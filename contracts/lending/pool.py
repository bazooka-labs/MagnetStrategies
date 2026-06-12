from algopy import (
    ARC4Contract,
    Account,
    BoxMap,
    Bytes,
    Global,
    GlobalState,
    Txn,
    UInt64,
    arc4,
    gtxn,
    itxn,
    op,
    subroutine,
)


# ── Constants ──────────────────────────────────────────────────────────────────

BLOCKS_PER_YEAR = 9_565_009   # ~3.3s/block × 365.25 days
DEAD_SHARES = 1_000
ORACLE_STALENESS = 600         # 10 minutes in seconds
GRACE_PERIOD = 7_200           # 2 hours in seconds
MIN_ALGO_RESERVE = 1_000_000   # 1 ALGO in microALGO


# ── Box value structs ──────────────────────────────────────────────────────────

class BorrowerState(arc4.Struct):
    collateral_amount: arc4.UInt64
    borrow_balance: arc4.UInt64
    last_accrual_block: arc4.UInt64
    eligible_timestamp: arc4.UInt64
    liquidation_state: arc4.UInt64        # 0=none 1=eligible 2=in_liquidation
    outstanding_registered: arc4.UInt64  # 0=false 1=true; prevents double pool registration


class LiquidationState(arc4.Struct):
    outstanding_balance: arc4.UInt64
    collateral_held: arc4.UInt64


# ── Pool contract ──────────────────────────────────────────────────────────────

