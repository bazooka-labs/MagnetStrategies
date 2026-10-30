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
    op,
    subroutine,
)

# Dynamic global-state key prefixes for per-pool data.
# Key layout: prefix (9-11 bytes) + pool_id (8 bytes big-endian uint64) → ≤19 bytes per key.
_PRICE_PREFIX: bytes = b"lp_price_"
_TS_PREFIX: bytes = b"lp_ts_"
_ACTIVE_PREFIX: bytes = b"lp_active_"

# ── What this is, and what it deliberately is not ────────────────────────────
#
# The posted-price oracle exactly as it has run since launch, with every PRICE
# GATE removed. Spec: magnetfi/v2/ORACLE_LEAN_SPEC.md.
#
# Gone: the admin-set anchor, the ±25% band around it, and the ±50%-vs-prior
# deviation guard. All three existed to bound a COMPROMISED BOT KEY, and that
# risk is accepted at this scale.
#
# "This scale" is a NUMBER, not a feeling: AUDIT.md:1077 puts the reviewed
# safe envelope at < ~$100k collateral-pool TVL. Measured 2026-10-30 the vault
# held $2,534 of LP at the oracle's own posted prices — 2.5% of it, 39x of
# headroom. Crossing that envelope is the trigger to restore a bound here (a
# wide one: the 2026-08-21 freeze was a ±25% band rejecting a valid post, and
# a limit set to catch decimals slips and bad routes would not have fired on
# it). The check belongs in OPERATIONS.md; this comment exists so the decision
# and the number it rests on cannot drift apart unnoticed. Their cost was not: on 2026-08-21 the band
# rejected a perfectly valid post and froze the feed while the bot ran happily,
# logging no error (ADMIN.md:151, pc=512). Of three oracle freezes, that one was
# the contract's doing and it is the only structural cause left.
#
# So update_lp_price now asserts three things and nothing else: the sender is
# the authorized updater, the price is non-zero, and the pool is whitelisted.
#
# A price ten times the previous one posts. That is the point, not an oversight.
#
# What still guards the number lives OFF chain in the bot, because it catches
# BUGS rather than key theft — TWAP smoothing, multi-route cross-checks, a
# second opinion from CompX, and a pool-composition sanity warning. A bug runs
# our code; only a stolen key bypasses them, and that is the accepted risk.
#
# Declared capacity: 3 uint64 slots (price/ts/active) × 19 pools = 57 uints;
# 7 byte slots (authorized_updater + admin + guardian + 2 pending + headroom).
# Declared near the 64-entry AVM ceiling ON PURPOSE: the schema is frozen at
# creation, so under-declaring costs a redeploy PLUS another 48h vault repoint.
# The one remedy this design defers to — an upward rate limit, if the operator
# ever stops being the only borrower — needs no new state, since the prior price
# and timestamp are already here.


