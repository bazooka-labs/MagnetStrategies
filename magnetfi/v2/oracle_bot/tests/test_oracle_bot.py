"""Unit tests for the MagnetFi v2 LP oracle bot (no network — pure logic + orchestration)."""
import base64
import json

import pytest

import oracle_bot as ob


# ── helpers ─────────────────────────────────────────────────────────────────────

def make_pool(**over):
    d = {
        "pool_id": 1,
        "pool_address": "POOLADDR",
        "asset_a_id": 111,
        "asset_a_decimals": 6,
        "asset_b_id": 222,
        "asset_b_decimals": 6,
        "min_price": 0,
        "max_price": 0,
        "label": "T",
    }
    d.update(over)
    return ob.PoolConfig(d)


def _kv_uint(key: str, val: int):
    return {"key": base64.b64encode(key.encode()).decode(), "value": {"type": 2, "uint": val}}


def _kv_bytes(key: str, b64: str = ""):
    return {"key": base64.b64encode(key.encode()).decode(), "value": {"type": 1, "bytes": b64}}


# ── PoolConfig ───────────────────────────────────────────────────────────────────

def test_poolconfig_parses_and_defaults():
    p = make_pool(min_price=5, max_price=9, label="U/tALGO")
    assert (p.pool_id, p.asset_a_id, p.asset_b_id) == (1, 111, 222)
    assert (p.min_price, p.max_price, p.label) == (5, 9, "U/tALGO")
    # defaults applied when omitted
    p2 = ob.PoolConfig({"pool_id": 2, "pool_address": "X", "asset_a_id": 1,
                        "asset_a_decimals": 6, "asset_b_id": 0, "asset_b_decimals": 6})
    assert p2.min_price == 0 and p2.max_price == 0 and p2.label == "pool_2"


# ── TWAP math ────────────────────────────────────────────────────────────────────

def test_twap_returns_spot_with_thin_history(tmp_path):
    s = ob.TwapState(tmp_path / "t.json")
    assert s.twap(1, 1_234) == 1_234            # no history
    s.history[1] = [(1000, 999)]
    assert s.twap(1, 1_234) == 1_234            # one reading


def test_twap_returns_spot_when_total_time_zero(tmp_path):
    s = ob.TwapState(tmp_path / "t.json")
    s.history[1] = [(1000, 1_000_000), (1000, 2_000_000)]   # same timestamp
    assert s.twap(1, 1_500_000) == 1_500_000


def test_twap_trapezoidal_includes_latest_reading(tmp_path):
    s = ob.TwapState(tmp_path / "t.json")
    # Two equal-length intervals: 1.0 → 1.0 → 2.0
    s.history[1] = [(0, 1_000_000), (100, 1_000_000), (200, 2_000_000)]
    # trapezoid: [100*(1.0+1.0)/2 + 100*(1.0+2.0)/2] / 200 = (100e6 + 150e6)/200 = 1.25e6
    assert s.twap(1, 999) == 1_250_000
    # A pure left-Riemann (the old bug) would have given 1.0e6 — the latest reading matters.


def test_add_trims_to_window_and_counts(tmp_path):
    s = ob.TwapState(tmp_path / "t.json")
    for i in range(7):
        s.add(1, 1000 + i, 1_000_000 + i, window=5)
    assert s.count(1) == 5
    # kept the most recent 5 (prices …+2..+6)
    assert [p for _, p in s.history[1]] == [1_000_002, 1_000_003, 1_000_004, 1_000_005, 1_000_006]


# ── persistence (atomic save / load / corrupt recovery) ──────────────────────────

def test_state_roundtrips_across_instances(tmp_path):
    path = tmp_path / "twap_state.json"
    a = ob.TwapState(path)
    a.add(7, 1000, 1_000_000, window=5)
    a.add(7, 1300, 1_100_000, window=5)
    b = ob.TwapState(path)                       # fresh instance reloads from disk
    assert b.count(7) == 2
    assert b.history[7] == [(1000, 1_000_000), (1300, 1_100_000)]


def test_save_is_atomic_no_tmp_left(tmp_path):
    path = tmp_path / "twap_state.json"
    s = ob.TwapState(path)
    s.add(1, 1000, 1_000_000, window=5)
    assert path.exists()
    assert not (tmp_path / "twap_state.tmp").exists()   # temp file renamed away