class PoolContract(ARC4Contract):

    def __init__(self) -> None:
        # Asset IDs — set once at initialize(), immutable thereafter
        self.deposit_asset_id = GlobalState(UInt64, key="dep_asset")
        self.collateral_asset_id = GlobalState(UInt64, key="col_asset")
        # Oracle
        self.oracle_app_id = GlobalState(UInt64, key="oracle_app")
        # Pool accounting
        self.total_deposits = GlobalState(UInt64, key="total_dep")
        self.total_shares = GlobalState(UInt64, key="total_shares")
        self.dead_shares = GlobalState(UInt64, key="dead_shares")
        self.total_borrowed = GlobalState(UInt64, key="total_borrow")
        self.outstanding_liq_bal = GlobalState(UInt64, key="out_liq_bal")
        self.protocol_reserve = GlobalState(UInt64, key="proto_rsrv")
        self.last_accrual_block = GlobalState(UInt64, key="last_accrual")
        # Interest rate model
        self.base_rate_bps = GlobalState(UInt64, key="base_rate")
        self.optimal_rate_bps = GlobalState(UInt64, key="opt_rate")
        self.max_rate_bps = GlobalState(UInt64, key="max_rate")
        self.kink_bps = GlobalState(UInt64, key="kink")
        self.protocol_fee_bps = GlobalState(UInt64, key="fee_bps")
        # LTV / liquidation parameters
        self.ltv_bps = GlobalState(UInt64, key="ltv_bps")
        self.liq_threshold_bps = GlobalState(UInt64, key="liq_thresh")
        self.min_borrow = GlobalState(UInt64, key="min_borrow")
        # Box maps
        self.lenders = BoxMap(Account, UInt64, key_prefix=b"lend_")
        self.borrowers = BoxMap(Account, BorrowerState, key_prefix=b"borrow_")
        self.liquidations = BoxMap(Account, LiquidationState, key_prefix=b"liq_")

    # ─────────────────────────────────────────────────────────────────────────
    # Deployment
    # ─────────────────────────────────────────────────────────────────────────

    @arc4.baremethod(create="require")
    def create(self) -> None:
        pass

    @arc4.abimethod
    def optin_asa(self, asset: UInt64) -> None:
        """Opt the pool into an ASA. Admin only. Must be called for both assets before initialize()."""
        assert Txn.sender == Global.creator_address, "not admin"
        itxn.AssetTransfer(
            xfer_asset=asset,
            asset_receiver=Global.current_application_address,
            asset_amount=UInt64(0),
            fee=UInt64(0),
        ).submit()

    @arc4.abimethod
    def initialize(
        self,
        deposit_asset: UInt64,
        collateral_asset: UInt64,
        oracle_app: UInt64,
        base_rate: UInt64,
        optimal_rate: UInt64,
        max_rate: UInt64,
        kink: UInt64,
        fee_bps: UInt64,
        ltv: UInt64,
        liq_threshold: UInt64,
        min_borrow_amount: UInt64,
    ) -> None:
        """
        Initialize the pool. Must be called in an atomic group containing a DEAD_AMOUNT
        asset transfer at index 1. Both ASAs must be opted in before calling. Admin only.
        Can only be called once.
        """
        assert Txn.sender == Global.creator_address, "not admin"
        assert not self.deposit_asset_id, "already initialized"
        assert Global.group_size == UInt64(2), "init requires atomic group of exactly 2"
        assert base_rate <= optimal_rate, "base_rate must be <= optimal_rate"
        assert optimal_rate <= max_rate, "optimal_rate must be <= max_rate"

        dead_transfer = gtxn.AssetTransferTransaction(1)
        assert dead_transfer.xfer_asset == deposit_asset, "wrong asset in init group"
        dead_amount = dead_transfer.asset_amount
        assert dead_amount > UInt64(0), "dead_amount must be > 0"

        _, dep_opted = op.AssetHoldingGet.asset_balance(Global.current_application_address, deposit_asset)
        assert dep_opted, "not opted into deposit asset"
        _, col_opted = op.AssetHoldingGet.asset_balance(Global.current_application_address, collateral_asset)
        assert col_opted, "not opted into collateral asset"

        self.deposit_asset_id.value = deposit_asset
        self.collateral_asset_id.value = collateral_asset
        self.oracle_app_id.value = oracle_app

        self.total_deposits.value = dead_amount
        self.total_shares.value = UInt64(DEAD_SHARES)
        self.dead_shares.value = UInt64(DEAD_SHARES)
        self.total_borrowed.value = UInt64(0)
        self.outstanding_liq_bal.value = UInt64(0)
        self.protocol_reserve.value = UInt64(0)
        self.last_accrual_block.value = Global.round

        self.base_rate_bps.value = base_rate
        self.optimal_rate_bps.value = optimal_rate
        self.max_rate_bps.value = max_rate
        self.kink_bps.value = kink
        self.protocol_fee_bps.value = fee_bps
        self.ltv_bps.value = ltv
        self.liq_threshold_bps.value = liq_threshold
        self.min_borrow.value = min_borrow_amount

    # ─────────────────────────────────────────────────────────────────────────
    # Internal helpers
    # ─────────────────────────────────────────────────────────────────────────

    @subroutine
    def _calc_rate(self, util_bps: UInt64) -> UInt64:
        """Two-slope kink interest rate model. util_bps and kink_bps both use 10_000 = 100%."""
        kink = self.kink_bps.value
        if util_bps <= kink:
            slope = util_bps * (self.optimal_rate_bps.value - self.base_rate_bps.value) // kink
            return self.base_rate_bps.value + slope
        else:
            excess = util_bps - kink
            range_above = UInt64(10_000) - kink
            slope = excess * (self.max_rate_bps.value - self.optimal_rate_bps.value) // range_above
            return self.optimal_rate_bps.value + slope

    @subroutine
    def _accrue_pool(self) -> None:
        """
        Pool-level interest accrual. Credits lender_portion to total_deposits and
        protocol_portion to protocol_reserve. Uses divide-before-multiply to prevent overflow.
        """
        blocks = Global.round - self.last_accrual_block.value
        if blocks == UInt64(0):
            return
        total_borrow = self.total_borrowed.value
        total_dep = self.total_deposits.value
        if total_borrow == UInt64(0) or total_dep == UInt64(0):
            self.last_accrual_block.value = Global.round
            return
        util_bps = total_borrow * UInt64(10_000) // total_dep
        rate_bps = self._calc_rate(util_bps)
        annual_interest = total_borrow * rate_bps // UInt64(10_000)
        new_interest = annual_interest * blocks // UInt64(BLOCKS_PER_YEAR)
        if new_interest == UInt64(0):
            self.last_accrual_block.value = Global.round
            return
        fee_bps = self.protocol_fee_bps.value
        lender_portion = new_interest * (UInt64(10_000) - fee_bps) // UInt64(10_000)
        protocol_portion = new_interest - lender_portion
        self.total_deposits.value = total_dep + lender_portion
        self.protocol_reserve.value = self.protocol_reserve.value + protocol_portion
        self.last_accrual_block.value = Global.round

    @subroutine
    def _accrue_borrower(self, borrower: Account) -> None:
        """Per-borrower interest accrual. Updates borrow_balance and last_accrual_block in box."""
        state = self.borrowers[borrower].copy()
        if state.liquidation_state.native == UInt64(2):
            return  # interest frozen in state 2
        balance = state.borrow_balance.native
        if balance == UInt64(0):
            return
        blocks = Global.round - state.last_accrual_block.native
        if blocks == UInt64(0):
            return
        total_dep = self.total_deposits.value
        total_borrow = self.total_borrowed.value
        util_bps = UInt64(0)
        if total_dep > UInt64(0):
            util_bps = total_borrow * UInt64(10_000) // total_dep
        rate_bps = self._calc_rate(util_bps)
        annual = balance * rate_bps // UInt64(10_000)
        new_interest = annual * blocks // UInt64(BLOCKS_PER_YEAR)
        state.borrow_balance = arc4.UInt64(balance + new_interest)
        state.last_accrual_block = arc4.UInt64(Global.round)
        self.borrowers[borrower] = state

    @subroutine
    def _oracle_price(self) -> UInt64:
        """Read current $U/USDC price from oracle global state."""
        price, exists = op.AppGlobal.get_ex_uint64(self.oracle_app_id.value, Bytes(b"u_price"))
        assert exists, "oracle price not set"
        assert price > UInt64(0), "oracle price is zero"
        return price

    @subroutine
    def _assert_oracle_fresh(self) -> None:
        """Revert if oracle last_updated is older than ORACLE_STALENESS seconds."""
        last_updated, exists = op.AppGlobal.get_ex_uint64(
            self.oracle_app_id.value, Bytes(b"last_updated")
        )
        assert exists, "oracle not initialized"
        assert Global.latest_timestamp - last_updated <= UInt64(ORACLE_STALENESS), "oracle stale"

    @subroutine
    def _collateral_value(self, collateral_amount: UInt64, oracle_price: UInt64) -> UInt64:
        # oracle_price is scaled to 6 decimal places: 1.50 USDC = 1_500_000
        return collateral_amount * oracle_price // UInt64(1_000_000)

    @subroutine
    def _health_ok(self, collateral_value: UInt64, borrow_balance: UInt64) -> bool:
        # health_factor >= 1.0 iff floor(collateral_value * liq_threshold / 10_000) >= borrow_balance
        numerator = collateral_value * self.liq_threshold_bps.value // UInt64(10_000)
        return numerator >= borrow_balance

    @subroutine
    def _safe_sub_borrowed(self, amount: UInt64) -> None:
        # total_borrowed is a stale approximation; clamp to 0 to prevent underflow
        current = self.total_borrowed.value
        if current >= amount:
            self.total_borrowed.value = current - amount
        else:
            self.total_borrowed.value = UInt64(0)

    # ─────────────────────────────────────────────────────────────────────────
    # Lender operations
    # ─────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def deposit(self) -> None:
        """
        Lend assets to the pool, receive shares proportional to the deposit.
        First deposit: atomic group must include Payment (MBR 20,500 µALGO) + AppCall + AssetTransfer.
        Subsequent deposits: AppCall + AssetTransfer.
        """
        transfer = gtxn.AssetTransferTransaction(Txn.group_index + UInt64(1))
        assert transfer.xfer_asset.id == self.deposit_asset_id.value, "wrong deposit asset"
        assert transfer.asset_receiver == Global.current_application_address, "wrong receiver"
        amount = transfer.asset_amount
        assert amount > UInt64(0), "deposit amount must be > 0"

        self._accrue_pool()

        total_dep = self.total_deposits.value
        total_sh = self.total_shares.value
        shares_minted = amount * total_sh // total_dep
        assert shares_minted > UInt64(0), "deposit too small — zero shares minted"

        if Txn.sender in self.lenders:
            self.lenders[Txn.sender] = self.lenders[Txn.sender] + shares_minted
        else:
            self.lenders[Txn.sender] = shares_minted

        self.total_deposits.value = total_dep + amount
        self.total_shares.value = total_sh + shares_minted

    @arc4.abimethod
    def withdraw(self, shares: UInt64) -> None:
        """Burn shares and receive proportional assets. Box persists if shares remain."""
        assert Txn.sender in self.lenders, "no lender position"
        existing = self.lenders[Txn.sender]
        assert shares > UInt64(0), "shares must be > 0"
        assert shares <= existing, "insufficient shares"

        self._accrue_pool()

        total_dep = self.total_deposits.value
        total_sh = self.total_shares.value
        withdrawal_amount = shares * total_dep // total_sh
        assert withdrawal_amount > UInt64(0), "withdrawal resolves to zero"

        available = total_dep - self.total_borrowed.value - self.outstanding_liq_bal.value
        assert withdrawal_amount <= available, "insufficient pool liquidity"

        new_shares = existing - shares
        if new_shares == UInt64(0):
            del self.lenders[Txn.sender]
        else:
            self.lenders[Txn.sender] = new_shares

        self.total_deposits.value = total_dep - withdrawal_amount
        self.total_shares.value = total_sh - shares

        itxn.AssetTransfer(
            xfer_asset=self.deposit_asset_id.value,
            asset_receiver=Txn.sender,
            asset_amount=withdrawal_amount,
            fee=UInt64(0),
        ).submit()

    @arc4.abimethod
    def withdraw_all(self) -> None:
        """Burn all shares, receive all assets, delete lender box and return 20,500 µALGO MBR."""
        assert Txn.sender in self.lenders, "no lender position"
        shares = self.lenders[Txn.sender]

        self._accrue_pool()

        total_dep = self.total_deposits.value
        total_sh = self.total_shares.value
        withdrawal_amount = shares * total_dep // total_sh

        available = total_dep - self.total_borrowed.value - self.outstanding_liq_bal.value
        assert withdrawal_amount <= available, "insufficient pool liquidity"

        del self.lenders[Txn.sender]
        self.total_deposits.value = total_dep - withdrawal_amount
        self.total_shares.value = total_sh - shares

        itxn.AssetTransfer(
            xfer_asset=self.deposit_asset_id.value,
            asset_receiver=Txn.sender,
            asset_amount=withdrawal_amount,
            fee=UInt64(0),
        ).submit()

    # ─────────────────────────────────────────────────────────────────────────
    # Borrower operations
    # ─────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def deposit_collateral(self) -> None:
        """
        Deposit collateral into the pool.
        First call: atomic group must include Payment (MBR 37,300 µALGO) + AppCall + AssetTransfer.
        Subsequent calls: AppCall + AssetTransfer.
        Blocked in state 2. Clears grace period unconditionally when oracle is stale.
        """
        transfer = gtxn.AssetTransferTransaction(Txn.group_index + UInt64(1))
        assert transfer.xfer_asset.id == self.collateral_asset_id.value, "wrong collateral asset"
        assert transfer.asset_receiver == Global.current_application_address, "wrong receiver"
        amount = transfer.asset_amount
        assert amount > UInt64(0), "collateral amount must be > 0"

        if Txn.sender in self.borrowers:
            state = self.borrowers[Txn.sender].copy()
            assert state.liquidation_state.native != UInt64(2), "blocked: position in liquidation"

            new_collateral = state.collateral_amount.native + amount
            state.collateral_amount = arc4.UInt64(new_collateral)

            # If eligible (state 1): attempt to restore health and clear grace period
            if state.liquidation_state.native == UInt64(1):
                last_updated, ts_exists = op.AppGlobal.get_ex_uint64(
                    self.oracle_app_id.value, Bytes(b"last_updated")
                )
                price, price_exists = op.AppGlobal.get_ex_uint64(
                    self.oracle_app_id.value, Bytes(b"u_price")
                )
                oracle_fresh = (
                    ts_exists
                    and Global.latest_timestamp - last_updated <= UInt64(ORACLE_STALENESS)
                )
                if oracle_fresh and price_exists and price > UInt64(0):
                    col_val = self._collateral_value(new_collateral, price)
                    if self._health_ok(col_val, state.borrow_balance.native):
                        state.liquidation_state = arc4.UInt64(0)
                        state.eligible_timestamp = arc4.UInt64(0)
                else:
                    # Oracle stale: adding collateral is unambiguously safe — clear unconditionally
                    state.liquidation_state = arc4.UInt64(0)
                    state.eligible_timestamp = arc4.UInt64(0)

            self.borrowers[Txn.sender] = state
        else:
            self.borrowers[Txn.sender] = BorrowerState(
                collateral_amount=arc4.UInt64(amount),
                borrow_balance=arc4.UInt64(0),
                last_accrual_block=arc4.UInt64(Global.round),
                eligible_timestamp=arc4.UInt64(0),
                liquidation_state=arc4.UInt64(0),
                outstanding_registered=arc4.UInt64(0),
            )

    @arc4.abimethod
    def borrow(self, amount: UInt64) -> None:
        """
        Draw assets against deposited collateral. Oracle must be fresh.
        Blocked in state 1 and 2. Unified LTV check applied to all borrows.
        Interest accrued before health check to prevent drawing against understated debt.
        """
        assert Txn.sender in self.borrowers, "no borrower position"
        assert amount > UInt64(0), "borrow amount must be > 0"

        self._assert_oracle_fresh()
        oracle_price = self._oracle_price()

        self._accrue_pool()
        self._accrue_borrower(Txn.sender)
        state = self.borrowers[Txn.sender].copy()

        assert state.liquidation_state.native == UInt64(0), "blocked: position not in healthy state"
        assert state.collateral_amount.native > UInt64(0), "no collateral deposited"

        available = (
            self.total_deposits.value
            - self.total_borrowed.value
            - self.outstanding_liq_bal.value
        )
        assert amount <= available, "insufficient pool liquidity"

        col_val = self._collateral_value(state.collateral_amount.native, oracle_price)
        new_total_debt = state.borrow_balance.native + amount
        max_borrow = col_val * self.ltv_bps.value // UInt64(10_000)
        assert new_total_debt <= max_borrow, "borrow exceeds LTV limit"

        state.borrow_balance = arc4.UInt64(new_total_debt)
        self.borrowers[Txn.sender] = state
        self.total_borrowed.value = self.total_borrowed.value + amount

        itxn.AssetTransfer(
            xfer_asset=self.deposit_asset_id.value,
            asset_receiver=Txn.sender,
            asset_amount=amount,
            fee=UInt64(0),
        ).submit()

    @arc4.abimethod
    def repay(self) -> None:
        """
        Partial or full repayment. If remaining balance falls below min_borrow, forces full close.
        Atomic group: AppCall + AssetTransfer.
        Outer fee must always be 2000 µALGO — force-close path sends collateral inner txn.
        Blocked in state 2.
        """
        assert Txn.sender in self.borrowers, "no borrower position"

        transfer = gtxn.AssetTransferTransaction(Txn.group_index + UInt64(1))
        assert transfer.xfer_asset.id == self.deposit_asset_id.value, "wrong repayment asset"
        assert transfer.asset_receiver == Global.current_application_address, "wrong receiver"
        amount = transfer.asset_amount
        assert amount > UInt64(0), "repayment amount must be > 0"

        state = self.borrowers[Txn.sender].copy()
        assert state.liquidation_state.native != UInt64(2), "blocked: position in liquidation"

        self._accrue_pool()
        self._accrue_borrower(Txn.sender)
        state = self.borrowers[Txn.sender].copy()
        current_balance = state.borrow_balance.native

        remaining = UInt64(0)
        if amount < current_balance:
            remaining = current_balance - amount

        force_close = remaining == UInt64(0) or remaining < self.min_borrow.value

        if force_close:
            collateral = state.collateral_amount.native
            del self.borrowers[Txn.sender]
            self._safe_sub_borrowed(current_balance)
            if collateral > UInt64(0):
                itxn.AssetTransfer(
                    xfer_asset=self.collateral_asset_id.value,
                    asset_receiver=Txn.sender,
                    asset_amount=collateral,
                    fee=UInt64(0),
                ).submit()
        else:
            state.borrow_balance = arc4.UInt64(remaining)

            # If in eligible state, check if repayment restored health factor
            if state.liquidation_state.native == UInt64(1):
                last_updated, ts_exists = op.AppGlobal.get_ex_uint64(
                    self.oracle_app_id.value, Bytes(b"last_updated")
                )
                price, price_exists = op.AppGlobal.get_ex_uint64(
                    self.oracle_app_id.value, Bytes(b"u_price")
                )
                oracle_fresh = (
                    ts_exists
                    and Global.latest_timestamp - last_updated <= UInt64(ORACLE_STALENESS)
                )
                if oracle_fresh and price_exists and price > UInt64(0):
                    col_val = self._collateral_value(state.collateral_amount.native, price)
                    if self._health_ok(col_val, remaining):
                        state.liquidation_state = arc4.UInt64(0)
                        state.eligible_timestamp = arc4.UInt64(0)

            self.borrowers[Txn.sender] = state
            self._safe_sub_borrowed(amount)

    @arc4.abimethod
    def repay_all(self) -> None:
        """
        Full repayment path. Returns collateral, deletes borrower box.
        Atomic group: AppCall + AssetTransfer. Transfer amount must be >= full borrow_balance.
        Blocked in state 2.
        """
        assert Txn.sender in self.borrowers, "no borrower position"

        state = self.borrowers[Txn.sender].copy()
        assert state.liquidation_state.native != UInt64(2), "blocked: position in liquidation"

        transfer = gtxn.AssetTransferTransaction(Txn.group_index + UInt64(1))
        assert transfer.xfer_asset.id == self.deposit_asset_id.value, "wrong repayment asset"
        assert transfer.asset_receiver == Global.current_application_address, "wrong receiver"

        self._accrue_pool()
        self._accrue_borrower(Txn.sender)
        state = self.borrowers[Txn.sender].copy()
        full_balance = state.borrow_balance.native

        assert transfer.asset_amount >= full_balance, "transfer insufficient for full repayment"

        collateral = state.collateral_amount.native
        del self.borrowers[Txn.sender]
        self._safe_sub_borrowed(full_balance)

        itxn.AssetTransfer(
            xfer_asset=self.collateral_asset_id.value,
            asset_receiver=Txn.sender,
            asset_amount=collateral,
            fee=UInt64(0),
        ).submit()

    @arc4.abimethod
    def withdraw_collateral(self) -> None:
        """
        Return all collateral to borrower. Only callable when borrow_balance == 0.
        Borrower must be opted into collateral_asset_id to receive transfer.
        Deletes borrower box and returns 37,300 µALGO MBR.
        """
        assert Txn.sender in self.borrowers, "no borrower position"
        state = self.borrowers[Txn.sender].copy()
        assert state.borrow_balance.native == UInt64(0), "borrow balance must be zero"
        assert state.collateral_amount.native > UInt64(0), "no collateral to withdraw"
        assert state.liquidation_state.native == UInt64(0), "position not in healthy state"

        collateral = state.collateral_amount.native
        del self.borrowers[Txn.sender]

        itxn.AssetTransfer(
            xfer_asset=self.collateral_asset_id.value,
            asset_receiver=Txn.sender,
            asset_amount=collateral,
            fee=UInt64(0),
        ).submit()

    # ─────────────────────────────────────────────────────────────────────────
    # Liquidation
    # ─────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def check_liquidation_eligibility(self, borrower: Account) -> None:
        """Set position to eligible state (1) when health factor < 1.0. Oracle must be fresh."""
        assert borrower in self.borrowers, "no borrower position"
        state = self.borrowers[borrower].copy()
        assert state.liquidation_state.native == UInt64(0), "position not in state 0"

        self._assert_oracle_fresh()
        oracle_price = self._oracle_price()
        self._accrue_borrower(borrower)
        state = self.borrowers[borrower].copy()

        col_val = self._collateral_value(state.collateral_amount.native, oracle_price)
        assert not self._health_ok(col_val, state.borrow_balance.native), "position is healthy"

        state.liquidation_state = arc4.UInt64(1)
        state.eligible_timestamp = arc4.UInt64(Global.latest_timestamp)
        self.borrowers[borrower] = state

    @arc4.abimethod
    def liquidate(self, borrower: Account) -> None:
        """
        Seize collateral from an eligible position after the 2-hour grace period.
        Admin only. Must be called in same atomic group as set_outstanding_liquidation_balance().
        Outer fee must be 3000 µALGO (two inner asset transfers: excess → borrower, bonus → admin).
        MBR payment of 23,300 µALGO must also be included in the outer transaction to fund
        the liquidation box.
        """
        assert Txn.sender == Global.creator_address, "not admin"
        assert borrower in self.borrowers, "no borrower position"

        state = self.borrowers[borrower].copy()
        assert state.liquidation_state.native == UInt64(1), "position not in eligible state"
        assert (
            Global.latest_timestamp >= state.eligible_timestamp.native + UInt64(GRACE_PERIOD)
        ), "grace period still active"

        self._assert_oracle_fresh()
        oracle_price = self._oracle_price()

        # Live health factor re-check at execution time
        col_val = self._collateral_value(state.collateral_amount.native, oracle_price)
        assert not self._health_ok(col_val, state.borrow_balance.native), "position has recovered"

        borrow_bal = state.borrow_balance.native
        collateral_amt = state.collateral_amount.native

        # seized = floor(borrow_balance × 108 / 100 / oracle_price)
        # = floor(borrow_balance × 108 × 1_000_000 / (100 × oracle_price))
        seized = borrow_bal * UInt64(108) * UInt64(1_000_000) // (UInt64(100) * oracle_price)
        assert seized <= collateral_amt, "insufficient collateral for seizure"

        excess_collateral = collateral_amt - seized
        bonus_amount = seized * UInt64(8) // UInt64(108)
        collateral_held = seized - bonus_amount

        # STATE CHANGES BEFORE INNER TRANSACTIONS (check-effects-interactions)
        state.liquidation_state = arc4.UInt64(2)
        state.collateral_amount = arc4.UInt64(0)
        self.borrowers[borrower] = state

        self.liquidations[borrower] = LiquidationState(
            outstanding_balance=arc4.UInt64(borrow_bal),
            collateral_held=arc4.UInt64(collateral_held),
        )

        # Inner txn 1: excess collateral → borrower immediately
        itxn.AssetTransfer(
            xfer_asset=self.collateral_asset_id.value,
            asset_receiver=borrower,
            asset_amount=excess_collateral,
            fee=UInt64(0),
        ).submit()

        # Inner txn 2: 8% bonus in collateral → founder wallet immediately
        itxn.AssetTransfer(
            xfer_asset=self.collateral_asset_id.value,
            asset_receiver=Global.creator_address,
            asset_amount=bonus_amount,
            fee=UInt64(0),
        ).submit()

    @arc4.abimethod
    def set_outstanding_liquidation_balance(self, borrower: Account, amount: UInt64) -> None:
        """
        Lock pool withdrawal capacity for an active liquidation. Admin only.
        Must be called in same atomic group as liquidate(). Increments pool counter.
        amount must equal borrower's current borrow_balance.
        """
        assert Txn.sender == Global.creator_address, "not admin"
        assert borrower in self.borrowers, "no borrower position"

        state = self.borrowers[borrower].copy()
        assert state.liquidation_state.native == UInt64(2), "position not in liquidation state"
        assert amount == state.borrow_balance.native, "amount must equal borrow_balance"
        assert state.outstanding_registered.native == UInt64(0), "already registered"

        state.outstanding_registered = arc4.UInt64(1)
        self.borrowers[borrower] = state
        self.outstanding_liq_bal.value = self.outstanding_liq_bal.value + amount

    @arc4.abimethod
    def release_collateral_for_sale(self, borrower: Account, amount: UInt64) -> None:
        """
        Transfer retained collateral from contract to founder wallet for off-chain sale.
        Admin only. Does not modify outstanding_balance.
        """
        assert Txn.sender == Global.creator_address, "not admin"
        assert borrower in self.liquidations, "no liquidation position"

        liq = self.liquidations[borrower].copy()
        assert liq.outstanding_balance.native > UInt64(0), "liquidation already fully settled"
        assert amount > UInt64(0), "amount must be > 0"
        assert amount <= liq.collateral_held.native, "exceeds collateral held by contract"

        liq.collateral_held = arc4.UInt64(liq.collateral_held.native - amount)
        self.liquidations[borrower] = liq

        itxn.AssetTransfer(
            xfer_asset=self.collateral_asset_id.value,
            asset_receiver=Global.creator_address,
            asset_amount=amount,
            fee=UInt64(0),
        ).submit()

    @arc4.abimethod
    def deposit_liquidation_proceeds(self, borrower: Account) -> None:
        """
        Deposit cash proceeds from selling seized collateral. Admin only.
        Atomic group: AppCall + AssetTransfer.
        Decrements outstanding_balance per deposit. When it reaches zero, both boxes are deleted.
        """
        assert Txn.sender == Global.creator_address, "not admin"
        assert borrower in self.liquidations, "no liquidation position"

        transfer = gtxn.AssetTransferTransaction(Txn.group_index + UInt64(1))
        assert transfer.xfer_asset.id == self.deposit_asset_id.value, "wrong settlement asset"
        assert transfer.asset_receiver == Global.current_application_address, "wrong receiver"
        amount = transfer.asset_amount
        assert amount > UInt64(0), "amount must be > 0"

        liq = self.liquidations[borrower].copy()
        assert amount <= liq.outstanding_balance.native, "exceeds outstanding balance"

        new_outstanding = liq.outstanding_balance.native - amount

        # Update pool accounting per-deposit (not only at completion)
        self.outstanding_liq_bal.value = self.outstanding_liq_bal.value - amount
        self._safe_sub_borrowed(amount)
        self.total_deposits.value = self.total_deposits.value + amount

        if new_outstanding == UInt64(0):
            # Settlement complete — delete both boxes
            bor = self.borrowers[borrower].copy()
            bor.outstanding_registered = arc4.UInt64(0)
            self.borrowers[borrower] = bor
            del self.liquidations[borrower]
            del self.borrowers[borrower]
        else:
            liq.outstanding_balance = arc4.UInt64(new_outstanding)
            self.liquidations[borrower] = liq

    @arc4.abimethod
    def cancel_liquidation_with_repayment(self, borrower: Account) -> None:
        """
        Cancel an active liquidation with full repayment. Closes position entirely.
        Returns held collateral to borrower. Admin only.
        Atomic group: AppCall + AssetTransfer (amount must equal outstanding_balance exactly).
        """
        assert Txn.sender == Global.creator_address, "not admin"
        assert borrower in self.liquidations, "no liquidation position"

        transfer = gtxn.AssetTransferTransaction(Txn.group_index + UInt64(1))
        assert transfer.xfer_asset.id == self.deposit_asset_id.value, "wrong repayment asset"
        assert transfer.asset_receiver == Global.current_application_address, "wrong receiver"

        liq = self.liquidations[borrower].copy()
        outstanding = liq.outstanding_balance.native
        collateral_held = liq.collateral_held.native
        assert transfer.asset_amount == outstanding, "must repay exact outstanding balance"

        # Update pool accounting
        self.outstanding_liq_bal.value = self.outstanding_liq_bal.value - outstanding
        self._safe_sub_borrowed(outstanding)
        self.total_deposits.value = self.total_deposits.value + outstanding

        # Close position
        del self.liquidations[borrower]
        del self.borrowers[borrower]

        # Return held collateral to borrower wallet
        if collateral_held > UInt64(0):
            itxn.AssetTransfer(
                xfer_asset=self.collateral_asset_id.value,
                asset_receiver=borrower,
                asset_amount=collateral_held,
                fee=UInt64(0),
            ).submit()

    @arc4.abimethod
    def cancel_liquidation_without_repayment(self, borrower: Account) -> None:
        """
        Cancel an active liquidation without repayment. Returns position to eligible state (1).
        Resets grace period timer to current_time — borrower gets a fresh 2-hour window.
        collateral_amount in borrower box is 0 after cancel; borrower must call
        deposit_collateral() within 2 hours or position is immediately re-liquidatable.
        Admin only.
        """
        assert Txn.sender == Global.creator_address, "not admin"
        assert borrower in self.liquidations, "no liquidation position"

        liq = self.liquidations[borrower].copy()
        outstanding = liq.outstanding_balance.native
        collateral_held = liq.collateral_held.native

        bor = self.borrowers[borrower].copy()

        # Decrement (not zero-assign) to correctly handle simultaneous liquidations
        self.outstanding_liq_bal.value = self.outstanding_liq_bal.value - outstanding

        # Reset to eligible with fresh grace period
        bor.outstanding_registered = arc4.UInt64(0)
        bor.collateral_amount = arc4.UInt64(0)
        bor.eligible_timestamp = arc4.UInt64(Global.latest_timestamp)
        bor.liquidation_state = arc4.UInt64(1)

        del self.liquidations[borrower]
        self.borrowers[borrower] = bor

        # Return held collateral directly to borrower wallet (not re-deposited into box)
        if collateral_held > UInt64(0):
            itxn.AssetTransfer(
                xfer_asset=self.collateral_asset_id.value,
                asset_receiver=borrower,
                asset_amount=collateral_held,
                fee=UInt64(0),
            ).submit()

    # ─────────────────────────────────────────────────────────────────────────
    # Admin operations
    # ─────────────────────────────────────────────────────────────────────────

    @arc4.abimethod
    def set_rates(
        self,
        base_rate: UInt64,
        optimal_rate: UInt64,
        max_rate: UInt64,
        kink: UInt64,
        fee_bps: UInt64,
    ) -> None:
        """Update interest rate model. Bounds enforced on-chain. Admin only."""
        assert Txn.sender == Global.creator_address, "not admin"
        assert base_rate <= UInt64(5_000), "base_rate exceeds max (50%)"
        assert optimal_rate <= UInt64(50_000), "optimal_rate exceeds max (500%)"
        assert max_rate <= UInt64(50_000), "max_rate exceeds max (500%)"
        assert kink >= UInt64(1) and kink <= UInt64(9_500), "kink out of bounds [1, 9500]"
        assert fee_bps <= UInt64(5_000), "fee_bps exceeds max (50%)"
        assert base_rate <= optimal_rate, "base_rate must be <= optimal_rate"
        assert optimal_rate <= max_rate, "optimal_rate must be <= max_rate"
        self.base_rate_bps.value = base_rate
        self.optimal_rate_bps.value = optimal_rate
        self.max_rate_bps.value = max_rate
        self.kink_bps.value = kink
        self.protocol_fee_bps.value = fee_bps

    @arc4.abimethod
    def set_oracle(self, new_oracle_app: UInt64) -> None:
        """Update the oracle app ID. Admin only. Both pools must reference the same oracle."""
        assert Txn.sender == Global.creator_address, "not admin"
        self.oracle_app_id.value = new_oracle_app

    @arc4.abimethod
    def collect_fees(self) -> None:
        """Sweep protocol_reserve to treasury (founder) wallet. Admin only."""
        assert Txn.sender == Global.creator_address, "not admin"
        amount = self.protocol_reserve.value
        assert amount > UInt64(0), "no fees to collect"
        self.protocol_reserve.value = UInt64(0)
        itxn.AssetTransfer(
            xfer_asset=self.deposit_asset_id.value,
            asset_receiver=Global.creator_address,
            asset_amount=amount,
            fee=UInt64(0),
        ).submit()

    @arc4.abimethod
    def collect_algo(self) -> None:
        """
        Sweep ALGO above 1 ALGO minimum reserve to founder wallet. Admin only.
        The 1 ALGO minimum is a floor — monitor and top up proactively at higher TVL.
        """
        assert Txn.sender == Global.creator_address, "not admin"
        balance = op.balance(Global.current_application_address)
        assert balance > UInt64(MIN_ALGO_RESERVE), "balance at or below minimum reserve"
        sweep = balance - UInt64(MIN_ALGO_RESERVE)
        itxn.Payment(
            receiver=Global.creator_address,
            amount=sweep,
            fee=UInt64(0),
        ).submit()
