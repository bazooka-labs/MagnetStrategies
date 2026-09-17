# ruff: noqa: N802
"""
VPL — Volatility Prediction Ladder. A daily BTC ladder, the first product in the
Hedge sector.

A parimutuel ladder. Each day a reference price is set at 09:00 ET, the US session
runs, and at 16:00 ET the band containing the settlement price takes the entire pot,
pro-rata by stake. Entry for the *next* round is always open, so exactly one round
accepts entries at any moment.

Design and rationale: hedge/VPL.md
Specification (rev 6):  hedge/VPL_SPEC.md

Threat model: the operator is assumed honest; the deterrent against a dishonest one
is public verifiability (settlements are OHLC4 of published 1-minute candles on four
exchanges, with all four quotes written on-chain). What this contract defends against
is external participants and honest-operation failure — a keeper that dies, a venue
that lags, an admin that fat-fingers a parameter. The contract is non-upgradeable, so
operator mistakes are permanent; several guards exist only to make them recoverable.
"""

import typing

from algopy import (
    Account,
    ARC4Contract,
    Asset,
    BoxMap,
    Bytes,
    Global,
    GlobalState,
    OpUpFeeSource,
    StateTotals,
    TemplateVar,
    Txn,
    UInt64,
    arc4,
    gtxn,
    itxn,
    op,
    ensure_budget,
    subroutine,
    urange,
)

# ── Ladder shape ──────────────────────────────────────────────────────────────
BAND_COUNT = 9
BOUND_COUNT = 8  # BAND_COUNT - 1
BPS_DENOM = 10_000

# ── Economics ─────────────────────────────────────────────────────────────────
RAKE_BPS_CAP = 1_000  # 10% ceiling; not raisable
MIN_STAKE_FLOOR = 1_000_000  # 1 mUSD. Keeps get_ladder's muldiv away from dust overflow.
MIN_STAKE_CAP = 1_000_000_000  # 1,000 mUSD
MAX_POSITION_STAKE = 1_000_000_000_000  # 1M mUSD per box — an overflow bound, NOT a
# concentration limit. A single address may hold many boxes; that is intended.

# ── Round scheduling ──────────────────────────────────────────────────────────
MIN_ENTRY_WINDOW = 3_600
MAX_ENTRY_WINDOW = 172_800
MIN_SESSION = 7_200  # must exceed KEEPER_LOCK_DEADLINE, so the settlement checkpoint
# can never be knowable while lock() is still open
MAX_SESSION = 86_400
MAX_SCHEDULE_AHEAD = 172_800  # 2 days. Without this an admin typo (a millisecond
# timestamp) pins open_round_id forever with no recovery in a non-upgradeable contract.

# Two windows, split by sender. A published attestation can be RELAYED by anyone for
# 120s — that path exists for one failure, a keeper that signed but could not submit,
# which is a seconds-to-minutes problem. The KEEPER itself has an hour, because the
# attestation is pinned to the checkpoint and a candle is historical data: a keeper that
# crashes at 09:00 and returns at 09:45 reads the same 09:00 candle and the round
# proceeds at the correct reference rather than throwing the day away.
#
# The split matters because whoever relays chooses WHETHER the round commits, having
# watched some of the session — at an hour, ~14% of its variance. A participant holding
# the band the price drifted toward would submit; one holding the centre would not. The
# keeper gains no power it lacks (it can already decline to sign); a participant is held
# to 120s.
LOCK_DEADLINE = 120
KEEPER_LOCK_DEADLINE = 3_600
RESOLVE_DEADLINE = 259_200  # 72h — a winner has three days to relay a published
# attestation before anyone can void the round
BOUNTY_DELAY = 300  # the keeper's own settlement window is bounty-free
CLEANUP_GRACE = 604_800  # 7 days
FORFEIT_PERIOD = 15_552_000  # 180 days

# ── Oracle ────────────────────────────────────────────────────────────────────
SOURCE_COUNT = 4
MIN_SOURCES = 3
PRESENT_MASK_MAX = 0x0F

CHECKPOINT_LOCK = 0
CHECKPOINT_RESOLVE = 1

# Settlement must land 20%–500% of the reference. Wide on purpose: a 50–200% window
# would reject a genuine 55% move and void the most valuable round the product could have.
PRICE_SANITY_LO = 2_000
PRICE_SANITY_HI = 50_000

# The reference must land 50%–200% of the previous round's settlement. The whole ladder
# spans 7% of the reference, so any reference error above ~3.5% decides the round — a
# wrong quote currency (BTC-EUR for BTC-USD) shifts every boundary 8% while all four
# venues agree and every other check passes.
REF_DRIFT_LO = 5_000
REF_DRIFT_HI = 20_000

# 2% max venue spread AT LOCK ONLY. No outcome exists before lock, so buying a void
# there means paying to refund your own stake — the incentive that makes a spread gate
# dangerous at resolve is simply absent. ~130x above observed inter-venue agreement
# (0.015%); this catches a per-venue misconfiguration, it is not a manipulation defence.
LOCK_SPREAD_CAP_BPS = 200

MIN_REFERENCE_PRICE = 1_000_000  # $1 — below this, band boundaries collide under truncation
MAX_REFERENCE_PRICE = 100_000_000_000_000  # $100M

# ── Box economics (µALGO) ─────────────────────────────────────────────────────
# Position box: key 42 (prefix 1 + round 8 + owner 32 + band 1), value 56
# (stake 8 + recipient 32 + mbr_paid 8 + fee_paid 8) -> 2500 + 400*98 = 41,700.
# Settable because per-box and per-byte MBR are consensus parameters and Algorand's
# have changed before; a hardcoded value would break enter() for everyone if they rose.
# The amount actually collected is stored in the box and refunded exactly.
DEFAULT_BOX_MBR = 41_700
BOX_MBR_CAP = 200_000
# Both a floor and a cap, and NEITHER direction is free. Under-collecting bleeds the
# app's free ALGO per box (min_balance rises by the real consensus figure while the
# entrant paid less). Over-collecting looks harmless but is not: the surplus is owed
# back on close while min_balance releases only the consensus amount, so without a
# reserve it shows up as withdrawable free balance and an honest sweep takes money the
# contract has to pay out later — after which every terminal method reverts on an
# insufficient inner payment. `mbr_reserve` tracks what was actually collected so the
# withdraw floor sees it, which makes the two-sided exposure safe rather than assumed.
BOX_MBR_FLOOR = 41_700
DEFAULT_PAYOUT_FEE = 8_000  # covers <=3 inner txns + the bounty, with margin
PAYOUT_FEE_CAP = 50_000
# Worst case is settle-by-a-third-party: 3 inner fees + the bounty. Below that a
# position stops pre-funding its own terminal call, fee_reserve under-states the real
# commitment, and withdraw_operating_algo is then authorised to take ALGO that is owed.
PAYOUT_FEE_FLOOR = 8_000
CLOSE_BOUNTY = 3_000
# RoundBox serialises to 307 bytes; key is b"r" + 8 = 9. MBR = 2500 + 400*(9+307).
# Reserved in the withdraw floor so an honest sweep cannot starve create_round.
ROUND_BOX_MBR = 128_900

# ── Status / void reasons ─────────────────────────────────────────────────────
STATUS_OPEN = 0
STATUS_LOCKED = 1
STATUS_RESOLVED = 2
STATUS_VOID = 3

VOID_THIN = 0
VOID_EMPTY_BAND = 1
VOID_NO_LOCK = 2
VOID_NO_RESOLVE = 3
VOID_ADMIN = 4

MIN_OCCUPIED_BANDS = 2

Bytes32 = arc4.StaticArray[arc4.Byte, typing.Literal[32]]
Bytes64 = arc4.StaticArray[arc4.Byte, typing.Literal[64]]
BandStakes = arc4.StaticArray[arc4.UInt64, typing.Literal[9]]
BandBounds = arc4.StaticArray[arc4.UInt16, typing.Literal[8]]
Sources = arc4.StaticArray[arc4.UInt64, typing.Literal[4]]


# ── ARC-28 events ─────────────────────────────────────────────────────────────
# Logs are block data: permanent, indexable, and — crucially — they survive
# cleanup_round deleting the round box. Without them a settled round becomes
# unauditable from chain state after CLEANUP_GRACE, which would gut the public
# verifiability this product's whole trust model rests on.


class RoundCreated(arc4.Struct):
    round_id: arc4.UInt64
    open_time: arc4.UInt64
    lock_time: arc4.UInt64
    resolve_time: arc4.UInt64
    rake_bps: arc4.UInt64


class Entered(arc4.Struct):
    round_id: arc4.UInt64
    owner: arc4.Address
    band: arc4.UInt8
    stake: arc4.UInt64


class Locked(arc4.Struct):
    round_id: arc4.UInt64
    reference_price: arc4.UInt64
    sources: Sources
    source_count: arc4.UInt64
    total_stake: arc4.UInt64


