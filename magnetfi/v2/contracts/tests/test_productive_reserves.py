"""
MagnetFi v3 — Productive Reserves (PSMv3) LocalNet integration tests.

Deploys the real compiled PSMv3 + a controllable MockAdapter + a MockVault (a minimal
registered cross-app caller for issue_musd/receive_musd), and drives every strategy path
and loss scenario deterministically. Each audit finding is a named regression test.

Prereqs (same as the v2 suite): `algokit localnet start`, contracts compiled
(smart_contracts/{psm_v3,mock_adapter,mock_vault}/*.arc56.json present), and:
    .venv-test/bin/python -m pytest tests/test_productive_reserves.py -q
"""

from __future__ import annotations

import base64
import os
import struct
from pathlib import Path

import algosdk
import pytest
import algokit_utils
from algokit_utils import (
    AlgoAmount,
    AlgorandClient,
    AppClientMethodCallParams,
    AppFactoryCreateMethodCallParams,
    AssetCreateParams,
    AssetOptInParams,
    AssetTransferParams,
    PaymentParams,
    SendParams,
    SigningAccount,
)

algokit_utils.config.config.configure(populate_app_call_resources=True, debug=False)

CONTRACTS_DIR = Path(__file__).resolve().parent.parent / "smart_contracts"
MUSD_TOTAL = 500_000_000_000_000   # 500M × 1e6
USDC_TOTAL = 1_000_000_000_000     # 1M × 1e6
TIMELOCK = 172_800                 # 48h
K = 1_000_000                      # 1.0 unit (6 dp)  → "1k" written as 1_000 * K where used
_SP = SendParams(populate_app_call_resources=True, cover_app_call_inner_transaction_fees=True)
_MAX_FEE = AlgoAmount(micro_algo=100_000)


def _arc56(folder: str, cls: str) -> str:
    return (CONTRACTS_DIR / folder / f"{cls}.arc56.json").read_text()


