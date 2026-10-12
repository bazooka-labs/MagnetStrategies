from algopy import (
    Account,
    ARC4Contract,
    Bytes,
    Global,
    GlobalState,
    StateTotals,
    Txn,
    UInt64,
    arc4,
    itxn,
    op,
    subroutine,
    urange,
)

# ── MagnetFi Relay Oracle (v5) ────────────────────────────────────────────────
#
# Full rationale: magnetfi/v2/ORACLE_V5_SPEC.md. In one paragraph:
#
# Three oracle freezes, zero key compromises. The protocol was defended heavily
# against a stolen bot key and barely at all against the feed stopping — and
# when it stops, borrowing AND all three liquidation paths revert. This oracle
# accepts a SIGNED price from ANYONE, so a liquidator can refresh the price
# inside their own transaction group and the freshness window can never block
# them. The vault is unchanged: it reads lp_price_<pool> and lp_ts_<pool> by
# global-state key (vault/contract.py:207-219) and its oracle reference is
# swappable behind a 48h timelock with a guardian veto.
#
# ── Every price gate is gone, deliberately (SPEC §2.6) ───────────────────────
#
# No anchor. No anchor band. No deviation-vs-prior guard. No absolute bounds.
# A price ten times the last one posts successfully, by design — the operator
# accepted key-compromise risk in exchange for never again being unable to
# liquidate during a move. The defences that remain live OFF chain in the
# signer, because they catch BUGS rather than key theft: TWAP smoothing, a
# multi-route cross-check, and one wide scaling-slip band three orders of
# magnitude clear of any real price.
#
# What is asserted here is only what makes a signature mean something.

_PRICE_PREFIX: bytes = b"lp_price_"
_TS_PREFIX: bytes = b"lp_ts_"
_ACTIVE_PREFIX: bytes = b"lp_active_"

# Payload layout — 85 bytes, big-endian. MUST match magnetfi/v2/signer/payload.py
# byte for byte; SIGNED_PAYLOAD.md is the shared contract.
#
#   0   4   magic "MFLP"      37  8  target_app     69  8  issued_at
#   4   1   version           45  8  lp_asa_id      77  8  max_age
#   5   32  genesis hash      53  8  price_min
#                             61  8  price_max
MSG_LEN = 85
SIG_LEN = 64
_MAGIC_VERSION: bytes = b"MFLP\x01"
_OFF_TARGET_APP = 37
_OFF_LP_ASA = 45
_OFF_PRICE_MIN = 53
_OFF_PRICE_MAX = 61
_OFF_ISSUED_AT = 69
_OFF_MAX_AGE = 77

# A payload is public the moment it is used, so anyone can keep one from a price
# spike and replay it later — arithmetic on public data, not a compromise. This
# is the only thing stopping that. Matches PEX's live max_age_seconds of 30.
PAYLOAD_MAX_AGE = 30

# Global.latest_timestamp is the PREVIOUS block's time, measured ~5s behind the
# wall clock, so this check is already stricter than it reads. Zero matches PEX's
# max_future_skew_seconds. NOTE the age check below is written as an ADDITION
# for this reason: a subtraction underflows the moment this becomes non-zero.
CLOCK_SKEW = 0

# 48h, matching the vault's own timelock on repointing its oracle.
TIMELOCK_DELAY = 172_800

# ed25519verify_bare costs exactly 1900 units (measured); an app call affords
# 700 and budget pools across the group. Three inner calls add ~682 each, which
# with this call's own 700 and the consumer's 700 leaves ~1450 spare for the
# vault's work in the same group — measured at ~3x what it needs.
OPUP_CALLS = 3