class Resolved(arc4.Struct):
    round_id: arc4.UInt64
    settlement_price: arc4.UInt64
    sources: Sources
    source_count: arc4.UInt64
    winning_band: arc4.UInt8
    payable_pot: arc4.UInt64


class Voided(arc4.Struct):
    round_id: arc4.UInt64
    reason: arc4.UInt8
    total_stake: arc4.UInt64


class Settled(arc4.Struct):
    round_id: arc4.UInt64
    owner: arc4.Address
    band: arc4.UInt8
    payout: arc4.UInt64


class Closed(arc4.Struct):
    round_id: arc4.UInt64
    owner: arc4.Address
    band: arc4.UInt8


class Refunded(arc4.Struct):
    round_id: arc4.UInt64
    owner: arc4.Address
    band: arc4.UInt8
    stake: arc4.UInt64


class Purged(arc4.Struct):
    round_id: arc4.UInt64
    owner: arc4.Address
    band: arc4.UInt8


class RakeSwept(arc4.Struct):
    amount: arc4.UInt64


class RoundCleaned(arc4.Struct):
    round_id: arc4.UInt64
    forfeited: arc4.UInt64


class RoundCancelled(arc4.Struct):
    round_id: arc4.UInt64


class RoundBox(arc4.Struct, kw_only=True):
    """One day's ladder. Everything defining the round's terms is snapshotted at
    creation, so no admin action can change the terms of a round already underway."""

    open_time: arc4.UInt64
    lock_time: arc4.UInt64
    resolve_time: arc4.UInt64
    reference_price: arc4.UInt64
    settlement_price: arc4.UInt64
    ref_sources: Sources
    settle_sources: Sources
    band_stake: BandStakes
    total_stake: arc4.UInt64
    rake_bps: arc4.UInt64
    min_stake: arc4.UInt64
    box_mbr: arc4.UInt64
    payout_fee: arc4.UInt64
    oracle_pubkey: Bytes32
    band_bounds: BandBounds
    price_feed_id: arc4.UInt64
    payable_pot: arc4.UInt64
    remaining_payable: arc4.UInt64
    position_count: arc4.UInt64
    # When the round reached RESOLVED or VOID. The bounty is gated on this, not on
    # resolve_time: a VOID(no_lock) opens refunds at lock_time+120 but resolve_time can
    # be up to 24h later, and third-party help being unpaid for that whole window is
    # exactly when users who cannot transact themselves need it.
    finalized_at: arc4.UInt64
    winning_band: arc4.UInt8
    status: arc4.UInt8
    void_reason: arc4.UInt8


class PositionBox(arc4.Struct, kw_only=True):
    """A stake on one band. There is deliberately no `settled` flag — terminal
    operations delete the box, so existence IS the flag and double-settle is
    structurally impossible rather than dependent on a check someone might forget."""

    stake: arc4.UInt64
    recipient: arc4.Address  # zero = pay the owner
    mbr_paid: arc4.UInt64
    fee_paid: arc4.UInt64