class PR:
    """Productive-reserves test harness."""

    def __init__(self, algorand: AlgorandClient) -> None:
        self.algorand = algorand
        self.algod = algorand.client.algod
        self.dispenser = algorand.account.localnet_dispenser()

        self.admin = self._acct(1_000)
        self.guardian = self._acct(100)
        self.treasury = self._acct(100)

        # admin is the creator/holder of both assets
        self.usdc_id = self._asset("USD Coin", "USDC")
        self.musd_id = self._asset("Magnet USD", "mUSD", total=MUSD_TOTAL)
        self.algorand.send.asset_opt_in(
            AssetOptInParams(sender=self.treasury.address, asset_id=self.usdc_id))

        self.psm = self._deploy("psm_v3", "PSMv3",
                                [self.musd_id, self.usdc_id, self.guardian.address])
        self.vault = self._deploy("mock_vault", "MockVault", [])
        self.adapter = self._deploy("mock_adapter", "MockAdapter",
                                    [self.psm.app_id, self.usdc_id, self.admin.address])

        self._fund(self.psm.app_address, 5)
        self._fund(self.vault.app_address, 2)
        self._fund(self.adapter.app_address, 2)

        self._wire()

    # ── setup ────────────────────────────────────────────────────────────────
    def _acct(self, algo: float) -> SigningAccount:
        a = self.algorand.account.random()
        self._fund(a.address, algo)
        return a

    def _fund(self, address: str, algo: float) -> None:
        self.algorand.send.payment(PaymentParams(
            sender=self.dispenser.address, receiver=address, amount=AlgoAmount.from_algo(algo)))

    def _asset(self, name: str, unit: str, total: int = USDC_TOTAL) -> int:
        return self.algorand.send.asset_create(AssetCreateParams(
            sender=self.admin.address, total=total, decimals=6, default_frozen=False,
            unit_name=unit, asset_name=name)).asset_id

    def _deploy(self, folder: str, cls: str, args: list):
        factory = self.algorand.client.get_app_factory(
            app_spec=_arc56(folder, cls), default_sender=self.admin.address)
        client, _ = factory.send.create(
            AppFactoryCreateMethodCallParams(method="create" if cls != "PSMv3" else "deploy",
                                             args=args, max_fee=_MAX_FEE),
            send_params=_SP)
        return client

    def _wire(self) -> None:
        self.call(self.psm, "opt_in_asset", [self.musd_id], self.admin)
        self.call(self.psm, "opt_in_asset", [self.usdc_id], self.admin)
        self.call(self.psm, "set_treasury", [self.treasury.address], self.admin)
        self.call(self.adapter, "opt_in_asset", [self.usdc_id], self.admin)
        # register mock vault (48h timelock)
        self.call(self.psm, "propose_vault_contract", [self.vault.app_id], self.admin)
        self.time_travel(TIMELOCK + 10)
        self.call(self.psm, "confirm_vault_contract", [], self.admin)
        # whitelist the adapter (48h timelock)
        self.call(self.psm, "propose_adapter", [self.adapter.app_id], self.admin)
        self.time_travel(TIMELOCK + 10)
        self.call(self.psm, "confirm_adapter", [], self.admin)
        # seed full mUSD reserve
        self.algorand.send.asset_transfer(AssetTransferParams(
            sender=self.admin.address, receiver=self.psm.app_address,
            asset_id=self.musd_id, amount=MUSD_TOTAL))

    # ── generic call helpers ───────────────────────────────────────────────────
    def call(self, client, method: str, args: list, sender: SigningAccount):
        return client.send.call(AppClientMethodCallParams(
            method=method, args=args, sender=sender.address, signer=sender.signer,
            max_fee=_MAX_FEE, note=os.urandom(8)), send_params=_SP)

    def _mc(self, client, method: str, args: list, sender: SigningAccount):
        return client.params.call(AppClientMethodCallParams(
            method=method, args=args, sender=sender.address, signer=sender.signer,
            max_fee=_MAX_FEE, note=os.urandom(8)))

    def time_travel(self, seconds: int) -> None:
        self.algod.set_timestamp_offset(seconds)
        self.algorand.send.payment(PaymentParams(
            sender=self.dispenser.address, receiver=self.dispenser.address,
            amount=AlgoAmount.from_micro_algo(0), note=os.urandom(16)))
        self.algod.set_timestamp_offset(1)

    # ── reserve actions ─────────────────────────────────────────────────────────
    def deposit_usdc(self, amount: int) -> None:
        grp = self.algorand.new_group()
        grp.add_asset_transfer(AssetTransferParams(
            sender=self.admin.address, receiver=self.psm.app_address,
            asset_id=self.usdc_id, amount=amount, note=os.urandom(8)))
        grp.add_app_call_method_call(self._mc(self.psm, "deposit_usdc", [amount], self.admin))
        grp.send(_SP)

    def restore(self, amount: int) -> None:
        grp = self.algorand.new_group()
        grp.add_asset_transfer(AssetTransferParams(
            sender=self.admin.address, receiver=self.psm.app_address,
            asset_id=self.usdc_id, amount=amount, note=os.urandom(8)))
        grp.add_app_call_method_call(self._mc(self.psm, "restore", [amount], self.admin))
        grp.send(_SP)

    def deploy_to_venue(self, amount: int) -> None:
        self.call(self.psm, "strategy_deploy", [self.adapter.app_id, amount], self.admin)

    def recall(self, amount: int) -> None:
        self.call(self.psm, "strategy_recall", [self.adapter.app_id, amount], self.admin)

    def harvest(self) -> None:
        self.call(self.psm, "strategy_harvest", [self.adapter.app_id], self.admin)

    def mark_impaired(self, flag: int, sender: SigningAccount | None = None) -> None:
        self.call(self.psm, "mark_impaired", [self.adapter.app_id, flag], sender or self.admin)

    def remove_adapter(self, sender: SigningAccount | None = None) -> None:
        self.call(self.psm, "remove_adapter", [self.adapter.app_id], sender or self.admin)

    def issue(self, recipient: SigningAccount, amount: int) -> None:
        self.call(self.vault, "call_issue",
                  [self.psm.app_id, recipient.address, amount], self.admin)

    def mint_musd(self, user: SigningAccount, amount: int) -> None:
        grp = self.algorand.new_group()
        grp.add_asset_transfer(AssetTransferParams(
            sender=user.address, receiver=self.psm.app_address,
            asset_id=self.usdc_id, amount=amount, note=os.urandom(8)))
        grp.add_app_call_method_call(self._mc(self.psm, "mint_musd", [amount], user))
        grp.send(_SP)

    def redeem_musd(self, user: SigningAccount, amount: int) -> None:
        grp = self.algorand.new_group()
        grp.add_asset_transfer(AssetTransferParams(
            sender=user.address, receiver=self.psm.app_address,
            asset_id=self.musd_id, amount=amount, note=os.urandom(8)))
        grp.add_app_call_method_call(self._mc(self.psm, "redeem_musd", [amount], user))
        grp.send(_SP)

    # ── mock knobs ────────────────────────────────────────────────────────────
    def mock_set_value(self, v: int) -> None:
        self.call(self.adapter, "set_value", [v], self.admin)

    def mock_set_locked(self, b: int) -> None:
        self.call(self.adapter, "set_locked", [b], self.admin)

    def mock_set_withdraw_lie(self, v: int) -> None:
        self.call(self.adapter, "set_withdraw_lie", [v], self.admin)

    def mock_drain(self, amount: int) -> None:
        self.call(self.adapter, "drain", [amount], self.admin)

    def mock_fund(self, amount: int) -> None:
        """Simulate accrued yield by sending USDC straight to the adapter account."""
        self.algorand.send.asset_transfer(AssetTransferParams(
            sender=self.admin.address, receiver=self.adapter.app_address,
            asset_id=self.usdc_id, amount=amount, note=os.urandom(8)))

    def new_user(self, usdc: int = 0) -> SigningAccount:
        u = self._acct(10)
        self.algorand.send.asset_opt_in(AssetOptInParams(sender=u.address, asset_id=self.musd_id))
        self.algorand.send.asset_opt_in(AssetOptInParams(sender=u.address, asset_id=self.usdc_id))
        if usdc:
            self.algorand.send.asset_transfer(AssetTransferParams(
                sender=self.admin.address, receiver=u.address, asset_id=self.usdc_id, amount=usdc))
        return u

    # ── reads ────────────────────────────────────────────────────────────────
    def _bal(self, address: str, asset_id: int) -> int:
        try:
            return self.algod.account_asset_info(address, asset_id)["asset-holding"]["amount"]
        except algosdk.error.AlgodHTTPError:
            return 0

    def psm_usdc(self) -> int:
        return self._bal(self.psm.app_address, self.usdc_id)

    def adapter_usdc(self) -> int:
        return self._bal(self.adapter.app_address, self.usdc_id)

    def treasury_usdc(self) -> int:
        return self._bal(self.treasury.address, self.usdc_id)

    def circulating(self) -> int:
        return MUSD_TOTAL - self._bal(self.psm.app_address, self.musd_id)

    def _psm_uint(self, key: bytes) -> int:
        info = self.algod.application_info(self.psm.app_id)
        kb = base64.b64encode(key).decode()
        for kv in info["params"].get("global-state", []):
            if kv["key"] == kb:
                return kv["value"]["uint"]
        return 0

    def _psm_bytes(self, key: bytes) -> bytes | None:
        info = self.algod.application_info(self.psm.app_id)
        kb = base64.b64encode(key).decode()
        for kv in info["params"].get("global-state", []):
            if kv["key"] == kb:
                return base64.b64decode(kv["value"]["bytes"])
        return None

    def reserve_deficit(self) -> int:
        return self._psm_uint(b"reserve_deficit")

    def principals(self) -> list[int]:
        raw = self._psm_bytes(b"deployed_principal")
        return list(struct.unpack(">5Q", raw)) if raw else [0, 0, 0, 0, 0]


