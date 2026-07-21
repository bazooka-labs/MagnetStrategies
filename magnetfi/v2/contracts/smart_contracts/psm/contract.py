from algopy import (
    Account,
    ARC4Contract,
    Asset,
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

# 48-hour timelock on the catastrophic vault-contract repointing power.
TIMELOCK_DELAY = 172_800  # 48 × 3600


class PSM(
    ARC4Contract,
    state_totals=StateTotals(global_uints=8, global_bytes=6),
):
    """
    ⚠️ SUPERSEDED — NOT the launch contract. The productive-reserves PSM in
    `smart_contracts/psm_v3/` (class PSMv3) replaces this for v3/mainnet. This original v2 PSM
    is retained ONLY because the v2 integration test suite (tests/conftest.py) deploys it to
    exercise the vault + lp_oracle. Do not deploy this; do not review it as live code.

    MagnetFi v2 Peg Stability Module.

    Holds USDC reserves and the non-circulating mUSD reserve.
    Core invariant: circulating_musd ≤ psm_usdc_balance  (enforced at issue and withdraw).

    circulating_musd = total_musd_supply − psm_musd_asa_balance
    vault_ceiling    = psm_usdc_balance − circulating_musd

    Two-role trust model:
      admin    — hot key: routine ops (fees, reserves, treasury, opt-in, mint pause).
      guardian — cold key: pause/unpause, cancel queued timelocked changes, recover admin.

    Public:   mint_musd, redeem_musd
    Vault:    issue_musd, receive_musd   (Txn.sender must be registered vault app address)
    Admin:    deposit_usdc, withdraw_usdc, set_redeem_fee, set_treasury,
              propose/confirm_vault_contract, opt_in_asset
    Guardian: pause, unpause, cancel_pending_vault_contract
    """

    def __init__(self) -> None:
        self.musd_asa_id = GlobalState(UInt64)
        self.usdc_asa_id = GlobalState(UInt64)
        self.redeem_fee_bps = GlobalState(UInt64)   # default 100 = 1%
        self.vault_app_id = GlobalState(UInt64)
        self.treasury_address = GlobalState(Account)

        # Two-role admin model.
        self.admin = GlobalState(Account)
        self.guardian = GlobalState(Account)
        self.pending_admin = GlobalState(Account)
        self.pending_guardian = GlobalState(Account)

        # Incident pause (gates public mint only; redeem/vault flows always open).
        self.paused = GlobalState(UInt64)

        # Timelocked vault-contract repointing.
        self.pending_vault_app_id = GlobalState(UInt64)
        self.pending_vault_eta = GlobalState(UInt64)

    # ── deployment ────────────────────────────────────────────────────────────

    @arc4.abimethod(allow_actions=["NoOp"], create="require")
    def deploy(
        self,
        musd_asa_id: UInt64,
        usdc_asa_id: UInt64,
        guardian: Account,
    ) -> None:
        """Create PSM. Caller becomes admin; guardian is a separate cold key."""
        assert musd_asa_id != UInt64(0), "musd_asa_id required"
        assert usdc_asa_id != UInt64(0), "usdc_asa_id required"
        assert musd_asa_id != usdc_asa_id, "musd and usdc must be different assets"
        assert guardian != Global.zero_address, "guardian required"
        assert guardian != Txn.sender, "guardian must differ from admin"
        self.musd_asa_id.value = musd_asa_id
        self.usdc_asa_id.value = usdc_asa_id
        self.redeem_fee_bps.value = UInt64(100)  # 1% default

        self.admin.value = Txn.sender
        self.guardian.value = guardian
        self.pending_admin.value = Global.zero_address
        self.pending_guardian.value = Global.zero_address
        self.paused.value = UInt64(0)
        self.pending_vault_app_id.value = UInt64(0)
        self.pending_vault_eta.value = UInt64(0)

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
    def _psm_musd_balance(self) -> UInt64:
        """Actual mUSD held by this contract — the unissued reserve."""
        bal, exists = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.musd_asa_id.value
        )
        assert exists, "PSM not opted into mUSD"
        return bal

    @subroutine
    def _psm_usdc_balance(self) -> UInt64:
        """Actual USDC held by this contract."""
        bal, exists = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.usdc_asa_id.value
        )
        assert exists, "PSM not opted into USDC"
        return bal

    @subroutine
    def _total_musd_supply(self) -> UInt64:
        """Total mUSD ASA supply — fixed at 500M × 10^6 base units, immutable post-creation."""
        total, exists = op.AssetParamsGet.asset_total(self.musd_asa_id.value)
        assert exists, "mUSD ASA not found"
        return total

    @subroutine
    def _circulating_musd(self) -> UInt64:
        """circulating = total_supply − psm_musd_balance (PSM holds all non-circulating mUSD)."""
        return self._total_musd_supply() - self._psm_musd_balance()

    @subroutine
    def _assert_vault_caller(self) -> None:
        """Txn.sender must be the registered vault contract's escrow address (AUD-038)."""
        vault_addr, exists = op.AppParamsGet.app_address(self.vault_app_id.value)
        assert exists, "vault app not found"
        assert Txn.sender == vault_addr, "caller is not registered vault"

    @subroutine
    def _wide_ratio(self, a: UInt64, b: UInt64, c: UInt64) -> UInt64:
        high, low = op.mulw(a, b)
        return op.divw(high, low, c)

    # ── role management ───────────────────────────────────────────────────────

    @arc4.abimethod
    def propose_admin(self, new_admin: Account) -> None:
        """
        Start 2-step admin rotation. Callable by admin OR guardian — the guardian path
        lets a lost/compromised hot key be recovered from the cold key.
        """
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
        # Clear any queued vault-contract repoint so a change proposed by the prior admin
        # can't be confirmed by the new one unaware of its provenance (P21-04).
        self.pending_vault_app_id.value = UInt64(0)
        self.pending_vault_eta.value = UInt64(0)

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
        """Halt public mint_musd. Either role can pause for fast response."""
        self._assert_admin_or_guardian()
        self.paused.value = UInt64(1)

    @arc4.abimethod
    def unpause(self) -> None:
        """Resume mint. Guardian only — a compromised hot key cannot lift a lockdown."""
        self._assert_guardian()
        self.paused.value = UInt64(0)

    # ── public methods (anyone) ───────────────────────────────────────────────

    @arc4.abimethod
    def mint_musd(self, amount: UInt64) -> None:
        """
        USDC → mUSD at 1:1, no fee. Self-balancing — vault ceiling unchanged.

        Atomic group: AppCall mint_musd(amount) + AssetTransfer(USDC → PSM, amount).
        The USDC lands in PSM from the outer-group AssetTransfer; PSM sends mUSD to caller.
        """
        assert self.paused.value == UInt64(0), "minting paused"
        assert amount > UInt64(0), "amount must be > 0"

        # Verify the outer group contains the correct USDC deposit (at index-1).
        assert op.Txn.group_index >= UInt64(1), "mint_musd not preceded by USDC deposit"
        usdc_xfer = op.Txn.group_index - UInt64(1)
        pay_txn = gtxn.AssetTransferTransaction(usdc_xfer)
        assert pay_txn.xfer_asset == Asset(self.usdc_asa_id.value), "wrong asset"
        assert pay_txn.asset_receiver == Global.current_application_address, "wrong receiver"
        assert pay_txn.asset_amount == amount, "amount mismatch"

        # PSM must hold enough mUSD reserve to issue.
        assert self._psm_musd_balance() >= amount, "insufficient mUSD reserve"

        itxn.AssetTransfer(
            xfer_asset=self.musd_asa_id.value,
            asset_receiver=Txn.sender,
            asset_amount=amount,
            fee=0,
        ).submit()

    @arc4.abimethod
    def redeem_musd(self, amount: UInt64) -> None:
        """
        mUSD → USDC at 1:1 with redeem_fee_bps fee routed to treasury.

        Atomic group: AppCall redeem_musd(amount) + AssetTransfer(mUSD → PSM, amount).

        usdc_out = floor(amount × (10_000 − redeem_fee_bps) / 10_000)
        fee_out  = amount − usdc_out   (sent to treasury wallet in USDC)

        Redemption stays open even while paused — users must always be able to exit.
        """
        assert amount > UInt64(0), "amount must be > 0"
        assert self.treasury_address, "treasury not set"

        # Verify the outer mUSD deposit (at index-1).
        assert op.Txn.group_index >= UInt64(1), "redeem_musd not preceded by mUSD deposit"
        musd_xfer = op.Txn.group_index - UInt64(1)
        musd_txn = gtxn.AssetTransferTransaction(musd_xfer)
        assert musd_txn.xfer_asset == Asset(self.musd_asa_id.value), "wrong asset"
        assert musd_txn.asset_receiver == Global.current_application_address, "wrong receiver"
        assert musd_txn.asset_amount == amount, "amount mismatch"

        fee_bps = self.redeem_fee_bps.value
        usdc_out = self._wide_ratio(amount, UInt64(10_000) - fee_bps, UInt64(10_000))
        assert usdc_out > UInt64(0), "amount too small (dust guard)"

        # PSM must hold enough USDC to cover both user payout and treasury fee.
        assert self._psm_usdc_balance() >= amount, "insufficient USDC reserve"

        # Send USDC to caller.
        itxn.AssetTransfer(
            xfer_asset=self.usdc_asa_id.value,
            asset_receiver=Txn.sender,
            asset_amount=usdc_out,
            fee=0,
        ).submit()

        # Send fee to treasury if non-zero (AUD-036: skip 0-amount transfer).
        fee_out = amount - usdc_out
        if fee_out > UInt64(0):
            itxn.AssetTransfer(
                xfer_asset=self.usdc_asa_id.value,
                asset_receiver=self.treasury_address.value,
                asset_amount=fee_out,
                fee=0,
            ).submit()

    # ── vault-only methods ────────────────────────────────────────────────────

    @arc4.abimethod
    def issue_musd(self, recipient: Account, amount: UInt64) -> None:
        """
        Mint mUSD to recipient — called by vault as cross-app inner transaction.

        Enforces the core invariant: circulating_musd + amount ≤ psm_usdc_balance.
        Only the registered vault contract can call this (AUD-038).
        """
        assert amount > UInt64(0), "amount must be > 0"
        self._assert_vault_caller()

        circulating = self._circulating_musd()
        usdc_bal = self._psm_usdc_balance()
        assert circulating + amount <= usdc_bal, "exceeds vault ceiling"

        itxn.AssetTransfer(
            xfer_asset=self.musd_asa_id.value,
            asset_receiver=recipient,
            asset_amount=amount,
            fee=0,
        ).submit()

    @arc4.abimethod
    def receive_musd(self, amount: UInt64) -> None:
        """
        Account for mUSD returned to PSM reserve — called by vault via inner transaction.

        mUSD arrives physically at PSM via the outer-group or sibling-inner AssetTransfer
        handled at the vault level. PSM's ASA balance increases regardless; this call lets
        PSM note the return for any future accounting (no Gtxn assertion — AUD-062).

        Security: only the registered vault app address can call this.
        """
        assert amount > UInt64(0), "amount must be > 0"
        self._assert_vault_caller()
        # No additional action needed — mUSD already landed at this address.
        # circulating_musd decreases automatically as psm_musd_balance increases.

    # ── admin methods ─────────────────────────────────────────────────────────

    @arc4.abimethod
    def deposit_usdc(self, amount: UInt64) -> None:
        """
        Admin deposits USDC into PSM, expanding the vault ceiling.

        Atomic group: AppCall deposit_usdc(amount) + AssetTransfer(USDC → PSM, amount).
        """
        self._assert_admin()
        assert amount > UInt64(0), "amount must be > 0"

        # USDC deposit must be at index-1.
        assert op.Txn.group_index >= UInt64(1), "deposit_usdc not preceded by USDC deposit"
        usdc_xfer = op.Txn.group_index - UInt64(1)
        pay_txn = gtxn.AssetTransferTransaction(usdc_xfer)
        assert pay_txn.xfer_asset == Asset(self.usdc_asa_id.value), "wrong asset"
        assert pay_txn.asset_receiver == Global.current_application_address, "wrong receiver"
        assert pay_txn.asset_amount == amount, "amount mismatch"

    @arc4.abimethod
    def withdraw_usdc(self, amount: UInt64) -> None:
        """
        Admin withdraws USDC from PSM.

        Guard (AUD-034): psm_usdc_balance ≥ circulating_musd + amount
        Written as addition to avoid uint64 underflow from the subtraction form.
        """
        self._assert_admin()
        assert amount > UInt64(0), "amount must be > 0"

        usdc_bal = self._psm_usdc_balance()
        circulating = self._circulating_musd()
        assert usdc_bal >= circulating + amount, "would break invariant"

        itxn.AssetTransfer(
            xfer_asset=self.usdc_asa_id.value,
            asset_receiver=self.admin.value,
            asset_amount=amount,
            fee=0,
        ).submit()

    @arc4.abimethod
    def set_redeem_fee(self, fee_bps: UInt64) -> None:
        """Set mUSD→USDC redemption fee. On-chain cap: 500 bps (5%)."""
        self._assert_admin()
        assert fee_bps <= UInt64(500), "max fee 500 bps"
        self.redeem_fee_bps.value = fee_bps

    @arc4.abimethod
    def set_treasury(self, address: Account) -> None:
        """Set treasury wallet for redemption fee routing. Zero address rejected (AUD-011)."""
        self._assert_admin()
        assert address != Global.zero_address, "zero address not allowed"
        self.treasury_address.value = address

    # ── timelocked vault-contract repointing ──────────────────────────────────

    @arc4.abimethod
    def propose_vault_contract(self, vault_app_id: UInt64) -> None:
        """
        Queue a change to the registered vault contract. Takes effect only after the
        48h timelock via confirm_vault_contract; guardian may cancel before then.
        Registering the wrong vault would authorize an attacker to mint mUSD — hence the delay.
        """
        self._assert_admin()
        assert vault_app_id != UInt64(0), "invalid vault app id"
        self.pending_vault_app_id.value = vault_app_id
        self.pending_vault_eta.value = Global.latest_timestamp + UInt64(TIMELOCK_DELAY)

    @arc4.abimethod
    def confirm_vault_contract(self) -> None:
        """Apply a queued vault-contract change after the timelock has elapsed."""
        self._assert_admin()
        assert self.pending_vault_app_id.value != UInt64(0), "no pending vault contract"
        assert Global.latest_timestamp >= self.pending_vault_eta.value, "timelock not elapsed"
        self.vault_app_id.value = self.pending_vault_app_id.value
        self.pending_vault_app_id.value = UInt64(0)
        self.pending_vault_eta.value = UInt64(0)

    @arc4.abimethod
    def cancel_pending_vault_contract(self) -> None:
        """Cancel a queued vault-contract change. Admin or guardian (the guardian veto)."""
        self._assert_admin_or_guardian()
        self.pending_vault_app_id.value = UInt64(0)
        self.pending_vault_eta.value = UInt64(0)

    @arc4.abimethod
    def opt_in_asset(self, asa_id: UInt64) -> None:
        """
        Opt PSM contract account into an ASA (mUSD, USDC).
        Must be called for both ASAs before first use.
        """
        self._assert_admin()
        assert asa_id != UInt64(0), "invalid ASA ID"
        itxn.AssetTransfer(
            xfer_asset=asa_id,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0,
        ).submit()
