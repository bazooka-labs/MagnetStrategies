from algopy import (
    Account,
    Application,
    ARC4Contract,
    Asset,
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
)

# Folks Finance v2 fixed-point scale for the deposit interest index (14 dp).
ONE_14_DP = 100_000_000_000_000

# Pool global-state key "i" (0x69) is a 56-byte blob = 7 × uint64. The deposit interest index
# (`diit`, 14dp) is interest[5] → byte offset 40. Verified live + against the Folks SDK.
INDEX_OFFSET = 40


class FolksAdapter(
    ARC4Contract,
    state_totals=StateTotals(global_uints=5, global_bytes=1),
):
    """
    MagnetFi v3 yield adapter for the Folks Finance v2 USDC lending pool.

    Immutable, single-venue. Speaks the PSM↔adapter interface:
        pool_deposit(amount)          — deposit USDC (already sent by the PSM) into Folks → hold fUSDC
        pool_withdraw(amount) -> sent — redeem fUSDC → send USDC to the PSM; report amount
        recoverable_value() -> value  — fUSDC_balance × depositInterestIndex / 1e14

    recoverable_value is a NON-MANIPULABLE on-chain read (the adapter's own fUSDC ASA balance ×
    Folks' own pool index) — the load-bearing requirement from PSM.md H-1. The stored index is
    the value at the pool's last update: monotonic, so a stale read is conservatively LOW, exactly
    what the PSM's min(principal, recoverable) wants.

    Mainnet ids (set at create, verified in FOLKS_ADAPTER.md):
        pool_app 971372237, pool_manager 971350278, USDC 31566704, fUSDC 971384592.

    ⚠ NOT integration-tested (Folks is not on LocalNet). Requires a mainnet-fork / testnet
    deposit→read→harvest→recall cycle + a dedicated audit before whitelisting. See FOLKS_ADAPTER.md.
    """

    def __init__(self) -> None:
        self.psm_app_id = GlobalState(UInt64)          # authorized caller (the PSM)
        self.usdc_asa_id = GlobalState(UInt64)         # underlying (mainnet 31566704)
        self.fusdc_asa_id = GlobalState(UInt64)        # receipt fUSDC (mainnet 971384592)
        self.pool_app_id = GlobalState(UInt64)         # Folks USDC pool (mainnet 971372237)
        self.pool_manager_app_id = GlobalState(UInt64)  # Folks pool manager (mainnet 971350278)
        self.admin = GlobalState(Account)              # setup key (opt-ins only)

    @arc4.abimethod(allow_actions=["NoOp"], create="require")
    def create(
        self,
        psm_app_id: UInt64,
        usdc_asa_id: UInt64,
        fusdc_asa_id: UInt64,
        pool_app_id: UInt64,
        pool_manager_app_id: UInt64,
        admin: Account,
    ) -> None:
        assert psm_app_id != UInt64(0), "psm_app_id required"
        assert usdc_asa_id != UInt64(0), "usdc required"
        assert fusdc_asa_id != UInt64(0), "fusdc required"
        assert usdc_asa_id != fusdc_asa_id, "usdc and fusdc must differ"
        assert pool_app_id != UInt64(0), "pool required"
        assert pool_manager_app_id != UInt64(0), "pool_manager required"
        assert admin != Global.zero_address, "admin required"
        self.psm_app_id.value = psm_app_id
        self.usdc_asa_id.value = usdc_asa_id
        self.fusdc_asa_id.value = fusdc_asa_id
        self.pool_app_id.value = pool_app_id
        self.pool_manager_app_id.value = pool_manager_app_id
        self.admin.value = admin

    # ── internal helpers ──────────────────────────────────────────────────────
    @subroutine
    def _psm_address(self) -> Account:
        addr, exists = op.AppParamsGet.app_address(self.psm_app_id.value)
        assert exists, "psm app not found"
        return addr

    @subroutine
    def _pool_address(self) -> Account:
        addr, exists = op.AppParamsGet.app_address(self.pool_app_id.value)
        assert exists, "pool app not found"
        return addr

    @subroutine
    def _assert_psm(self) -> None:
        assert Txn.sender == self._psm_address(), "caller is not the PSM"

    @subroutine
    def _assert_admin(self) -> None:
        assert Txn.sender == self.admin.value, "admin only"

    @subroutine
    def _fusdc_balance(self) -> UInt64:
        bal, exists = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.fusdc_asa_id.value
        )
        assert exists, "adapter not opted into fUSDC"
        return bal

    @subroutine
    def _usdc_balance(self) -> UInt64:
        bal, exists = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.usdc_asa_id.value
        )
        assert exists, "adapter not opted into USDC"
        return bal

    @subroutine
    def _deposit_index(self) -> UInt64:
        """Folks depositInterestIndex (14dp): uint64 at byte 40 of the pool's global key 'i'."""
        raw, exists = op.AppGlobal.get_ex_bytes(self.pool_app_id.value, Bytes(b"i"))
        assert exists, "pool interest state missing"
        return op.extract_uint64(raw, UInt64(INDEX_OFFSET))

    @subroutine
    def _wide_ratio(self, a: UInt64, b: UInt64, c: UInt64) -> UInt64:
        high, low = op.mulw(a, b)
        return op.divw(high, low, c)

    @arc4.abimethod
    def opt_in_asset(self, asa_id: UInt64) -> None:
        """Opt the adapter account into USDC / fUSDC. Admin only (setup)."""
        self._assert_admin()
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
        """Deposit `amount` USDC (already transferred to the adapter by the PSM) into the Folks
        pool; the adapter receives fUSDC. Inner group: [AssetTransfer(USDC→pool), pool.deposit]."""
        self._assert_psm()
        assert self._usdc_balance() >= amount, "usdc not received"
        pool_addr = self._pool_address()
        arc4.abi_call[arc4.UInt64](
            "deposit(txn,account,asset,asset,application)uint64",
            itxn.AssetTransfer(
                xfer_asset=self.usdc_asa_id.value,
                asset_receiver=pool_addr,
                asset_amount=amount,
                fee=0,
            ),
            Global.current_application_address,          # receiver (adapter gets fUSDC)
            Asset(self.usdc_asa_id.value),               # asset
            Asset(self.fusdc_asa_id.value),              # f_asset
            Application(self.pool_manager_app_id.value),  # pool_manager
            app_id=self.pool_app_id.value,
            fee=0,
        )

    @arc4.abimethod
    def pool_withdraw(self, amount: UInt64) -> arc4.UInt64:
        """Redeem fUSDC for up to `amount` USDC, sent straight to the PSM; return the requested
        amount. The PSM re-measures the real USDC delta, so a best-effort result is safe."""
        self._assert_psm()
        # Refresh the pool's stored index so received_amount matches the live index.
        arc4.abi_call(
            "update_pool_interest_indexes(application)void",
            Application(self.pool_manager_app_id.value),
            app_id=self.pool_app_id.value,
            fee=0,
        )
        index = self._deposit_index()
        fusdc_bal = self._fusdc_balance()

        # fUSDC needed to cover `amount` USDC (floor); cap at holdings (full exit).
        needed = self._wide_ratio(amount, UInt64(ONE_14_DP), index)
        fusdc_to_send = needed if needed <= fusdc_bal else fusdc_bal
        # Request the USDC that this fUSDC is worth, so the request always matches what is sent.
        received = self._wide_ratio(fusdc_to_send, index, UInt64(ONE_14_DP))

        if fusdc_to_send > UInt64(0) and received > UInt64(0):
            arc4.abi_call[arc4.UInt64](
                "withdraw(axfer,uint64,account,asset,asset,application)uint64",
                itxn.AssetTransfer(
                    xfer_asset=self.fusdc_asa_id.value,
                    asset_receiver=self._pool_address(),
                    asset_amount=fusdc_to_send,
                    fee=0,
                ),
                received,                                     # received_amount (USDC)
                self._psm_address(),                          # receiver (USDC → PSM directly)
                Asset(self.usdc_asa_id.value),                # asset
                Asset(self.fusdc_asa_id.value),               # f_asset
                Application(self.pool_manager_app_id.value),  # pool_manager
                app_id=self.pool_app_id.value,
                fee=0,
            )
        return arc4.UInt64(received)

    @arc4.abimethod(readonly=True)
    def recoverable_value(self) -> arc4.UInt64:
        """USDC value of the fUSDC position = fUSDC_balance × depositInterestIndex / 1e14.
        Non-manipulable: the adapter's own fUSDC balance × Folks' own (stored, conservative) index."""
        return arc4.UInt64(self._wide_ratio(self._fusdc_balance(), self._deposit_index(), UInt64(ONE_14_DP)))
