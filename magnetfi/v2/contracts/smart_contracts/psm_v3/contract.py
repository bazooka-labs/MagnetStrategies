import typing

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
    urange,
)

# 48-hour timelock on catastrophic repointing powers (vault contract, adapter whitelist,
# treasury change) — reused from v2.
TIMELOCK_DELAY = 172_800  # 48 × 3600

# Max whitelisted yield adapters (compile-time bound on state + the invariant loop).
MAX_ADAPTERS = 5

# Dust tolerance (µUSDC). A recall shortfall at or below this is treated as entry-rounding
# noise (fUSDC mint rounds down) and does NOT crystallize a reserve deficit (F-3/F-4).
DUST_EPSILON = 10_000  # 0.01 USDC

# Fixed-length parallel arrays for the adapter registry (one slot per adapter, 0 = empty).
AdapterArray = arc4.StaticArray[arc4.UInt64, typing.Literal[5]]


class PSMv3(
    ARC4Contract,
    state_totals=StateTotals(global_uints=13, global_bytes=9),
):
    """
    MagnetFi v3 Peg Stability Module — Productive Reserves.

    The v2 PSM core (unchanged: mint/redeem/issue/receive, two-role trust model, timelocks)
    PLUS a yield-bearing reserve: idle USDC can be deployed to a whitelist of ≤5 vetted,
    immutable *adapter* contracts (Folks Finance first), each speaking one fixed interface:
        pool_deposit(uint64) / pool_withdraw(uint64)->uint64 / recoverable_value()->uint64.

    Redefined invariant (backing exists in two forms, both counted conservatively):
        circulating mUSD  ≤  on-chain USDC  +  Σ min(deployed_principalᵢ, recoverableᵢ)
    counting min() so a venue can never over-report backing, and an impaired venue counts 0.

    Non-negotiables preserved: instant 1:1 redeemability (buffer-primary) and the invariant.
    Yield (recoverable − principal) is a bonus swept to treasury, never counted as backing.
    Immutable (no UpdateApplication), as v2.

    See PSM.md → Productive Reserves (v3). NOT deployed — pre-audit build.
    """

    def __init__(self) -> None:
        # ── v2 core state ──
        self.musd_asa_id = GlobalState(UInt64)
        self.usdc_asa_id = GlobalState(UInt64)
        self.redeem_fee_bps = GlobalState(UInt64)   # default 100 = 1%
        self.vault_app_id = GlobalState(UInt64)
        self.treasury_address = GlobalState(Account)

        self.admin = GlobalState(Account)
        self.guardian = GlobalState(Account)
        self.pending_admin = GlobalState(Account)
        self.pending_guardian = GlobalState(Account)

        self.paused = GlobalState(UInt64)

        self.pending_vault_app_id = GlobalState(UInt64)
        self.pending_vault_eta = GlobalState(UInt64)

        # ── v3 productive-reserves state ──
        # Parallel adapter registry: adapter app id, principal receipt, impairment flag.
        self.adapter_ids = GlobalState(AdapterArray)
        self.deployed_principal = GlobalState(AdapterArray)
        self.adapter_impaired = GlobalState(AdapterArray)  # 1 = impaired (value loss OR halt)

        # Outstanding amount the reserve owes itself after a realized loss (freeze/restore gate).
        self.reserve_deficit = GlobalState(UInt64)

        # Deploy-time guardrails.
        self.buffer_bps = GlobalState(UInt64)      # min on-chain USDC fraction of total reserve
        self.max_venue_bps = GlobalState(UInt64)   # per-venue cap as fraction of total reserve

        # Timelocked adapter whitelisting.
        self.pending_adapter_id = GlobalState(UInt64)
        self.pending_adapter_eta = GlobalState(UInt64)

        # Timelocked treasury change (F-7). Initial set is immediate while treasury == zero.
        self.pending_treasury = GlobalState(Account)
        self.pending_treasury_eta = GlobalState(UInt64)

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
        self.treasury_address.value = Global.zero_address
        self.paused.value = UInt64(0)
        self.pending_vault_app_id.value = UInt64(0)
        self.pending_vault_eta.value = UInt64(0)

        # v3 defaults: keep ≥70% liquid (deploy ≤30%); single-venue cap starts at 100%
        # (total deployment governed by the buffer). Both admin-tunable post-deploy.
        self.buffer_bps.value = UInt64(7_000)
        self.max_venue_bps.value = UInt64(10_000)
        self.reserve_deficit.value = UInt64(0)
        self.pending_adapter_id.value = UInt64(0)
        self.pending_adapter_eta.value = UInt64(0)
        self.pending_treasury.value = Global.zero_address
        self.pending_treasury_eta.value = UInt64(0)
        self.adapter_ids.value = AdapterArray(
            arc4.UInt64(0), arc4.UInt64(0), arc4.UInt64(0), arc4.UInt64(0), arc4.UInt64(0)
        )
        self.deployed_principal.value = AdapterArray(
            arc4.UInt64(0), arc4.UInt64(0), arc4.UInt64(0), arc4.UInt64(0), arc4.UInt64(0)
        )
        self.adapter_impaired.value = AdapterArray(
            arc4.UInt64(0), arc4.UInt64(0), arc4.UInt64(0), arc4.UInt64(0), arc4.UInt64(0)
        )

    # ── internal helpers (v2, unchanged) ───────────────────────────────────────

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
        bal, exists = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.musd_asa_id.value
        )
        assert exists, "PSM not opted into mUSD"
        return bal

    @subroutine
    def _psm_usdc_balance(self) -> UInt64:
        bal, exists = op.AssetHoldingGet.asset_balance(
            Global.current_application_address, self.usdc_asa_id.value
        )
        assert exists, "PSM not opted into USDC"
        return bal

    @subroutine
    def _total_musd_supply(self) -> UInt64:
        total, exists = op.AssetParamsGet.asset_total(self.musd_asa_id.value)
        assert exists, "mUSD ASA not found"
        return total

    @subroutine
    def _circulating_musd(self) -> UInt64:
        return self._total_musd_supply() - self._psm_musd_balance()

    @subroutine
    def _assert_vault_caller(self) -> None:
        vault_addr, exists = op.AppParamsGet.app_address(self.vault_app_id.value)
        assert exists, "vault app not found"
        assert Txn.sender == vault_addr, "caller is not registered vault"

    @subroutine
    def _wide_ratio(self, a: UInt64, b: UInt64, c: UInt64) -> UInt64:
        high, low = op.mulw(a, b)
        return op.divw(high, low, c)

    # ── internal helpers (v3 productive reserves) ───────────────────────────────

    @subroutine
    def _adapter_address(self, adapter_app_id: UInt64) -> Account:
        addr, exists = op.AppParamsGet.app_address(adapter_app_id)
        assert exists, "adapter app not found"
        return addr

    @subroutine
    def _find_adapter_slot(self, adapter_app_id: UInt64) -> UInt64:
        """Return the registry index [0..4] holding adapter_app_id, or MAX_ADAPTERS if absent.
        Caller must pass a non-zero id (0 is the empty-slot sentinel)."""
        ids = self.adapter_ids.value.copy()
        result = UInt64(MAX_ADAPTERS)
        for i in urange(MAX_ADAPTERS):
            if ids[i].native == adapter_app_id:
                result = i
        return result

    @subroutine
    def _free_slot(self) -> UInt64:
        """Return the index of the first empty registry slot, or MAX_ADAPTERS if full."""
        ids = self.adapter_ids.value.copy()
        result = UInt64(MAX_ADAPTERS)
        for i in urange(MAX_ADAPTERS):
            # Walk high→low so the lowest empty index wins.
            j = UInt64(MAX_ADAPTERS) - UInt64(1) - i
            if ids[j].native == UInt64(0):
                result = j
        return result

    @subroutine
    def _set_slot(self, slot: UInt64, aid: UInt64, principal: UInt64, impaired: UInt64) -> None:
        ids = self.adapter_ids.value.copy()
        principals = self.deployed_principal.value.copy()
        flags = self.adapter_impaired.value.copy()
        ids[slot] = arc4.UInt64(aid)
        principals[slot] = arc4.UInt64(principal)
        flags[slot] = arc4.UInt64(impaired)
        self.adapter_ids.value = ids.copy()
        self.deployed_principal.value = principals.copy()
        self.adapter_impaired.value = flags.copy()

    @subroutine
    def _set_principal(self, slot: UInt64, principal: UInt64) -> None:
        principals = self.deployed_principal.value.copy()
        principals[slot] = arc4.UInt64(principal)
        self.deployed_principal.value = principals.copy()

    @subroutine
    def _principal_at(self, slot: UInt64) -> UInt64:
        principals = self.deployed_principal.value.copy()
        return principals[slot].native

    @subroutine
    def _total_deployed_principal(self) -> UInt64:
        principals = self.deployed_principal.value.copy()
        total = UInt64(0)
        for i in urange(MAX_ADAPTERS):
            total += principals[i].native
        return total

    @subroutine
    def _any_impaired(self) -> bool:
        ids = self.adapter_ids.value.copy()
        flags = self.adapter_impaired.value.copy()
        result = False
        for i in urange(MAX_ADAPTERS):
            if ids[i].native != UInt64(0) and flags[i].native != UInt64(0):
                result = True
        return result

    @subroutine
    def _adapter_recoverable(self, adapter_app_id: UInt64) -> UInt64:
        """Read a venue position's recoverable USDC value via the adapter interface."""
        result, _txn = arc4.abi_call[arc4.UInt64](
            "recoverable_value()uint64",
            app_id=adapter_app_id,
        )
        return result.native

    @subroutine
    def _deployed_backing(self) -> UInt64:
        """Σ over active adapters of min(deployed_principal, recoverable); impaired venues = 0."""
        ids = self.adapter_ids.value.copy()
        principals = self.deployed_principal.value.copy()
        flags = self.adapter_impaired.value.copy()
        total = UInt64(0)
        for i in urange(MAX_ADAPTERS):
            aid = ids[i].native
            if aid != UInt64(0) and flags[i].native == UInt64(0):
                principal = principals[i].native
                recoverable = self._adapter_recoverable(aid)
                total += principal if principal <= recoverable else recoverable
        return total

    @subroutine
    def _total_backing(self) -> UInt64:
        """on-chain USDC + Σ min(principal, recoverable). What the invariant measures."""
        return self._psm_usdc_balance() + self._deployed_backing()

    # ── role management (v2, admin-change also clears v3 pendings) ───────────────

    @arc4.abimethod
    def propose_admin(self, new_admin: Account) -> None:
        self._assert_admin_or_guardian()
        assert new_admin != Global.zero_address, "zero address not allowed"
        assert new_admin != self.guardian.value, "admin must differ from guardian"
        self.pending_admin.value = new_admin

    @arc4.abimethod
    def accept_admin(self) -> None:
        assert self.pending_admin.value != Global.zero_address, "no pending admin"
        assert Txn.sender == self.pending_admin.value, "not pending admin"
        self.admin.value = self.pending_admin.value
        self.pending_admin.value = Global.zero_address
        # Clear any queued privileged change so it can't be confirmed by a new admin
        # unaware of its provenance (P21-04, extended to adapter + treasury queues).
        self.pending_vault_app_id.value = UInt64(0)
        self.pending_vault_eta.value = UInt64(0)
        self.pending_adapter_id.value = UInt64(0)
        self.pending_adapter_eta.value = UInt64(0)
        self.pending_treasury.value = Global.zero_address
        self.pending_treasury_eta.value = UInt64(0)

    @arc4.abimethod
    def propose_guardian(self, new_guardian: Account) -> None:
        self._assert_guardian()
        assert new_guardian != Global.zero_address, "zero address not allowed"
        assert new_guardian != self.admin.value, "guardian must differ from admin"
        self.pending_guardian.value = new_guardian

    @arc4.abimethod
    def accept_guardian(self) -> None:
        assert self.pending_guardian.value != Global.zero_address, "no pending guardian"
        assert Txn.sender == self.pending_guardian.value, "not pending guardian"
        self.guardian.value = self.pending_guardian.value
        self.pending_guardian.value = Global.zero_address

    # ── pause (incident response) ──────────────────────────────────────────────

    @arc4.abimethod
    def pause(self) -> None:
        self._assert_admin_or_guardian()
        self.paused.value = UInt64(1)

    @arc4.abimethod
    def unpause(self) -> None:
        self._assert_guardian()
        self.paused.value = UInt64(0)

    # ── public methods (v2, unchanged) ─────────────────────────────────────────

    @arc4.abimethod
    def mint_musd(self, amount: UInt64) -> None:
        """USDC → mUSD 1:1, no fee. Self-balancing; the redefined invariant holds automatically."""
        assert self.paused.value == UInt64(0), "minting paused"
        assert amount > UInt64(0), "amount must be > 0"

        assert op.Txn.group_index >= UInt64(1), "mint_musd not preceded by USDC deposit"
        usdc_xfer = op.Txn.group_index - UInt64(1)
        pay_txn = gtxn.AssetTransferTransaction(usdc_xfer)
        assert pay_txn.xfer_asset == Asset(self.usdc_asa_id.value), "wrong asset"
        assert pay_txn.asset_receiver == Global.current_application_address, "wrong receiver"
        assert pay_txn.asset_amount == amount, "amount mismatch"

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
        mUSD → USDC 1:1 minus redeem_fee_bps. BUFFER-PRIMARY (H-2): pays from on-chain USDC
        only, unchanged from v2. Reverts if the buffer can't cover — the accepted, bounded
        liquidity tail-risk (admin recalls to top up). Redemption lowers circulating and
        on-chain USDC equally, so the invariant is preserved without evaluating the sum.
        """
        assert amount > UInt64(0), "amount must be > 0"
        assert self.treasury_address.value != Global.zero_address, "treasury not set"

        assert op.Txn.group_index >= UInt64(1), "redeem_musd not preceded by mUSD deposit"
        musd_xfer = op.Txn.group_index - UInt64(1)
        musd_txn = gtxn.AssetTransferTransaction(musd_xfer)
        assert musd_txn.xfer_asset == Asset(self.musd_asa_id.value), "wrong asset"
        assert musd_txn.asset_receiver == Global.current_application_address, "wrong receiver"
        assert musd_txn.asset_amount == amount, "amount mismatch"

        fee_bps = self.redeem_fee_bps.value
        usdc_out = self._wide_ratio(amount, UInt64(10_000) - fee_bps, UInt64(10_000))
        assert usdc_out > UInt64(0), "amount too small (dust guard)"

        assert self._psm_usdc_balance() >= amount, "insufficient liquid reserve — retry shortly"

        itxn.AssetTransfer(
            xfer_asset=self.usdc_asa_id.value,
            asset_receiver=Txn.sender,
            asset_amount=usdc_out,
            fee=0,
        ).submit()

        fee_out = amount - usdc_out
        if fee_out > UInt64(0):
            itxn.AssetTransfer(
                xfer_asset=self.usdc_asa_id.value,
                asset_receiver=self.treasury_address.value,
                asset_amount=fee_out,
                fee=0,
            ).submit()

    # ── vault-only methods ──────────────────────────────────────────────────────

    @arc4.abimethod
    def issue_musd(self, recipient: Account, amount: UInt64) -> None:
        """
        Mint mUSD to recipient (vault cross-app call). MODIFIED for v3:
        - Enforces the redefined invariant: circulating + amount ≤ on-chain USDC + Σ min(...).
          Reads each active adapter's recoverable_value live, so a paper loss (recoverable <
          principal) immediately reduces headroom (the borrow group must reference each active
          adapter app; at launch that is the single Folks adapter).
        - Frozen while reserve_deficit > 0 or any adapter is impaired (F-4/F-6).
        """
        assert amount > UInt64(0), "amount must be > 0"
        self._assert_vault_caller()
        assert self.reserve_deficit.value == UInt64(0), "issuance frozen — reserve deficit"
        assert not self._any_impaired(), "issuance frozen — adapter impaired"

        circulating = self._circulating_musd()
        assert circulating + amount <= self._total_backing(), "exceeds vault ceiling"

        itxn.AssetTransfer(
            xfer_asset=self.musd_asa_id.value,
            asset_receiver=recipient,
            asset_amount=amount,
            fee=0,
        ).submit()

    @arc4.abimethod
    def receive_musd(self, amount: UInt64) -> None:
        """Account for mUSD returned to reserve (vault cross-app call). Unchanged from v2."""
        assert amount > UInt64(0), "amount must be > 0"
        self._assert_vault_caller()

    # ── admin methods: reserves ─────────────────────────────────────────────────

    @arc4.abimethod
    def deposit_usdc(self, amount: UInt64) -> None:
        """Admin deposits USDC into PSM, expanding the buffer / ceiling. Unchanged from v2."""
        self._assert_admin()
        assert amount > UInt64(0), "amount must be > 0"

        assert op.Txn.group_index >= UInt64(1), "deposit_usdc not preceded by USDC deposit"
        usdc_xfer = op.Txn.group_index - UInt64(1)
        pay_txn = gtxn.AssetTransferTransaction(usdc_xfer)
        assert pay_txn.xfer_asset == Asset(self.usdc_asa_id.value), "wrong asset"
        assert pay_txn.asset_receiver == Global.current_application_address, "wrong receiver"
        assert pay_txn.asset_amount == amount, "amount mismatch"

    @arc4.abimethod
    def withdraw_usdc(self, amount: UInt64) -> None:
        """
        Admin withdraws USDC from PSM. MODIFIED for v3 — buffer-aware and deficit-frozen (F-5):
            amount ≤ min(on-chain USDC − buffer, total_backing − circulating)
        written in underflow-safe additive form (on-chain − buffer legitimately underflows once
        redemptions have drawn the buffer down). Frozen while reserve_deficit > 0 so reserves
        cannot leave while under-reserved.
        """
        self._assert_admin()
        assert amount > UInt64(0), "amount must be > 0"
        assert self.reserve_deficit.value == UInt64(0), "withdraw frozen — reserve deficit"

        on_chain = self._psm_usdc_balance()
        circulating = self._circulating_musd()
        total_reserve = on_chain + self._total_deployed_principal()
        buffer_floor = self._wide_ratio(total_reserve, self.buffer_bps.value, UInt64(10_000))

        # amount ≤ on-chain − buffer  →  on-chain ≥ amount + buffer_floor
        assert on_chain >= amount + buffer_floor, "would breach liquidity buffer"
        # amount ≤ total_backing − circulating  →  total_backing ≥ circulating + amount
        assert self._total_backing() >= circulating + amount, "would break invariant"

        itxn.AssetTransfer(
            xfer_asset=self.usdc_asa_id.value,
            asset_receiver=self.admin.value,
            asset_amount=amount,
            fee=0,
        ).submit()

    @arc4.abimethod
    def restore(self, amount: UInt64) -> None:
        """
        Admin deposits USDC to pay down reserve_deficit after a realized venue loss.
        Atomic group: AppCall restore(amount) + AssetTransfer(USDC → PSM, amount).
        The USDC lands in PSM (real backing) and the deficit counter drops; at zero, full 1:1
        backing is restored and issuance re-enables.
        """
        self._assert_admin()
        assert amount > UInt64(0), "amount must be > 0"

        assert op.Txn.group_index >= UInt64(1), "restore not preceded by USDC deposit"
        usdc_xfer = op.Txn.group_index - UInt64(1)
        pay_txn = gtxn.AssetTransferTransaction(usdc_xfer)
        assert pay_txn.xfer_asset == Asset(self.usdc_asa_id.value), "wrong asset"
        assert pay_txn.asset_receiver == Global.current_application_address, "wrong receiver"
        assert pay_txn.asset_amount == amount, "amount mismatch"

        deficit = self.reserve_deficit.value
        paid = amount if amount <= deficit else deficit
        self.reserve_deficit.value = deficit - paid

    # ── admin methods: fees / treasury ──────────────────────────────────────────

    @arc4.abimethod
    def set_redeem_fee(self, fee_bps: UInt64) -> None:
        """Set mUSD→USDC redemption fee. On-chain cap: 500 bps (5%)."""
        self._assert_admin()
        assert fee_bps <= UInt64(500), "max fee 500 bps"
        self.redeem_fee_bps.value = fee_bps

    @arc4.abimethod
    def set_treasury(self, address: Account) -> None:
        """
        Set treasury wallet — INITIAL bootstrap only (while treasury is unset). Because harvest
        routes yield here, later changes must go through the 48h timelock (F-7).
        """
        self._assert_admin()
        assert address != Global.zero_address, "zero address not allowed"
        assert self.treasury_address.value == Global.zero_address, "already set — use propose_treasury"
        self.treasury_address.value = address

    @arc4.abimethod
    def propose_treasury(self, address: Account) -> None:
        """Queue a treasury change (48h timelock + guardian veto) — harvest destination (F-7)."""
        self._assert_admin()
        assert address != Global.zero_address, "zero address not allowed"
        self.pending_treasury.value = address
        self.pending_treasury_eta.value = Global.latest_timestamp + UInt64(TIMELOCK_DELAY)

    @arc4.abimethod
    def confirm_treasury(self) -> None:
        self._assert_admin()
        assert self.pending_treasury.value != Global.zero_address, "no pending treasury"
        assert Global.latest_timestamp >= self.pending_treasury_eta.value, "timelock not elapsed"
        self.treasury_address.value = self.pending_treasury.value
        self.pending_treasury.value = Global.zero_address
        self.pending_treasury_eta.value = UInt64(0)

    @arc4.abimethod
    def cancel_pending_treasury(self) -> None:
        self._assert_admin_or_guardian()
        self.pending_treasury.value = Global.zero_address
        self.pending_treasury_eta.value = UInt64(0)

    # ── timelocked vault-contract repointing (v2, unchanged) ────────────────────

    @arc4.abimethod
    def propose_vault_contract(self, vault_app_id: UInt64) -> None:
        self._assert_admin()
        assert vault_app_id != UInt64(0), "invalid vault app id"
        self.pending_vault_app_id.value = vault_app_id
        self.pending_vault_eta.value = Global.latest_timestamp + UInt64(TIMELOCK_DELAY)

    @arc4.abimethod
    def confirm_vault_contract(self) -> None:
        self._assert_admin()
        assert self.pending_vault_app_id.value != UInt64(0), "no pending vault contract"
        assert Global.latest_timestamp >= self.pending_vault_eta.value, "timelock not elapsed"
        self.vault_app_id.value = self.pending_vault_app_id.value
        self.pending_vault_app_id.value = UInt64(0)
        self.pending_vault_eta.value = UInt64(0)

    @arc4.abimethod
    def cancel_pending_vault_contract(self) -> None:
        self._assert_admin_or_guardian()
        self.pending_vault_app_id.value = UInt64(0)
        self.pending_vault_eta.value = UInt64(0)

    # ── timelocked adapter whitelist (v3) ───────────────────────────────────────

    @arc4.abimethod
    def propose_adapter(self, adapter_app_id: UInt64) -> None:
        """
        Queue adding a yield adapter. Takes effect after the 48h timelock via confirm_adapter;
        guardian may cancel. A malicious adapter could only affect funds later deployed to it,
        but the delay + veto keep whitelisting deliberate.
        """
        self._assert_admin()
        assert adapter_app_id != UInt64(0), "invalid adapter app id"
        assert self._find_adapter_slot(adapter_app_id) == UInt64(MAX_ADAPTERS), "already whitelisted"
        assert self._free_slot() < UInt64(MAX_ADAPTERS), "adapter registry full"
        self.pending_adapter_id.value = adapter_app_id
        self.pending_adapter_eta.value = Global.latest_timestamp + UInt64(TIMELOCK_DELAY)

    @arc4.abimethod
    def confirm_adapter(self) -> None:
        """Whitelist a queued adapter after the timelock elapses."""
        self._assert_admin()
        aid = self.pending_adapter_id.value
        assert aid != UInt64(0), "no pending adapter"
        assert Global.latest_timestamp >= self.pending_adapter_eta.value, "timelock not elapsed"
        assert self._find_adapter_slot(aid) == UInt64(MAX_ADAPTERS), "already whitelisted"
        slot = self._free_slot()
        assert slot < UInt64(MAX_ADAPTERS), "adapter registry full"
        self._set_slot(slot, aid, UInt64(0), UInt64(0))
        self.pending_adapter_id.value = UInt64(0)
        self.pending_adapter_eta.value = UInt64(0)

    @arc4.abimethod
    def cancel_pending_adapter(self) -> None:
        """Cancel a queued adapter (admin or the guardian veto)."""
        self._assert_admin_or_guardian()
        self.pending_adapter_id.value = UInt64(0)
        self.pending_adapter_eta.value = UInt64(0)

    @arc4.abimethod
    def remove_adapter(self, adapter_app_id: UInt64) -> None:
        """
        De-whitelist an adapter. Requires it be fully wound down — no principal receipt and
        zero recoverable value — so funds can never be orphaned in a removed venue.
        """
        self._assert_admin()
        slot = self._find_adapter_slot(adapter_app_id)
        assert slot < UInt64(MAX_ADAPTERS), "not whitelisted"
        assert self._principal_at(slot) == UInt64(0), "recall principal first"
        assert self._adapter_recoverable(adapter_app_id) == UInt64(0), "adapter still holds value"
        self._set_slot(slot, UInt64(0), UInt64(0), UInt64(0))

    # ── strategy operations (v3) ────────────────────────────────────────────────

    @arc4.abimethod
    def strategy_deploy(self, adapter_app_id: UInt64, amount: UInt64) -> None:
        """
        Route `amount` idle USDC PSM → adapter → venue and record the principal receipt.
        Asserts, after the move: the liquidity buffer holds, the per-venue cap holds, and the
        invariant holds. Frozen while paused, in deficit, or any adapter is impaired.
        """
        self._assert_admin()
        assert amount > UInt64(0), "amount must be > 0"
        assert self.paused.value == UInt64(0), "deploy paused"
        assert self.reserve_deficit.value == UInt64(0), "deploy frozen — reserve deficit"
        assert not self._any_impaired(), "deploy frozen — adapter impaired"

        slot = self._find_adapter_slot(adapter_app_id)
        assert slot < UInt64(MAX_ADAPTERS), "adapter not whitelisted"

        on_chain = self._psm_usdc_balance()
        total_reserve = on_chain + self._total_deployed_principal()

        # Guardrail 1: on-chain USDC after deploy ≥ buffer floor (F-8, deploy-time throttle).
        buffer_floor = self._wide_ratio(total_reserve, self.buffer_bps.value, UInt64(10_000))
        assert on_chain >= amount + buffer_floor, "would breach liquidity buffer"

        # Guardrail 2: per-venue exposure cap on principal.
        principal_after = self._principal_at(slot) + amount
        venue_cap = self._wide_ratio(total_reserve, self.max_venue_bps.value, UInt64(10_000))
        assert principal_after <= venue_cap, "would breach per-venue cap"

        # Move USDC to the adapter, then have it take custody / enter the venue.
        itxn.AssetTransfer(
            xfer_asset=self.usdc_asa_id.value,
            asset_receiver=self._adapter_address(adapter_app_id),
            asset_amount=amount,
            fee=0,
        ).submit()
        arc4.abi_call("pool_deposit(uint64)void", amount, app_id=adapter_app_id)

        self._set_principal(slot, principal_after)

        # Guardrail 3: invariant still holds against the freshly-valued reserve.
        assert self._circulating_musd() <= self._total_backing(), "would break invariant"

    @arc4.abimethod
    def strategy_recall(self, adapter_app_id: UInt64, amount: UInt64) -> None:
        """
        Withdraw USDC from a venue back into the PSM buffer (principal → reserve). Admin-directed
        and per-venue. Precise loss accounting (F-4):
            retired = min(deployed_principal, amount);   deployed_principal −= retired
            shortfall = max(0, retired − recovered);     reserve_deficit += shortfall (if > ε)
        Any recovered value above retired principal simply stays as buffer USDC (over-backing).
        Allowed during pause/deficit — recall only brings funds home.
        """
        self._assert_admin()
        assert amount > UInt64(0), "amount must be > 0"
        slot = self._find_adapter_slot(adapter_app_id)
        assert slot < UInt64(MAX_ADAPTERS), "adapter not whitelisted"

        recovered, _txn = arc4.abi_call[arc4.UInt64](
            "pool_withdraw(uint64)uint64",
            amount,
            app_id=adapter_app_id,
        )
        recovered_usdc = recovered.native

        principal = self._principal_at(slot)
        retired = principal if principal <= amount else amount
        self._set_principal(slot, principal - retired)

        if retired > recovered_usdc:
            shortfall = retired - recovered_usdc
            if shortfall > UInt64(DUST_EPSILON):
                self.reserve_deficit.value = self.reserve_deficit.value + shortfall

    @arc4.abimethod
    def strategy_harvest(self, adapter_app_id: UInt64) -> None:
        """
        Sweep only realized yield (recoverable − principal) to treasury. Self-verifying (F-1):
        routes only what actually withdraws, then asserts recoverable ≥ principal AFTER the
        sweep — so a too-high venue mark can never pull principal out (the assert reverts the
        whole transaction, including the treasury transfer). Halted while paused or in deficit
        (F-7); skips impaired venues.
        """
        self._assert_admin()
        assert self.paused.value == UInt64(0), "harvest paused"
        assert self.reserve_deficit.value == UInt64(0), "harvest frozen — reserve deficit"
        assert self.treasury_address.value != Global.zero_address, "treasury not set"

        slot = self._find_adapter_slot(adapter_app_id)
        assert slot < UInt64(MAX_ADAPTERS), "adapter not whitelisted"
        flags = self.adapter_impaired.value.copy()
        assert flags[slot].native == UInt64(0), "adapter impaired"

        principal = self._principal_at(slot)
        recoverable_before = self._adapter_recoverable(adapter_app_id)
        assert recoverable_before > principal, "no yield to harvest"
        yield_amt = recoverable_before - principal

        recovered, _txn = arc4.abi_call[arc4.UInt64](
            "pool_withdraw(uint64)uint64",
            yield_amt,
            app_id=adapter_app_id,
        )
        realized = recovered.native
        assert realized > UInt64(0), "nothing realized"

        itxn.AssetTransfer(
            xfer_asset=self.usdc_asa_id.value,
            asset_receiver=self.treasury_address.value,
            asset_amount=realized,
            fee=0,
        ).submit()

        # Self-verify: principal must remain fully recoverable after the sweep.
        assert self._adapter_recoverable(adapter_app_id) >= principal, "harvest would impair principal"

    @arc4.abimethod
    def mark_impaired(self, adapter_app_id: UInt64, flag: UInt64) -> None:
        """
        Manually mark/unmark an adapter impaired (F-6). Applies to a value loss OR a withdrawal
        halt (a venue whose index still reads healthy but won't return funds). While marked, the
        venue counts 0 backing and issuance/deploy are frozen. Admin or guardian (safety brake).
        """
        self._assert_admin_or_guardian()
        assert flag <= UInt64(1), "flag must be 0 or 1"
        slot = self._find_adapter_slot(adapter_app_id)
        assert slot < UInt64(MAX_ADAPTERS), "adapter not whitelisted"
        flags = self.adapter_impaired.value.copy()
        flags[slot] = arc4.UInt64(flag)
        self.adapter_impaired.value = flags.copy()

    # ── admin methods: config / opt-in ──────────────────────────────────────────

    @arc4.abimethod
    def set_buffer_bps(self, bps: UInt64) -> None:
        """Set the minimum on-chain liquidity buffer (fraction of total reserve). ≤ 100%."""
        self._assert_admin()
        assert bps <= UInt64(10_000), "max 10000 bps"
        self.buffer_bps.value = bps

    @arc4.abimethod
    def set_venue_cap_bps(self, bps: UInt64) -> None:
        """Set the per-venue exposure cap (fraction of total reserve). ≤ 100%."""
        self._assert_admin()
        assert bps <= UInt64(10_000), "max 10000 bps"
        self.max_venue_bps.value = bps

    @arc4.abimethod
    def opt_in_asset(self, asa_id: UInt64) -> None:
        """Opt PSM into an ASA (mUSD, USDC). Admin only."""
        self._assert_admin()
        assert asa_id != UInt64(0), "invalid ASA ID"
        itxn.AssetTransfer(
            xfer_asset=asa_id,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0,
        ).submit()
