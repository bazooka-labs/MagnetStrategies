from algopy import (
    ARC4Contract,
    Global,
    GlobalState,
    Txn,
    UInt64,
    arc4,
    itxn,
    op,
    subroutine,
)


class MockPsm(ARC4Contract):
    """
    Minimal PSM stand-in for the FolksAdapter TESTNET integration test only.

    The adapter gates pool_deposit/pool_withdraw on `Txn.sender == psm app address`, so a real
    app must drive them. This app holds the test USDC, forwards it to the adapter and triggers a
    deposit, and receives USDC back on withdraw (the adapter routes withdrawals to its psm).

    NOT a production contract — the real caller is PSMv3.
    """

    def __init__(self) -> None:
        self.admin = GlobalState(arc4.Address)

    @arc4.abimethod(allow_actions=["NoOp"], create="require")
    def create(self) -> None:
        self.admin.value = arc4.Address(Txn.sender)

    @subroutine
    def _assert_admin(self) -> None:
        assert Txn.sender == self.admin.value.native, "admin only"

    @arc4.abimethod
    def opt_in_asset(self, asa_id: UInt64) -> None:
        self._assert_admin()
        assert asa_id != UInt64(0), "invalid ASA"
        itxn.AssetTransfer(
            xfer_asset=asa_id,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0,
        ).submit()

    @arc4.abimethod
    def fund_and_deposit(self, adapter_app_id: UInt64, usdc_asa_id: UInt64, amount: UInt64) -> None:
        """Send `amount` USDC (this app holds it) to the adapter, then trigger its deposit."""
        self._assert_admin()
        adapter_addr, exists = op.AppParamsGet.app_address(adapter_app_id)
        assert exists, "adapter app not found"
        itxn.AssetTransfer(
            xfer_asset=usdc_asa_id,
            asset_receiver=adapter_addr,
            asset_amount=amount,
            fee=0,
        ).submit()
        arc4.abi_call("pool_deposit(uint64)void", amount, app_id=adapter_app_id, fee=0)

    @arc4.abimethod
    def noop(self) -> None:
        """Filler app call — adds foreign-reference capacity to a group for resource-heavy
        Folks operations (each app call carries up to 8 refs)."""

    @arc4.abimethod
    def do_withdraw(self, adapter_app_id: UInt64, amount: UInt64) -> arc4.UInt64:
        self._assert_admin()
        result, _txn = arc4.abi_call[arc4.UInt64](
            "pool_withdraw(uint64)uint64", amount, app_id=adapter_app_id, fee=0
        )
        return result
