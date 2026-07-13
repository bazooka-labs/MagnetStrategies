"""
PSMv3 loss → deficit → restore DRILL on TESTNET (Phase 5.3).

Drives the deficit machinery against the REAL PSMv3 (short-timelock build from the real source)
on live testnet, using a controllable MockAdapter to force a realized loss: deploy → drain the
venue + make it lie about the recall → confirm the shortfall crystallizes into reserve_deficit →
confirm the freeze (deploy + withdraw blocked) → restore → confirm unfreeze. This is the on-network
rehearsal of what the LocalNet PR suite covers with the mock.

Gated on FOLKS_TEST_MNEMONIC (throwaway testnet wallet with ALGO + testnet USDC 67395862).
    export FOLKS_TEST_MNEMONIC="..."
    magnetfi/v2/contracts/.venv-test/bin/python -m pytest tests/test_psm_deficit_testnet.py -s -q
"""

from __future__ import annotations

import base64
import os
import struct
import subprocess
import tempfile
import time
from pathlib import Path

import pytest
from algosdk import account
from algokit_utils import (
    AlgoAmount,
    AlgorandClient,
    AppClientMethodCallParams,
    AppFactoryCreateMethodCallParams,
    AssetCreateParams,
    AssetTransferParams,
    PaymentParams,
    SendParams,
)
import algokit_utils

MNEMONIC = os.environ.get("FOLKS_TEST_MNEMONIC")
pytestmark = pytest.mark.skipif(
    not MNEMONIC, reason="set FOLKS_TEST_MNEMONIC (throwaway testnet wallet) to run"
)

USDC = 67395862
MUSD_TOTAL = 500_000_000_000_000
SEED = 600_000     # 0.6 USDC reserve
DEPLOY = 150_000   # 0.15 to the venue
DRAIN = 50_000     # venue loses 0.05
SHORT_TL = 10

CONTRACTS_DIR = Path(__file__).resolve().parent.parent / "smart_contracts"
COMPILER_PY = Path(__file__).resolve().parent.parent / ".venv" / "bin" / "python3.12"
_SP = SendParams(populate_app_call_resources=True, cover_app_call_inner_transaction_fees=True)
_MAX_FEE = AlgoAmount(micro_algo=250_000)
algokit_utils.config.config.configure(populate_app_call_resources=True, debug=False)


def _arc56(folder: str, cls: str) -> str:
    return (CONTRACTS_DIR / folder / f"{cls}.arc56.json").read_text()


def _build_short_timelock_psm() -> str:
    src = (CONTRACTS_DIR / "psm_v3" / "contract.py").read_text()
    patched = src.replace("TIMELOCK_DELAY = 172_800", f"TIMELOCK_DELAY = {SHORT_TL}")
    tmp = Path(tempfile.mkdtemp(prefix="psm_v3_tn_"))
    (tmp / "contract.py").write_text(patched)
    subprocess.run([str(COMPILER_PY), "-m", "puyapy", str(tmp / "contract.py")], check=True,
                   capture_output=True)
    return (tmp / "PSMv3.arc56.json").read_text()


