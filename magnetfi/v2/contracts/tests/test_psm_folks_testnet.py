"""
Full-stack PSMv3 → FolksAdapter → live Folks integration test (TESTNET).

Validates the REAL PSMv3 contract driving the REAL FolksAdapter into the REAL Folks v2 testnet
USDC pool — the composition LocalNet (mock adapter) and the isolated adapter test each cover only
half of. Exercises strategy_deploy (PSMv3 → adapter → Folks, plus PSMv3's live recoverable read in
its invariant post-check), strategy_recall, and remove_adapter, at full call depth with the
resource-padding the real deployment needs.

Testnet has real time, so the 48h adapter-whitelist timelock can't be fast-forwarded. To test the
real logic without weakening the audited contract, we compile a SHORT-timelock build generated
from the real psm_v3/contract.py source (only the TIMELOCK_DELAY constant is patched — no logic
drift). Everything else is the production contract.

Gated on FOLKS_TEST_MNEMONIC (a throwaway testnet wallet with ALGO + Folks testnet USDC).
    export FOLKS_TEST_MNEMONIC="..."
    magnetfi/v2/contracts/.venv-test/bin/python -m pytest tests/test_psm_folks_testnet.py -s -q
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

# Folks Finance v2 — TESTNET
POOL = 147170678
POOL_MGR = 147157634
USDC = 67395862
FUSDC = 147171826

MUSD_TOTAL = 500_000_000_000_000
SEED_USDC = 1_000_000       # 1.0 USDC into the PSM reserve
DEPLOY_AMT = 300_000        # deploy 0.3 (== 30% of a 1.0 reserve at the default 70% buffer)
RECALL_AMT = 500_000        # recall > deployed to fully empty the adapter
SHORT_TL = 10               # seconds (patched TIMELOCK_DELAY for testnet)

CONTRACTS_DIR = Path(__file__).resolve().parent.parent / "smart_contracts"
COMPILER_PY = Path(__file__).resolve().parent.parent / ".venv" / "bin" / "python3.12"
_SP = SendParams(populate_app_call_resources=True, cover_app_call_inner_transaction_fees=True)
_MAX_FEE = AlgoAmount(micro_algo=250_000)
algokit_utils.config.config.configure(populate_app_call_resources=True, debug=False)


def _arc56(folder: str, cls: str) -> str:
    return (CONTRACTS_DIR / folder / f"{cls}.arc56.json").read_text()


def _build_short_timelock_psm() -> str:
    """Compile a PSMv3 build from the real source with TIMELOCK_DELAY patched to SHORT_TL."""
    src = (CONTRACTS_DIR / "psm_v3" / "contract.py").read_text()
    patched = src.replace("TIMELOCK_DELAY = 172_800", f"TIMELOCK_DELAY = {SHORT_TL}")
    assert f"TIMELOCK_DELAY = {SHORT_TL}" in patched, "timelock patch failed"
    tmp = Path(tempfile.mkdtemp(prefix="psm_v3_tn_"))
    (tmp / "contract.py").write_text(patched)
    subprocess.run([str(COMPILER_PY), "-m", "puyapy", str(tmp / "contract.py")], check=True,
                   capture_output=True)
    return (tmp / "PSMv3.arc56.json").read_text()


def test_psm_folks_full_stack():
    algorand = AlgorandClient.testnet()
    algorand.set_suggested_params_cache_timeout(0)
    acct = algorand.account.from_mnemonic(mnemonic=MNEMONIC)
    algod = algorand.client.algod
    _, guardian = account.generate_account()
    _, treasury = account.generate_account()

    def bal(address: str, asset_id: int) -> int:
        for a in algod.account_info(address).get("assets", []):
            if a["asset-id"] == asset_id:
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

    def padded(client, method, args, fillers=4):
        grp = algorand.new_group()
        grp.add_app_call_method_call(mc(client, method, args))
        for _ in range(fillers):
            grp.add_app_call_method_call(mc(filler, "noop", []))
        return grp.send(_SP)

    def psm_uint(app_id, key: bytes) -> int:
        for kv in algod.application_info(app_id)["params"].get("global-state", []):
            if kv["key"] == base64.b64encode(key).decode():
                return kv["value"]["uint"]
        return 0

    def deployed_principal(app_id) -> list[int]:
        for kv in algod.application_info(app_id)["params"].get("global-state", []):
            if kv["key"] == base64.b64encode(b"deployed_principal").decode():
                raw = base64.b64decode(kv["value"]["bytes"])
                return list(struct.unpack(">5Q", raw))
        return [0, 0, 0, 0, 0]

    # ── preflight ──────────────────────────────────────────────────────────────
    assert bal(acct.address, USDC) >= SEED_USDC, (
        f"wallet needs >= {SEED_USDC} µUSDC of Folks testnet USDC {USDC}; "
        f"faucet at https://testnet.folks.finance/faucet")

    # ── create test mUSD + deploy PSMv3 (short-timelock build) + adapter + filler ──
    musd = algorand.send.asset_create(AssetCreateParams(
        sender=acct.address, total=MUSD_TOTAL, decimals=6, default_frozen=False,
        unit_name="mUSD", asset_name="Magnet USD (testnet)")).asset_id

    psm_spec = _build_short_timelock_psm()
    psm, _ = algorand.client.get_app_factory(app_spec=psm_spec, default_sender=acct.address).send.create(
        AppFactoryCreateMethodCallParams(method="deploy", args=[musd, USDC, guardian], max_fee=_MAX_FEE),
        send_params=_SP)
    adapter, _ = algorand.client.get_app_factory(
        app_spec=_arc56("folks_adapter", "FolksAdapter"), default_sender=acct.address).send.create(
        AppFactoryCreateMethodCallParams(
            method="create", args=[psm.app_id, USDC, FUSDC, POOL, POOL_MGR, acct.address],
            max_fee=_MAX_FEE), send_params=_SP)
    filler, _ = algorand.client.get_app_factory(
        app_spec=_arc56("mock_psm", "MockPsm"), default_sender=acct.address).send.create(
        AppFactoryCreateMethodCallParams(method="create", args=[], max_fee=_MAX_FEE), send_params=_SP)
    print(f"\n[deploy] PSMv3={psm.app_id} adapter={adapter.app_id} filler={filler.app_id} mUSD={musd}")

    for addr, algo in [(psm.app_address, 1.0), (adapter.app_address, 1.0)]:
        algorand.send.payment(PaymentParams(sender=acct.address, receiver=addr,
                                            amount=AlgoAmount.from_algo(algo)))

    # ── wire ────────────────────────────────────────────────────────────────────
    call(psm, "opt_in_asset", [musd])
    call(psm, "opt_in_asset", [USDC])
    call(psm, "set_treasury", [treasury])
    call(adapter, "opt_in_asset", [USDC])
    call(adapter, "opt_in_asset", [FUSDC])

    # whitelist the adapter (short timelock)
    call(psm, "propose_adapter", [adapter.app_id])
    print(f"[timelock] waiting {SHORT_TL + 6}s for adapter whitelist eta…")
    time.sleep(SHORT_TL + 6)
    call(psm, "confirm_adapter", [])

    # seed reserves: full mUSD supply + USDC
    algorand.send.asset_transfer(AssetTransferParams(
        sender=acct.address, receiver=psm.app_address, asset_id=musd, amount=MUSD_TOTAL))
    grp = algorand.new_group()
    grp.add_asset_transfer(AssetTransferParams(
        sender=acct.address, receiver=psm.app_address, asset_id=USDC, amount=SEED_USDC, note=os.urandom(8)))
    grp.add_app_call_method_call(mc(psm, "deposit_usdc", [SEED_USDC]))
    grp.send(_SP)
    assert bal(psm.app_address, USDC) == SEED_USDC

    # ── strategy_deploy: PSMv3 → adapter → real Folks ────────────────────────────
    padded(psm, "strategy_deploy", [adapter.app_id, DEPLOY_AMT])
    fusdc = bal(adapter.app_address, FUSDC)
    print(f"[deploy] adapter fUSDC={fusdc}  PSM USDC={bal(psm.app_address, USDC)}  "
          f"principal={deployed_principal(psm.app_id)[0]}")
    assert fusdc > 0, "adapter got no fUSDC — deposit through PSMv3 failed"
    assert bal(psm.app_address, USDC) == SEED_USDC - DEPLOY_AMT
    assert deployed_principal(psm.app_id)[0] == DEPLOY_AMT

    # ── strategy_recall: empty the venue back into the PSM buffer ─────────────────
    padded(psm, "strategy_recall", [adapter.app_id, RECALL_AMT])
    psm_usdc = bal(psm.app_address, USDC)
    print(f"[recall] PSM USDC={psm_usdc}  principal={deployed_principal(psm.app_id)[0]}  "
          f"deficit={psm_uint(psm.app_id, b'reserve_deficit')}  adapter fUSDC={bal(adapter.app_address, FUSDC)}")
    assert deployed_principal(psm.app_id)[0] == 0
    assert psm_uint(psm.app_id, b"reserve_deficit") == 0, "unexpected deficit on a clean recall"
    assert psm_usdc >= SEED_USDC - 10, f"USDC not fully recovered: {psm_usdc}"

    # ── remove the (now-empty) adapter, then withdraw USDC back to the wallet ─────
    padded(psm, "remove_adapter", [adapter.app_id])
    assert deployed_principal(psm.app_id)[0] == 0
    call(psm, "set_buffer_bps", [0])
    wallet_before = bal(acct.address, USDC)
    call(psm, "withdraw_usdc", [bal(psm.app_address, USDC)])
    print(f"[cleanup] returned {bal(acct.address, USDC) - wallet_before} µUSDC to wallet")
    print("[ok] full PSMv3 → FolksAdapter → live Folks cycle passed")