class LeanOracle(
    ARC4Contract,
    state_totals=StateTotals(global_uints=57, global_bytes=7),
):
    """
    MagnetFi Lean Oracle — prices Tinyman LP tokens in mUSD (≈ USDC), scaled × 10^6.

    The oracle bot posts TWAP-smoothed prices. There are NO on-chain price
    guards; see the module docstring for why.

    Two-role trust model:
      admin    — hot key: set_authorized_updater, add_pool, remove_pool.
      guardian — cold key: admin recovery (propose_admin), guardian rotation.
    Bot-only:   update_lp_price.
    Read-only:  get_lp_price (vaults also read global state directly via cross-app state ref).
    """

    def __init__(self) -> None:
        # 32-byte address of the oracle bot wallet. Unset until set_authorized_updater().
        self.authorized_updater = GlobalState(Account)

        # Two-role admin model.
        self.admin = GlobalState(Account)
        self.guardian = GlobalState(Account)
        self.pending_admin = GlobalState(Account)
        self.pending_guardian = GlobalState(Account)

    # ── deployment ────────────────────────────────────────────────────────────

    @arc4.abimethod(allow_actions=["NoOp"], create="require")
    def deploy(self, guardian: Account) -> None:
        """Create the oracle. Caller becomes admin; guardian is a separate cold key."""
        assert guardian != Global.zero_address, "guardian required"
        assert guardian != Txn.sender, "guardian must differ from admin"
        self.admin.value = Txn.sender
        self.guardian.value = guardian
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
    def _wide_ratio(self, a: UInt64, b: UInt64, c: UInt64) -> UInt64:
        """floor(a * b / c) via AVM wide arithmetic — prevents uint64 overflow."""
        high, low = op.mulw(a, b)
        return op.divw(high, low, c)

    # ── role management ───────────────────────────────────────────────────────

    @arc4.abimethod
    def propose_admin(self, new_admin: Account) -> None:
        """Start 2-step admin rotation. Admin OR guardian (guardian path = recovery)."""
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

    # ── oracle bot method ─────────────────────────────────────────────────────

    @arc4.abimethod
    def update_lp_price(self, pool_id: UInt64, new_price: UInt64) -> None:
        """
        Post a new LP token price for pool_id.

        Called by the authorized oracle bot with a TWAP-smoothed price.

        Three assertions, deliberately:
          1. Caller must be authorized_updater.
          2. new_price > 0 — a zero permanently bricks the pool (AUD-042), and
             that is a bug-class failure rather than a key-compromise one.
          3. Pool must be in the active whitelist.

        No deviation guard and no anchor band. A price ten times the prior one
        is accepted. See the module docstring.
        """
        assert Txn.sender == self.authorized_updater.value, "not authorized updater"
        assert new_price > UInt64(0), "price must be > 0"

        active_val, active_exists = op.AppGlobal.get_ex_uint64(
            Global.current_application_id, self._active_key(pool_id)
        )
        assert active_exists and active_val != UInt64(0), "pool not in whitelist"

        price_key = self._price_key(pool_id)

        op.AppGlobal.put(price_key, new_price)
        op.AppGlobal.put(self._ts_key(pool_id), Global.latest_timestamp)

    # ── admin methods ─────────────────────────────────────────────────────────

    @arc4.abimethod
    def set_authorized_updater(self, new_address: Account) -> None:
        """
        Set the oracle bot wallet address.

        Must be called before any price can be posted. Immediate (not timelocked) so a
        compromised bot key can be rotated fast.

        NOTE: in the banded LPOracle this docstring went on to say the blast radius was
        "already bounded by the ±50% and ±25% guards". That is exactly what this contract
        removes, so rotation speed is no longer a second line of defence behind a bound —
        it is the ONLY one. Immediacy is therefore load-bearing here in a way it was not
        before. See ORACLE_LEAN_SPEC.md §5 and the key-compromise tripwire in STATUS.md.

        Zero address is rejected (AUD-044).
        """
        self._assert_admin()
        assert new_address != Global.zero_address, "zero address not allowed"
        self.authorized_updater.value = new_address

    @arc4.abimethod
    def add_pool(self, pool_id: UInt64, initial_price: UInt64) -> None:
        """
        Register a new LP pool and seed its first price.

        The seed exists so the vault's `assert price > 0` is never hit in the gap
        before the bot's first post. It is NOT an anchor and nothing is measured
        against it.

        Note what this gives up: in the banded oracle the seed doubled as the
        anchor, which closed a first-post manipulation window (AUD-003/AUD-043).
        That window reopens here. It is bounded by the same thing as everything
        else in this design — the bot key is trusted, and the operator is
        currently the only borrower.
        """
        self._assert_admin()

        active_val, already_exists = op.AppGlobal.get_ex_uint64(
            Global.current_application_id, self._active_key(pool_id)
        )
        assert not (already_exists and active_val != UInt64(0)), "pool already registered"
        assert initial_price > UInt64(0), "initial price must be > 0"

        op.AppGlobal.put(self._active_key(pool_id), UInt64(1))
        op.AppGlobal.put(self._price_key(pool_id), initial_price)
        op.AppGlobal.put(self._ts_key(pool_id), Global.latest_timestamp)

    @arc4.abimethod
    def remove_pool(self, pool_id: UInt64) -> None:
        """
        Remove a pool from the active whitelist and delete its price/timestamp state.

        WARNING: removing a pool while active vaults are borrowing against it will make
        oracle prices stale for those vaults and block health-factor liquidations.
        Verify no active vaults exist for pool_id before calling (AUD-046).
        """
        self._assert_admin()
        op.AppGlobal.delete(self._active_key(pool_id))
        op.AppGlobal.delete(self._price_key(pool_id))
        op.AppGlobal.delete(self._ts_key(pool_id))

    # ── read-only ─────────────────────────────────────────────────────────────

    @arc4.abimethod(readonly=True)
    def get_lp_price(self, pool_id: UInt64) -> arc4.Tuple[arc4.UInt64, arc4.UInt64]:
        """
        Return (price_scaled, last_updated_timestamp) for pool_id.

        price_scaled is mUSD per LP token × 10^6 (e.g. 1_000_000 = 1.00 mUSD/LP).
        Returns (0, 0) if pool is not registered.

        Vaults can also read lp_price_<pool_id> directly via cross-app global state reference
        without calling this method — saving the inner-transaction overhead.
        """
        price = op.AppGlobal.get_uint64(self._price_key(pool_id))
        ts = op.AppGlobal.get_uint64(self._ts_key(pool_id))
        return arc4.Tuple((arc4.UInt64(price), arc4.UInt64(ts)))