def test_corrupt_state_recovers_fresh(tmp_path):
    path = tmp_path / "twap_state.json"
    path.write_text("{ this is not valid json")
    s = ob.TwapState(path)                       # must not raise
    assert s.history == {}


# ── _decode_local_state ──────────────────────────────────────────────────────────

def test_decode_local_state_extracts_uints_ignores_bytes():
    info = {"app-local-state": {"key-value": [
        _kv_uint("asset_1_reserves", 1000),
        _kv_uint("asset_2_reserves", 2000),
        _kv_uint("issued_pool_tokens", 500),
        _kv_bytes("asset_1_cumulative_price", "AAAA"),
    ]}}
    assert ob._decode_local_state(info) == {
        "asset_1_reserves": 1000, "asset_2_reserves": 2000, "issued_pool_tokens": 500,
    }


def test_decode_local_state_handles_camelcase_keys():
    info = {"appLocalState": {"keyValue": [_kv_uint("issued_pool_tokens", 42)]}}
    assert ob._decode_local_state(info) == {"issued_pool_tokens": 42}


def test_decode_local_state_empty():
    assert ob._decode_local_state({}) == {}


# ── compute_lp_price ─────────────────────────────────────────────────────────────

def test_compute_lp_price_basic():
    pool = make_pool(asset_a_decimals=6, asset_b_decimals=6)
    state = {"asset_1_reserves": 1_000_000_000, "asset_2_reserves": 1_000_000_000,
             "issued_pool_tokens": 1_000_000_000}
    # TVL = 1000*1 + 1000*1 = 2000; LP supply = 1000; price/LP = 2.0 → scaled 2_000_000
    assert ob.compute_lp_price(pool, state, 1.0, 1.0) == 2_000_000


def test_compute_lp_price_respects_decimals():
    pool = make_pool(asset_a_decimals=6, asset_b_decimals=0)
    state = {"asset_1_reserves": 1_000_000, "asset_2_reserves": 5,
             "issued_pool_tokens": 1_000_000}
    # TVL = (1e6/1e6)*1 + (5/1)*2 = 1 + 10 = 11; LP supply = 1; price/LP = 11 → 11_000_000
    assert ob.compute_lp_price(pool, state, 1.0, 2.0) == 11_000_000


def test_compute_lp_price_zero_supply_returns_none():
    pool = make_pool()
    state = {"asset_1_reserves": 1_000_000_000, "asset_2_reserves": 1_000_000_000,
             "issued_pool_tokens": 0}
    assert ob.compute_lp_price(pool, state, 1.0, 1.0) is None


def test_compute_lp_price_zero_reserves_returns_none():
    pool = make_pool()
    state = {"asset_1_reserves": 0, "asset_2_reserves": 0, "issued_pool_tokens": 1_000_000}
    assert ob.compute_lp_price(pool, state, 1.0, 1.0) is None


# ── get_lp_price orchestration (guards) ──────────────────────────────────────────

GOOD_STATE = {
    "asset_1_id": 111, "asset_2_id": 222,
    "asset_1_reserves": 1_000_000_000, "asset_2_reserves": 1_000_000_000,
    "issued_pool_tokens": 1_000_000_000,
}


def _stub_pricing(monkeypatch, state, price=1.0):
    monkeypatch.setattr(ob, "fetch_pool_state", lambda *a, **k: dict(state))
    monkeypatch.setattr(ob, "fetch_vestige_price", lambda asa: price)


def test_get_lp_price_happy(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)
    assert ob.get_lp_price(None, make_pool(), amm_app_id=1) == 2_000_000


def test_get_lp_price_rejects_asset_id_mismatch(monkeypatch):
    bad = dict(GOOD_STATE, asset_1_id=999)       # wrong pool_address would show wrong ids
    _stub_pricing(monkeypatch, bad, price=1.0)
    assert ob.get_lp_price(None, make_pool(), amm_app_id=1) is None


def test_get_lp_price_none_when_vestige_missing(monkeypatch):
    monkeypatch.setattr(ob, "fetch_pool_state", lambda *a, **k: dict(GOOD_STATE))
    monkeypatch.setattr(ob, "fetch_vestige_price", lambda asa: None)
    assert ob.get_lp_price(None, make_pool(), amm_app_id=1) is None


