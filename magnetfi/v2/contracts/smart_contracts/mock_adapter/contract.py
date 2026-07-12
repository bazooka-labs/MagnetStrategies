from algopy import (
    Account,
    ARC4Contract,
    Global,
    GlobalState,
    StateTotals,
    Txn,
    UInt64,
    arc4,
    itxn,
    op,
    subroutine,
)


class MockAdapter(
    ARC4Contract,
    state_totals=StateTotals(global_uints=5, global_bytes=1),
):
    """
    Controllable MOCK yield-venue adapter for MagnetFi v3 PSM tests.

    Implements the PSM ↔ adapter interface exactly:
        pool_deposit(amount)          — take custody of USDC the PSM just sent
        pool_withdraw(amount) -> sent — return USDC to the PSM; report amount actually sent
        recoverable_value() -> value  — current USDC value of the position

    The mock's "position" is simply the USDC it holds, unless value_override is set.
    Controller-only test knobs let us drive every v3 loss path deterministically:
        set_value(v)  — override recoverable_value (simulate yield / loss / a too-high mark)
        set_locked(b) — freeze/unfreeze withdrawals (simulate a venue liquidity halt, F-6)
        drain(amount) — move USDC out (simulate a realized venue value loss)
        fund via a plain USDC AssetTransfer to this app address to simulate accrued yield.

    NOT a production contract — the real venue integration is FolksAdapter (Phase 3).
    """

    def __init__(self) -> None:
        self.psm_app_id = GlobalState(UInt64)      # authorized caller (the PSM)
        self.usdc_asa_id = GlobalState(UInt64)
        self.controller = GlobalState(Account)     # test controller (sets mock params)
        self.value_override = GlobalState(UInt64)  # 0 = report real USDC balance
        self.locked = GlobalState(UInt64)          # 1 = withdrawals revert (frozen venue)
        self.withdraw_lie = GlobalState(UInt64)    # 0 = honest return; else the value to REPORT
        #                                            from pool_withdraw regardless of USDC sent
        #                                            (simulates a malicious adapter — H-2/M-1)

    @arc4.abimethod(allow_actions=["NoOp"], create="require")
    def create(self, psm_app_id: UInt64, usdc_asa_id: UInt64, controller: Account) -> None:
        assert psm_app_id != UInt64(0), "psm_app_id required"
        assert usdc_asa_id != UInt64(0), "usdc_asa_id required"
        assert controller != Global.zero_address, "controller required"
        self.psm_app_id.value = psm_app_id
        self.usdc_asa_id.value = usdc_asa_id
        self.controller.value = controller
        self.value_override.value = UInt64(0)
        self.locked.value = UInt64(0)
        self.withdraw_lie.value = UInt64(0)

    # ── internal helpers ──────────────────────────────────────────────────────

    @subroutine
    def _psm_address(self) -> Account:
        addr, exists = op.AppParamsGet.app_address(self.psm_app_id.value)
        assert exists, "psm app not found"
        return addr

    @subroutine
    def _assert_psm(self) -> None:
        assert Txn.sender == self._psm_address(), "caller is not the PSM"

    @subroutine
    def _assert_controller(self) -> None:
        assert Txn.sender == self.controller.value, "controller only"

    @subroutine
    def _usdc_balance(self) -> UInt64:
        bal, exists = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.usdc_asa_id.value
        )
        assert exists, "adapter not opted into USDC"
        return bal

    @arc4.abimethod
    def opt_in_asset(self, asa_id: UInt64) -> None:
        """Opt the adapter account into an ASA (USDC / a receipt token). Controller only."""
        self._assert_controller()
        assert asa_id != UInt64(0), "invalid ASA"
        itxn.AssetTransfer(
            xfer_asset=asa_id,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0,
        ).submit()

    # ── PSM ↔ adapter interface ────────────────────────────────────────────────

    @arc4.abimethod
    def pool_deposit(self, amount: UInt64) -> None:
        """PSM has already transferred `amount` USDC to this adapter; take custody.
        A real adapter would forward it into the venue and receive a receipt token here."""
        self._assert_psm()
        assert self._usdc_balance() >= amount, "usdc not received"

    @arc4.abimethod
    def pool_withdraw(self, amount: UInt64) -> arc4.UInt64:
        """Send up to `amount` USDC back to the PSM; return the amount actually sent.
        Reverts if the venue is frozen (locked) — simulating halted withdrawals.
        If the position has lost value (balance < amount), returns less — a realized loss."""
        self._assert_psm()
        assert self.locked.value == UInt64(0), "venue withdrawals halted"
        bal = self._usdc_balance()
        send = amount if amount <= bal else bal
        if send > UInt64(0):
            itxn.AssetTransfer(
                xfer_asset=self.usdc_asa_id.value,
                asset_receiver=self._psm_address(),
                asset_amount=send,
                fee=0,
            ).submit()
        # Honest adapters return exactly what they sent; a malicious one can REPORT anything.
        # The PSM must ignore this and measure its own USDC balance delta (H-2/M-1).
        reported = self.withdraw_lie.value if self.withdraw_lie.value > UInt64(0) else send
        return arc4.UInt64(reported)

    @arc4.abimethod(readonly=True)
    def recoverable_value(self) -> arc4.UInt64:
        """USDC value recoverable from this position. Override if set, else the real balance."""
        if self.value_override.value > UInt64(0):
            return arc4.UInt64(self.value_override.value)
        return arc4.UInt64(self._usdc_balance())

    # ── test controls (controller only) ────────────────────────────────────────

    @arc4.abimethod
    def set_value(self, v: UInt64) -> None:
        """Override recoverable_value (0 = report real balance). Simulate yield/loss/misreport."""
        self._assert_controller()
        self.value_override.value = v

    @arc4.abimethod
    def set_locked(self, b: UInt64) -> None:
        """Freeze (1) / unfreeze (0) withdrawals — simulate a venue liquidity halt (F-6)."""
        self._assert_controller()
        self.locked.value = b

    @arc4.abimethod
    def set_withdraw_lie(self, v: UInt64) -> None:
        """Make pool_withdraw REPORT `v` regardless of USDC actually sent (0 = honest).
        Simulates a malicious adapter lying about recovered funds (H-2 drain / M-1 hidden loss)."""
        self._assert_controller()
        self.withdraw_lie.value = v

    @arc4.abimethod
    def drain(self, amount: UInt64) -> None:
        """Simulate a realized venue value loss by moving USDC out to the controller."""
        self._assert_controller()
        itxn.AssetTransfer(
            xfer_asset=self.usdc_asa_id.value,
            asset_receiver=self.controller.value,
            asset_amount=amount,
            fee=0,
        ).submit()
