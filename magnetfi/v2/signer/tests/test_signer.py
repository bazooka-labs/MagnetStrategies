"""
Tests for the v5 signer.

The pricing pipeline is oracle_bot's and has its own 139 tests; these cover what
is new — key handling, the confidence policy, the one legitimate refusal, and
the property that matters most: **the signer is not a gate.**
"""
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / "oracle_bot"))
import oracle_bot as ob      # noqa: E402
import payload as pl         # noqa: E402
import signer as sg          # noqa: E402

SEED = bytes(range(32))
ORACLE_APP = 4_242_424_242
POOL = 3_163_770_927


def make_pool(**over):
    d = dict(pool_id=POOL, pool_address="X", asset_a_id=1, asset_a_decimals=6,
             asset_b_id=2, asset_b_decimals=6, label="U/tALGO")
    d.update(over)
    return ob.PoolConfig(d)


def make_cfg(**over):
    raw = dict(oracle_app_id=555, usdc_asa_id=31566704, asset_decimals={},
               asset_price_bounds={}, reference_pools={}, pools=[])
    raw.update(over)
    return ob.BotConfig(raw)


@pytest.fixture
def twap(tmp_path):
    return ob.TwapState(tmp_path / "t.json")


def fill(twap, price=915_905, n=None):
    """Give a pool enough history that the TWAP gate is satisfied."""
    import time
    n = n if n is not None else ob.MIN_TWAP_READINGS
    base = int(time.time()) - n * 300
    for i in range(n):
        twap.add(POOL, base + i * 300, price, ob.TWAP_WINDOW)


def price_is(monkeypatch, value, compx=True):
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: (value, compx))


# ── the signing key ──────────────────────────────────────────────────────────

def test_rejects_a_missing_key(monkeypatch):
    monkeypatch.delenv(sg.SEED_ENV, raising=False)
    with pytest.raises(RuntimeError, match="not set"):
        sg.load_signing_key()


def test_rejects_a_mnemonic(monkeypatch):
    """
    The commonest mistake available. This key is deliberately NOT an Algorand
    account — it signs prices and cannot sign a transaction — so an Algorand
    mnemonic here means someone has reached for the wrong key entirely.
    """
    monkeypatch.setenv(sg.SEED_ENV, "abandon abandon abandon about")
    with pytest.raises(RuntimeError, match="valid hex"):
        sg.load_signing_key()


def test_rejects_a_wrong_length_seed(monkeypatch):
    monkeypatch.setenv(sg.SEED_ENV, "aabbcc")
    with pytest.raises(RuntimeError, match="need 32"):
        sg.load_signing_key()


def test_accepts_a_real_seed_and_derives_the_pinned_key(monkeypatch):
    import nacl.signing
    monkeypatch.setenv(sg.SEED_ENV, SEED.hex())
    assert sg.load_signing_key() == SEED
    assert sg.public_key(SEED) == bytes(nacl.signing.SigningKey(SEED).verify_key)


# ── the signer is NOT a gate (ORACLE_V5_SPEC.md §2.6) ────────────────────────

def test_it_signs_a_price_ten_times_the_last_one(monkeypatch, twap):
    """
    The commitment. A 10x move is what froze the feed three times; under v5 it
    must sail through. If anyone reintroduces a bound here, this fails loudly —
    and a bound in the SIGNER is the same total halt as a band in the contract,
    because no payload means nobody can post.
    """
    fill(twap, price=915_905)
    price_is(monkeypatch, 9_159_050)
    out = sg.sign_pool(object(), make_cfg(), make_pool(), twap, ORACLE_APP, SEED)
    assert out is not None, "the signer refused a large move — it has become a gate"


def test_it_does_not_consult_the_anchor_bound(monkeypatch, twap):
    """Explicitly: effective_bounds must never be reached from this path."""
    fill(twap)
    called = []
    monkeypatch.setattr(ob, "effective_bounds", lambda *a, **k: called.append(1) or (1, 2))
    monkeypatch.setattr(ob, "fetch_pool_state", lambda *a, **k: {
        "asset_1_id": 1, "asset_2_id": 2, "asset_1_reserves": 10**6,
        "asset_2_reserves": 10**6, "issued_pool_tokens": 10**6,
        "pool_token_asset_id": POOL})
    monkeypatch.setattr(ob, "derive_asset_price_usdc", lambda *a, **k: 1.0)
    sg.sign_pool(object(), make_cfg(), make_pool(), twap, ORACLE_APP, SEED)
    assert not called, "the signer consulted the anchor bound"


# ── the one legitimate refusal ───────────────────────────────────────────────

def test_it_refuses_to_sign_an_unsmoothed_price(monkeypatch, twap):
    """
    The single exception, and it is not a price gate: an unsmoothed spot price
    on a thin pool is signable garbage, because anyone who can move the pool for
    one block could make us sign it.
    """
    price_is(monkeypatch, 915_905)
    assert sg.sign_pool(object(), make_cfg(), make_pool(), twap, ORACLE_APP, SEED) is None