@pytest.fixture()
def pr(algorand: AlgorandClient) -> PR:
    return PR(algorand)


def _fails(fn):
    with pytest.raises(Exception):
        fn()


# ══════════════════════════════════════════════════════════════════════════════
# Happy paths
# ══════════════════════════════════════════════════════════════════════════════

def test_deploy_and_recall_round_trip(pr: PR):
    pr.deposit_usdc(100_000 * K)
    pr.deploy_to_venue(30_000 * K)
    assert pr.adapter_usdc() == 30_000 * K
    assert pr.psm_usdc() == 70_000 * K
    assert pr.principals()[0] == 30_000 * K

    pr.recall(30_000 * K)
    assert pr.adapter_usdc() == 0
    assert pr.psm_usdc() == 100_000 * K
    assert pr.principals()[0] == 0


def test_harvest_sweeps_yield_to_treasury(pr: PR):
    pr.deposit_usdc(100_000 * K)
    pr.deploy_to_venue(30_000 * K)
    pr.mock_fund(5_000 * K)  # simulate accrued yield: adapter now holds 35k, recoverable 35k
    assert pr.treasury_usdc() == 0

    pr.harvest()
    assert pr.treasury_usdc() == 5_000 * K       # only the yield went to treasury
    assert pr.principals()[0] == 30_000 * K      # principal untouched
    assert pr.adapter_usdc() == 30_000 * K       # yield swept, principal remains deployed


