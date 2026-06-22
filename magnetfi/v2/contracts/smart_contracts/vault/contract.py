from algopy import (
    Account,
    ARC4Contract,
    Asset,
    BoxMap,
    Bytes,
    Global,
    GlobalState,
    StateTotals,
    Txn,
    UInt64,
    arc4,
    gtxn,
    itxn,
    op,
    subroutine,
)
from smart_contracts.psm.contract import PSM

# ── module-level constants (plain int — UInt64() not allowed at module scope) ─

SECONDS_PER_YEAR = 31_536_000   # 365 × 24 × 3600
DAYS_90 = 7_776_000             # 90 × 24 × 3600
VAULT_MBR = 46_500              # µALGO MBR: 2500 + 400×(46+64)
MICRO_LIQ_BUFFER_BPS = 500      # 5% buffer on micro-liq seizure
ORACLE_FRESHNESS = 1_800        # 30 minutes
TIMELOCK_DELAY = 172_800        # 48h on the catastrophic oracle-repointing power

# Dynamic global-state key prefixes for per-pool parameters
_RATE_PREFIX   = b"rate_"
_LTV_PREFIX    = b"ltv_"
_LIQ_PREFIX    = b"liq_"
_LP_ASA_PREFIX = b"lpasa_"


# ── vault box state ──────────────────────────────────────────────────────────

class VaultState(arc4.Struct):
    """
    64 bytes stored per vault box.
    Box key: b"vault_" (6B prefix) + borrower_pubkey (32B) + pool_id uint64 BE (8B) = 46B
    MBR: 2500 + 400 × (46 + 64) = 46,500 µALGO
    """
    lp_amount: arc4.UInt64
    lp_pool_id: arc4.UInt64
    musd_borrowed: arc4.UInt64
    accrued_interest: arc4.UInt64   # repurposed as settlement counter in vault_state 2
    rate_bps: arc4.UInt64
    last_accrual_timestamp: arc4.UInt64
    last_payment_timestamp: arc4.UInt64
    vault_state: arc4.UInt64        # 0=active  1=payment_overdue  2=in_liquidation


# ── main contract ────────────────────────────────────────────────────────────

