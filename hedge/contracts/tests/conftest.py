"""Localnet fixtures.

These exercise the COMPILED contract through real transaction groups. Every finding
from the implementation review — opcode budget, inner-transaction limits, fee pooling,
inner-payment failure, group-index pinning — is in the class that only an AVM-level
test can catch; pure-Python arithmetic tests cannot reach any of it.
"""

import base64
import subprocess
import sys
import time
from pathlib import Path

import algokit_utils
import pytest
from algokit_utils import AlgorandClient, SigningAccount
from algosdk import transaction
from nacl.signing import SigningKey

ROOT = Path(__file__).parent.parent
BUILD_DIR = ROOT / "smart_contracts" / "artifacts_test"

BANDS = (9650, 9775, 9875, 9950, 10050, 10125, 10225, 10350)
RAKE_BPS = 400
MIN_STAKE = 5_000_000
BOX_MBR = 41_700
PAYOUT_FEE = 8_000
MIN_ENTRY_WINDOW = 3_600
MIN_SESSION = 7_200


@pytest.fixture(scope="session")
def algorand() -> AlgorandClient:
    return AlgorandClient.default_localnet()


@pytest.fixture(scope="session")
def dispenser(algorand: AlgorandClient) -> SigningAccount:
    return algorand.account.localnet_dispenser()


@pytest.fixture(scope="session")
def admin(algorand: AlgorandClient, dispenser: SigningAccount) -> SigningAccount:
    acct = algorand.account.random()
    algorand.account.ensure_funded(acct.address, dispenser, algokit_utils.AlgoAmount(algo=200))
    return acct


@pytest.fixture(scope="session")
def musd(algorand: AlgorandClient, admin: SigningAccount) -> int:
    """An asset shaped exactly like mainnet mUSD: 6 decimals, unit name mUSD, and —
    the property that actually carries the ring-fencing claim — clawback and freeze
    both the zero address. bootstrap asserts all four."""
    result = algorand.send.asset_create(
        algokit_utils.AssetCreateParams(
            sender=admin.address,
            total=500_000_000_000_000,
            decimals=6,
            unit_name="mUSD",
            asset_name="Magnet USD",
            manager=admin.address,
            reserve=admin.address,
            # clawback and freeze deliberately unset -> zero address
        )
    )
    return result.asset_id


@pytest.fixture(scope="session")
def app_spec() -> dict:
    """One artifact for every network; MUSD_ASSET_ID is substituted at deploy."""
    sys.path.insert(0, str(ROOT))
    from smart_contracts.__main__ import build  # noqa: PLC0415

    assert build(out_dir=BUILD_DIR) == 0
    import json  # noqa: PLC0415

    return json.loads((BUILD_DIR / "ladder" / "Ladder.arc56.json").read_text())


@pytest.fixture(scope="session")
def oracle_key() -> SigningKey:
    return SigningKey(b"\x11" * 32)


def opt_in(algorand: AlgorandClient, acct: SigningAccount, asset_id: int) -> None:
    algorand.send.asset_opt_in(
        algokit_utils.AssetOptInParams(sender=acct.address, asset_id=asset_id)
    )


def fund_musd(
    algorand: AlgorandClient, admin: SigningAccount, to: SigningAccount,
    asset_id: int, amount: int,
) -> None:
    opt_in(algorand, to, asset_id)
    algorand.send.asset_transfer(
        algokit_utils.AssetTransferParams(
            sender=admin.address, receiver=to.address,
            asset_id=asset_id, amount=amount,
        )
    )


def player(
    algorand: AlgorandClient, dispenser: SigningAccount, admin: SigningAccount,
    musd_id: int, musd_amount: int = 1_000_000_000,
) -> SigningAccount:
    acct = algorand.account.random()
    algorand.account.ensure_funded(acct.address, dispenser, algokit_utils.AlgoAmount(algo=10))
    fund_musd(algorand, admin, acct, musd_id, musd_amount)
    return acct


def sign_attestation(
    key: SigningKey, app_id: int, round_id: int, kind: int, mask: int,
    feed_id: int, prices: list[int], timestamps: list[int],
) -> bytes:
    """Mirrors the contract's preimage exactly.

    app_id, round_id, kind and feed_id come from contract state there — if a keeper
    built the preimage from call arguments instead, those bindings would be decorative
    and an attestation for another app or feed would replay.
    """
    import hashlib

    msg = b"".join(
        x.to_bytes(8, "big")
        for x in [app_id, round_id, kind, mask, feed_id, *prices, *timestamps]
    )
    return key.sign(hashlib.sha256(msg).digest()).signature


ALGOD_TOKEN = "a" * 64


def set_offset(seconds: int) -> None:
    import urllib.request

    req = urllib.request.Request(
        f"http://localhost:4001/v2/devmode/blocks/offset/{seconds}",
        method="POST", headers={"X-Algo-API-Token": ALGOD_TOKEN},
    )
    urllib.request.urlopen(req, timeout=10).read()


def chain_now(algorand) -> int:
    """The chain's clock, not the wall clock. Dev-mode offsets mean they diverge, and
    every timestamp guard in the contract reads Global.latest_timestamp."""
    status = algorand.client.algod.status()
    blk = algorand.client.algod.block_info(status["last-round"])
    return blk["block"]["ts"]


def advance_to(algorand, dispenser, target_ts: int) -> None:
    """Move the chain clock to at least target_ts.

    The dev-mode offset is the delta applied to EACH new block, not an absolute offset
    from wall clock — so it is set, consumed by exactly one block, and reset. Leaving it
    set compounds every subsequent block and runs the chain away.

    A real round spans hours; this makes the whole lifecycle testable without touching
    a single contract constant.
    """
    delta = target_ts - chain_now(algorand)
    if delta <= 0:
        return
    set_offset(delta + 5)
    tick(algorand, dispenser)
    set_offset(0)
    now = chain_now(algorand)
    assert now >= target_ts, f"wanted {target_ts}, chain at {now}"


def tick(algorand, dispenser) -> None:
    """Produce a block so the pending timestamp offset takes effect.

    The note keeps each tick a distinct transaction — identical ones collide with
    "already in ledger".
    """
    import os

    import algokit_utils

    algorand.send.payment(
        algokit_utils.PaymentParams(
            sender=dispenser.address, receiver=dispenser.address,
            amount=algokit_utils.AlgoAmount(micro_algo=0),
            note=os.urandom(8),
        )
    )
