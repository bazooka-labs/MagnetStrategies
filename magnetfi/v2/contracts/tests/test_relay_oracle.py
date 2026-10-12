"""
MagnetFi Relay Oracle (v5) — LocalNet integration tests.

The point of v5 is one property: **a liquidator can always make the price fresh
inside their own transaction group**, so the vault's freshness window can never
be the reason a liquidation fails. Everything else here protects that.

These run against real compiled contracts on a dev-mode LocalNet, with real
ed25519 payloads built by the same `signer/payload.py` the production signer
will use — so a disagreement between the contract's byte offsets and the
signer's is a test failure, not a mainnet surprise.

Requires: `algokit localnet start`, and both contracts compiled.
"""

from __future__ import annotations

import base64
import sys
import time
from pathlib import Path

import algosdk
import pytest
from algokit_utils import (
    AlgoAmount,
    AlgorandClient,
    AppClientMethodCallParams,
    AppFactoryCreateMethodCallParams,
    CommonAppCallParams,
    SendParams,
)
import algokit_utils

algokit_utils.config.config.configure(populate_app_call_resources=True, debug=False)

# the production payload builder — deliberately the same module, not a copy
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "signer"))
import payload as pl  # noqa: E402

ROOT = Path(__file__).resolve().parents[1] / "smart_contracts"
SEED = bytes(range(32))
ADMIN_ADDR: list[str] = []   # filled by the deployed fixture
POOL = 3_163_770_927          # U/tALGO LP ASA, as on mainnet
PRICE = 915_905


def pubkey() -> bytes:
    import nacl.signing
    return bytes(nacl.signing.SigningKey(SEED).verify_key)


@pytest.fixture(scope="module")
def algorand() -> AlgorandClient:
    return AlgorandClient.default_localnet()


@pytest.fixture(scope="module", autouse=True)
def real_clock(algorand: AlgorandClient):
    """
    Reset LocalNet's block-time offset before this module runs.

    Other modules in this suite time-travel — they push the chain clock days or
    months forward to exercise interest accrual and overdue logic. This module
    is the one that cares about the chain clock in SECONDS, because a payload
    is only valid for 30 of them, so it must not inherit their offset.

    Found the hard way: these tests passed alone and failed after the full
    suite, with "payload expired" — the assertion working correctly on a clock
    someone else had moved.
    """
    import urllib.request
    try:
        req = urllib.request.Request(
            "http://localhost:4001/v2/devmode/blocks/offset/0", method="POST",
            headers={"X-Algo-API-Token": "a" * 64})
        urllib.request.urlopen(req, timeout=5).close()
    except Exception as e:      # noqa: BLE001 — a non-dev node just has no offset
        print(f"could not reset block-time offset ({e}); continuing")
    yield


@pytest.fixture(scope="module")
def genesis(algorand: AlgorandClient) -> bytes:
    """LocalNet's genesis hash — the contract reads it from the chain."""
    return base64.b64decode(algorand.client.algod.suggested_params().gh)


@pytest.fixture(scope="module")
def accounts(algorand: AlgorandClient):
    admin = algorand.account.localnet_dispenser()
    guardian = algorand.account.random()
    stranger = algorand.account.random()
    for acct in (guardian, stranger):
        algorand.send.payment(algokit_utils.PaymentParams(
            sender=admin.address, receiver=acct.address,
            amount=AlgoAmount(algo=20)))
    return admin, guardian, stranger


@pytest.fixture(scope="module")
def deployed(algorand: AlgorandClient, accounts):
    """Deploy OpUp, then the oracle pointed at it, then register one pool."""
    admin, guardian, _ = accounts

    opup_factory = algorand.client.get_app_factory(
        app_spec=(ROOT / "opup" / "OpUp.arc56.json").read_text(), default_sender=admin.address)
    opup, _ = opup_factory.send.create(
        AppFactoryCreateMethodCallParams(method="deploy", args=[]))

    oracle_factory = algorand.client.get_app_factory(
        app_spec=(ROOT / "relay_oracle" / "RelayOracle.arc56.json").read_text(),
        default_sender=admin.address)
    oracle, _ = oracle_factory.send.create(AppFactoryCreateMethodCallParams(
        method="deploy", args=[guardian.address, pubkey(), opup.app_id]))

    algorand.send.payment(algokit_utils.PaymentParams(
        sender=admin.address, receiver=oracle.app_address, amount=AlgoAmount(algo=5)))
    oracle.send.call(AppClientMethodCallParams(
        method="add_pool", args=[POOL, PRICE], sender=admin.address))
    ADMIN_ADDR.clear(); ADMIN_ADDR.append(admin.address)
    return opup, oracle