class VPL(
    ARC4Contract,
    state_totals=StateTotals(global_uints=15, global_bytes=6),
):
    """VPL — daily parimutuel BTC ladder. Non-upgradeable, non-deletable."""

    def __init__(self) -> None:
        self.admin = GlobalState(Account(), key=b"admin")
        self.pending_admin = GlobalState(Account(), key=b"pending_admin")
        self.keeper = GlobalState(Account(), key=b"keeper")
        self.treasury = GlobalState(Account(), key=b"treasury")
        self.oracle_pubkey = GlobalState(Bytes(), key=b"oracle_pk")

        self.musd_asset_id = GlobalState(UInt64(0), key=b"musd")
        self.price_feed_id = GlobalState(UInt64(0), key=b"feed")

        self.round_count = GlobalState(UInt64(0), key=b"rcount")
        self.open_round_id = GlobalState(UInt64(0), key=b"open_rid")

        self.default_rake_bps = GlobalState(UInt64(0), key=b"rake")
        self.min_stake = GlobalState(UInt64(0), key=b"min_stake")
        self.box_mbr = GlobalState(UInt64(DEFAULT_BOX_MBR), key=b"box_mbr")
        self.payout_fee = GlobalState(UInt64(DEFAULT_PAYOUT_FEE), key=b"fee")
        self.band_bounds = GlobalState(Bytes(), key=b"bounds")

        # Previous round's settlement. Bounds the next reference against a global scale
        # or pair error. 0 until the first resolve.
        self.last_settlement_price = GlobalState(UInt64(0), key=b"last_px")
        # Which round last wrote it. Rounds overlap (lock clears open_round_id so N+1
        # can be created while N is still LOCKED, and RESOLVE_DEADLINE is 72h), so
        # without this a stale attestation relayed at a chosen moment could set the
        # basis for a newer round's drift check. Not profitable — the payoff is a VOID
        # that refunds the attacker too — but it is a liveness hazard for free.
        self.last_settled_round = GlobalState(UInt64(0), key=b"last_rid")

        # mUSD owed to users across ALL rounds. Makes solvency checkable on-chain and
        # bounds sweep_excess_musd. See the identity in _obligation invariants below.
        self.total_obligations = GlobalState(UInt64(0), key=b"oblig")
        self.rake_owed = GlobalState(UInt64(0), key=b"rake_owed")
        # µALGO committed to live position boxes; floors withdraw_operating_algo.
        self.fee_reserve = GlobalState(UInt64(0), key=b"fee_res")
        # µALGO of box deposits collected and owed back. Tracked separately from
        # min_balance because box_mbr is settable and need not equal the consensus
        # per-box MBR in either direction.
        self.mbr_reserve = GlobalState(UInt64(0), key=b"mbr_res")
        self.paused = GlobalState(UInt64(0), key=b"paused")

        self.rounds = BoxMap(UInt64, RoundBox, key_prefix=b"r")
        self.positions = BoxMap(Bytes, PositionBox, key_prefix=b"p")

    # ────────────────────────────────────────────────────────────────────────
    #  Internal helpers
    # ────────────────────────────────────────────────────────────────────────

    @subroutine
    def _only_admin(self) -> None:
        assert Txn.sender == self.admin.value, "admin only"

    @subroutine
    def _muldiv(self, a: UInt64, b: UInt64, c: UInt64) -> UInt64:
        """(a * b) // c through a 128-bit intermediate.

        Mandatory on every a*b/c in this contract: payable_pot * stake reaches ~1e24
        against a 1.8e19 uint64 ceiling.
        """
        hi, lo = op.mulw(a, b)
        return op.divw(hi, lo, c)

    @subroutine
    def _position_key(self, round_id: UInt64, owner: Account, band: UInt64) -> Bytes:
        """round_id(8) || owner(32) || band(1). Full key, never a truncated hash —
        a 64-bit hash is grindable against thousands of known positions.

        No band-range assert here: the batch helpers must SKIP a bad entry, not revert
        the whole group, and an assert inside the key builder fires before any skip
        logic can run. Callers that need the check do it themselves.
        """
        return op.itob(round_id) + owner.bytes + op.extract(op.itob(band), 7, 1)

    @subroutine
    def _band_boundary(self, reference: UInt64, bounds: Bytes, i: UInt64) -> UInt64:
        """i-th boundary price. Bounds are unsigned bps multipliers of the reference,
        so no value in this contract is ever signed."""
        bps = op.btoi(op.extract(bounds, i * 2, 2))
        return self._muldiv(reference, bps, UInt64(BPS_DENOM))

    @subroutine
    def _assert_not_paused(self) -> None:
        assert self.paused.value == UInt64(0), "paused"

    @subroutine
    def _pay_algo(self, receiver: Account, amount: UInt64) -> None:
        if amount > UInt64(0):
            itxn.Payment(
                receiver=receiver, amount=amount, fee=Global.min_txn_fee
            ).submit()

    @subroutine
    def _pay_musd(self, receiver: Account, amount: UInt64) -> None:
        if amount > UInt64(0):
            itxn.AssetTransfer(
                xfer_asset=self.musd_asset_id.value,
                asset_receiver=receiver,
                asset_amount=amount,
                fee=Global.min_txn_fee,
            ).submit()

    @subroutine
    def _sort2(self, a: UInt64, b: UInt64) -> tuple[UInt64, UInt64]:
        if a <= b:
            return a, b
        return b, a

    @subroutine
    def _solvency_ok(self) -> bool:
        """app mUSD balance >= total_obligations + rake_owed.

        Asserted before either sweep so a bookkeeping drift fails closed rather than
        authorising a transfer of live escrow.
        """
        bal, _exists = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.musd_asset_id.value
        )
        return bal >= self.total_obligations.value + self.rake_owed.value

    # ────────────────────────────────────────────────────────────────────────
    #  Lifecycle — non-upgradeable, non-deletable
    # ────────────────────────────────────────────────────────────────────────
    # Ring-fencing is a claim about code, and an upgradeable contract can replace
    # settle_position with one that pays Txn.sender. Bugs being permanent is the
    # accepted cost; MAX_SCHEDULE_AHEAD, admin_void_round, the bootstrap asset checks
    # and the wide sanity bounds exist to make operator foot-guns recoverable.

    @arc4.baremethod(allow_actions=["UpdateApplication"])
    def update(self) -> None:
        assert False, "non-upgradeable"  # noqa: B011

    @arc4.baremethod(allow_actions=["DeleteApplication"])
    def delete(self) -> None:
        assert False, "non-deletable"  # noqa: B011

    @arc4.abimethod(create="require")
    def create_application(self) -> None:
        self.admin.value = Txn.sender

    @arc4.abimethod
    def bootstrap(
        self,
        musd_asset: Asset,
        price_feed_id: arc4.UInt64,
        treasury: arc4.Address,
        oracle_pubkey: Bytes32,
        keeper: arc4.Address,
        rake_bps: arc4.UInt64,
        min_stake: arc4.UInt64,
        band_bounds: BandBounds,
    ) -> None:
        """One-shot. A wrong asset id here is unrecoverable in a non-upgradeable
        contract, so the asset is validated rather than trusted.

        clawback and freeze must be the zero address. That is the property that makes
        MagnetFi unable to touch Hedge's escrow — decimals and a unit name are trivially
        forgeable by any third party's ASA, so checking only those would leave the
        isolation claim resting on an off-chain eyeball.
        """
        self._only_admin()
        assert self.musd_asset_id.value == UInt64(0), "already bootstrapped"
        # Substituted at DEPLOY time and baked permanently into the deployed program,
        # not trusted from this call's argument: bootstrap is one-shot and irreversible
        # in a non-upgradeable contract, so a transposed asset id would brick the
        # deployment. mainnet mUSD is 3615600399.
        assert musd_asset.id == TemplateVar[UInt64]("MUSD_ASSET_ID"), "wrong asset"
        assert musd_asset.decimals == UInt64(6), "decimals"
        assert musd_asset.unit_name == Bytes(b"mUSD"), "unit name"
        assert musd_asset.clawback == Global.zero_address, "clawback must be zero"
        assert musd_asset.freeze == Global.zero_address, "freeze must be zero"
        assert musd_asset.total > UInt64(0), "total"
        assert rake_bps.native <= RAKE_BPS_CAP, "rake cap"
        assert treasury.native != Global.zero_address, "treasury"
        assert keeper.native != Global.zero_address, "keeper"

        self.musd_asset_id.value = musd_asset.id
        self.price_feed_id.value = price_feed_id.native
        self.treasury.value = treasury.native
        self.oracle_pubkey.value = oracle_pubkey.bytes
        self.keeper.value = keeper.native
        self.default_rake_bps.value = rake_bps.native
        self._set_min_stake_checked(min_stake.native)
        self._set_bounds_checked(band_bounds.copy())

        itxn.AssetTransfer(
            xfer_asset=musd_asset.id,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=Global.min_txn_fee,
        ).submit()

    # ────────────────────────────────────────────────────────────────────────
    #  Admin
    # ────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def propose_admin(self, new_admin: arc4.Address) -> None:
        """The zero address is a valid argument: it cancels a pending proposal.
        Without that, a proposal to a typo'd or later-compromised key stands forever."""
        self._only_admin()
        self.pending_admin.value = new_admin.native

    @arc4.abimethod
    def accept_admin(self) -> None:
        pending = self.pending_admin.value
        assert pending != Global.zero_address, "no pending"
        assert Txn.sender == pending, "not pending admin"
        self.admin.value = pending
        self.pending_admin.value = Global.zero_address

    @arc4.abimethod
    def set_keeper(self, keeper: arc4.Address) -> None:
        self._only_admin()
        assert keeper.native != Global.zero_address, "zero"
        self.keeper.value = keeper.native

    @arc4.abimethod
    def set_treasury(self, treasury: arc4.Address) -> None:
        """Zero-guarded: sweep_rake to the zero address would burn accrued rake with
        no recovery, since sweep_excess_musd subtracts rake_owed and cannot pick it up."""
        self._only_admin()
        assert treasury.native != Global.zero_address, "zero"
        self.treasury.value = treasury.native

    @arc4.abimethod
    def set_oracle_pubkey(
        self, pubkey: Bytes32
    ) -> None:
        self._only_admin()
        assert pubkey.bytes != op.bzero(32), "zero key"
        self.oracle_pubkey.value = pubkey.bytes

    @arc4.abimethod
    def set_default_rake_bps(self, bps: arc4.UInt64) -> None:
        self._only_admin()
        assert bps.native <= RAKE_BPS_CAP, "rake cap"
        self.default_rake_bps.value = bps.native

    @subroutine
    def _set_min_stake_checked(self, v: UInt64) -> None:
        assert v >= MIN_STAKE_FLOOR, "min stake floor"
        assert v <= MIN_STAKE_CAP, "min stake cap"
        self.min_stake.value = v

    @arc4.abimethod
    def set_min_stake(self, v: arc4.UInt64) -> None:
        """Ordinary parameter hygiene — 5 mUSD is a guess and a dust floor is not a
        throttle on anything. The floor also keeps get_ladder's muldiv away from
        overflow at dust band_stake values."""
        self._only_admin()
        self._set_min_stake_checked(v.native)

    @subroutine
    def _set_bounds_checked(self, bounds: BandBounds) -> None:
        """Strictly increasing, straddling BPS_DENOM, each within [5000, 20000], and
        no single band wider than 1000 bps.

        The range and width checks matter: a digit transposition (10350 -> 13050) stays
        strictly increasing and still straddles, but silently reshapes a band to cover
        +2.25% to +30.5% and makes the outer band dead — snapshotted into a round that
        then runs for 24 hours before anyone notices.
        """
        prev = UInt64(0)
        packed = Bytes()
        for i in urange(BOUND_COUNT):
            v = bounds[i].native
            assert v >= 5_000 and v <= 20_000, "bound range"
            assert v > prev, "not increasing"
            if i > UInt64(0):
                assert v - prev <= 1_000, "band too wide"
            prev = v
            packed += op.extract(op.itob(v), 6, 2)
        assert bounds[0].native < BPS_DENOM, "must straddle"
        assert bounds[BOUND_COUNT - 1].native > BPS_DENOM, "must straddle"
        self.band_bounds.value = packed

    @arc4.abimethod
    def set_band_bounds(self, bounds: BandBounds) -> None:
        self._only_admin()
        self._set_bounds_checked(bounds.copy())

    @arc4.abimethod
    def set_box_mbr(self, v: arc4.UInt64) -> None:
        self._only_admin()
        assert v.native >= BOX_MBR_FLOOR, "mbr floor"
        assert v.native <= BOX_MBR_CAP, "cap"
        self.box_mbr.value = v.native

    @arc4.abimethod
    def set_payout_fee(self, v: arc4.UInt64) -> None:
        self._only_admin()
        assert v.native >= PAYOUT_FEE_FLOOR, "fee floor"
        assert v.native <= PAYOUT_FEE_CAP, "cap"
        self.payout_fee.value = v.native

    @arc4.abimethod
    def set_paused(self, paused: arc4.UInt64) -> None:
        """Read live, never snapshotted. Snapshotting it would mean discovering a bug
        five minutes into an entry window and then accepting deposits for another 24
        hours with no lever. Every exit path ignores it, so funds are never trapped."""
        self._only_admin()
        self.paused.value = paused.native

    # ────────────────────────────────────────────────────────────────────────
    #  Treasury
    # ────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def sweep_rake(self) -> None:
        """Permissionless. Separate from resolve() on purpose: transferring rake inside
        resolve would revert the whole call if the treasury were not opted into mUSD —
        one configuration mistake voiding every round in flight."""
        assert self.rake_owed.value > UInt64(0), "nothing owed"
        assert self._solvency_ok(), "insolvent"
        amount = self.rake_owed.value
        self.rake_owed.value = UInt64(0)
        self._pay_musd(self.treasury.value, amount)
        arc4.emit(RakeSwept(arc4.UInt64(amount)))

    @arc4.abimethod
    def sweep_excess_musd(self, amount: arc4.UInt64) -> None:
        """Recovers mUSD that reached the app outside an entry group — the single most
        common escrow user error. Bounded by total_obligations so it can never touch
        live escrow, and gated on the solvency assert so a counter drift fails closed."""
        self._only_admin()
        assert self._solvency_ok(), "insolvent"
        bal, _e = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.musd_asset_id.value
        )
        excess = bal - self.total_obligations.value - self.rake_owed.value
        assert amount.native <= excess, "exceeds excess"
        self._pay_musd(self.treasury.value, amount.native)

    @arc4.abimethod
    def withdraw_operating_algo(self, amount: arc4.UInt64) -> None:
        """Floor reserves position payout fees AND round-box headroom. Without the
        latter an honest sweep to the stated floor leaves no free balance for the next
        create_round, and the conveyor stops until someone notices."""
        self._only_admin()
        floor = (
            Global.current_application_address.min_balance
            + self.fee_reserve.value
            + self.mbr_reserve.value
            + UInt64(ROUND_BOX_MBR)
            + UInt64(CLOSE_BOUNTY)
        )
        assert (
            Global.current_application_address.balance - amount.native >= floor
        ), "below floor"
        self._pay_algo(self.admin.value, amount.native)

    # ────────────────────────────────────────────────────────────────────────
    #  Round lifecycle
    # ────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def create_round(
        self,
        open_time: arc4.UInt64,
        lock_time: arc4.UInt64,
        resolve_time: arc4.UInt64,
    ) -> arc4.UInt64:
        """Admin or keeper, so the conveyor needs no human step.

        Ids come from round_count and box existence is asserted unconditionally: a
        keeper retry re-sending a previous call's arguments would otherwise overwrite a
        live round's box, zeroing total_stake and remaining_payable and making every
        position in it unreachable.
        """
        assert (
            Txn.sender == self.admin.value or Txn.sender == self.keeper.value
        ), "admin or keeper"
        self._assert_not_paused()
        assert self.open_round_id.value == UInt64(0), "a round is already open"
        assert self.musd_asset_id.value != UInt64(0), "not bootstrapped"

        ot = open_time.native
        lt = lock_time.native
        rt = resolve_time.native
        assert ot >= Global.latest_timestamp, "open in the past"
        assert ot <= Global.latest_timestamp + MAX_SCHEDULE_AHEAD, "too far ahead"
        assert lt > ot, "lock before open"
        assert lt - ot >= MIN_ENTRY_WINDOW, "entry window short"
        assert lt - ot <= MAX_ENTRY_WINDOW, "entry window long"
        assert rt > lt, "resolve before lock"
        assert rt - lt >= MIN_SESSION, "session short"
        assert rt - lt <= MAX_SESSION, "session long"
        # Checkpoints must be minute-aligned, because an attestation's candle boundary
        # is asserted EQUAL to the checkpoint. A misaligned checkpoint would make the
        # round unresolvable by any attestation the keeper can ever sign.
        assert lt % UInt64(60) == UInt64(0), "lock_time not minute-aligned"
        assert rt % UInt64(60) == UInt64(0), "resolve_time not minute-aligned"

        rid = self.round_count.value + UInt64(1)
        self.round_count.value = rid
        assert rid not in self.rounds, "round box exists"

        self.rounds[rid] = RoundBox(
            open_time=arc4.UInt64(ot),
            lock_time=arc4.UInt64(lt),
            resolve_time=arc4.UInt64(rt),
            reference_price=arc4.UInt64(0),
            settlement_price=arc4.UInt64(0),
            ref_sources=Sources.from_bytes(op.bzero(32)),
            settle_sources=Sources.from_bytes(op.bzero(32)),
            band_stake=BandStakes.from_bytes(op.bzero(72)),
            total_stake=arc4.UInt64(0),
            rake_bps=arc4.UInt64(self.default_rake_bps.value),
            min_stake=arc4.UInt64(self.min_stake.value),
            box_mbr=arc4.UInt64(self.box_mbr.value),
            payout_fee=arc4.UInt64(self.payout_fee.value),
            oracle_pubkey=Bytes32.from_bytes(
                self.oracle_pubkey.value
            ),
            band_bounds=BandBounds.from_bytes(self.band_bounds.value),
            price_feed_id=arc4.UInt64(self.price_feed_id.value),
            payable_pot=arc4.UInt64(0),
            remaining_payable=arc4.UInt64(0),
            position_count=arc4.UInt64(0),
            finalized_at=arc4.UInt64(0),
            winning_band=arc4.UInt8(0),
            status=arc4.UInt8(STATUS_OPEN),
            void_reason=arc4.UInt8(0),
        )
        self.open_round_id.value = rid
        arc4.emit(RoundCreated(
            arc4.UInt64(rid), arc4.UInt64(ot), arc4.UInt64(lt), arc4.UInt64(rt),
            arc4.UInt64(self.default_rake_bps.value),
        ))
        return arc4.UInt64(rid)

    @arc4.abimethod
    def cancel_empty_round(self, round_id: arc4.UInt64) -> None:
        """Cheap path when nobody has entered yet."""
        self._only_admin()
        rid = round_id.native
        rnd = self.rounds[rid].copy()
        assert rnd.status.native == STATUS_OPEN, "not open"
        assert rnd.position_count.native == UInt64(0), "has positions"
        assert rnd.total_stake.native == UInt64(0), "has stake"
        del self.rounds[rid]
        if self.open_round_id.value == rid:
            self.open_round_id.value = UInt64(0)
        arc4.emit(RoundCancelled(arc4.UInt64(rid)))

    @arc4.abimethod
    def admin_void_round(self, round_id: arc4.UInt64) -> None:
        """The recovery lever. OPEN only, full refunds, no rake.

        cancel_empty_round alone was not enough: a bot entering min_stake seconds after
        RoundCreated disarms it permanently for ~$0.002, after which a fat-fingered
        schedule could block the conveyor for days. This does not weaken the "no
        cancellation that costs a user anything" invariant — before lock no reference
        price exists, so voiding is informationally neutral and everyone gets 100% back.
        """
        self._only_admin()
        rid = round_id.native
        rnd = self.rounds[rid].copy()
        assert rnd.status.native == STATUS_OPEN, "not open"
        rnd.status = arc4.UInt8(STATUS_VOID)
        rnd.void_reason = arc4.UInt8(VOID_ADMIN)
        rnd.remaining_payable = arc4.UInt64(rnd.total_stake.native)
        rnd.finalized_at = arc4.UInt64(Global.latest_timestamp)
        self.rounds[rid] = rnd.copy()
        if self.open_round_id.value == rid:
            self.open_round_id.value = UInt64(0)
        arc4.emit(Voided(
            arc4.UInt64(rid), arc4.UInt8(VOID_ADMIN),
            arc4.UInt64(rnd.total_stake.native),
        ))

    @arc4.abimethod
    def void_round(self, round_id: arc4.UInt64) -> None:
        """Permissionless. Operator failure must never be able to strand funds, so
        every state reachable by inaction has a time-derived exit.

        Deliberately a single deadline with no stored timer: an earlier two-step design
        could be re-armed by anyone every 23 hours for ~0.37 ALGO/year, freezing a
        round's escrow permanently — and a naive keeper retry loop would have done it
        accidentally to itself.
        """
        rid = round_id.native
        rnd = self.rounds[rid].copy()
        st = rnd.status.native
        now = Global.latest_timestamp
        if st == UInt64(STATUS_OPEN):
            # the longer of the two windows, so a void cannot race a recovering keeper
            assert (
                now > rnd.lock_time.native + KEEPER_LOCK_DEADLINE
            ), "lock window open"
            rnd.void_reason = arc4.UInt8(VOID_NO_LOCK)
        else:
            assert st == UInt64(STATUS_LOCKED), "not voidable"
            assert now > rnd.resolve_time.native + RESOLVE_DEADLINE, "resolve window open"
            rnd.void_reason = arc4.UInt8(VOID_NO_RESOLVE)
        rnd.status = arc4.UInt8(STATUS_VOID)
        rnd.remaining_payable = arc4.UInt64(rnd.total_stake.native)
        rnd.finalized_at = arc4.UInt64(now)
        self.rounds[rid] = rnd.copy()
        if self.open_round_id.value == rid:
            self.open_round_id.value = UInt64(0)
        arc4.emit(Voided(
            arc4.UInt64(rid), rnd.void_reason, arc4.UInt64(rnd.total_stake.native),
        ))

    # ────────────────────────────────────────────────────────────────────────
    #  Entry
    # ────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def enter(
        self,
        mbr: gtxn.PaymentTransaction,
        payment: gtxn.AssetTransferTransaction,
        round_id: arc4.UInt64,
        band_index: arc4.UInt8,
    ) -> None:
        """Three-transaction group: ALGO for box MBR + payout fee, mUSD stake, app call.

        What actually makes this safe is the ARC-4 calling convention plus the TYPE of
        each parameter. Transaction arguments are resolved positionally by the compiler
        — `payment` IS `group[GroupIndex-1]` and `mbr` IS `group[GroupIndex-2]`, not an
        index the caller supplies — so a group cannot cite one transfer from several
        `enter` calls. The declared `gtxn.PaymentTransaction` / `AssetTransferTransaction`
        types then reject any group whose preceding two transactions are the wrong shape.

        (The two `group_index` asserts below compile to comparisons of a value against
        itself. They are kept as executable documentation of the required shape, but
        they are not what stops anything — a reader should not mistake them for a
        defence, and a future refactor that took an index parameter instead would need
        a real check here.)

        `stake` is read from the transfer, never passed as a parameter.
        """
        self._assert_not_paused()
        sender = Txn.sender
        assert sender != self.admin.value, "operator may not enter"
        assert sender != self.keeper.value, "operator may not enter"
        assert sender != self.treasury.value, "operator may not enter"

        rid = round_id.native
        assert rid == self.open_round_id.value, "not the open round"
        rnd = self.rounds[rid].copy()
        assert rnd.status.native == STATUS_OPEN, "not open"
        now = Global.latest_timestamp
        assert now >= rnd.open_time.native, "not yet open"
        assert now < rnd.lock_time.native, "entry closed"

        band = band_index.native
        assert band < BAND_COUNT, "band"  # _position_key no longer checks

        assert payment.group_index == Txn.group_index - 1, "axfer position"
        assert payment.xfer_asset.id == self.musd_asset_id.value, "wrong asset"
        assert (
            payment.asset_receiver == Global.current_application_address
        ), "wrong receiver"
        assert payment.sender == sender, "axfer sender"
        assert payment.asset_close_to == Global.zero_address, "close_to"
        assert payment.rekey_to == Global.zero_address, "rekey"
        stake = payment.asset_amount

        assert mbr.group_index == Txn.group_index - 2, "pay position"
        assert mbr.receiver == Global.current_application_address, "wrong receiver"
        assert mbr.sender == sender, "pay sender"
        assert mbr.close_remainder_to == Global.zero_address, "close_to"
        assert mbr.rekey_to == Global.zero_address, "rekey"

        key = self._position_key(rid, sender, band)
        # New-vs-topup is derived from box existence at execution time, never from a
        # caller-supplied flag — otherwise a caller declares "top-up" against a
        # non-existent box and gets one free. Sequential execution keeps this safe even
        # within one group: [new, topup] works, [topup, new] reverts on the first.
        is_new = key not in self.positions
        if is_new:
            required = rnd.box_mbr.native + rnd.payout_fee.native
            assert mbr.amount == required, "mbr+fee exact"
            assert stake >= rnd.min_stake.native, "below min stake"
            assert stake <= MAX_POSITION_STAKE, "position cap"
            self.positions[key] = PositionBox(
                stake=arc4.UInt64(stake),
                recipient=arc4.Address(Global.zero_address),
                mbr_paid=arc4.UInt64(rnd.box_mbr.native),
                fee_paid=arc4.UInt64(rnd.payout_fee.native),
            )
            rnd.position_count = arc4.UInt64(rnd.position_count.native + UInt64(1))
            self.fee_reserve.value += rnd.payout_fee.native
            self.mbr_reserve.value += rnd.box_mbr.native
        else:
            assert mbr.amount == UInt64(0), "no mbr on top-up"
            pos = self.positions[key].copy()
            assert stake >= rnd.min_stake.native, "below min stake"
            # Overflow-safe: never `a + b <= MAX`.
            assert stake <= MAX_POSITION_STAKE - pos.stake.native, "position cap"
            pos.stake = arc4.UInt64(pos.stake.native + stake)
            self.positions[key] = pos.copy()

        rnd.band_stake[band] = arc4.UInt64(rnd.band_stake[band].native + stake)
        rnd.total_stake = arc4.UInt64(rnd.total_stake.native + stake)
        self.rounds[rid] = rnd.copy()
        self.total_obligations.value += stake
        arc4.emit(Entered(
            arc4.UInt64(rid), arc4.Address(sender), arc4.UInt8(band), arc4.UInt64(stake),
        ))

    @arc4.abimethod
    def set_payout_recipient(
        self, round_id: arc4.UInt64, band_index: arc4.UInt8, recipient: arc4.Address
    ) -> None:
        """Lets a winner who is not opted into mUSD redirect their payout rather than
        forfeit it. Owner only."""
        assert band_index.native < BAND_COUNT, "band"
        key = self._position_key(round_id.native, Txn.sender, band_index.native)
        pos = self.positions[key].copy()
        pos.recipient = recipient.copy()
        self.positions[key] = pos.copy()

    # ────────────────────────────────────────────────────────────────────────
    #  Oracle
    # ────────────────────────────────────────────────────────────────────────

    @subroutine
    def _verify_attestation(
        self,
        rnd: RoundBox,
        round_id: UInt64,
        kind: UInt64,
        present_mask: UInt64,
        prices: Sources,
        timestamps: Sources,
        sig: Bytes,
    ) -> tuple[UInt64, UInt64, Sources]:
        """Verify one aggregate attestation and return the median price.

        ONE signature over the whole vector including the mask — not four independent
        signatures. With per-source signatures and an unsigned mask, the signatures
        become public the instant they reach the mempool and anyone can resubmit them
        with a different mask, selecting from a menu of medians after seeing every value.

        Field provenance is part of the contract: app_id comes from Global, round_id
        from the box key, kind from the calling method's literal, and price_feed_id from
        the round's snapshot. Taking any of those from arguments would make the binding
        decorative.
        """
        # ed25519verify_bare alone costs 1900 opcodes against a 700 budget per app
        # call, so this method cannot run in a bare single-transaction call. Budget is
        # drawn from GROUP CREDIT, never the app account: lock/resolve are permissionless,
        # and letting the app fund opup for anyone would be a drain vector. The caller
        # over-pays fees; the keeper does this by default and a relayer must too.
        ensure_budget(3_000, OpUpFeeSource.GroupCredit)

        assert present_mask > UInt64(0), "empty mask"
        assert present_mask <= PRESENT_MASK_MAX, "mask range"

        msg = (
            op.itob(Global.current_application_id.id)
            + op.itob(round_id)
            + op.itob(kind)
            + op.itob(present_mask)
            + op.itob(rnd.price_feed_id.native)
            + prices.bytes
            + timestamps.bytes
        )
        assert op.ed25519verify_bare(
            op.sha256(msg), sig, rnd.oracle_pubkey.bytes
        ), "bad signature"

        checkpoint = rnd.lock_time.native if kind == UInt64(CHECKPOINT_LOCK) else rnd.resolve_time.native

        # Sort the four slots ascending, absent slots forced to MAX so they sort last.
        # Fixed 5-comparator network — optimal for n=4 and, being fixed, the "middle"
        # is well-defined for any present subset.
        n = UInt64(0)
        a0 = UInt64(0)
        a1 = UInt64(0)
        a2 = UInt64(0)
        a3 = UInt64(0)
        for i in urange(SOURCE_COUNT):
            if present_mask & (UInt64(1) << i) != UInt64(0):
                p = prices[i].native
                assert p > UInt64(0), "zero price"
                # timestamps[i] is the candle's clock-aligned OPEN BOUNDARY in seconds,
                # asserted EQUAL to the checkpoint. A tolerance band would be the wrong
                # shape for a bucket key: most checkpoints would admit either the wrong
                # minute or no minute at all.
                assert timestamps[i].native == checkpoint, "candle boundary"
                n += UInt64(1)
                if n == UInt64(1):
                    a0 = p
                elif n == UInt64(2):
                    a1 = p
                elif n == UInt64(3):
                    a2 = p
                else:
                    a3 = p
        assert n >= MIN_SOURCES, "quorum"
        if n == UInt64(3):
            a3 = UInt64(2**64 - 1)

        a0, a1 = self._sort2(a0, a1)
        a2, a3 = self._sort2(a2, a3)
        a0, a2 = self._sort2(a0, a2)
        a1, a3 = self._sort2(a1, a3)
        a1, a2 = self._sort2(a1, a2)

        # Price is from the checkpoint; the submission may be late.
        assert Global.latest_timestamp >= checkpoint, "before checkpoint"

        # Absent slots are published as 0, never the keeper's submitted value —
        # otherwise a three-source settlement is indistinguishable on-chain from a
        # four-source one, and the published record no longer supports the claim that
        # anyone can recompute the median.
        clean = Sources.from_bytes(op.bzero(32))
        for i in urange(SOURCE_COUNT):
            if present_mask & (UInt64(1) << i) != UInt64(0):
                clean[i] = prices[i]

        if n == UInt64(4):
            return a1 + (a2 - a1) // UInt64(2), n, clean.copy()  # no underflow: sorted
        return a1, n, clean.copy()

    # ────────────────────────────────────────────────────────────────────────
    #  Lock / resolve
    # ────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def lock(
        self,
        round_id: arc4.UInt64,
        present_mask: arc4.UInt64,
        prices: Sources,
        timestamps: Sources,
        sig: Bytes64,
    ) -> None:
        """Permissionless: verifies a signature, not a sender. Once the keeper publishes
        an attestation, anyone can relay it — a reliability backup so a keeper failure
        between signing and submitting cannot strand a round."""
        rid = round_id.native
        rnd = self.rounds[rid].copy()
        assert rnd.status.native == STATUS_OPEN, "not open"
        now = Global.latest_timestamp
        assert now >= rnd.lock_time.native, "too early"
        if Txn.sender == self.keeper.value:
            assert (
                now <= rnd.lock_time.native + KEEPER_LOCK_DEADLINE
            ), "keeper lock window closed"
        else:
            assert now <= rnd.lock_time.native + LOCK_DEADLINE, "relay window closed"

        reference, n_present, clean_sources = self._verify_attestation(
            rnd.copy(),
            rid,
            UInt64(CHECKPOINT_LOCK),
            present_mask.native,
            prices.copy(),
            timestamps.copy(),
            sig.bytes,
        )

        assert reference >= MIN_REFERENCE_PRICE, "reference too low"
        assert reference <= MAX_REFERENCE_PRICE, "reference too high"
        last = self.last_settlement_price.value
        if last > UInt64(0):
            assert reference >= self._muldiv(
                last, UInt64(REF_DRIFT_LO), UInt64(BPS_DENOM)
            ), "reference drift low"
            assert reference <= self._muldiv(
                last, UInt64(REF_DRIFT_HI), UInt64(BPS_DENOM)
            ), "reference drift high"

        # Spread gates HERE and deliberately nowhere else. See LOCK_SPREAD_CAP_BPS.
        lo = UInt64(2**64 - 1)
        hi = UInt64(0)
        for i in urange(SOURCE_COUNT):
            if present_mask.native & (UInt64(1) << i) != UInt64(0):
                p = prices[i].native
                if p < lo:
                    lo = p
                if p > hi:
                    hi = p
        assert hi - lo <= self._muldiv(
            reference, UInt64(LOCK_SPREAD_CAP_BPS), UInt64(BPS_DENOM)
        ), "venue spread"

        rnd.reference_price = arc4.UInt64(reference)
        rnd.ref_sources = clean_sources.copy()

        # Boundaries must stay strictly increasing after truncation.
        prev = UInt64(0)
        for i in urange(BOUND_COUNT):
            b = self._band_boundary(reference, rnd.band_bounds.bytes, i)
            assert b > prev, "boundary collision"
            prev = b

        occupied = UInt64(0)
        for i in urange(BAND_COUNT):
            if rnd.band_stake[i].native > UInt64(0):
                occupied += UInt64(1)

        self.open_round_id.value = UInt64(0)

        if occupied >= MIN_OCCUPIED_BANDS:
            rnd.status = arc4.UInt8(STATUS_LOCKED)
        else:
            # Every stake in one band pays 1 - rake to everyone. Not a market.
            # A liveness check and nothing more: occupancy only ever increases, so
            # anyone can satisfy it, and if they do they are buying cheap exposure to
            # an outcome the crowd is dismissing — which is the product.
            rnd.status = arc4.UInt8(STATUS_VOID)
            rnd.void_reason = arc4.UInt8(VOID_THIN)
            rnd.remaining_payable = arc4.UInt64(rnd.total_stake.native)
        rnd.finalized_at = arc4.UInt64(Global.latest_timestamp)
        self.rounds[rid] = rnd.copy()
        arc4.emit(Locked(
            arc4.UInt64(rid), arc4.UInt64(reference), rnd.ref_sources.copy(),
            arc4.UInt64(n_present), arc4.UInt64(rnd.total_stake.native),
        ))
        if rnd.status.native == UInt64(STATUS_VOID):
            arc4.emit(Voided(
                arc4.UInt64(rid), arc4.UInt8(VOID_THIN),
                arc4.UInt64(rnd.total_stake.native),
            ))

    @arc4.abimethod
    def resolve(
        self,
        round_id: arc4.UInt64,
        present_mask: arc4.UInt64,
        prices: Sources,
        timestamps: Sources,
        sig: Bytes64,
    ) -> None:
        """Permissionless, like lock. No spread gate here: a participant facing a total
        loss could otherwise push one venue past the threshold and buy themselves a
        refund — the cheapest attack on the contract, and cheapest exactly when the
        stakes are highest."""
        rid = round_id.native
        rnd = self.rounds[rid].copy()
        assert rnd.status.native == STATUS_LOCKED, "not locked"
        now = Global.latest_timestamp
        assert now >= rnd.resolve_time.native, "too early"
        assert now <= rnd.resolve_time.native + RESOLVE_DEADLINE, "resolve window closed"

        settlement, n_present, clean_sources = self._verify_attestation(
            rnd.copy(),
            rid,
            UInt64(CHECKPOINT_RESOLVE),
            present_mask.native,
            prices.copy(),
            timestamps.copy(),
            sig.bytes,
        )

        reference = rnd.reference_price.native
        assert settlement >= self._muldiv(
            reference, UInt64(PRICE_SANITY_LO), UInt64(BPS_DENOM)
        ), "settlement implausible low"
        assert settlement <= self._muldiv(
            reference, UInt64(PRICE_SANITY_HI), UInt64(BPS_DENOM)
        ), "settlement implausible high"

        # Inclusive upper bounds: a price landing exactly on a boundary is
        # deterministic and needs no tie rule.
        winning = UInt64(0)
        for i in urange(BOUND_COUNT):
            if winning == i and settlement > self._band_boundary(
                reference, rnd.band_bounds.bytes, i
            ):
                winning = i + UInt64(1)

        rnd.settlement_price = arc4.UInt64(settlement)
        rnd.settle_sources = clean_sources.copy()
        rnd.winning_band = arc4.UInt8(winning)
        if rid > self.last_settled_round.value:
            self.last_settlement_price.value = settlement
            self.last_settled_round.value = rid

        if rnd.band_stake[winning].native > UInt64(0):
            payable = self._muldiv(
                rnd.total_stake.native,
                UInt64(BPS_DENOM) - rnd.rake_bps.native,
                UInt64(BPS_DENOM),
            )
            rake = rnd.total_stake.native - payable
            rnd.payable_pot = arc4.UInt64(payable)
            rnd.remaining_payable = arc4.UInt64(payable)
            rnd.status = arc4.UInt8(STATUS_RESOLVED)
            rnd.finalized_at = arc4.UInt64(Global.latest_timestamp)
            # Rake accrues to a counter; it is NEVER transferred here. A direct transfer
            # would revert the whole call if the treasury were not opted into mUSD.
            self.rake_owed.value += rake
            self.total_obligations.value -= rake
        else:
            rnd.payable_pot = arc4.UInt64(0)
            rnd.remaining_payable = arc4.UInt64(rnd.total_stake.native)
            rnd.status = arc4.UInt8(STATUS_VOID)
            rnd.void_reason = arc4.UInt8(VOID_EMPTY_BAND)
            rnd.finalized_at = arc4.UInt64(Global.latest_timestamp)
            # No rake on a round that pays nobody.
        self.rounds[rid] = rnd.copy()
        # Resolved XOR Voided, never both: an indexer counting Resolved must not count
        # a voided round, and payable_pot == 0 is too weak a signal to distinguish them.
        if rnd.status.native == UInt64(STATUS_VOID):
            arc4.emit(Voided(
                arc4.UInt64(rid), arc4.UInt8(VOID_EMPTY_BAND),
                arc4.UInt64(rnd.total_stake.native),
            ))
        else:
            arc4.emit(Resolved(
                arc4.UInt64(rid), arc4.UInt64(settlement), clean_sources.copy(),
                arc4.UInt64(n_present), arc4.UInt8(winning),
                arc4.UInt64(rnd.payable_pot.native),
            ))

    # ────────────────────────────────────────────────────────────────────────
    #  Terminal operations
    # ────────────────────────────────────────────────────────────────────────
    #  THE total_obligations IDENTITY
    #
    #    enter              += stake
    #    resolve RESOLVED   -= total_stake - payable_pot   (the rake leaves the obligation)
    #    resolve VOID       unchanged                      (the full stake is still owed)
    #    settle_position    -= payout
    #    close_position      UNCHANGED  <-- a loser's stake was reallocated, not extinguished
    #    refund_position    -= stake
    #    cleanup_round      -= remaining_payable
    #
    #  close_position decrementing by `stake` double-counts: at resolve the losing
    #  stakes were folded into payable_pot and are still owed — to the winners. The
    #  decrements then over-run the counter by the entire losing pot. Loudly that
    #  underflows and bricks settle, close and cleanup alike; quietly, once several
    #  rounds overlap, total_obligations under-reports and sweep_excess_musd would
    #  authorise an honest admin to sweep other rounds' live escrow.

    @subroutine
    def _payee(self, pos: PositionBox, owner: Account) -> Account:
        if pos.recipient.native == Global.zero_address:
            return owner
        return pos.recipient.native

    @subroutine
    def _bounty_due(self, rnd: RoundBox, owner: Account, fee_paid: UInt64) -> UInt64:
        """Only for a third party, and only once the keeper's own window has passed.

        Clamped to what THIS position actually pre-funded, after the inner fees its
        terminal call will spend. A fixed bounty against fees that scale with
        Global.min_txn_fee would, on any rise in the network fee floor, quietly make
        every terminal operation net-negative for the app — the same zero-margin
        failure the payout fee itself was raised to avoid.
        """
        if Txn.sender == owner:
            return UInt64(0)
        if Global.latest_timestamp <= rnd.finalized_at.native + BOUNTY_DELAY:
            return UInt64(0)
        reserved = UInt64(3) * Global.min_txn_fee
        if fee_paid <= reserved:
            return UInt64(0)
        available = fee_paid - reserved
        if available < CLOSE_BOUNTY:
            return available
        return UInt64(CLOSE_BOUNTY)

    @subroutine
    def _settle_one(
        self, rid: UInt64, owner: Account, band: UInt64, expected_payee: Account
    ) -> bool:
        """Returns False (skip) rather than reverting, so batches degrade gracefully."""
        if band >= BAND_COUNT:
            return False
        key = self._position_key(rid, owner, band)
        if key not in self.positions:
            return False
        # The forfeit branch of cleanup_round deletes the round box while position
        # boxes survive. Reading it unguarded would assert instead of skipping, and a
        # retrying keeper or bounty bot would loop on a revert forever.
        if rid not in self.rounds:
            return False
        rnd = self.rounds[rid].copy()
        if rnd.status.native != UInt64(STATUS_RESOLVED):
            return False
        if band != rnd.winning_band.native:
            return False
        pos = self.positions[key].copy()
        payee = self._payee(pos.copy(), owner)
        # expected_payee is load-bearing: settle must read the payee's mUSD holding, and
        # an asset-holding read against an account absent from the resource array is a
        # HARD program failure that no skip logic can reach. Without it, a griefer calls
        # set_payout_recipient on one position moments before the keeper's batch and the
        # entire batch reverts for one transaction fee.
        if payee != expected_payee:
            return False
        _bal, opted = op.AssetHoldingGet.asset_balance(payee, self.musd_asset_id.value)
        if not opted:
            return False

        payout = self._muldiv(
            rnd.payable_pot.native, pos.stake.native, rnd.band_stake[band].native
        )
        assert payout <= rnd.remaining_payable.native, "exceeds remaining"
        rnd.remaining_payable = arc4.UInt64(rnd.remaining_payable.native - payout)
        rnd.position_count = arc4.UInt64(rnd.position_count.native - UInt64(1))
        self.rounds[rid] = rnd.copy()
        self.total_obligations.value -= payout
        self.fee_reserve.value -= pos.fee_paid.native
        self.mbr_reserve.value -= pos.mbr_paid.native

        bounty = self._bounty_due(rnd.copy(), owner, pos.fee_paid.native)
        del self.positions[key]
        self._pay_musd(payee, payout)
        self._pay_algo(payee, pos.mbr_paid.native)
        self._pay_algo(Txn.sender, bounty)
        arc4.emit(Settled(
            arc4.UInt64(rid), arc4.Address(owner), arc4.UInt8(band),
            arc4.UInt64(payout),
        ))
        return True

    @subroutine
    def _close_one(
        self, rid: UInt64, owner: Account, band: UInt64, expected_payee: Account
    ) -> bool:
        if band >= BAND_COUNT:
            return False
        key = self._position_key(rid, owner, band)
        if key not in self.positions:
            return False
        if rid not in self.rounds:
            return False
        rnd = self.rounds[rid].copy()
        if rnd.status.native != UInt64(STATUS_RESOLVED):
            return False
        if band == rnd.winning_band.native:
            return False
        pos = self.positions[key].copy()
        payee = self._payee(pos.copy(), owner)
        # expected_payee is load-bearing here too: without it an owner redirects to an
        # address the caller did not put in its resource array and the whole batch
        # hard-reverts, which no skip logic can catch.
        #
        # The receivability test is EXISTENCE, not mUSD opt-in. This path moves only
        # ALGO, so an opt-in check would be a proxy — sound in one direction (opted-in
        # implies funded) but strictly narrower than the property needed, and the gap is
        # exactly the funded, non-opted-in account. A loser who tidies their wallet by
        # opting out of mUSD after the round would otherwise never be able to close, and
        # would forfeit their box deposit to a purge bot at the forfeit period.
        if payee != expected_payee:
            return False
        _mb, exists = op.AcctParamsGet.acct_balance(payee)
        if not exists:
            # After the cleanup grace a position whose payee cannot receive would pin
            # the whole round until FORFEIT_PERIOD — 180 days of the round box's MBR
            # and this box's deposit frozen, for the price of one redirect. Past the
            # grace, escheat the deposit (it is ALGO the app already holds; deleting
            # the box releases the matching min_balance) and let the round finish.
            if Global.latest_timestamp <= rnd.resolve_time.native + CLEANUP_GRACE:
                return False
            rnd.position_count = arc4.UInt64(rnd.position_count.native - UInt64(1))
            self.rounds[rid] = rnd.copy()
            self.fee_reserve.value -= pos.fee_paid.native
            self.mbr_reserve.value -= pos.mbr_paid.native
            del self.positions[key]
            arc4.emit(Closed(arc4.UInt64(rid), arc4.Address(owner), arc4.UInt8(band)))
            return True

        rnd.position_count = arc4.UInt64(rnd.position_count.native - UInt64(1))
        self.rounds[rid] = rnd.copy()
        self.fee_reserve.value -= pos.fee_paid.native
        self.mbr_reserve.value -= pos.mbr_paid.native
        # total_obligations deliberately unchanged — see the identity above.

        bounty = self._bounty_due(rnd.copy(), owner, pos.fee_paid.native)
        del self.positions[key]
        self._pay_algo(payee, pos.mbr_paid.native)
        self._pay_algo(Txn.sender, bounty)
        arc4.emit(Closed(arc4.UInt64(rid), arc4.Address(owner), arc4.UInt8(band)))
        return True

    @subroutine
    def _refund_one(
        self, rid: UInt64, owner: Account, band: UInt64, expected_payee: Account
    ) -> bool:
        if band >= BAND_COUNT:
            return False
        key = self._position_key(rid, owner, band)
        if key not in self.positions:
            return False
        if rid not in self.rounds:
            return False
        rnd = self.rounds[rid].copy()
        if rnd.status.native != UInt64(STATUS_VOID):
            return False
        pos = self.positions[key].copy()
        payee = self._payee(pos.copy(), owner)
        if payee != expected_payee:
            return False
        _bal, opted = op.AssetHoldingGet.asset_balance(payee, self.musd_asset_id.value)
        if not opted:
            return False

        stake = pos.stake.native
        assert stake <= rnd.remaining_payable.native, "exceeds remaining"
        rnd.remaining_payable = arc4.UInt64(rnd.remaining_payable.native - stake)
        rnd.position_count = arc4.UInt64(rnd.position_count.native - UInt64(1))
        self.rounds[rid] = rnd.copy()
        self.total_obligations.value -= stake
        self.fee_reserve.value -= pos.fee_paid.native
        self.mbr_reserve.value -= pos.mbr_paid.native

        bounty = self._bounty_due(rnd.copy(), owner, pos.fee_paid.native)
        del self.positions[key]
        self._pay_musd(payee, stake)
        self._pay_algo(payee, pos.mbr_paid.native)
        self._pay_algo(Txn.sender, bounty)
        arc4.emit(Refunded(
            arc4.UInt64(rid), arc4.Address(owner), arc4.UInt8(band), arc4.UInt64(stake),
        ))
        return True

    @arc4.abimethod
    def settle_position(
        self, round_id: arc4.UInt64, owner: arc4.Address, band_index: arc4.UInt8,
        expected_payee: arc4.Address,
    ) -> None:
        assert self._settle_one(
            round_id.native, owner.native, band_index.native, expected_payee.native
        ), "settle failed"

    @arc4.abimethod
    def close_position(
        self, round_id: arc4.UInt64, owner: arc4.Address, band_index: arc4.UInt8,
        expected_payee: arc4.Address,
    ) -> None:
        assert self._close_one(
            round_id.native, owner.native, band_index.native, expected_payee.native
        ), "close failed"

    @arc4.abimethod
    def refund_position(
        self, round_id: arc4.UInt64, owner: arc4.Address, band_index: arc4.UInt8,
        expected_payee: arc4.Address,
    ) -> None:
        assert self._refund_one(
            round_id.native, owner.native, band_index.native, expected_payee.native
        ), "refund failed"

    @arc4.abimethod
    def purge_position(
        self, round_id: arc4.UInt64, owner: arc4.Address, band_index: arc4.UInt8
    ) -> None:
        """Pays the CALLER, not the owner.

        Only reachable once the round box is gone — which requires cleanup_round, i.e.
        either an empty round or the 180-day forfeit branch. By then the position is
        demonstrably abandoned, and paying the caller guarantees every box is
        unconditionally deletable. That is what makes "no stranded funds" true even when
        an owner has closed their Algorand account and can receive nothing.
        """
        rid = round_id.native
        assert rid not in self.rounds, "round still live"
        assert band_index.native < BAND_COUNT, "band"
        key = self._position_key(rid, owner.native, band_index.native)
        pos = self.positions[key].copy()
        self.fee_reserve.value -= pos.fee_paid.native
        self.mbr_reserve.value -= pos.mbr_paid.native
        del self.positions[key]
        self._pay_algo(Txn.sender, pos.mbr_paid.native)
        arc4.emit(Purged(round_id, owner, band_index))

    # ────────────────────────────────────────────────────────────────────────
    #  Batches — skip, never revert
    # ────────────────────────────────────────────────────────────────────────
    #  An all-skipped batch succeeds as a no-op. Asserting "at least one worked" would
    #  mean a batch whose entries were all already settled by bounty-collecting third
    #  parties reverts, and a keeper retry loop written the obvious way resubmits it
    #  forever. Burning a fee on an empty batch is the caller's problem; a reverting
    #  keeper path is not.
    #
    #  Group shape, measured rather than derived: a FULL batch of 8 needs FOUR
    #  top-level app calls, not three. References are pooled for USE across a group but
    #  each transaction may only DECLARE 8, of which at most 4 are accounts — and 8
    #  entries need 8 payee accounts, 9 boxes (8 positions + the round) and the asset.
    #  Three calls have the raw slots on paper and still fail in practice. Pad with
    #  `noop`; readonly methods never reach the submitted group.

    @arc4.abimethod
    def settle_batch(
        self,
        round_id: arc4.UInt64,
        owners: arc4.DynamicArray[arc4.Address],
        bands: arc4.DynamicArray[arc4.UInt8],
        payees: arc4.DynamicArray[arc4.Address],
    ) -> arc4.UInt64:
        assert owners.length <= 8, "batch cap"
        # Scaled to the batch, not a constant. A flat figure is wrong in both
        # directions: too low and a full batch dies mid-loop on "dynamic cost budget
        # exceeded" (measured: 8 settles cost well over 2,000, not the ~1,400 a static
        # reading suggests), too high and every small batch pays for opup it does not
        # need. `global OpcodeBudget` also reads what REMAINS of the pooled budget, so
        # a constant made the same three transactions pass or fail on ordering alone.
        ensure_budget(UInt64(500) + UInt64(400) * owners.length,
                      OpUpFeeSource.GroupCredit)
        assert owners.length == bands.length, "length"
        assert owners.length == payees.length, "length"
        bitmap = UInt64(0)
        for i in urange(owners.length):
            if self._settle_one(
                round_id.native, owners[i].native, bands[i].native, payees[i].native
            ):
                bitmap = bitmap | (UInt64(1) << i)
        return arc4.UInt64(bitmap)

    @arc4.abimethod
    def close_batch(
        self,
        round_id: arc4.UInt64,
        owners: arc4.DynamicArray[arc4.Address],
        bands: arc4.DynamicArray[arc4.UInt8],
        payees: arc4.DynamicArray[arc4.Address],
    ) -> arc4.UInt64:
        assert owners.length <= 8, "batch cap"
        # Scaled to the batch, not a constant. A flat figure is wrong in both
        # directions: too low and a full batch dies mid-loop on "dynamic cost budget
        # exceeded" (measured: 8 settles cost well over 2,000, not the ~1,400 a static
        # reading suggests), too high and every small batch pays for opup it does not
        # need. `global OpcodeBudget` also reads what REMAINS of the pooled budget, so
        # a constant made the same three transactions pass or fail on ordering alone.
        ensure_budget(UInt64(500) + UInt64(400) * owners.length,
                      OpUpFeeSource.GroupCredit)
        assert owners.length == bands.length, "length"
        assert owners.length == payees.length, "length"
        bitmap = UInt64(0)
        for i in urange(owners.length):
            if self._close_one(
                round_id.native, owners[i].native, bands[i].native, payees[i].native
            ):
                bitmap = bitmap | (UInt64(1) << i)
        return arc4.UInt64(bitmap)

    @arc4.abimethod
    def refund_batch(
        self,
        round_id: arc4.UInt64,
        owners: arc4.DynamicArray[arc4.Address],
        bands: arc4.DynamicArray[arc4.UInt8],
        payees: arc4.DynamicArray[arc4.Address],
    ) -> arc4.UInt64:
        assert owners.length <= 8, "batch cap"
        # Scaled to the batch, not a constant. A flat figure is wrong in both
        # directions: too low and a full batch dies mid-loop on "dynamic cost budget
        # exceeded" (measured: 8 settles cost well over 2,000, not the ~1,400 a static
        # reading suggests), too high and every small batch pays for opup it does not
        # need. `global OpcodeBudget` also reads what REMAINS of the pooled budget, so
        # a constant made the same three transactions pass or fail on ordering alone.
        ensure_budget(UInt64(500) + UInt64(400) * owners.length,
                      OpUpFeeSource.GroupCredit)
        assert owners.length == bands.length, "length"
        assert owners.length == payees.length, "length"
        bitmap = UInt64(0)
        for i in urange(owners.length):
            if self._refund_one(
                round_id.native, owners[i].native, bands[i].native, payees[i].native
            ):
                bitmap = bitmap | (UInt64(1) << i)
        return arc4.UInt64(bitmap)

    # ────────────────────────────────────────────────────────────────────────
    #  Cleanup
    # ────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def cleanup_round(self, round_id: arc4.UInt64) -> None:
        """Deletes the round box, then pays the bounty — in that order, so the released
        MBR funds the payment.

        Unclaimed value flows to rake_owed rather than into a next round's pot. Rolling
        it forward sounds fairer, but unowned money in a pot is a free claim for anyone
        covering every band, which turns a guaranteed rake-sized loss into a risk-free
        profit whenever the carry exceeds the rake rate.
        """
        rid = round_id.native
        rnd = self.rounds[rid].copy()
        st = rnd.status.native
        assert st == UInt64(STATUS_RESOLVED) or st == UInt64(STATUS_VOID), "not final"
        now = Global.latest_timestamp
        assert now > rnd.resolve_time.native + CLEANUP_GRACE, "grace"
        assert (
            rnd.position_count.native == UInt64(0)
            or now > rnd.resolve_time.native + FORFEIT_PERIOD
        ), "positions outstanding"

        residual = rnd.remaining_payable.native
        self.rake_owed.value += residual
        self.total_obligations.value -= residual
        del self.rounds[rid]
        # The last accounting fact about this round, and the only one that would
        # otherwise be deleted along with the box.
        arc4.emit(RoundCleaned(arc4.UInt64(rid), arc4.UInt64(residual)))
        self._pay_algo(Txn.sender, UInt64(CLOSE_BOUNTY))

    # ────────────────────────────────────────────────────────────────────────
    #  Readonly
    # ────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def noop(self) -> None:
        """Group padding.

        A full batch needs at least three top-level app calls — for box references,
        for the 16-inner-transaction-per-call limit, and for pooled opcode budget.
        Readonly methods cannot serve as padding: clients route them through simulate,
        so they never land in the submitted group and a keeper that pads with one ships
        a single-call group that dies partway through the batch.
        """

    @arc4.abimethod(readonly=True)
    def get_round(self, round_id: arc4.UInt64) -> RoundBox:
        return self.rounds[round_id.native]

    @arc4.abimethod(readonly=True)
    def get_position(
        self, round_id: arc4.UInt64, owner: arc4.Address, band_index: arc4.UInt8
    ) -> PositionBox:
        return self.positions[
            self._position_key(round_id.native, owner.native, band_index.native)
        ]

    @arc4.abimethod(readonly=True)
    def get_ladder(self, round_id: arc4.UInt64) -> BandStakes:
        """Live multiple per band, in bps. 0 means an empty band.

        The zero guard is mandatory, not defensive: with 9 bands an empty band is the
        normal case, and an unguarded division would panic and take the frontend's
        primary view down on most rounds.
        """
        rnd = self.rounds[round_id.native].copy()
        provisional = self._muldiv(
            rnd.total_stake.native,
            UInt64(BPS_DENOM) - rnd.rake_bps.native,
            UInt64(BPS_DENOM),
        )
        out = BandStakes.from_bytes(op.bzero(72))
        for i in urange(BAND_COUNT):
            s = rnd.band_stake[i].native
            if s > UInt64(0):
                out[i] = arc4.UInt64(
                    self._muldiv(provisional, UInt64(BPS_DENOM), s)
                )
        return out

    @arc4.abimethod(readonly=True)
    def get_solvency(self) -> arc4.Tuple[arc4.UInt64, arc4.UInt64, arc4.UInt64]:
        """(mUSD balance, total_obligations, rake_owed) — invariant 1, externally
        checkable at any time by anyone."""
        bal, _e = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.musd_asset_id.value
        )
        return arc4.Tuple(
            (
                arc4.UInt64(bal),
                arc4.UInt64(self.total_obligations.value),
                arc4.UInt64(self.rake_owed.value),
            )
        )
