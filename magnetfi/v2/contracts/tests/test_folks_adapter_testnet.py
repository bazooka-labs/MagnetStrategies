"""
FolksAdapter TESTNET integration test (Phase 3.2) — the real write-side validation.

Runs against LIVE Folks Finance v2 on Algorand TESTNET: deploys FolksAdapter + a MockPsm caller,
deposits USDC into the real Folks USDC pool, verifies recoverable_value matches
fUSDC × depositInterestIndex / 1e14 read from the real pool, then withdraws and checks the USDC
comes home. This is what LocalNet cannot cover (Folks isn't there).

Gated on FOLKS_TEST_MNEMONIC — SKIPPED in the normal suite + CI. Never commit the mnemonic
(public repo): supply it at runtime, e.g.
    export FOLKS_TEST_MNEMONIC="word word ... word"     # a THROWAWAY testnet wallet
    magnetfi/v2/contracts/.venv-test/bin/python -m pytest tests/test_folks_adapter_testnet.py -s -q

Preconditions on the wallet (throwaway): a few testnet ALGO, and testnet USDC (asset 67395862)
claimed from https://testnet.folks.finance/faucet. Each run deploys fresh immutable apps, so a
bit of ALGO is locked in their MBR per run.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

import pytest
from algokit_utils import (
    AlgoAmount,
    AlgorandClient,
    AppClientMethodCallParams,
    AppFactoryCreateMethodCallParams,
    AssetTransferParams,
    PaymentParams,
    SendParams,
)
import algokit_utils

MNEMONIC = os.environ.get("FOLKS_TEST_MNEMONIC")
pytestmark = pytest.mark.skipif(
    not MNEMONIC, reason="set FOLKS_TEST_MNEMONIC (throwaway testnet wallet) to run the Folks test"
)

# Folks Finance v2 — TESTNET
POOL = 147170678
POOL_MGR = 147157634
USDC = 67395862
FUSDC = 147171826
INDEX_OFFSET = 40
ONE_14_DP = 100_000_000_000_000
DEPOSIT = 500_000  # 0.5 USDC

CONTRACTS_DIR = Path(__file__).resolve().parent.parent / "smart_contracts"
_SP = SendParams(populate_app_call_resources=True, cover_app_call_inner_transaction_fees=True)
_MAX_FEE = AlgoAmount(micro_algo=200_000)

algokit_utils.config.config.configure(populate_app_call_resources=True, debug=False)


def _arc56(folder: str, cls: str) -> str:
    return (CONTRACTS_DIR / folder / f"{cls}.arc56.json").read_text()


def _pool_deposit_index(algod, pool_app: int) -> int:
    st = algod.application_info(pool_app)["params"]["global-state"]
    kb = base64.b64encode(b"i").decode()
    for kv in st:
        if kv["key"] == kb:
            raw = base64.b64decode(kv["value"]["bytes"])
            return int.from_bytes(raw[INDEX_OFFSET:INDEX_OFFSET + 8], "big")
    raise AssertionError("pool interest key 'i' not found")


def test_folks_adapter_full_cycle():
    algorand = AlgorandClient.testnet()
    algorand.set_suggested_params_cache_timeout(0)
    acct = algorand.account.from_mnemonic(mnemonic=MNEMONIC)
    algod = algorand.client.algod

    def bal(address: str, asset_id: int) -> int:
        for a in algod.account_info(address).get("assets", []):
            if a["asset-id"] == asset_id:
                return a["amount"]
        return 0

    def call(client, method: str, args: list):
        return client.send.call(AppClientMethodCallParams(
            method=method, args=args, sender=acct.address, signer=acct.signer,
            max_fee=_MAX_FEE, note=os.urandom(8)), send_params=_SP)

    def mc(client, method: str, args: list):
        return client.params.call(AppClientMethodCallParams(
            method=method, args=args, sender=acct.address, signer=acct.signer,
            max_fee=_MAX_FEE, note=os.urandom(8)))

    def call_grouped(client, method: str, args: list, fillers: int = 3):
        """Send a method call plus `fillers` no-op app calls so populate_app_call_resources has
        enough foreign-reference slots for resource-heavy Folks inner calls."""
        grp = algorand.new_group()
        grp.add_app_call_method_call(mc(client, method, args))
        for _ in range(fillers):
            grp.add_app_call_method_call(mc(psm, "noop", []))
        return grp.send(_SP)

    # ── preflight ──────────────────────────────────────────────────────────────
    wallet_usdc = bal(acct.address, USDC)
    print(f"\n[preflight] {acct.address}")
    print(f"[preflight] wallet USDC {USDC}: {wallet_usdc / 1e6}")
    assert wallet_usdc >= DEPOSIT, (
        f"wallet holds {wallet_usdc} µUSDC of Folks testnet USDC {USDC}; need >= {DEPOSIT}. "
        f"Claim from https://testnet.folks.finance/faucet"
    )

    # ── deploy MockPsm + FolksAdapter ──────────────────────────────────────────
    psm_factory = algorand.client.get_app_factory(
        app_spec=_arc56("mock_psm", "MockPsm"), default_sender=acct.address)
    psm, _ = psm_factory.send.create(
        AppFactoryCreateMethodCallParams(method="create", args=[], max_fee=_MAX_FEE), send_params=_SP)

    ad_factory = algorand.client.get_app_factory(
        app_spec=_arc56("folks_adapter", "FolksAdapter"), default_sender=acct.address)
    adapter, _ = ad_factory.send.create(
        AppFactoryCreateMethodCallParams(
            method="create", args=[psm.app_id, USDC, FUSDC, POOL, POOL_MGR, acct.address],
            max_fee=_MAX_FEE), send_params=_SP)
    print(f"[deploy] MockPsm={psm.app_id}  FolksAdapter={adapter.app_id}")

    # fund app accounts (MBR + inner-txn headroom)
    for addr, algo in [(adapter.app_address, 1.0), (psm.app_address, 0.6)]:
        algorand.send.payment(PaymentParams(
            sender=acct.address, receiver=addr, amount=AlgoAmount.from_algo(algo)))

    # opt-ins
    call(adapter, "opt_in_asset", [USDC])
    call(adapter, "opt_in_asset", [FUSDC])
    call(psm, "opt_in_asset", [USDC])

    # ── deposit into real Folks ─────────────────────────────────────────────────
    algorand.send.asset_transfer(AssetTransferParams(
        sender=acct.address, receiver=psm.app_address, asset_id=USDC, amount=DEPOSIT))
    call_grouped(psm, "fund_and_deposit", [adapter.app_id, USDC, DEPOSIT])

    fusdc_bal = bal(adapter.app_address, FUSDC)
    index = _pool_deposit_index(algod, POOL)
    expected = fusdc_bal * index // ONE_14_DP
    print(f"[deposit] fUSDC minted: {fusdc_bal}  pool index: {index} ({index/1e14:.6f})")
    print(f"[deposit] expected recoverable: {expected} µUSDC")
    assert fusdc_bal > 0, "no fUSDC minted — deposit failed"

    # recoverable_value must match fUSDC × index / 1e14 (the invariant read)
    rec = call(adapter, "recoverable_value", []).abi_return
    print(f"[read] recoverable_value(): {rec}  (deposited {DEPOSIT})")
    assert abs(int(rec) - expected) <= 1, f"recoverable {rec} != expected {expected}"
    assert DEPOSIT - int(rec) <= 10, f"recoverable {rec} lost too much vs deposit {DEPOSIT} (entry rounding)"

    # ── withdraw back to the PSM ─────────────────────────────────────────────────
    psm_usdc_before = bal(psm.app_address, USDC)
    call_grouped(psm, "do_withdraw", [adapter.app_id, DEPOSIT])
    psm_usdc_after = bal(psm.app_address, USDC)
    got = psm_usdc_after - psm_usdc_before
    print(f"[withdraw] USDC returned to PSM: {got}  (requested {DEPOSIT})")
    assert got >= DEPOSIT - 10, f"withdraw returned {got}, expected ~{DEPOSIT}"
    print("[ok] full deposit → read → withdraw cycle passed against live Folks testnet")
