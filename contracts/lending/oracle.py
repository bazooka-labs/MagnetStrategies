from algopy import (
    ARC4Contract,
    GlobalState,
    UInt64,
    Account,
    Txn,
    Global,
    arc4,
)


class OracleContract(ARC4Contract):
    """
    Magnet Lending price oracle — $U/USDC.

    Stores a single uint64 price (6 decimal places: 1.50 USDC = 1_500_000).
    Updated by an authorized bot wallet subject to an on-chain 50% deviation guard.
    Pool contracts read u_price and last_updated directly via cross-app state reference.
    """

    def __init__(self) -> None:
        self.u_price = GlobalState(UInt64, key="u_price")
        self.last_updated = GlobalState(UInt64, key="last_updated")
        self.authorized_updater = GlobalState(Account, key="authorized_updater")

    # ── Deployment ────────────────────────────────────────────────────────────

    @arc4.baremethod(create="require")
    def create(self) -> None:
        self.u_price.value = UInt64(0)
        self.last_updated.value = UInt64(0)
        self.authorized_updater.value = Txn.sender

    # ── Price update ──────────────────────────────────────────────────────────

    @arc4.abimethod
    def update_price(self, new_price: UInt64) -> None:
        """
        Post a new $U/USDC price. Callable by authorized_updater only.

        On-chain deviation guard: rejects any update that moves the price more
        than 50% in either direction from the last posted value. Skipped on the
        very first post (current_price == 0) — no prior value to compare against.
        """
        assert Txn.sender == self.authorized_updater.value, "not authorized updater"
        assert new_price > UInt64(0), "price must be positive"

        current = self.u_price.value
        if current != UInt64(0):
            # Divide-then-compare to avoid overflow on the multiply
            assert new_price >= current * UInt64(50) // UInt64(100), "price drop exceeds 50%"
            assert new_price <= current * UInt64(150) // UInt64(100), "price spike exceeds 50%"

        self.u_price.value = new_price
        self.last_updated.value = Global.latest_timestamp

    # ── Read ──────────────────────────────────────────────────────────────────

    @arc4.abimethod(readonly=True)
    def get_price(self) -> UInt64:
        """Returns current stored price. Pool contracts read global state directly."""
        return self.u_price.value

    @arc4.abimethod(readonly=True)
    def get_last_updated(self) -> UInt64:
        """Returns timestamp of last successful update."""
        return self.last_updated.value

    # ── Admin ─────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def set_authorized_updater(self, new_updater: Account) -> None:
        """Reassign the oracle bot wallet. Admin (contract creator) only."""
        assert Txn.sender == Global.creator_address, "not admin"
        self.authorized_updater.value = new_updater