class Vault(
    ARC4Contract,
    state_totals=StateTotals(global_uints=40, global_bytes=6),
):
    """
    MagnetFi v2 Vault — LP collateral engine.

    Borrowers deposit Tinyman LP tokens and receive mUSD loans up to the LTV limit.
    Repayment is interest-only every ~90 days; principal is optional.
    Two independent liquidation paths: missed payment (micro-liq) and health factor (tiered).

    Two-role trust model:
      admin    — hot key: rates/LTV/thresholds, liquidations, fees, opt-in, advance accrual.
      guardian — cold key: pause/unpause borrowing, cancel queued oracle repoint, recover admin.

    Box storage: one VaultState per (borrower, pool_id) pair.
    BoxMap key_prefix = b"vault_"; suffix = borrower.bytes (32B) + itob(pool_id) (8B).
    """

    def __init__(self) -> None:
        self.psm_app_id = GlobalState(UInt64)
        self.lp_oracle_app_id = GlobalState(UInt64)
        self.musd_asa_id = GlobalState(UInt64)
        self.usdc_asa_id = GlobalState(UInt64)
        self.accumulated_fees = GlobalState(UInt64)

        # Two-role admin model.
        self.admin = GlobalState(Account)
        self.guardian = GlobalState(Account)
        self.pending_admin = GlobalState(Account)
        self.pending_guardian = GlobalState(Account)

        # Incident pause (gates new borrowing only; repay/liquidate/settle stay open).
        self.paused = GlobalState(UInt64)

        # Timelocked LP-oracle repointing.
        self.pending_lp_oracle = GlobalState(UInt64)
        self.pending_lp_oracle_eta = GlobalState(UInt64)

        # Per-pool params live in dynamic global-state slots using prefixed keys:
        # b"rate_" + itob(pool_id), b"ltv_" + itob(pool_id), etc.

        self.vaults = BoxMap(Bytes, VaultState, key_prefix=b"vault_")

    # ── deployment ────────────────────────────────────────────────────────────

    @arc4.abimethod(allow_actions=["NoOp"], create="require")
    def deploy(
        self,
        psm_app_id: UInt64,
        lp_oracle_app_id: UInt64,
        musd_asa_id: UInt64,
        usdc_asa_id: UInt64,
        guardian: Account,
    ) -> None:
        assert psm_app_id != UInt64(0)
        assert lp_oracle_app_id != UInt64(0)
        assert musd_asa_id != UInt64(0)
        assert usdc_asa_id != UInt64(0)
        assert guardian != Global.zero_address, "guardian required"
        assert guardian != Txn.sender, "guardian must differ from admin"
        self.psm_app_id.value = psm_app_id
        self.lp_oracle_app_id.value = lp_oracle_app_id
        self.musd_asa_id.value = musd_asa_id
        self.usdc_asa_id.value = usdc_asa_id
        self.accumulated_fees.value = UInt64(0)

        self.admin.value = Txn.sender
        self.guardian.value = guardian
        self.pending_admin.value = Global.zero_address
        self.pending_guardian.value = Global.zero_address
        self.paused.value = UInt64(0)
        self.pending_lp_oracle.value = UInt64(0)
        self.pending_lp_oracle_eta.value = UInt64(0)

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
    def _vault_key(self, account: Account, pool_id: UInt64) -> Bytes:
        return account.bytes + op.itob(pool_id)

    @subroutine
    def _wide_ratio(self, a: UInt64, b: UInt64, c: UInt64) -> UInt64:
        """floor(a × b / c) via AVM wide arithmetic — no uint64 overflow."""
        high, low = op.mulw(a, b)
        return op.divw(high, low, c)

    @subroutine
    def _pool_lp_asa(self, pool_id: UInt64) -> UInt64:
        asa_id = op.AppGlobal.get_uint64(Bytes(_LP_ASA_PREFIX) + op.itob(pool_id))
        assert asa_id != UInt64(0), "pool not registered"
        return asa_id

    @subroutine
    def _pool_rate(self, pool_id: UInt64) -> UInt64:
        return op.AppGlobal.get_uint64(Bytes(_RATE_PREFIX) + op.itob(pool_id))

    @subroutine
    def _pool_ltv(self, pool_id: UInt64) -> UInt64:
        return op.AppGlobal.get_uint64(Bytes(_LTV_PREFIX) + op.itob(pool_id))

    @subroutine
    def _pool_liq_threshold(self, pool_id: UInt64) -> UInt64:
        return op.AppGlobal.get_uint64(Bytes(_LIQ_PREFIX) + op.itob(pool_id))

    @subroutine
    def _oracle_price(self, pool_id: UInt64) -> UInt64:
        key = Bytes(b"lp_price_") + op.itob(pool_id)
        price, exists = op.AppGlobal.get_ex_uint64(self.lp_oracle_app_id.value, key)
        assert exists and price > UInt64(0), "oracle price not set"
        return price

    @subroutine
    def _oracle_is_fresh(self, pool_id: UInt64) -> bool:
        key = Bytes(b"lp_ts_") + op.itob(pool_id)
        ts, exists = op.AppGlobal.get_ex_uint64(self.lp_oracle_app_id.value, key)
        if not exists:
            return False
        return ts + UInt64(ORACLE_FRESHNESS) >= Global.latest_timestamp

    @subroutine
    def _accrue_interest(self, vault: VaultState) -> VaultState:
        """
        Update accrued_interest and last_accrual_timestamp.
        Caps elapsed time at one year to prevent overflow on abandoned vaults.
        """
        if vault.vault_state.native == UInt64(2):
            return vault
        now = Global.latest_timestamp
        last_accrual = vault.last_accrual_timestamp.native
        seconds_elapsed = now - last_accrual
        if seconds_elapsed > UInt64(SECONDS_PER_YEAR):
            seconds_elapsed = UInt64(SECONDS_PER_YEAR)

        principal = vault.musd_borrowed.native
        rate = vault.rate_bps.native

        annual_interest = self._wide_ratio(principal, rate, UInt64(10_000))
        period_interest = self._wide_ratio(annual_interest, seconds_elapsed, UInt64(SECONDS_PER_YEAR))

        vault.accrued_interest = arc4.UInt64(vault.accrued_interest.native + period_interest)
        # Advance the clock by the CAPPED elapsed time, not to `now` (P21-01). In the
        # normal <1yr case last_accrual + seconds_elapsed == now (no behavior change). For
        # multi-year dormancy this leaves the remainder to be charged on the next accrual
        # call, so no interest is forgiven and advance_accrual genuinely catches up.
        vault.last_accrual_timestamp = arc4.UInt64(last_accrual + seconds_elapsed)
        return vault

    @subroutine
    def _lazy_overdue_check(self, vault: VaultState) -> VaultState:
        """
        Set vault_state = 1 if 90+ days elapsed since last payment and state is 0.
        Called at the top of all borrower-facing methods before any other logic.
        """
        if vault.vault_state.native == UInt64(0):
            if Global.latest_timestamp >= vault.last_payment_timestamp.native + UInt64(DAYS_90):
                vault.vault_state = arc4.UInt64(1)
        return vault

    @subroutine
    def _lp_value(self, lp_amount: UInt64, pool_id: UInt64) -> UInt64:
        """lp_value in mUSD = lp_amount × oracle_price / 1_000_000."""
        price = self._oracle_price(pool_id)
        return self._wide_ratio(lp_amount, price, UInt64(1_000_000))

    @subroutine
    def _psm_address(self) -> Account:
        addr, exists = op.AppParamsGet.app_address(self.psm_app_id.value)
        assert exists, "PSM app not found"
        return addr

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
        # Clear any queued oracle repoint so a change proposed by the prior admin can't
        # be confirmed by the new one unaware of its provenance (P21-04).
        self.pending_lp_oracle.value = UInt64(0)
        self.pending_lp_oracle_eta.value = UInt64(0)

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

    # ── pause (incident response) ─────────────────────────────────────────────

    @arc4.abimethod
    def pause(self) -> None:
        """Halt new borrowing (open_vault w/ borrow, borrow_more). Either role can pause."""
        self._assert_admin_or_guardian()
        self.paused.value = UInt64(1)

    @arc4.abimethod
    def unpause(self) -> None:
        """Resume borrowing. Guardian only — a compromised hot key cannot lift a lockdown."""
        self._assert_guardian()
        self.paused.value = UInt64(0)

    # ── open vault ────────────────────────────────────────────────────────────

    @arc4.abimethod
    def open_vault(self, pool_id: UInt64, borrow_amount: UInt64) -> None:
        """
        Create a new vault for (caller, pool_id).

        Atomic group (no borrow): Payment (MBR) + AppCall open_vault + AssetTransfer (LP)
        Atomic group (with borrow): same — vault issues mUSD immediately after LP deposit
        """
        key = self._vault_key(Txn.sender, pool_id)
        assert key not in self.vaults, "vault already exists"

        # This AppCall must be sandwiched: MBR payment at index-1, LP transfer at index+1.
        assert op.Txn.group_index >= UInt64(1), "open_vault not preceded by MBR payment"
        assert op.Txn.group_index + UInt64(1) < Global.group_size, "open_vault not followed by LP transfer"

        # Verify MBR payment in preceding txn.
        mbr_pay = gtxn.PaymentTransaction(op.Txn.group_index - UInt64(1))
        assert mbr_pay.receiver == Global.current_application_address, "wrong MBR receiver"
        assert mbr_pay.amount == UInt64(VAULT_MBR), "wrong MBR amount"

        # Verify LP deposit in following txn.
        lp_asa_id = self._pool_lp_asa(pool_id)
        lp_xfer = gtxn.AssetTransferTransaction(op.Txn.group_index + UInt64(1))
        assert lp_xfer.xfer_asset == Asset(lp_asa_id), "wrong LP token"
        assert lp_xfer.asset_receiver == Global.current_application_address, "wrong LP receiver"
        assert lp_xfer.asset_amount > UInt64(0), "zero LP deposit"

        lp_amount = lp_xfer.asset_amount

        # Rate locked at open time; guard ensures admin called set_rate for this pool.
        pool_rate = self._pool_rate(pool_id)
        assert pool_rate > UInt64(0), "pool rate not set"

        vault = VaultState(
            lp_amount=arc4.UInt64(lp_amount),
            lp_pool_id=arc4.UInt64(pool_id),
            musd_borrowed=arc4.UInt64(0),
            accrued_interest=arc4.UInt64(0),
            rate_bps=arc4.UInt64(pool_rate),
            last_accrual_timestamp=arc4.UInt64(Global.latest_timestamp),
            last_payment_timestamp=arc4.UInt64(Global.latest_timestamp),
            vault_state=arc4.UInt64(0),
        )

        if borrow_amount == UInt64(0):
            self.vaults[key] = vault.copy()
        else:
            # New borrowing is gated by the incident pause.
            assert self.paused.value == UInt64(0), "borrowing paused"
            assert self._oracle_is_fresh(pool_id), "oracle stale"
            lp_val = self._lp_value(lp_amount, pool_id)
            ltv = self._pool_ltv(pool_id)
            max_borrow = self._wide_ratio(lp_val, ltv, UInt64(10_000))
            assert borrow_amount <= max_borrow, "exceeds LTV"

            vault.musd_borrowed = arc4.UInt64(borrow_amount)
            self.vaults[key] = vault.copy()

            itxn.abi_call(
                PSM.issue_musd,
                Txn.sender,
                borrow_amount,
                app_id=self.psm_app_id.value,
                fee=0,
            ).submit()

    # ── pay interest ─────────────────────────────────────────────────────────

    @arc4.abimethod
    def pay_interest(self, pool_id: UInt64) -> None:
        """
        Pay accrued interest. Overpayment reduces principal; full repayment closes vault.

        Atomic group: AssetTransfer (mUSD → vault address) + AppCall pay_interest(pool_id)
        The transfer MUST precede the app call: the vault forwards the principal-repayment
        portion (`change`) to the PSM via an inner transaction during this call, so the
        mUSD must already have landed in the vault (a later group txn has not executed yet).
        """
        key = self._vault_key(Txn.sender, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()

        # Lazy overdue check before any state assertions.
        vault = self._lazy_overdue_check(vault)
        assert vault.vault_state.native != UInt64(2), "vault in liquidation"

        assert op.Txn.group_index >= UInt64(1), "missing mUSD payment txn"
        musd_xfer = gtxn.AssetTransferTransaction(op.Txn.group_index - UInt64(1))
        assert musd_xfer.xfer_asset == Asset(self.musd_asa_id.value), "wrong asset"
        assert musd_xfer.asset_receiver == Global.current_application_address, "wrong receiver"
        assert musd_xfer.asset_amount > UInt64(0), "zero payment"

        vault = self._accrue_interest(vault)
        payment = musd_xfer.asset_amount
        interest_due = vault.accrued_interest.native
        assert payment >= interest_due, "insufficient payment"

        vault.accrued_interest = arc4.UInt64(0)
        self.accumulated_fees.value = self.accumulated_fees.value + interest_due
        vault.last_payment_timestamp = arc4.UInt64(Global.latest_timestamp)
        if vault.vault_state.native == UInt64(1):
            vault.vault_state = arc4.UInt64(0)

        change = payment - interest_due
        if change > UInt64(0):
            assert change <= vault.musd_borrowed.native, "overpayment exceeds principal"
            new_borrowed = vault.musd_borrowed.native - change
            vault.musd_borrowed = arc4.UInt64(new_borrowed)

            psm_addr = self._psm_address()
            itxn.AssetTransfer(
                xfer_asset=self.musd_asa_id.value,
                asset_receiver=psm_addr,
                asset_amount=change,
                fee=0,
            ).submit()
            itxn.abi_call(
                PSM.receive_musd,
                change,
                app_id=self.psm_app_id.value,
                fee=0,
            ).submit()

            if new_borrowed == UInt64(0):
                lp_asa_id = self._pool_lp_asa(vault.lp_pool_id.native)
                lp_amount = vault.lp_amount.native
                del self.vaults[key]
                if lp_amount > UInt64(0):
                    itxn.AssetTransfer(
                        xfer_asset=lp_asa_id,
                        asset_receiver=Txn.sender,
                        asset_amount=lp_amount,
                        fee=0,
                    ).submit()
                itxn.Payment(
                    receiver=Txn.sender,
                    amount=UInt64(VAULT_MBR),
                    fee=0,
                ).submit()
            else:
                self.vaults[key] = vault.copy()
        else:
            self.vaults[key] = vault.copy()

    # ── repay principal ───────────────────────────────────────────────────────

    @arc4.abimethod
    def repay_principal(self, pool_id: UInt64) -> None:
        """
        Repay mUSD principal. Caller must clear accrued interest first.

        Atomic group: AppCall repay_principal(pool_id) + AssetTransfer (mUSD → PSM address)
        """
        key = self._vault_key(Txn.sender, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()

        vault = self._lazy_overdue_check(vault)
        assert vault.vault_state.native != UInt64(2), "vault in liquidation"

        psm_addr = self._psm_address()
        assert op.Txn.group_index + UInt64(1) < Global.group_size, "missing mUSD repayment txn"
        musd_xfer = gtxn.AssetTransferTransaction(op.Txn.group_index + UInt64(1))
        assert musd_xfer.xfer_asset == Asset(self.musd_asa_id.value), "wrong asset"
        assert musd_xfer.asset_receiver == psm_addr, "mUSD must go to PSM"
        assert musd_xfer.asset_amount > UInt64(0), "zero repayment"

        assert vault.accrued_interest.native == UInt64(0), "clear interest first"

        repayment = musd_xfer.asset_amount
        assert repayment <= vault.musd_borrowed.native, "repayment exceeds debt"

        new_borrowed = vault.musd_borrowed.native - repayment
        vault.musd_borrowed = arc4.UInt64(new_borrowed)

        itxn.abi_call(
            PSM.receive_musd,
            repayment,
            app_id=self.psm_app_id.value,
            fee=0,
        ).submit()

        if new_borrowed == UInt64(0):
            lp_asa_id = self._pool_lp_asa(vault.lp_pool_id.native)
            lp_amount = vault.lp_amount.native
            del self.vaults[key]
            if lp_amount > UInt64(0):
                itxn.AssetTransfer(
                    xfer_asset=lp_asa_id,
                    asset_receiver=Txn.sender,
                    asset_amount=lp_amount,
                    fee=0,
                ).submit()
            itxn.Payment(
                receiver=Txn.sender,
                amount=UInt64(VAULT_MBR),
                fee=0,
            ).submit()
        else:
            self.vaults[key] = vault.copy()

    # ── add collateral ────────────────────────────────────────────────────────

    @arc4.abimethod
    def add_collateral(self, pool_id: UInt64) -> None:
        """
        Deposit additional LP tokens into an existing vault.

        Atomic group: AppCall add_collateral(pool_id) + AssetTransfer (LP → vault)
        """
        key = self._vault_key(Txn.sender, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()

        vault = self._lazy_overdue_check(vault)
        assert vault.vault_state.native != UInt64(2), "vault in liquidation"

        lp_asa_id = self._pool_lp_asa(vault.lp_pool_id.native)
        assert op.Txn.group_index + UInt64(1) < Global.group_size, "missing LP deposit txn"
        lp_xfer = gtxn.AssetTransferTransaction(op.Txn.group_index + UInt64(1))
        assert lp_xfer.xfer_asset == Asset(lp_asa_id), "wrong LP token"
        assert lp_xfer.asset_receiver == Global.current_application_address, "wrong receiver"
        assert lp_xfer.asset_amount > UInt64(0), "zero deposit"

        vault = self._accrue_interest(vault)
        vault.lp_amount = arc4.UInt64(vault.lp_amount.native + lp_xfer.asset_amount)
        self.vaults[key] = vault.copy()

    # ── borrow more ───────────────────────────────────────────────────────────

    @arc4.abimethod
    def borrow_more(self, pool_id: UInt64, amount: UInt64) -> None:
        """Draw additional mUSD from an existing active vault."""
        assert self.paused.value == UInt64(0), "borrowing paused"
        assert amount > UInt64(0), "zero borrow"

        key = self._vault_key(Txn.sender, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()

        vault = self._lazy_overdue_check(vault)
        assert vault.vault_state.native == UInt64(0), "vault not active"
        assert self._oracle_is_fresh(pool_id), "oracle stale"

        vault = self._accrue_interest(vault)
        lp_val = self._lp_value(vault.lp_amount.native, pool_id)
        ltv = self._pool_ltv(pool_id)
        max_debt = self._wide_ratio(lp_val, ltv, UInt64(10_000))

        total_after = vault.musd_borrowed.native + vault.accrued_interest.native + amount
        assert total_after <= max_debt, "exceeds LTV"

        vault.musd_borrowed = arc4.UInt64(vault.musd_borrowed.native + amount)
        self.vaults[key] = vault.copy()

        itxn.abi_call(
            PSM.issue_musd,
            Txn.sender,
            amount,
            app_id=self.psm_app_id.value,
            fee=0,
        ).submit()

    # ── fee collection ────────────────────────────────────────────────────────

    @arc4.abimethod
    def collect_fees(self) -> None:
        """Sweep accumulated interest to the admin wallet as mUSD."""
        self._assert_admin()
        fees = self.accumulated_fees.value
        assert fees > UInt64(0), "no fees"

        # Clamp to the vault's actual mUSD balance. The counter should always be
        # backed 1:1 by mUSD received via pay_interest, but clamping guarantees a
        # phantom-fee entry can never brick collection (defense-in-depth).
        bal, exists = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.musd_asa_id.value
        )
        assert exists, "vault not opted into mUSD"
        sweep = fees if fees <= bal else bal
        assert sweep > UInt64(0), "no mUSD balance to sweep"

        self.accumulated_fees.value = fees - sweep
        itxn.AssetTransfer(
            xfer_asset=self.musd_asa_id.value,
            asset_receiver=self.admin.value,
            asset_amount=sweep,
            fee=0,
        ).submit()

    @arc4.abimethod
    def collect_algo(self, amount: UInt64) -> None:
        """
        Sweep excess ALGO to the admin wallet.
        Admin computes safe amount off-chain: contract_balance − (vault_count × 46_500) − buffer.
        The AVM rejects any amount that would drop below the contract's own min balance.
        """
        self._assert_admin()
        assert amount > UInt64(0), "zero amount"
        itxn.Payment(
            receiver=self.admin.value,
            amount=amount,
            fee=0,
        ).submit()

    @arc4.abimethod
    def opt_in_asset(self, asa_id: UInt64) -> None:
        """
        Opt vault contract account into an ASA (mUSD, LP tokens).
        Must be called for every ASA the vault needs to hold before first use.
        """
        self._assert_admin()
        assert asa_id != UInt64(0), "invalid ASA ID"
        itxn.AssetTransfer(
            xfer_asset=asa_id,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0,
        ).submit()

    # ── payment overdue (admin) ───────────────────────────────────────────────

    @arc4.abimethod
    def mark_payment_overdue(self, borrower: Account, pool_id: UInt64) -> None:
        """Explicitly transition vault from active → payment_overdue after 90-day window."""
        self._assert_admin()
        key = self._vault_key(borrower, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()
        assert vault.vault_state.native == UInt64(0), "vault not active"
        assert Global.latest_timestamp >= vault.last_payment_timestamp.native + UInt64(DAYS_90), "not overdue"
        vault.vault_state = arc4.UInt64(1)
        self.vaults[key] = vault.copy()

    @arc4.abimethod
    def advance_accrual(self, borrower: Account, pool_id: UInt64) -> None:
        """
        Admin: advance interest accrual on a vault (1-year cap per call).
        Lets the protocol catch up interest on a multi-year-abandoned position by calling
        repeatedly before liquidation, since a delinquent borrower won't trigger accrual (P19-13).
        """
        self._assert_admin()
        key = self._vault_key(borrower, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()
        assert vault.vault_state.native != UInt64(2), "vault in liquidation"
        vault = self._accrue_interest(vault)
        self.vaults[key] = vault.copy()

    # ── liquidation: micro ────────────────────────────────────────────────────

    @arc4.abimethod
    def trigger_micro_liquidation(self, borrower: Account, pool_id: UInt64) -> None:
        """
        Seize LP covering accrued interest + 5% buffer after 90-day non-payment.
        Position continues; payment clock resets.
        """
        self._assert_admin()

        key = self._vault_key(borrower, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()

        assert vault.vault_state.native == UInt64(1), "vault not payment_overdue"
        assert Global.latest_timestamp >= vault.last_payment_timestamp.native + UInt64(DAYS_90), "not overdue"
        assert self._oracle_is_fresh(pool_id), "oracle stale"

        vault = self._accrue_interest(vault)
        interest = vault.accrued_interest.native
        assert interest > UInt64(0), "no accrued interest"

        buffer = self._wide_ratio(interest, UInt64(MICRO_LIQ_BUFFER_BPS), UInt64(10_000))
        total_recovery = interest + buffer
        lp_price = self._oracle_price(pool_id)

        lp_to_seize = self._wide_ratio(total_recovery, UInt64(1_000_000), lp_price)
        # Ceiling: add 1 if floor undervalues
        if self._wide_ratio(lp_to_seize, lp_price, UInt64(1_000_000)) < total_recovery:
            lp_to_seize = lp_to_seize + UInt64(1)

        assert lp_to_seize <= vault.lp_amount.native, "insufficient collateral for micro-liq"

        vault.lp_amount = arc4.UInt64(vault.lp_amount.native - lp_to_seize)
        vault.accrued_interest = arc4.UInt64(0)
        vault.last_accrual_timestamp = arc4.UInt64(Global.latest_timestamp)
        vault.last_payment_timestamp = arc4.UInt64(Global.latest_timestamp)
        vault.vault_state = arc4.UInt64(0)
        self.vaults[key] = vault.copy()

        lp_asa_id = self._pool_lp_asa(pool_id)
        itxn.AssetTransfer(
            xfer_asset=lp_asa_id,
            asset_receiver=self.admin.value,
            asset_amount=lp_to_seize,
            fee=0,
        ).submit()

    # ── liquidation: partial (tiered) ─────────────────────────────────────────

    @arc4.abimethod
    def trigger_partial_liquidation(
        self, borrower: Account, pool_id: UInt64, tier: UInt64
    ) -> None:
        """
        Seize 35% (tier 1) or 60% (tier 2) of LP for HF in [0.85, 1.0).
        Sets vault_state = 2 pending admin mUSD settlement.
        """
        self._assert_admin()
        assert tier == UInt64(1) or tier == UInt64(2), "tier must be 1 or 2"

        key = self._vault_key(borrower, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()

        assert vault.vault_state.native != UInt64(2), "already in liquidation"
        assert self._oracle_is_fresh(pool_id), "oracle stale"

        vault = self._accrue_interest(vault)
        total_debt = vault.musd_borrowed.native + vault.accrued_interest.native
        assert total_debt > UInt64(0), "no debt"

        lp_val = self._lp_value(vault.lp_amount.native, pool_id)
        liq_threshold = self._pool_liq_threshold(pool_id)
        hf_num = self._wide_ratio(lp_val, liq_threshold, UInt64(10_000))

        if tier == UInt64(1):
            # Tier 1: 0.95 ≤ HF < 1.0
            assert hf_num * UInt64(100) >= total_debt * UInt64(95), "HF not in tier 1 (lower)"
            assert hf_num < total_debt, "HF not in tier 1 (upper)"
        else:
            # Tier 2: 0.85 ≤ HF < 0.95
            assert hf_num * UInt64(100) >= total_debt * UInt64(85), "HF not in tier 2 (lower)"
            assert hf_num * UInt64(100) < total_debt * UInt64(95), "HF not in tier 2 (upper)"

        tier_bps = UInt64(3_500) if tier == UInt64(1) else UInt64(6_000)

        lp_amount = vault.lp_amount.native
        lp_to_seize = self._wide_ratio(lp_amount, tier_bps, UInt64(10_000))
        # Ceiling division
        if self._wide_ratio(lp_to_seize, UInt64(10_000), tier_bps) < lp_amount:
            lp_to_seize = lp_to_seize + UInt64(1)

        lp_price = self._oracle_price(pool_id)
        seized_lp_value = self._wide_ratio(lp_to_seize, lp_price, UInt64(1_000_000))
        if seized_lp_value > total_debt:
            seized_lp_value = total_debt

        vault.musd_borrowed = arc4.UInt64(total_debt - seized_lp_value)
        vault.accrued_interest = arc4.UInt64(seized_lp_value)  # settlement counter
        vault.lp_amount = arc4.UInt64(lp_amount - lp_to_seize)
        vault.last_accrual_timestamp = arc4.UInt64(Global.latest_timestamp)
        vault.vault_state = arc4.UInt64(2)
        self.vaults[key] = vault.copy()

        lp_asa_id = self._pool_lp_asa(pool_id)
        itxn.AssetTransfer(
            xfer_asset=lp_asa_id,
            asset_receiver=self.admin.value,
            asset_amount=lp_to_seize,
            fee=0,
        ).submit()

    # ── liquidation: full ─────────────────────────────────────────────────────

    @arc4.abimethod
    def trigger_full_liquidation(self, borrower: Account, pool_id: UInt64) -> None:
        """
        Seize all LP for HF < 0.85. Sets vault_state = 2 pending settlement.
        Surplus LP above total debt is returned to borrower immediately.
        Dust positions (total_lp_value == 0) are closed as bad debt immediately.
        """
        self._assert_admin()

        key = self._vault_key(borrower, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()

        assert vault.vault_state.native != UInt64(2), "already in liquidation"
        assert self._oracle_is_fresh(pool_id), "oracle stale"

        vault = self._accrue_interest(vault)
        total_debt = vault.musd_borrowed.native + vault.accrued_interest.native
        assert total_debt > UInt64(0), "no debt"

        lp_amount = vault.lp_amount.native
        lp_price = self._oracle_price(pool_id)
        total_lp_value = self._wide_ratio(lp_amount, lp_price, UInt64(1_000_000))

        # Tier 3 HF check: HF < 0.85
        liq_threshold = self._pool_liq_threshold(pool_id)
        hf_num = self._wide_ratio(total_lp_value, liq_threshold, UInt64(10_000))
        assert hf_num * UInt64(100) < total_debt * UInt64(85), "HF not below 0.85"

        lp_asa_id = self._pool_lp_asa(pool_id)

        # Dust-position fast-path: LP value rounds to zero.
        if total_lp_value == UInt64(0):
            del self.vaults[key]
            itxn.AssetTransfer(
                xfer_asset=lp_asa_id,
                asset_receiver=self.admin.value,
                asset_amount=lp_amount,
                fee=0,
            ).submit()
            itxn.Payment(
                receiver=borrower,
                amount=UInt64(VAULT_MBR),
                fee=0,
            ).submit()
            return

        surplus_lp = UInt64(0)
        lp_to_seize = lp_amount
        if total_lp_value > total_debt:
            surplus_lp = self._wide_ratio(
                total_lp_value - total_debt, UInt64(1_000_000), lp_price
            )
            lp_to_seize = lp_amount - surplus_lp
        assert lp_to_seize > UInt64(0), "nothing to seize after surplus"

        musd_to_settle = total_debt if total_lp_value >= total_debt else total_lp_value

        vault.musd_borrowed = arc4.UInt64(0)
        vault.accrued_interest = arc4.UInt64(musd_to_settle)  # settlement counter
        vault.lp_amount = arc4.UInt64(0)
        vault.vault_state = arc4.UInt64(2)
        self.vaults[key] = vault.copy()

        if surplus_lp > UInt64(0):
            itxn.AssetTransfer(
                xfer_asset=lp_asa_id,
                asset_receiver=borrower,
                asset_amount=surplus_lp,
                fee=0,
            ).submit()

        itxn.AssetTransfer(
            xfer_asset=lp_asa_id,
            asset_receiver=self.admin.value,
            asset_amount=lp_to_seize,
            fee=0,
        ).submit()

    # ── liquidation: settlement ───────────────────────────────────────────────

    @arc4.abimethod
    def settle_health_liquidation(
        self, borrower: Account, pool_id: UInt64, musd_amount: UInt64
    ) -> None:
        """
        Settle a health-factor liquidation by returning mUSD to PSM.

        Atomic group: AppCall settle_health_liquidation + AssetTransfer (mUSD → PSM address)
        May be called multiple times until the settlement counter (accrued_interest) reaches 0.
        """
        self._assert_admin()

        key = self._vault_key(borrower, pool_id)
        assert key in self.vaults, "vault not found"
        vault = self.vaults[key].copy()

        assert vault.vault_state.native == UInt64(2), "vault not in liquidation"

        psm_addr = self._psm_address()
        assert op.Txn.group_index + UInt64(1) < Global.group_size, "missing mUSD settlement txn"
        musd_xfer = gtxn.AssetTransferTransaction(op.Txn.group_index + UInt64(1))
        assert musd_xfer.xfer_asset == Asset(self.musd_asa_id.value), "wrong asset"
        assert musd_xfer.asset_receiver == psm_addr, "mUSD must go to PSM"
        assert musd_xfer.asset_amount == musd_amount, "amount mismatch"

        settlement_remaining = vault.accrued_interest.native
        assert musd_amount <= settlement_remaining, "exceeds settlement counter"

        new_remaining = settlement_remaining - musd_amount
        vault.accrued_interest = arc4.UInt64(new_remaining)

        itxn.abi_call(
            PSM.receive_musd,
            musd_amount,
            app_id=self.psm_app_id.value,
            fee=0,
        ).submit()

        if new_remaining > UInt64(0):
            # Partial settlement: stay in state 2.
            self.vaults[key] = vault.copy()
        elif vault.musd_borrowed.native > UInt64(0) and vault.lp_amount.native > UInt64(0):
            # Partial liq fully settled: restore active state.
            vault.last_accrual_timestamp = arc4.UInt64(Global.latest_timestamp)
            vault.last_payment_timestamp = arc4.UInt64(Global.latest_timestamp)
            vault.vault_state = arc4.UInt64(0)
            self.vaults[key] = vault.copy()
        elif vault.musd_borrowed.native == UInt64(0) and vault.lp_amount.native > UInt64(0):
            # Seized LP value exactly equalled total debt (cap hit) — remaining LP is surplus.
            # Return it to borrower and close the vault.
            lp_asa_id = self._pool_lp_asa(vault.lp_pool_id.native)
            lp_remaining = vault.lp_amount.native
            del self.vaults[key]
            itxn.AssetTransfer(
                xfer_asset=lp_asa_id,
                asset_receiver=borrower,
                asset_amount=lp_remaining,
                fee=0,
            ).submit()
            itxn.Payment(
                receiver=borrower,
                amount=UInt64(VAULT_MBR),
                fee=0,
            ).submit()
        else:
            # Full liq settled or dust bad-debt write-off: close vault.
            del self.vaults[key]
            itxn.Payment(
                receiver=borrower,
                amount=UInt64(VAULT_MBR),
                fee=0,
            ).submit()

    # ── parameter management (admin) ──────────────────────────────────────────

    @arc4.abimethod
    def set_rate(self, pool_id: UInt64, rate_bps: UInt64) -> None:
        """Set annual interest rate for new accrual periods. Cap: 3000 bps (30% APR)."""
        self._assert_admin()
        assert rate_bps <= UInt64(3_000), "rate exceeds 30% cap"
        op.AppGlobal.put(Bytes(_RATE_PREFIX) + op.itob(pool_id), rate_bps)

    @arc4.abimethod
    def set_ltv(self, pool_id: UInt64, ltv_bps: UInt64) -> None:
        """Set LTV for a pool. Must be strictly below the pool's liquidation threshold."""
        self._assert_admin()
        assert ltv_bps > UInt64(0), "ltv must be > 0"
        liq = op.AppGlobal.get_uint64(Bytes(_LIQ_PREFIX) + op.itob(pool_id))
        assert liq != UInt64(0), "set liq threshold before ltv"
        assert ltv_bps < liq, "LTV must be below liquidation threshold"
        op.AppGlobal.put(Bytes(_LTV_PREFIX) + op.itob(pool_id), ltv_bps)

    @arc4.abimethod
    def set_liq_threshold(self, pool_id: UInt64, threshold_bps: UInt64) -> None:
        """Set liquidation threshold. Must exceed LTV and be ≤ 9000 bps (90%)."""
        self._assert_admin()
        ltv = op.AppGlobal.get_uint64(Bytes(_LTV_PREFIX) + op.itob(pool_id))
        assert threshold_bps > ltv, "threshold must exceed LTV"
        assert threshold_bps <= UInt64(9_000), "threshold cap 90%"
        op.AppGlobal.put(Bytes(_LIQ_PREFIX) + op.itob(pool_id), threshold_bps)

    @arc4.abimethod
    def set_lp_asa_id(self, pool_id: UInt64, lp_asa_id: UInt64) -> None:
        """Register LP token ASA ID for a pool. Required before any vault can open."""
        self._assert_admin()
        assert lp_asa_id != UInt64(0), "invalid ASA ID"
        op.AppGlobal.put(Bytes(_LP_ASA_PREFIX) + op.itob(pool_id), lp_asa_id)

    # ── timelocked LP-oracle repointing ───────────────────────────────────────

    @arc4.abimethod
    def propose_lp_oracle(self, new_oracle_app_id: UInt64) -> None:
        """
        Queue an LP-oracle reference change. Takes effect only after the 48h timelock via
        confirm_lp_oracle; guardian may cancel before then. A malicious oracle could post
        arbitrary prices enabling over-borrow — hence the delay and the guardian veto.
        """
        self._assert_admin()
        assert new_oracle_app_id != UInt64(0), "invalid oracle app id"
        self.pending_lp_oracle.value = new_oracle_app_id
        self.pending_lp_oracle_eta.value = Global.latest_timestamp + UInt64(TIMELOCK_DELAY)

    @arc4.abimethod
    def confirm_lp_oracle(self) -> None:
        """Apply a queued LP-oracle change after the timelock has elapsed."""
        self._assert_admin()
        assert self.pending_lp_oracle.value != UInt64(0), "no pending oracle"
        assert Global.latest_timestamp >= self.pending_lp_oracle_eta.value, "timelock not elapsed"
        self.lp_oracle_app_id.value = self.pending_lp_oracle.value
        self.pending_lp_oracle.value = UInt64(0)
        self.pending_lp_oracle_eta.value = UInt64(0)

    @arc4.abimethod
    def cancel_pending_lp_oracle(self) -> None:
        """Cancel a queued LP-oracle change. Admin or guardian (the guardian veto)."""
        self._assert_admin_or_guardian()
        self.pending_lp_oracle.value = UInt64(0)
        self.pending_lp_oracle_eta.value = UInt64(0)
