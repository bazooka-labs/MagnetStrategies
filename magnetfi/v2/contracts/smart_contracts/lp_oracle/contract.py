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
_ANCHOR_PREFIX: bytes = b"lp_anchor_"

# Anchor deviation band: a posted price may not stray more than ±25% from the
# admin-set anchor (P19-03). The per-update ±50% guard only bounds movement vs.
# the *prior* post, which a compromised bot could ratchet arbitrarily over many
# updates; the anchor caps total drift until the admin re-anchors.
ANCHOR_BAND_LOW = 75    # new_price ≥ anchor × 75/100
ANCHOR_BAND_HIGH = 125  # new_price ≤ anchor × 125/100

# Declared capacity: 4 uint64 slots (price/ts/active/anchor) × 10 pools = 40 uints;
# 6 bytes slots (authorized_updater + admin + guardian + 2 pending + headroom).


class LPOracle(
    ARC4Contract,
    state_totals=StateTotals(global_uints=40, global_bytes=6),
):
    """
    MagnetFi v2 LP Oracle — prices Tinyman LP tokens in mUSD (≈ USDC), scaled × 10^6.

    The oracle bot posts TWAP-smoothed prices; two on-chain guards bound a compromised
    bot key: ±50% vs. the prior post, and ±25% vs. the admin-set anchor.

    Two-role trust model:
      admin    — hot key: set_authorized_updater, add_pool, remove_pool, set_price_anchor.
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
    def _anchor_key(self, pool_id: UInt64) -> Bytes:
        return Bytes(_ANCHOR_PREFIX) + op.itob(pool_id)

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

        Called by the authorized oracle bot every ~5 minutes with a TWAP-smoothed price.
        On-chain guards:
          1. Caller must be authorized_updater.
          2. new_price > 0 (zero permanently bricks the pool — AUD-042).
          3. Pool must be in the active whitelist.
          4. Deviation guard: reject if >50% drop or >50% spike vs prior price.
          5. Anchor band: reject if outside ±25% of the admin-set anchor (P19-03).
        """
        assert Txn.sender == self.authorized_updater.value, "not authorized updater"
        assert new_price > UInt64(0), "price must be > 0"

        active_val, active_exists = op.AppGlobal.get_ex_uint64(
            Global.current_application_id, self._active_key(pool_id)
        )
        assert active_exists and active_val != UInt64(0), "pool not in whitelist"

        price_key = self._price_key(pool_id)
        prior = op.AppGlobal.get_uint64(price_key)

        # Deviation guard vs prior — only when a prior price exists.
        if prior != UInt64(0):
            # Lower: new_price >= prior * 50/100  →  floor(new_price*100/50) >= prior
            assert self._wide_ratio(new_price, UInt64(100), UInt64(50)) >= prior, "price drop >50%"
            # Upper: new_price <= prior * 150/100  →  floor(new_price*100/150) <= prior
            assert self._wide_ratio(new_price, UInt64(100), UInt64(150)) <= prior, "price spike >50%"

        # Anchor band vs admin anchor — bounds cumulative drift (P19-03).
        anchor = op.AppGlobal.get_uint64(self._anchor_key(pool_id))
        if anchor != UInt64(0):
            # Lower: new_price >= anchor * 75/100  →  floor(new_price*100/75) >= anchor
            assert self._wide_ratio(new_price, UInt64(100), UInt64(ANCHOR_BAND_LOW)) >= anchor, "below anchor band"
            # Upper: new_price <= anchor * 125/100 →  floor(new_price*100/125) <= anchor
            assert self._wide_ratio(new_price, UInt64(100), UInt64(ANCHOR_BAND_HIGH)) <= anchor, "above anchor band"

        op.AppGlobal.put(price_key, new_price)
        op.AppGlobal.put(self._ts_key(pool_id), Global.latest_timestamp)

    # ── admin methods ─────────────────────────────────────────────────────────

    @arc4.abimethod
    def set_authorized_updater(self, new_address: Account) -> None:
        """
        Set the oracle bot wallet address.

        Must be called before any price can be posted. Immediate (not timelocked) so a
        compromised bot key can be rotated fast — its blast radius is already bounded by
        the ±50% and ±25% guards. Zero address is rejected (AUD-044).
        """
        self._assert_admin()
        assert new_address != Global.zero_address, "zero address not allowed"
        self.authorized_updater.value = new_address

    @arc4.abimethod
    def add_pool(self, pool_id: UInt64, initial_price: UInt64) -> None:
        """
        Register a new LP pool and anchor its first price.

        initial_price is set by the admin under the hardware wallet — stored as both the
        live price and the anchor, so both deviation guards are active from the first bot
        update, closing the first-post manipulation window (AUD-003 / AUD-043).
        """
        self._assert_admin()

        active_val, already_exists = op.AppGlobal.get_ex_uint64(
            Global.current_application_id, self._active_key(pool_id)
        )
        assert not (already_exists and active_val != UInt64(0)), "pool already registered"
        assert initial_price > UInt64(0), "initial price must be > 0"

        op.AppGlobal.put(self._active_key(pool_id), UInt64(1))
        op.AppGlobal.put(self._price_key(pool_id), initial_price)
        op.AppGlobal.put(self._anchor_key(pool_id), initial_price)
        op.AppGlobal.put(self._ts_key(pool_id), Global.latest_timestamp)

    @arc4.abimethod
    def set_price_anchor(self, pool_id: UInt64, anchor_price: UInt64) -> None:
        """
        Re-anchor a pool's reference price. The admin calls this to follow genuine large
        moves (beyond ±25%) under the hardware wallet. The anchor is the cumulative-drift
        backstop, so this is the deliberate, manual step a compromised bot cannot perform.
        """
        self._assert_admin()
        assert anchor_price > UInt64(0), "anchor must be > 0"
        active_val, exists = op.AppGlobal.get_ex_uint64(
            Global.current_application_id, self._active_key(pool_id)
        )
        assert exists and active_val != UInt64(0), "pool not registered"
        op.AppGlobal.put(self._anchor_key(pool_id), anchor_price)

    @arc4.abimethod
    def remove_pool(self, pool_id: UInt64) -> None:
        """
        Remove a pool from the active whitelist and delete its price/timestamp/anchor state.

        WARNING: removing a pool while active vaults are borrowing against it will make
        oracle prices stale for those vaults and block health-factor liquidations.
        Verify no active vaults exist for pool_id before calling (AUD-046).
        """
        self._assert_admin()
        op.AppGlobal.delete(self._active_key(pool_id))
        op.AppGlobal.delete(self._price_key(pool_id))
        op.AppGlobal.delete(self._ts_key(pool_id))
        op.AppGlobal.delete(self._anchor_key(pool_id))

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