def chain_now(algorand: AlgorandClient) -> int:
    """
    The chain's own clock, not the wall clock.

    LocalNet is a dev chain whose time is advanced by other tests — measured
    ~340 DAYS ahead of wall clock on this machine. The contract compares
    issued_at against `Global.latest_timestamp`, so a payload timestamped from
    `time.time()` is hundreds of days expired and every post fails. Which is
    the check working correctly, and a good reminder that the signer must take
    its clock seriously too.

    Mints a block first, then reads ITS timestamp.

    Reading the current last block is not enough: whatever the chain's clock is
    doing, the value the next transaction sees as `Global.latest_timestamp` is
    the timestamp of the block immediately before it. Minting one and reading
    that makes the two agree by construction, instead of hoping no time passes
    in between — which is what made the first test in this module flaky while
    the rest passed.
    """
    acct = algorand.account.localnet_dispenser()
    algorand.send.payment(algokit_utils.PaymentParams(
        sender=acct.address, receiver=acct.address, amount=AlgoAmount(micro_algo=0),
        note=f"tick-{time.time_ns()}".encode()))
    st = algorand.client.algod.status()
    blk = algorand.client.algod.block_info(st["last-round"])["block"]
    return blk.get("ts") or blk.get("timestamp")


def build(genesis: bytes, algorand: AlgorandClient, **over) -> tuple[bytes, bytes]:
    d = dict(target_app=0, lp_asa_id=POOL, price_min=PRICE, price_max=PRICE,
             issued_at=chain_now(algorand), genesis=genesis)
    d.update(over)
    return pl.sign(pl.Payload(**d), SEED)


def post(oracle, algorand, msg, sig, sender, extra_fee_txns: int = 4):
    """Post, paying enough fee to cover the oracle's inner OpUp calls."""
    return oracle.send.call(AppClientMethodCallParams(
        method="post_signed_price", args=[msg, sig], sender=sender,
        static_fee=AlgoAmount(micro_algo=1000 * extra_fee_txns)))


def read_state(algorand, app_id: int, prefix: bytes, pool: int) -> int | None:
    info = algorand.client.algod.application_info(app_id)
    want = base64.b64encode(prefix + pool.to_bytes(8, "big")).decode()
    for kv in info["params"].get("global-state", []):
        if kv["key"] == want:
            return kv["value"]["uint"]
    return None


# ── the offsets agree between contract and signer ────────────────────────────

def test_a_real_signed_payload_is_accepted_and_read_correctly(deployed, algorand, genesis):
    """
    The whole byte layout, end to end.

    The contract extracts each field by hardcoded offset from an ABI `byte[]`,
    and the signer packs them with `struct`. If those disagree by even one byte
    — the ABI length prefix being the obvious trap — the pool id reads as
    garbage and the whitelist check rejects it. So this passing is what proves
    the two agree.
    """
    _, oracle = deployed
    # Let build() stamp it and read the value back out of the SIGNED bytes.
    # Stamping it here instead would use a different clock reading from the one
    # build() mints against, so the payload would carry the timestamp of the
    # block BEFORE the one the contract sees — which is exactly how this test
    # failed while every other test in the module passed.
    msg, sig = build(genesis, algorand, target_app=oracle.app_id)
    issued = pl.decode(msg).issued_at
    post(oracle, algorand, msg, sig, ADMIN_ADDR[0])

    assert read_state(algorand, oracle.app_id, b"lp_price_", POOL) == PRICE
    # lp_ts_ carries the payload's OWN issued_at, not the block time, so the
    # age signal stays honest for a replayed payload.
    assert read_state(algorand, oracle.app_id, b"lp_ts_", POOL) == issued