def test_min_valuation_caps_backing_and_reflects_paper_loss(pr: PR):
    pr.deposit_usdc(100_000 * K)
    pr.deploy_to_venue(30_000 * K)  # backing = 70k buffer + min(30k, recoverable)
    user = pr.new_user()

    # Paper loss: venue value drops to 20k → backing = 70k + 20k = 90k. 95k must fail.
    pr.mock_set_value(20_000 * K)
    _fails(lambda: pr.issue(user, 95_000 * K))

    # Restore honest mark (recoverable = real 30k) → backing = 100k → 95k now succeeds.
    pr.mock_set_value(0)
    pr.issue(user, 95_000 * K)
    assert pr.circulating() == 95_000 * K


def test_inflated_mark_cannot_over_issue(pr: PR):
    # min() caps each venue at principal: a too-high recoverable can't raise the ceiling.
    pr.deposit_usdc(100_000 * K)
    pr.deploy_to_venue(30_000 * K)
    pr.mock_set_value(500_000 * K)  # lie high
    user = pr.new_user()
    # backing is still 70k + min(30k, 500k) = 100k, not 570k.
    _fails(lambda: pr.issue(user, 100_001 * K))
    pr.issue(user, 100_000 * K)  # exactly the honest ceiling


# ══════════════════════════════════════════════════════════════════════════════
# Audit regressions — the adapter trust boundary
# ══════════════════════════════════════════════════════════════════════════════

def test_H2_harvest_cannot_drain_buffer(pr: PR):
    # Malicious adapter reports a huge withdraw return; PSM must ignore it and pay treasury
    # only the on-chain USDC actually received — never the pre-existing buffer.
    pr.deposit_usdc(500_000 * K)
    pr.deploy_to_venue(30_000 * K)
    pr.mock_fund(5_000 * K)                   # real yield = 5k (recoverable 35k)
    pr.mock_set_withdraw_lie(400_000 * K)     # adapter will CLAIM it returned 400k
    buffer_before = pr.psm_usdc()             # 470k on-chain

    pr.harvest()
    assert pr.treasury_usdc() == 5_000 * K    # only the real 5k, NOT the reported 400k
    assert pr.psm_usdc() == buffer_before     # buffer fully intact (5k in, 5k out)


def test_M1_recall_crystallizes_hidden_loss(pr: PR):
    # Adapter really lost 10k but lies that it returned the full 30k. Balance-delta accounting
    # must still record the 10k shortfall as a deficit.
    pr.deposit_usdc(100_000 * K)
    pr.deploy_to_venue(30_000 * K)
    pr.mock_drain(10_000 * K)                 # venue value drops to 20k (real loss)
    pr.mock_set_withdraw_lie(30_000 * K)      # but claims it returned 30k

    pr.recall(30_000 * K)
    assert pr.principals()[0] == 0
    assert pr.reserve_deficit() == 10_000 * K  # loss crystallized despite the lie


def test_realized_loss_freezes_issuance_until_restore(pr: PR):
    pr.deposit_usdc(100_000 * K)
    pr.deploy_to_venue(30_000 * K)
    pr.mock_drain(10_000 * K)
    pr.recall(30_000 * K)                      # recovered 20k, retired 30k → deficit 10k
    assert pr.reserve_deficit() == 10_000 * K

    user = pr.new_user()
    _fails(lambda: pr.issue(user, 1 * K))      # issuance frozen while deficit > 0
    _fails(lambda: pr.deploy_to_venue(1 * K))  # deploy frozen too

    pr.restore(10_000 * K)                     # admin pays it down with real USDC
    assert pr.reserve_deficit() == 0
    pr.issue(user, 1 * K)                       # re-enabled
    assert pr.circulating() == 1 * K


def test_H1_dead_adapter_escape_hatch(pr: PR):
    # An impaired adapter with outstanding principal must be removable WITHOUT calling it,
    # writing off the principal to deficit — otherwise it bricks issuance forever.
    pr.deposit_usdc(100_000 * K)
    pr.deploy_to_venue(30_000 * K)
    pr.mark_impaired(1)

    user = pr.new_user()
    _fails(lambda: pr.issue(user, 1 * K))          # impairment freezes issuance
    _fails(lambda: pr.remove_adapter(sender=pr.guardian))  # remove is admin-only

    pr.remove_adapter()                        # escape hatch: no adapter call, writes off principal
    assert pr.reserve_deficit() == 30_000 * K
    assert pr.principals()[0] == 0

    # _any_impaired cleared (adapter gone); after restore, issuance resumes.
    pr.restore(30_000 * K)
    assert pr.reserve_deficit() == 0
    pr.issue(user, 1 * K)
    assert pr.circulating() == 1 * K