def test_psm_deficit_restore_drill():
    algorand = AlgorandClient.testnet()
    algorand.set_suggested_params_cache_timeout(0)
    acct = algorand.account.from_mnemonic(mnemonic=MNEMONIC)
    algod = algorand.client.algod
    _, guardian = account.generate_account()
    _, treasury = account.generate_account()

    def bal(addr: str, asset: int) -> int:
        for a in algod.account_info(addr).get("assets", []):
            if a["asset-id"] == asset:
                return a["amount"]
        return 0

    def mc(client, method, args):
        return client.params.call(AppClientMethodCallParams(
            method=method, args=args, sender=acct.address, signer=acct.signer,
            max_fee=_MAX_FEE, note=os.urandom(8)))

    def call(client, method, args):
        return client.send.call(AppClientMethodCallParams(
            method=method, args=args, sender=acct.address, signer=acct.signer,
            max_fee=_MAX_FEE, note=os.urandom(8)), send_params=_SP)

    def puint(app_id, key: bytes) -> int:
        for kv in algod.application_info(app_id)["params"].get("global-state", []):
            if kv["key"] == base64.b64encode(key).decode():
                return kv["value"]["uint"]
        return 0

    def principal0(app_id) -> int:
        for kv in algod.application_info(app_id)["params"].get("global-state", []):
            if kv["key"] == base64.b64encode(b"deployed_principal").decode():
                return struct.unpack(">5Q", base64.b64decode(kv["value"]["bytes"]))[0]
        return 0

    assert bal(acct.address, USDC) >= SEED, f"wallet needs >= {SEED} µUSDC (67395862)"

    # ── deploy real PSMv3 (short-tl) + controllable MockAdapter + mUSD ──
    musd = algorand.send.asset_create(AssetCreateParams(
        sender=acct.address, total=MUSD_TOTAL, decimals=6, default_frozen=False,
        unit_name="mUSD", asset_name="Magnet USD (testnet)")).asset_id
    psm, _ = algorand.client.get_app_factory(app_spec=_build_short_timelock_psm(), default_sender=acct.address).send.create(
        AppFactoryCreateMethodCallParams(method="deploy", args=[musd, USDC, guardian], max_fee=_MAX_FEE), send_params=_SP)
    adapter, _ = algorand.client.get_app_factory(
        app_spec=_arc56("mock_adapter", "MockAdapter"), default_sender=acct.address).send.create(
        AppFactoryCreateMethodCallParams(method="create", args=[psm.app_id, USDC, acct.address], max_fee=_MAX_FEE),
        send_params=_SP)
    print(f"\n[deploy] PSMv3={psm.app_id} MockAdapter={adapter.app_id} mUSD={musd}")

    for addr, algo in [(psm.app_address, 1.0), (adapter.app_address, 0.6)]:
        algorand.send.payment(PaymentParams(sender=acct.address, receiver=addr, amount=AlgoAmount.from_algo(algo)))

    call(psm, "opt_in_asset", [musd])
    call(psm, "opt_in_asset", [USDC])
    call(psm, "set_treasury", [treasury])
    call(adapter, "opt_in_asset", [USDC])

    call(psm, "propose_adapter", [adapter.app_id])
    print(f"[timelock] waiting {SHORT_TL + 6}s…")
    time.sleep(SHORT_TL + 6)
    call(psm, "confirm_adapter", [])

    algorand.send.asset_transfer(AssetTransferParams(
        sender=acct.address, receiver=psm.app_address, asset_id=musd, amount=MUSD_TOTAL))
    grp = algorand.new_group()
    grp.add_asset_transfer(AssetTransferParams(
        sender=acct.address, receiver=psm.app_address, asset_id=USDC, amount=SEED, note=os.urandom(8)))
    grp.add_app_call_method_call(mc(psm, "deposit_usdc", [SEED]))
    grp.send(_SP)
    call(psm, "set_buffer_bps", [5000])  # 50% floor for comfortable deploy margin

    # ── deploy to venue, then force a realized loss ──
    call(psm, "strategy_deploy", [adapter.app_id, DEPLOY])
    assert principal0(psm.app_id) == DEPLOY
    call(adapter, "drain", [DRAIN])                       # venue loses 0.05
    call(adapter, "set_withdraw_lie", [DEPLOY])           # but claims it returned the full 0.15
    call(psm, "strategy_recall", [adapter.app_id, DEPLOY])

    deficit = puint(psm.app_id, b"reserve_deficit")
    print(f"[loss] recall done — reserve_deficit={deficit} (expected {DRAIN}); principal={principal0(psm.app_id)}")
    assert deficit == DRAIN, "hidden loss did not crystallize into the deficit"
    assert principal0(psm.app_id) == 0

    # ── freeze: deploy + withdraw blocked while deficit > 0 ──
    with pytest.raises(Exception):
        call(psm, "strategy_deploy", [adapter.app_id, 10_000])
    with pytest.raises(Exception):
        call(psm, "withdraw_usdc", [10_000])
    print("[freeze] strategy_deploy and withdraw_usdc correctly reverted during deficit")

    # ── restore: pay it down, unfreeze ──
    grp = algorand.new_group()
    grp.add_asset_transfer(AssetTransferParams(
        sender=acct.address, receiver=psm.app_address, asset_id=USDC, amount=DRAIN, note=os.urandom(8)))
    grp.add_app_call_method_call(mc(psm, "restore", [DRAIN]))
    grp.send(_SP)
    assert puint(psm.app_id, b"reserve_deficit") == 0
    call(psm, "strategy_deploy", [adapter.app_id, 20_000])  # unfrozen — works again
    print("[restore] deficit cleared; strategy_deploy re-enabled")

    # ── cleanup: recall all, remove adapter, return USDC to wallet ──
    call(psm, "strategy_recall", [adapter.app_id, 1_000_000])
    call(psm, "remove_adapter", [adapter.app_id])
    call(psm, "set_buffer_bps", [0])
    call(psm, "withdraw_usdc", [bal(psm.app_address, USDC)])
    print("[ok] loss → deficit → freeze → restore → unfreeze drill passed on testnet")