def test_a_distinct_price_really_moves_the_stored_value(deployed, algorand, genesis):
    """Guards against the previous test passing on a stale add_pool seed."""
    _, oracle = deployed
    msg, sig = build(genesis, algorand, target_app=oracle.app_id, price_min=1_234_567,
                     price_max=1_234_567)
    post(oracle, algorand, msg, sig, ADMIN_ADDR[0])
    assert read_state(algorand, oracle.app_id, b"lp_price_", POOL) == 1_234_567


# ── permissionless: the property v5 exists for ───────────────────────────────

def test_a_stranger_with_no_role_can_post(deployed, algorand, accounts, genesis):
    """
    No sender check. A liquidator who holds nothing but a payload and a fee can
    refresh the price — which is what makes the freshness window unable to
    block a liquidation.
    """
    _, oracle = deployed
    _, _, stranger = accounts
    msg, sig = build(genesis, algorand, target_app=oracle.app_id, price_min=999_111,
                     price_max=999_111)
    post(oracle, algorand, msg, sig, stranger.address)
    assert read_state(algorand, oracle.app_id, b"lp_price_", POOL) == 999_111


def test_posting_creates_no_state(deployed, algorand, accounts, genesis):
    """
    Anyone can post, so posting must not grow state or there is a cheap
    griefing path. add_pool is admin-only and the keys already exist.
    """
    _, oracle = deployed
    _, _, stranger = accounts
    before = len(algorand.client.algod.application_info(oracle.app_id)["params"]["global-state"])
    msg, sig = build(genesis, algorand, target_app=oracle.app_id)
    post(oracle, algorand, msg, sig, stranger.address)
    after = len(algorand.client.algod.application_info(oracle.app_id)["params"]["global-state"])
    assert after == before


# ── no price gate survives (SPEC §2.6) ───────────────────────────────────────

def test_a_ten_times_price_posts_successfully(deployed, algorand, genesis):
    """
    The commitment v5 exists to honour: no band, no anchor, no deviation guard.
    A 10x move is exactly what froze the feed before. If anyone reintroduces a
    gate, this fails loudly.
    """
    _, oracle = deployed
    huge = PRICE * 10
    msg, sig = build(genesis, algorand, target_app=oracle.app_id, price_min=huge,
                     price_max=huge)
    post(oracle, algorand, msg, sig, ADMIN_ADDR[0])
    assert read_state(algorand, oracle.app_id, b"lp_price_", POOL) == huge


# ── bindings: authentic, but for something else ──────────────────────────────

def _rejects(oracle, algorand, msg, sig, sender, because: str):
    """
    Assert the post fails FOR THE STATED REASON.

    A bare `pytest.raises(Exception)` would also pass on a fee error, a
    resource error, or a typo in the test — passing while proving nothing. The
    contract puts its reason in the assert comment, so match on it.
    """
    with pytest.raises(Exception) as e:
        post(oracle, algorand, msg, sig, sender)
    assert because in str(e.value), f"failed, but for the wrong reason: {e.value}"


def test_rejects_a_payload_for_another_app(deployed, algorand, genesis):
    _, oracle = deployed
    msg, sig = build(genesis, algorand, target_app=oracle.app_id + 1)
    _rejects(oracle, algorand, msg, sig, ADMIN_ADDR[0], "payload targets another app")


def test_rejects_a_payload_for_another_network(deployed, algorand):
    """GENESIS_MAINNET on LocalNet — the contract reads genesis off the chain."""
    _, oracle = deployed
    msg, sig = build(pl.GENESIS_MAINNET, algorand, target_app=oracle.app_id)
    _rejects(oracle, algorand, msg, sig, ADMIN_ADDR[0], "bad magic, version or network")


def test_rejects_an_unregistered_pool(deployed, algorand, genesis):
    _, oracle = deployed
    msg, sig = build(genesis, algorand, target_app=oracle.app_id, lp_asa_id=999_999_999)
    _rejects(oracle, algorand, msg, sig, ADMIN_ADDR[0], "pool not in whitelist")


