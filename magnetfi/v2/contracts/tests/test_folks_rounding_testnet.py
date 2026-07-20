"""
FolksAdapter small-deposit / share-rounding DRILL on TESTNET (audit §8.5 item 1).

Probes the first-depositor / ERC-4626-class rounding concern against the REAL Folks v2 testnet
USDC pool. For a range of tiny deposits it verifies the two safety properties the PSM's invariant
relies on:
  (a) OVER-COUNT SAFETY — immediately after a deposit, the incremental recoverable_value never
      EXCEEDS the amount deposited (else min(principal, recoverable) could count phantom backing).
  (b) BOUNDED, CONSERVATIVE LOSS — any entry-rounding shortfall (fUSDC mint rounds down; a seasoned
      pool has index > 1.0 so sub-ratio deposits can mint 0 fUSDC) is small and always in the
      protocol's favour (recoverable ≤ principal), well within DUST_EPSILON (1000 µUSDC).

This is a probe, not a pass/fail on Folks' behaviour: it prints the round-to-zero threshold so we
can document "don't deploy dust amounts" — irrelevant in practice (the PSM deploys thousands of
USDC) but proven at the boundary.

Gated on FOLKS_TEST_MNEMONIC (throwaway testnet wallet with ALGO + testnet USDC 67395862).
    export FOLKS_TEST_MNEMONIC="..."
    magnetfi/v2/contracts/.venv-test/bin/python -m pytest tests/test_folks_rounding_testnet.py -s -q
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
    not MNEMONIC, reason="set FOLKS_TEST_MNEMONIC (throwaway testnet wallet) to run"
)

POOL = 147170678
POOL_MGR = 147157634
USDC = 67395862
FUSDC = 147171826
INDEX_OFFSET = 40
ONE_14_DP = 100_000_000_000_000
DUST_EPSILON = 1_000
# Tiny amounts (µUSDC): straddle the round-to-zero ratio (~index/1e14 ≈ 1.19) up to 0.001 USDC.
AMOUNTS = [1, 2, 3, 5, 13, 100, 1_000]

CONTRACTS_DIR = Path(__file__).resolve().parent.parent / "smart_contracts"
_SP = SendParams(populate_app_call_resources=True, cover_app_call_inner_transaction_fees=True)
_MAX_FEE = AlgoAmount(micro_algo=200_000)
algokit_utils.config.config.configure(populate_app_call_resources=True, debug=False)


def _arc56(folder: str, cls: str) -> str:
    return (CONTRACTS_DIR / folder / f"{cls}.arc56.json").read_text()


def test_folks_small_deposit_rounding():
    algorand = AlgorandClient.testnet()
    algorand.set_suggested_params_cache_timeout(0)
    acct = algorand.account.from_mnemonic(mnemonic=MNEMONIC)
    algod = algorand.client.algod

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

    def call_grouped(client, method, args, fillers=3):
        grp = algorand.new_group()
        grp.add_app_call_method_call(mc(client, method, args))
        for _ in range(fillers):
            grp.add_app_call_method_call(mc(psm, "noop", []))
        return grp.send(_SP)

    def pool_index() -> int:
        for kv in algod.application_info(POOL)["params"].get("global-state", []):
            if kv["key"] == base64.b64encode(b"i").decode():
                raw = base64.b64decode(kv["value"]["bytes"])
                return int.from_bytes(raw[INDEX_OFFSET:INDEX_OFFSET + 8], "big")
        raise AssertionError("pool index missing")

    def recoverable() -> int:
        return int(call(adapter, "recoverable_value", []).abi_return)

    total = sum(AMOUNTS)
    assert bal(acct.address, USDC) >= total, f"wallet needs >= {total} µUSDC (67395862)"

    # ── deploy MockPsm caller + FolksAdapter ──
    psm, _ = algorand.client.get_app_factory(
        app_spec=_arc56("mock_psm", "MockPsm"), default_sender=acct.address).send.create(
        AppFactoryCreateMethodCallParams(method="create", args=[], max_fee=_MAX_FEE), send_params=_SP)
    adapter, _ = algorand.client.get_app_factory(
        app_spec=_arc56("folks_adapter", "FolksAdapter"), default_sender=acct.address).send.create(
        AppFactoryCreateMethodCallParams(
            method="create", args=[psm.app_id, USDC, FUSDC, POOL, POOL_MGR, acct.address],
            max_fee=_MAX_FEE), send_params=_SP)
    for addr, algo in [(adapter.app_address, 1.0), (psm.app_address, 0.5)]:
        algorand.send.payment(PaymentParams(sender=acct.address, receiver=addr, amount=AlgoAmount.from_algo(algo)))
    call(adapter, "opt_in_asset", [USDC])
    call(adapter, "opt_in_asset", [FUSDC])
    call(psm, "opt_in_asset", [USDC])

    idx = pool_index()
    print(f"\n[pool] deposit index = {idx} ({idx/1e14:.6f}); round-to-zero below "
          f"~{idx // ONE_14_DP + 1} µUSDC per deposit\n")
    print(f"{'deposit':>8} {'fUSDC Δ':>9} {'recov Δ':>8} {'loss':>6}  {'over-count?':>11}")

    zero_share_threshold = None
    for amt in AMOUNTS:
        f_before, r_before = bal(adapter.app_address, FUSDC), recoverable()
        # fund_and_deposit forwards USDC from the MockPsm's own balance → send it there first.
        algorand.send.asset_transfer(AssetTransferParams(
            sender=acct.address, receiver=psm.app_address, asset_id=USDC, amount=amt, note=os.urandom(8)))
        call_grouped(psm, "fund_and_deposit", [adapter.app_id, USDC, amt])
        f_delta = bal(adapter.app_address, FUSDC) - f_before
        r_delta = recoverable() - r_before
        loss = amt - r_delta
        over = r_delta > amt
        print(f"{amt:>8} {f_delta:>9} {r_delta:>8} {loss:>6}  {'** YES **' if over else 'no':>11}")

        # (a) OVER-COUNT SAFETY — the invariant-critical property.
        assert not over, f"recoverable Δ {r_delta} EXCEEDS deposit {amt} — min() over-count risk!"
        # (b) BOUNDED, CONSERVATIVE LOSS — rounding never favours the depositor beyond dust.
        assert loss >= 0, "negative loss means over-count (should be caught above)"
        assert loss <= DUST_EPSILON, f"entry-rounding loss {loss} exceeds ε ({DUST_EPSILON})"
        if f_delta == 0 and zero_share_threshold is None:
            zero_share_threshold = amt

    print(f"\n[result] largest deposit that minted 0 fUSDC: "
          f"{zero_share_threshold if zero_share_threshold else 'none in range'}")
    print("[ok] no over-count at any tiny deposit; all rounding losses conservative + within ε")

    # ── cleanup: withdraw everything back, return USDC to wallet ──
    call_grouped(psm, "do_withdraw", [adapter.app_id, 10_000_000])
    got = bal(psm.app_address, USDC)
    print(f"[cleanup] recovered {got} µUSDC to the caller")