# ══════════════════════════════════════════════════════════════════════════════
# Access control / roles
# ══════════════════════════════════════════════════════════════════════════════

def test_L1_unimpair_is_guardian_only(pr: PR):
    pr.mark_impaired(1)                         # admin may SET
    _fails(lambda: pr.mark_impaired(0, sender=pr.admin))   # admin may NOT clear
    pr.mark_impaired(0, sender=pr.guardian)     # guardian may clear
    # issuance works again after the (empty-position) adapter is un-impaired
    pr.deposit_usdc(10_000 * K)
    user = pr.new_user()
    pr.issue(user, 1 * K)


def test_impaired_set_by_guardian_too(pr: PR):
    pr.mark_impaired(1, sender=pr.guardian)     # guardian may also set (safety brake)
    user = pr.new_user()
    pr.deposit_usdc(10_000 * K)
    _fails(lambda: pr.issue(user, 1 * K))       # frozen


# ══════════════════════════════════════════════════════════════════════════════
# Guardrails
# ══════════════════════════════════════════════════════════════════════════════

def test_buffer_floor_blocks_over_deploy(pr: PR):
    pr.deposit_usdc(100_000 * K)                # buffer_bps default 7000 → floor 70k
    _fails(lambda: pr.deploy_to_venue(30_001 * K))  # would leave 69,999 < 70k
    pr.deploy_to_venue(30_000 * K)              # leaves exactly 70k — ok


def test_venue_cap_blocks_over_concentration(pr: PR):
    pr.deposit_usdc(100_000 * K)
    pr.call(pr.psm, "set_venue_cap_bps", [2_000], pr.admin)  # 20% of total reserve = 20k
    _fails(lambda: pr.deploy_to_venue(21_000 * K))
    pr.deploy_to_venue(20_000 * K)


def test_withdraw_frozen_during_deficit(pr: PR):
    pr.deposit_usdc(100_000 * K)
    pr.deploy_to_venue(30_000 * K)
    pr.mock_drain(10_000 * K)
    pr.recall(30_000 * K)
    assert pr.reserve_deficit() == 10_000 * K
    grp_fail = lambda: pr.call(pr.psm, "withdraw_usdc", [1 * K], pr.admin)
    _fails(grp_fail)


# ══════════════════════════════════════════════════════════════════════════════
# Adapter whitelist timelock + veto
# ══════════════════════════════════════════════════════════════════════════════

def test_adapter_timelock_and_guardian_veto(pr: PR):
    DUMMY = 9_999_999
    pr.call(pr.psm, "propose_adapter", [DUMMY], pr.admin)
    _fails(lambda: pr.call(pr.psm, "confirm_adapter", [], pr.admin))  # timelock not elapsed
    pr.call(pr.psm, "cancel_pending_adapter", [], pr.guardian)        # guardian veto
    # after veto, confirm has nothing pending
    _fails(lambda: pr.call(pr.psm, "confirm_adapter", [], pr.admin))


def test_remove_requires_empty_on_healthy_path(pr: PR):
    pr.deposit_usdc(100_000 * K)
    pr.deploy_to_venue(30_000 * K)
    _fails(lambda: pr.remove_adapter())         # principal outstanding
    pr.recall(30_000 * K)
    pr.remove_adapter()                          # now empty → ok
    assert pr.principals()[0] == 0


# ══════════════════════════════════════════════════════════════════════════════
# v2 paths unchanged under v3
# ══════════════════════════════════════════════════════════════════════════════

def test_mint_and_redeem_unchanged(pr: PR):
    pr.deposit_usdc(100_000 * K)
    user = pr.new_user(usdc=10_000 * K)

    pr.mint_musd(user, 10_000 * K)              # USDC → mUSD 1:1, no fee
    assert pr._bal(user.address, pr.musd_id) == 10_000 * K

    pr.redeem_musd(user, 10_000 * K)            # mUSD → USDC, 1% fee to treasury
    assert pr._bal(user.address, pr.usdc_id) == 9_900 * K
    assert pr.treasury_usdc() == 100 * K
