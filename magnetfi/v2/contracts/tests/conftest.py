"""
MagnetFi v2 — LocalNet integration test harness.

Deploys the three real compiled contracts (LP Oracle, PSM, Vault) to a dev-mode
LocalNet, wires them together exactly as ADMIN.md prescribes, and exposes a
`Protocol` helper with high-level actions (open_vault, pay_interest, liquidations,
time travel, price control, balance/box reads) for the test modules.

Requires: `algokit localnet start` running, and the contracts compiled
(smart_contracts/*/<Name>.arc56.json present).
"""

from __future__ import annotations

import base64
import os
import struct
from dataclasses import dataclass
from pathlib import Path

import algosdk
import pytest
from algokit_utils import (
    AlgoAmount,
    AlgorandClient,
    AppClientMethodCallParams,
    AppFactoryCreateMethodCallParams,
    AssetCreateParams,
    AssetOptInParams,
    AssetTransferParams,
    CommonAppCallParams,
    PaymentParams,
    SendParams,
    SigningAccount,
)
import algokit_utils

# Quiet the verbose simulate-error logging on intentionally-failing calls.
algokit_utils.config.config.configure(populate_app_call_resources=True, debug=False)

CONTRACTS_DIR = Path(__file__).resolve().parent.parent / "smart_contracts"

# ── protocol constants ─────────────────────────────────────────────────────────
POOL_ID = 1001
INITIAL_PRICE = 1_000_000          # 1.00 mUSD per LP, scaled ×1e6
RATE_BPS = 1_000                   # 10% APR (round number for accrual asserts)
LIQ_BPS = 7_500                    # 75% liquidation threshold
LTV_BPS = 6_000                    # 60% LTV
MUSD_TOTAL = 500_000_000_000_000   # 500M × 1e6
USDC_TOTAL = 1_000_000_000_000     # 1M × 1e6 (mock)
LP_TOTAL = 1_000_000_000_000       # mock LP supply
VAULT_MBR = 46_500
SECONDS_PER_YEAR = 31_536_000
DAYS_90 = 7_776_000
TIMELOCK = 172_800                 # 48h
ONE_LP = 1_000_000                 # 1.0 LP in base units (6 dp)
ONE_MUSD = 1_000_000

_SP = SendParams(populate_app_call_resources=True, cover_app_call_inner_transaction_fees=True)
_MAX_FEE = AlgoAmount(micro_algo=50_000)


def _arc56(name: str, cls: str) -> str:
    return (CONTRACTS_DIR / name / f"{cls}.arc56.json").read_text()


@dataclass
class VaultBox:
    lp_amount: int
    lp_pool_id: int
    musd_borrowed: int
    accrued_interest: int
    rate_bps: int
    last_accrual_timestamp: int
    last_payment_timestamp: int
    vault_state: int