def test_rejects_an_expired_payload(deployed, algorand, genesis):
    """Replay protection — a payload is public the moment it is used."""
    _, oracle = deployed
    msg, sig = build(genesis, algorand, target_app=oracle.app_id,
                     issued_at=chain_now(algorand) - (pl.PAYLOAD_MAX_AGE + 120))
    _rejects(oracle, algorand, msg, sig, ADMIN_ADDR[0], "payload expired")


def test_rejects_a_payload_whose_own_max_age_has_passed(deployed, algorand, genesis):
    """The signer may ask for a SHORTER life; the contract honours it."""
    _, oracle = deployed
    msg, sig = build(genesis, algorand, target_app=oracle.app_id, max_age=5,
                     issued_at=chain_now(algorand) - 20)
    _rejects(oracle, algorand, msg, sig, ADMIN_ADDR[0], "payload expired")


def test_rejects_a_tampered_message(deployed, algorand, genesis):
    _, oracle = deployed
    msg, sig = build(genesis, algorand, target_app=oracle.app_id)
    bad = bytearray(msg); bad[pl.MSG_LEN - 20] ^= 0x01
    _rejects(oracle, algorand, bytes(bad), sig, ADMIN_ADDR[0], "bad signature")


def test_rejects_a_signature_from_another_key(deployed, algorand, genesis):
    """A valid signature is not enough — it must be OUR signer's."""
    import nacl.signing
    _, oracle = deployed
    p = pl.Payload(target_app=oracle.app_id, lp_asa_id=POOL, price_min=PRICE,
                   price_max=PRICE, issued_at=chain_now(algorand), genesis=genesis)
    msg = pl.encode(p)
    other = nacl.signing.SigningKey(bytes(range(1, 33))).sign(msg).signature
    _rejects(oracle, algorand, msg, other, ADMIN_ADDR[0], "bad signature")


def test_rejects_a_wrong_length_message(deployed, algorand, genesis):
    _, oracle = deployed
    msg, sig = build(genesis, algorand, target_app=oracle.app_id)
    _rejects(oracle, algorand, msg + b"\x00", sig, ADMIN_ADDR[0], "bad message length")


# ── admin surface ────────────────────────────────────────────────────────────

def test_add_pool_rejects_a_stranger(deployed, algorand, accounts):
    _, oracle = deployed
    _, _, stranger = accounts
    with pytest.raises(Exception):
        oracle.send.call(AppClientMethodCallParams(
            method="add_pool", args=[123456, 1_000_000], sender=stranger.address))


def test_admin_set_price_is_the_break_glass(deployed, algorand, accounts):
    """
    Grants nothing new — remove_pool + add_pool was always an admin price write.
    It exists so a POSTING bug is an inconvenience rather than a 48h freeze.
    """
    admin, _, stranger = accounts
    _, oracle = deployed
    oracle.send.call(AppClientMethodCallParams(
        method="admin_set_price", args=[POOL, 777_777], sender=admin.address))
    assert read_state(algorand, oracle.app_id, b"lp_price_", POOL) == 777_777
    with pytest.raises(Exception):
        oracle.send.call(AppClientMethodCallParams(
            method="admin_set_price", args=[POOL, 1], sender=stranger.address))


def test_signer_rotation_is_timelocked(deployed, algorand, accounts):
    admin, guardian, _ = accounts
    _, oracle = deployed
    import nacl.signing
    new = bytes(nacl.signing.SigningKey(bytes(range(2, 34))).verify_key)
    oracle.send.call(AppClientMethodCallParams(
        method="propose_signer", args=[new], sender=admin.address))
    with pytest.raises(Exception):      # 48h has not elapsed
        oracle.send.call(AppClientMethodCallParams(
            method="confirm_signer", args=[], sender=admin.address))
    # the guardian veto
    oracle.send.call(AppClientMethodCallParams(
        method="cancel_pending_signer", args=[], sender=guardian.address))
    with pytest.raises(Exception):      # nothing pending now
        oracle.send.call(AppClientMethodCallParams(
            method="confirm_signer", args=[], sender=admin.address))