class RelayOracle(
    ARC4Contract,
    # 57 + 7 = 64, exactly the measured AVM cap, declared at the ceiling on
    # purpose: the schema is frozen at creation and under-declaring would cost a
    # redeploy PLUS another 48h repoint — the very cost this design avoids.
    # 3 uints per pool x 18 pools + pending_signer_eta + opup_app_id = 56.
    state_totals=StateTotals(global_uints=57, global_bytes=7),
):
    """
    Prices Tinyman LP tokens in mUSD (x 10^6), from signed payloads relayed by
    anyone. Drop-in for the posted-price oracle: same lp_price_ / lp_ts_ keys.
    """

    def __init__(self) -> None:
        # The pinned ed25519 public key. Rotatable only through the timelock.
        self.signer_pubkey = GlobalState(Bytes)
        self.pending_signer = GlobalState(Bytes)
        self.pending_signer_eta = GlobalState(UInt64)

        # Immutable after deploy — see deploy().
        self.opup_app_id = GlobalState(UInt64)

        self.admin = GlobalState(Account)
        self.guardian = GlobalState(Account)
        self.pending_admin = GlobalState(Account)
        self.pending_guardian = GlobalState(Account)

    # ── deployment ────────────────────────────────────────────────────────────

    @arc4.abimethod(allow_actions=["NoOp"], create="require")
    def deploy(self, guardian: Account, signer_pubkey: Bytes, opup_app_id: UInt64) -> None:
        """
        Create. Caller becomes admin; guardian is a separate cold key.

        `opup_app_id` is set once and has NO setter. It is a liveness dependency
        of every price post, so a mutable pointer would let a compromised admin
        aim it at an app that fails or does not exist and brick posting. The
        OpUp app is itself non-deletable, so a fixed pointer cannot rot.
        """
        assert guardian != Global.zero_address, "guardian required"
        assert guardian != Txn.sender, "guardian must differ from admin"
        assert signer_pubkey.length == 32, "signer pubkey must be 32 bytes"
        assert opup_app_id != UInt64(0), "opup app id required"
        self.admin.value = Txn.sender
        self.guardian.value = guardian
        self.signer_pubkey.value = signer_pubkey
        self.opup_app_id.value = opup_app_id
        self.pending_signer.value = Bytes(b"")
        self.pending_signer_eta.value = UInt64(0)
        self.pending_admin.value = Global.zero_address
        self.pending_guardian.value = Global.zero_address

    # ── internal helpers ──────────────────────────────────────────────────────

    @subroutine
    def _assert_admin(self) -> None:
        assert Txn.sender == self.admin.value, "admin only"

    @subroutine
    def _assert_guardian(self) -> None:
        assert Txn.sender == self.guardian.value, "guardian only"

    @subroutine
    def _assert_admin_or_guardian(self) -> None:
        assert (
            Txn.sender == self.admin.value or Txn.sender == self.guardian.value
        ), "admin or guardian only"

    @subroutine
    def _price_key(self, pool_id: UInt64) -> Bytes:
        return Bytes(_PRICE_PREFIX) + op.itob(pool_id)

    @subroutine
    def _ts_key(self, pool_id: UInt64) -> Bytes:
        return Bytes(_TS_PREFIX) + op.itob(pool_id)

    @subroutine
    def _active_key(self, pool_id: UInt64) -> Bytes:
        return Bytes(_ACTIVE_PREFIX) + op.itob(pool_id)

    @subroutine
    def _assert_registered(self, pool_id: UInt64) -> None:
        active, exists = op.AppGlobal.get_ex_uint64(
            Global.current_application_id, self._active_key(pool_id)
        )
        assert exists and active != UInt64(0), "pool not in whitelist"

    # ── the price path ────────────────────────────────────────────────────────

    @arc4.abimethod
    def post_signed_price(self, message: Bytes, signature: Bytes) -> None:
        """
        Publish a signed price. **Callable by anyone** — there is no sender check.

        That is the point of the whole design. A liquidator submits
        [post_signed_price, trigger_*_liquidation] atomically, lp_ts_ is written
        in the same block the vault reads it, and the price is zero seconds old
        — so the vault's 1800s freshness window can never be the reason a
        liquidation fails.

        Anyone posting costs them ~0.004 ALGO and overwrites existing keys. No
        unprivileged action creates state (add_pool is admin-only), so there is
        no MBR growth and no denial surface: a spammer pays to keep us fresh.

        Checks run CHEAPEST FIRST. The bindings cost 49 opcode units together
        against 1900 for the signature (both measured), so a payload aimed
        somewhere else fails for 49 and reports why, instead of exhausting the
        budget and reporting that.
        """
        # 1. shape
        assert message.length == UInt64(MSG_LEN), "bad message length"
        assert signature.length == UInt64(SIG_LEN), "bad signature length"

        # 2. magic + version + network, in one slice. Genesis comes from the
        #    CHAIN rather than a constant or a deploy parameter, so a payload
        #    for another network cannot verify here and the binding cannot be
        #    misconfigured.
        assert (
            op.extract(message, 0, 37) == Bytes(_MAGIC_VERSION) + Global.genesis_hash
        ), "bad magic, version or network"

        # 3. bound to THIS app — a payload for another deployment is not ours
        assert (
            op.extract_uint64(message, _OFF_TARGET_APP) == Global.current_application_id.id
        ), "payload targets another app"

        # 4. pool must be whitelisted
        pool_id = op.extract_uint64(message, _OFF_LP_ASA)
        self._assert_registered(pool_id)

        # 5. a zero permanently bricks a pool (AUD-042); an inverted band is
        #    nonsense. The signer refuses to sign either, but the contract must
        #    not depend on the signer being correct.
        price_min = op.extract_uint64(message, _OFF_PRICE_MIN)
        price_max = op.extract_uint64(message, _OFF_PRICE_MAX)
        assert price_min > UInt64(0), "price must be > 0"
        assert price_max >= price_min, "inverted price band"

        # 6. not from the future
        issued_at = op.extract_uint64(message, _OFF_ISSUED_AT)
        assert issued_at <= Global.latest_timestamp + UInt64(CLOCK_SKEW), "payload from the future"

        # 7. not stale. The signer may ask for a SHORTER life than the ceiling,
        #    never a longer one — so a compromised key cannot extend its own
        #    payloads. Written as an addition: the subtraction form underflows
        #    if CLOCK_SKEW ever becomes non-zero, since step 6 then admits
        #    issued_at > latest_timestamp.
        max_age = op.extract_uint64(message, _OFF_MAX_AGE)
        effective = max_age
        if effective > UInt64(PAYLOAD_MAX_AGE):
            effective = UInt64(PAYLOAD_MAX_AGE)
        assert issued_at + effective >= Global.latest_timestamp, "payload expired"

        # 8. buy the budget, then verify. 1900 units against the 700 this call
        #    carries. Inner calls are fee=0 and the CALLER covers them by
        #    pooling; the app account must never pay, or spamming drains it.
        for _i in urange(OPUP_CALLS):
            itxn.ApplicationCall(app_id=self.opup_app_id.value, fee=0).submit()

        assert op.ed25519verify_bare(
            message, signature, self.signer_pubkey.value
        ), "bad signature"

        # lp_ts_ carries the payload's OWN timestamp, not the block's. Writing
        # the block time would report every post as zero seconds old, including
        # a replayed 30s-old payload, making the age signal meaningless exactly
        # when it matters. Step 7 bounds it to ~35s of now, far inside the
        # vault's 1800s window, so liveness is unaffected.
        op.AppGlobal.put(self._price_key(pool_id), price_min)
        op.AppGlobal.put(self._ts_key(pool_id), issued_at)

    # ── admin: pools ──────────────────────────────────────────────────────────

    @arc4.abimethod
    def add_pool(self, pool_id: UInt64, initial_price: UInt64) -> None:
        """
        Register a pool and seed a price, so the vault's `price > 0` assert is
        never hit in the gap before the first relayed post.
        """
        self._assert_admin()
        active, exists = op.AppGlobal.get_ex_uint64(
            Global.current_application_id, self._active_key(pool_id)
        )
        assert not (exists and active != UInt64(0)), "pool already registered"
        assert initial_price > UInt64(0), "initial price must be > 0"
        op.AppGlobal.put(self._active_key(pool_id), UInt64(1))
        op.AppGlobal.put(self._price_key(pool_id), initial_price)
        op.AppGlobal.put(self._ts_key(pool_id), Global.latest_timestamp)

    @arc4.abimethod
    def remove_pool(self, pool_id: UInt64) -> None:
        """
        Delist a pool and delete its state.

        WARNING: removing a pool with active vaults borrowing against it makes
        their price stale and blocks health-factor liquidations (AUD-046).
        """
        self._assert_admin()
        op.AppGlobal.delete(self._active_key(pool_id))
        op.AppGlobal.delete(self._price_key(pool_id))
        op.AppGlobal.delete(self._ts_key(pool_id))

    @arc4.abimethod
    def admin_set_price(self, pool_id: UInt64, price: UInt64) -> None:
        """
        BREAK-GLASS. Write a price the signer did not produce. Every use should
        be explained.

        It exists because under this design staleness self-heals — anyone can
        post — so the failure that would otherwise force a retreat is a POSTING
        bug: a wrong pinned key, a wrong target_app, a payload nobody can make
        valid. Then nobody can post at all, and repointing the vault back takes
        48 hours during which borrowing and liquidation are both dead. That is
        worse than any freeze this design removes.

        It grants the admin nothing new: `remove_pool` followed by `add_pool`
        has always been an arbitrary admin price write, in two transactions.
        Naming it makes the capability auditable instead of leaving it an
        undocumented workaround that looks like routine pool maintenance.
        """
        self._assert_admin()
        assert price > UInt64(0), "price must be > 0"
        self._assert_registered(pool_id)
        op.AppGlobal.put(self._price_key(pool_id), price)
        op.AppGlobal.put(self._ts_key(pool_id), Global.latest_timestamp)

    # ── admin: signer rotation ────────────────────────────────────────────────

    @arc4.abimethod
    def propose_signer(self, new_pubkey: Bytes) -> None:
        """
        Queue a signer-key rotation. Timelocked for the same reason the vault
        timelocks its oracle repoint: an instantly-settable signer key would be
        a one-transaction takeover for a compromised admin.
        """
        self._assert_admin()
        assert new_pubkey.length == 32, "signer pubkey must be 32 bytes"
        self.pending_signer.value = new_pubkey
        self.pending_signer_eta.value = Global.latest_timestamp + UInt64(TIMELOCK_DELAY)

    @arc4.abimethod
    def confirm_signer(self) -> None:
        """Apply a queued rotation once the timelock has elapsed."""
        self._assert_admin()
        assert self.pending_signer.value.length == 32, "no pending signer"
        assert Global.latest_timestamp >= self.pending_signer_eta.value, "timelock not elapsed"
        self.signer_pubkey.value = self.pending_signer.value
        self.pending_signer.value = Bytes(b"")
        self.pending_signer_eta.value = UInt64(0)

    @arc4.abimethod
    def cancel_pending_signer(self) -> None:
        """Cancel a queued rotation. Admin or guardian — the guardian veto."""
        self._assert_admin_or_guardian()
        self.pending_signer.value = Bytes(b"")
        self.pending_signer_eta.value = UInt64(0)

    # ── admin / guardian rotation ─────────────────────────────────────────────

    @arc4.abimethod
    def propose_admin(self, new_admin: Account) -> None:
        """Start 2-step admin rotation. Admin OR guardian (guardian = recovery)."""
        self._assert_admin_or_guardian()
        assert new_admin != Global.zero_address, "zero address not allowed"
        assert new_admin != self.guardian.value, "admin must differ from guardian"
        self.pending_admin.value = new_admin

    @arc4.abimethod
    def accept_admin(self) -> None:
        """Complete admin rotation — only the proposed account may accept."""
        assert self.pending_admin.value != Global.zero_address, "no pending admin"
        assert Txn.sender == self.pending_admin.value, "not pending admin"
        self.admin.value = self.pending_admin.value
        self.pending_admin.value = Global.zero_address
        # Clear any queued signer rotation, so one proposed by the prior admin
        # cannot be confirmed by a successor unaware of its provenance (P21-04).
        self.pending_signer.value = Bytes(b"")
        self.pending_signer_eta.value = UInt64(0)

    @arc4.abimethod
    def propose_guardian(self, new_guardian: Account) -> None:
        """Start 2-step guardian rotation. Guardian only."""
        self._assert_guardian()
        assert new_guardian != Global.zero_address, "zero address not allowed"
        assert new_guardian != self.admin.value, "guardian must differ from admin"
        self.pending_guardian.value = new_guardian

    @arc4.abimethod
    def accept_guardian(self) -> None:
        """Complete guardian rotation — only the proposed account may accept."""
        assert self.pending_guardian.value != Global.zero_address, "no pending guardian"
        assert Txn.sender == self.pending_guardian.value, "not pending guardian"
        self.guardian.value = self.pending_guardian.value
        self.pending_guardian.value = Global.zero_address

    # ── read-only ─────────────────────────────────────────────────────────────

    @arc4.abimethod(readonly=True)
    def get_lp_price(self, pool_id: UInt64) -> arc4.Tuple[arc4.UInt64, arc4.UInt64]:
        """
        (price_scaled, issued_at) for pool_id, or (0, 0) if unregistered.

        The vault does not use this — it reads lp_price_<pool_id> straight out
        of global state by cross-app reference, which is what makes this a
        drop-in replacement for the posted-price oracle.
        """
        price = op.AppGlobal.get_uint64(self._price_key(pool_id))
        ts = op.AppGlobal.get_uint64(self._ts_key(pool_id))
        return arc4.Tuple((arc4.UInt64(price), arc4.UInt64(ts)))