class Protocol:
    def __init__(self, algorand: AlgorandClient) -> None:
        self.algorand = algorand
        self.algod = algorand.client.algod
        self.dispenser = algorand.account.localnet_dispenser()

        # Roles
        self.admin = self._account(1_000)
        self.guardian = self._account(100)
        self.bot = self._account(100)
        self.treasury = self._account(100)
        self._treasury_opted = False

        # Assets (admin is creator / initial holder)
        self.musd_id = self._create_asset("Magnet USD", "mUSD", MUSD_TOTAL)
        self.usdc_id = self._create_asset("USD Coin", "USDC", USDC_TOTAL)
        self.lp_id = self._create_asset("U/tALGO LP", "TMPOOL2", LP_TOTAL)

        # Treasury must hold USDC to receive redemption fees.
        self.algorand.send.asset_opt_in(
            AssetOptInParams(sender=self.treasury.address, asset_id=self.usdc_id))

        # Deploy contracts
        self.oracle = self._deploy("lp_oracle", "LPOracle", [self.guardian.address])
        self.psm = self._deploy(
            "psm", "PSM", [self.musd_id, self.usdc_id, self.guardian.address]
        )
        self.vault = self._deploy(
            "vault", "Vault",
            [self.psm.app_id, self.oracle.app_id, self.musd_id, self.usdc_id, self.guardian.address],
        )

        # Fund app accounts for MBR + inner-txn min balances
        self._fund(self.oracle.app_address, 2)
        self._fund(self.psm.app_address, 5)
        self._fund(self.vault.app_address, 5)

        self._wire()

    # ── account / asset helpers ────────────────────────────────────────────────
    def _account(self, algo: float) -> SigningAccount:
        acct = self.algorand.account.random()
        self._fund(acct.address, algo)
        return acct

    def _fund(self, address: str, algo: float) -> None:
        self.algorand.send.payment(
            PaymentParams(sender=self.dispenser.address, receiver=address,
                          amount=AlgoAmount.from_algo(algo))
        )

    def _create_asset(self, name: str, unit: str, total: int) -> int:
        res = self.algorand.send.asset_create(
            AssetCreateParams(sender=self.admin.address, total=total, decimals=6,
                              default_frozen=False, unit_name=unit, asset_name=name)
        )
        return res.asset_id

    def _deploy(self, folder: str, cls: str, args: list):
        factory = self.algorand.client.get_app_factory(
            app_spec=_arc56(folder, cls), default_sender=self.admin.address
        )
        client, _ = factory.send.create(
            AppFactoryCreateMethodCallParams(method="deploy", args=args, max_fee=_MAX_FEE),
            send_params=_SP,
        )
        return client

    # ── generic call helpers ───────────────────────────────────────────────────
    def call(self, client, method: str, args: list, sender: SigningAccount):
        return client.send.call(
            AppClientMethodCallParams(
                method=method, args=args, sender=sender.address,
                signer=sender.signer, max_fee=_MAX_FEE, note=os.urandom(8),
            ),
            send_params=_SP,
        )

    def _signer(self, acct: SigningAccount):
        return acct.signer

    # ── wiring ──────────────────────────────────────────────────────────────────
    def _wire(self) -> None:
        # Oracle
        self.call(self.oracle, "set_authorized_updater", [self.bot.address], self.admin)
        self.call(self.oracle, "add_pool", [POOL_ID, INITIAL_PRICE], self.admin)
        # PSM opt-ins + treasury
        self.call(self.psm, "opt_in_asset", [self.musd_id], self.admin)
        self.call(self.psm, "opt_in_asset", [self.usdc_id], self.admin)
        self.call(self.psm, "set_treasury", [self.treasury.address], self.admin)
        # Vault opt-ins + risk params (liq before ltv!)
        self.call(self.vault, "opt_in_asset", [self.musd_id], self.admin)
        self.call(self.vault, "opt_in_asset", [self.lp_id], self.admin)
        self.call(self.vault, "set_rate", [POOL_ID, RATE_BPS], self.admin)
        self.call(self.vault, "set_liq_threshold", [POOL_ID, LIQ_BPS], self.admin)
        self.call(self.vault, "set_ltv", [POOL_ID, LTV_BPS], self.admin)
        self.call(self.vault, "set_lp_asa_id", [POOL_ID, self.lp_id], self.admin)
        # Register vault on PSM (timelocked 48h)
        self.call(self.psm, "propose_vault_contract", [self.vault.app_id], self.admin)
        self.time_travel(TIMELOCK + 10)
        self.call(self.psm, "confirm_vault_contract", [], self.admin)
        # Seed PSM with full mUSD reserve
        self.algorand.send.asset_transfer(
            AssetTransferParams(sender=self.admin.address, receiver=self.psm.app_address,
                                asset_id=self.musd_id, amount=MUSD_TOTAL)
        )
        # Open the vault ceiling with USDC
        self.deposit_usdc(100_000 * ONE_MUSD)
        # The genesis 48h timelock jump staled the oracle — re-post so borrows work.
        self.refresh_oracle()

    def refresh_oracle(self) -> None:
        """Re-post the current price so the oracle freshness window resets to now."""
        current = self.oracle_uint(b"lp_price_")
        self.oracle_post(current)

    # ── time / price control ────────────────────────────────────────────────────
    def time_travel(self, seconds: int) -> None:
        """Advance chain time by `seconds` (dev mode), then resume 1s/block cadence."""
        self.algod.set_timestamp_offset(seconds)
        # Bake one block at +seconds via a trivial self-payment (unique note avoids
        # duplicate-txid collisions across repeated time jumps).
        self.algorand.send.payment(
            PaymentParams(sender=self.dispenser.address, receiver=self.dispenser.address,
                          amount=AlgoAmount.from_micro_algo(0), note=os.urandom(16))
        )
        self.algod.set_timestamp_offset(1)

    def latest_ts(self) -> int:
        rnd = self.algod.status()["last-round"]
        return self.algod.block_info(rnd)["block"]["ts"]

    def oracle_post(self, price: int) -> None:
        self.call(self.oracle, "update_lp_price", [POOL_ID, price], self.bot)

    def set_anchor(self, price: int) -> None:
        self.call(self.oracle, "set_price_anchor", [POOL_ID, price], self.admin)

    def set_price(self, price: int) -> None:
        """Re-anchor then post — lets tests move price beyond the ±25% band in one step."""
        self.set_anchor(price)
        self.oracle_post(price)

    # ── PSM actions ──────────────────────────────────────────────────────────────
    def deposit_usdc(self, amount: int) -> None:
        grp = self.algorand.new_group()
        grp.add_asset_transfer(AssetTransferParams(
            sender=self.admin.address, receiver=self.psm.app_address,
            asset_id=self.usdc_id, amount=amount, note=os.urandom(8)))
        grp.add_app_call_method_call(self._mc(self.psm, "deposit_usdc", [amount], self.admin))
        grp.send(_SP)

    def mint_musd(self, user: SigningAccount, amount: int) -> None:
        grp = self.algorand.new_group()
        grp.add_asset_transfer(AssetTransferParams(
            sender=user.address, receiver=self.psm.app_address,
            asset_id=self.usdc_id, amount=amount, note=os.urandom(8)))
        grp.add_app_call_method_call(self._mc(self.psm, "mint_musd", [amount], user))
        grp.send(_SP)

    def redeem_musd(self, user: SigningAccount, amount: int) -> None:
        # PSM reads the mUSD deposit at index-1, so the transfer comes BEFORE the app call.
        grp = self.algorand.new_group()
        grp.add_asset_transfer(AssetTransferParams(
            sender=user.address, receiver=self.psm.app_address,
            asset_id=self.musd_id, amount=amount, note=os.urandom(8)))
        grp.add_app_call_method_call(self._mc(self.psm, "redeem_musd", [amount], user))
        grp.send(_SP)

    # ── Vault actions ────────────────────────────────────────────────────────────
    def open_vault(self, user: SigningAccount, lp_amount: int, borrow: int) -> None:
        grp = self.algorand.new_group()
        grp.add_payment(PaymentParams(sender=user.address, receiver=self.vault.app_address,
                                      amount=AlgoAmount.from_micro_algo(VAULT_MBR), note=os.urandom(8)))
        grp.add_app_call_method_call(self._mc(self.vault, "open_vault", [POOL_ID, borrow], user))
        grp.add_asset_transfer(AssetTransferParams(
            sender=user.address, receiver=self.vault.app_address,
            asset_id=self.lp_id, amount=lp_amount, note=os.urandom(8)))
        grp.send(_SP)

    def pay_interest(self, user: SigningAccount, amount: int) -> None:
        # mUSD transfer must PRECEDE the app call — the vault forwards `change` to PSM
        # via an inner txn during the call, so the funds must already have arrived.
        grp = self.algorand.new_group()
        grp.add_asset_transfer(AssetTransferParams(
            sender=user.address, receiver=self.vault.app_address,
            asset_id=self.musd_id, amount=amount, note=os.urandom(8)))
        grp.add_app_call_method_call(self._mc(self.vault, "pay_interest", [POOL_ID], user))
        grp.send(_SP)

    def repay_principal(self, user: SigningAccount, amount: int) -> None:
        grp = self.algorand.new_group()
        grp.add_app_call_method_call(self._mc(self.vault, "repay_principal", [POOL_ID], user))
        grp.add_asset_transfer(AssetTransferParams(
            sender=user.address, receiver=self.psm.app_address,
            asset_id=self.musd_id, amount=amount, note=os.urandom(8)))
        grp.send(_SP)

    def add_collateral(self, user: SigningAccount, lp_amount: int) -> None:
        grp = self.algorand.new_group()
        grp.add_app_call_method_call(self._mc(self.vault, "add_collateral", [POOL_ID], user))
        grp.add_asset_transfer(AssetTransferParams(
            sender=user.address, receiver=self.vault.app_address,
            asset_id=self.lp_id, amount=lp_amount, note=os.urandom(8)))
        grp.send(_SP)

    def borrow_more(self, user: SigningAccount, amount: int) -> None:
        self.call(self.vault, "borrow_more", [POOL_ID, amount], user)

    def settle(self, borrower: SigningAccount, amount: int) -> None:
        """Admin settles a health liquidation: mints the mUSD then settles to PSM."""
        self.admin_acquire_musd(amount)
        grp = self.algorand.new_group()
        grp.add_app_call_method_call(
            self._mc(self.vault, "settle_health_liquidation",
                     [borrower.address, POOL_ID, amount], self.admin))
        grp.add_asset_transfer(AssetTransferParams(
            sender=self.admin.address, receiver=self.psm.app_address,
            asset_id=self.musd_id, amount=amount, note=os.urandom(8)))
        grp.send(_SP)

    def admin_acquire_musd(self, amount: int) -> None:
        """Admin buys mUSD from the PSM with USDC (the documented float mechanism)."""
        self.mint_musd(self.admin, amount)

    def _mc(self, client, method: str, args: list, sender: SigningAccount):
        # Resolve to group-addable AppCallMethodCallParams (fills app_id + ABI method).
        return client.params.call(
            AppClientMethodCallParams(
                method=method, args=args, sender=sender.address,
                signer=sender.signer, max_fee=_MAX_FEE, note=os.urandom(8),
            )
        )

    # Public aliases for attack tests that build raw / malformed groups.
    def group(self):
        return self.algorand.new_group()

    def send_group(self, grp):
        return grp.send(_SP)

    def mc(self, client, method: str, args: list, sender: SigningAccount):
        return self._mc(client, method, args, sender)

    # ── user setup ───────────────────────────────────────────────────────────────
    def new_user(self, algo: float = 100, lp: int = 0, usdc: int = 0,
                 opt_musd: bool = True) -> SigningAccount:
        u = self._account(algo)
        self.algorand.send.asset_opt_in(AssetOptInParams(sender=u.address, asset_id=self.lp_id))
        if opt_musd:
            self.algorand.send.asset_opt_in(AssetOptInParams(sender=u.address, asset_id=self.musd_id))
        if usdc:
            self.algorand.send.asset_opt_in(AssetOptInParams(sender=u.address, asset_id=self.usdc_id))
            self._give(u.address, self.usdc_id, usdc)
        if lp:
            self._give(u.address, self.lp_id, lp)
        return u

    def _give(self, address: str, asset_id: int, amount: int) -> None:
        self.algorand.send.asset_transfer(AssetTransferParams(
            sender=self.admin.address, receiver=address, asset_id=asset_id, amount=amount))

    # ── reads ─────────────────────────────────────────────────────────────────────
    def asset_bal(self, address: str, asset_id: int) -> int:
        try:
            info = self.algod.account_asset_info(address, asset_id)
            return info["asset-holding"]["amount"]
        except algosdk.error.AlgodHTTPError:
            return 0

    def musd_bal(self, address: str) -> int:
        return self.asset_bal(address, self.musd_id)

    def lp_bal(self, address: str) -> int:
        return self.asset_bal(address, self.lp_id)

    def usdc_bal(self, address: str) -> int:
        return self.asset_bal(address, self.usdc_id)

    def algo_bal(self, address: str) -> int:
        return self.algod.account_info(address)["amount"]

    def oracle_uint(self, prefix: bytes, pool: int = POOL_ID) -> int | None:
        info = self.algod.application_info(self.oracle.app_id)
        kb = base64.b64encode(prefix + pool.to_bytes(8, "big")).decode()
        for kv in info["params"].get("global-state", []):
            if kv["key"] == kb:
                return kv["value"]["uint"]
        return None

    def psm_global(self, key: bytes) -> int:
        info = self.algod.application_info(self.psm.app_id)
        kb = base64.b64encode(key).decode()
        for kv in info["params"].get("global-state", []):
            if kv["key"] == kb:
                return kv["value"]["uint"]
        return 0

    def vault_box(self, borrower: SigningAccount) -> VaultBox | None:
        key = b"vault_" + algosdk.encoding.decode_address(borrower.address) + POOL_ID.to_bytes(8, "big")
        try:
            res = self.algod.application_box_by_name(self.vault.app_id, key)
        except algosdk.error.AlgodHTTPError:
            return None
        raw = base64.b64decode(res["value"])
        vals = struct.unpack(">8Q", raw)
        return VaultBox(*vals)

    def vault_exists(self, borrower: SigningAccount) -> bool:
        return self.vault_box(borrower) is not None

    # PSM invariant helpers
    def circulating_musd(self) -> int:
        return MUSD_TOTAL - self.musd_bal(self.psm.app_address)

    def psm_usdc(self) -> int:
        return self.usdc_bal(self.psm.app_address)


@pytest.fixture(scope="session")
def algorand() -> AlgorandClient:
    client = AlgorandClient.default_localnet()
    # Dev mode advances one round per transaction; the default time-based params cache
    # goes stale by round after ~1000 cumulative txns. Always fetch fresh params.
    client.set_suggested_params_cache_timeout(0)
    return client


@pytest.fixture()
def proto(algorand: AlgorandClient) -> Protocol:
    return Protocol(algorand)