def test_get_lp_price_rejects_below_sanity_floor(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)        # computes 2_000_000
    assert ob.get_lp_price(None, make_pool(min_price=3_000_000), amm_app_id=1) is None


def test_get_lp_price_rejects_above_sanity_ceiling(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)        # computes 2_000_000
    assert ob.get_lp_price(None, make_pool(max_price=1_000_000), amm_app_id=1) is None


def test_get_lp_price_passes_within_sanity_band(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)
    assert ob.get_lp_price(None, make_pool(min_price=1_500_000, max_price=2_500_000), amm_app_id=1) == 2_000_000


# ── update_pool orchestration (fail-stale gate + asymmetric divergence) ───────────

def _capture_posts(monkeypatch):
    posts = []
    monkeypatch.setattr(ob, "post_price",
                        lambda c, oid, sk, addr, pid, price, dry: posts.append(price) or True)
    monkeypatch.setattr(ob, "read_onchain_price", lambda *a, **k: 0)
    return posts


def _run(pool, twap):
    ob.update_pool(None, 1, 1, pool, twap, "sk", "addr", dry_run=True)


def test_update_pool_fail_stale_below_min_readings(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: 1_000_000)
    monkeypatch.setattr(ob.time, "time", lambda: 1900)
    twap = ob.TwapState(tmp_path / "t.json")     # 0 readings → add makes 1 < MIN(3)
    _run(make_pool(), twap)
    assert posts == []                           # held (fail-stale), nothing posted


def test_update_pool_posts_once_window_filled(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: 1_000_000)
    monkeypatch.setattr(ob.time, "time", lambda: 1600)
    twap = ob.TwapState(tmp_path / "t.json")
    twap.history[1] = [(1000, 1_000_000), (1300, 1_000_000)]   # 2 → add makes 3 == MIN
    _run(make_pool(), twap)
    assert len(posts) == 1 and posts[0] == 1_000_000


def test_update_pool_blocks_upward_spike(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: 2_000_000)   # +100% spike vs prior
    monkeypatch.setattr(ob.time, "time", lambda: 1900)
    twap = ob.TwapState(tmp_path / "t.json")
    twap.history[1] = [(1000, 1_000_000), (1300, 1_000_000), (1600, 1_000_000)]
    _run(make_pool(), twap)
    assert posts == []                           # manipulation guard blocked the post


def test_update_pool_allows_downward_drop(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: 600_000)     # sharp drop
    monkeypatch.setattr(ob.time, "time", lambda: 1900)
    twap = ob.TwapState(tmp_path / "t.json")
    twap.history[1] = [(1000, 1_000_000), (1300, 1_000_000), (1600, 1_000_000)]
    _run(make_pool(), twap)
    assert len(posts) == 1                        # drops pass through (TWAP-smoothed)


def test_update_pool_skips_when_price_unavailable(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: None)
    twap = ob.TwapState(tmp_path / "t.json")
    _run(make_pool(), twap)
    assert posts == [] and twap.count(1) == 0


# ── post_price dry-run ───────────────────────────────────────────────────────────

def test_post_price_dry_run_no_network():
    assert ob.post_price(None, 1, "sk", "addr", 1, 1_000_000, dry_run=True) is True


# ── load_config ──────────────────────────────────────────────────────────────────

def test_load_config_missing_file_exits(tmp_path):
    with pytest.raises(SystemExit):
        ob.load_config(tmp_path / "nope.json")


def test_load_config_zero_oracle_exits(tmp_path, monkeypatch):
    monkeypatch.delenv("ORACLE_APP_ID", raising=False)
    p = tmp_path / "c.json"
    p.write_text(json.dumps({"oracle_app_id": 0, "pools": []}))
    with pytest.raises(SystemExit):
        ob.load_config(p)


def test_load_config_happy(tmp_path):
    p = tmp_path / "c.json"
    p.write_text(json.dumps({
        "oracle_app_id": 555,
        "amm_validator_app_id": 1002541853,
        "pools": [{"pool_id": 1, "pool_address": "X", "asset_a_id": 1,
                   "asset_a_decimals": 6, "asset_b_id": 0, "asset_b_decimals": 6}],
    }))
    oracle_app_id, amm_app_id, pools = ob.load_config(p)
    assert oracle_app_id == 555 and amm_app_id == 1002541853
    assert len(pools) == 1 and pools[0].pool_id == 1