def test_the_cold_start_window_fits_inside_the_vaults_freshness(monkeypatch):
    """
    Which is why that refusal cannot cause an outage: the last good on-chain
    price stays valid for 30 minutes and the TWAP refills in 15.
    """
    warmup = ob.MIN_TWAP_READINGS * ob.POLL_INTERVAL
    assert warmup < 1_800, f"a signer restart would outlive the freshness window ({warmup}s)"


def test_it_signs_once_the_window_fills(monkeypatch, twap):
    price_is(monkeypatch, 915_905)
    p = make_pool()
    for _ in range(ob.MIN_TWAP_READINGS - 1):
        assert sg.sign_pool(object(), make_cfg(), p, twap, ORACLE_APP, SEED) is None
    assert sg.sign_pool(object(), make_cfg(), p, twap, ORACLE_APP, SEED) is not None


def test_an_unpriceable_pool_yields_no_payload(monkeypatch, twap):
    fill(twap)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: None)
    assert sg.sign_pool(object(), make_cfg(), make_pool(), twap, ORACLE_APP, SEED) is None


# ── confidence: the signer may shorten, never lengthen ───────────────────────

def test_a_verified_price_gets_the_full_life():
    assert sg.requested_max_age(True) == pl.PAYLOAD_MAX_AGE


def test_a_degraded_price_asks_for_less():
    assert sg.requested_max_age(False) < pl.PAYLOAD_MAX_AGE


def test_the_request_can_never_exceed_the_contracts_ceiling():
    """
    A clamp, not a setting. encode() refuses anything above the ceiling, so a
    compromised signer cannot mint itself a long-lived payload.
    """
    for verified in (True, False):
        assert sg.requested_max_age(verified) <= pl.PAYLOAD_MAX_AGE


def test_a_degraded_payload_really_carries_the_shorter_life(monkeypatch, twap):
    fill(twap)
    price_is(monkeypatch, 915_905, compx=False)
    msg, _ = sg.sign_pool(object(), make_cfg(), make_pool(), twap, ORACLE_APP, SEED)
    assert pl.decode(msg).max_age == sg.DEGRADED_MAX_AGE


# ── what gets signed ─────────────────────────────────────────────────────────

def test_the_payload_binds_to_the_oracle_and_the_pool(monkeypatch, twap):
    fill(twap)
    price_is(monkeypatch, 915_905)
    msg, sig = sg.sign_pool(object(), make_cfg(), make_pool(), twap, ORACLE_APP, SEED)
    p = pl.check_bindings(pl.verify(msg, sig, sg.public_key(SEED)),
                          target_app=ORACLE_APP, lp_asa_id=POOL,
                          now=pl.decode(msg).issued_at)
    assert p.target_app == ORACLE_APP and p.lp_asa_id == POOL


def test_it_signs_the_TWAP_not_the_spot(monkeypatch, twap):
    """
    The whole reason the refusal above exists. If this ever signs spot, a
    single-block pool move becomes a signed price.
    """
    fill(twap, price=1_000_000)
    price_is(monkeypatch, 2_000_000)        # a spike
    msg, _ = sg.sign_pool(object(), make_cfg(), make_pool(), twap, ORACLE_APP, SEED)
    signed = pl.decode(msg).price_min
    assert signed < 2_000_000, "signed the spot price, not the TWAP"


# ── the bundle ───────────────────────────────────────────────────────────────

def test_one_bad_pool_does_not_lose_the_others(monkeypatch, twap):
    """A single pool failing must not cost every other pool its payload."""
    good, bad = make_pool(), make_pool(pool_id=999, label="BROKEN")
    fill(twap)
    def flaky(client, pool, cfg, **k):
        if pool.pool_id == 999:
            raise RuntimeError("pool is on fire")
        return (915_905, True)
    monkeypatch.setattr(ob, "get_lp_price", flaky)
    cfg = make_cfg()
    cfg.pools = [bad, good]
    bundle = json.loads(sg.run_once(object(), cfg, twap, ORACLE_APP, SEED))
    assert len(bundle["payloads"]) == 1
    assert f"app-{ORACLE_APP}/lp-{POOL}" in bundle["payloads"]


def test_an_empty_bundle_is_still_valid_json(monkeypatch, twap):
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: None)
    cfg = make_cfg(); cfg.pools = [make_pool()]
    bundle = json.loads(sg.run_once(object(), cfg, twap, ORACLE_APP, SEED))
    assert bundle["payloads"] == {}
    assert "generated_at" in bundle


def test_publish_is_atomic(tmp_path):
    """
    A truncated bundle is one whose signatures do not verify — which looks
    exactly like an attack. So it is written and renamed, never streamed.
    """
    dest = tmp_path / "bundle.json"
    sg.publish('{"version": 1, "payloads": {}}', dest)
    assert json.loads(dest.read_text())["version"] == 1
    assert not (tmp_path / "bundle.tmp").exists()
    sg.publish('{"version": 1, "payloads": {"a": 1}}', dest)
    assert json.loads(dest.read_text())["payloads"] == {"a": 1}
