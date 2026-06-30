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


def make_cfg(**over):
    raw = {
        "oracle_app_id": 555,
        "amm_validator_app_id": 1002541853,
        "usdc_asa_id": 31566704,
        "compx_oracle_app_id": 0,
        "compx_divergence_limit": 0.05,
        "compx_max_age_seconds": 3600,
        "asset_decimals": {},
        "asset_price_bounds": {},
        "reference_pools": {},
        "pools": [],
    }
    raw.update(over)
    return ob.BotConfig(raw)


def _kv_uint(key: str, val: int):
    return {"key": base64.b64encode(key.encode()).decode(), "value": {"type": 2, "uint": val}}


def _kv_bytes(key: str, b64: str = ""):
    return {"key": base64.b64encode(key.encode()).decode(), "value": {"type": 1, "bytes": b64}}


def _ids(state):
    """Add the default make_pool asset ids to a pool-state dict (needed since
    compute_lp_price now maps reserves by id, not position)."""
    return {"asset_1_id": 111, "asset_2_id": 222, **state}


# ── PoolConfig ───────────────────────────────────────────────────────────────────

def test_poolconfig_parses_and_defaults():
    p = make_pool(min_price=5, max_price=9, label="U/tALGO", compx_check_asset_id=3081853135)
    assert (p.pool_id, p.asset_a_id, p.asset_b_id) == (1, 111, 222)
    assert (p.min_price, p.max_price, p.label) == (5, 9, "U/tALGO")
    assert p.compx_check_asset_id == 3081853135
    p2 = ob.PoolConfig({"pool_id": 2, "pool_address": "X", "asset_a_id": 1,
                        "asset_a_decimals": 6, "asset_b_id": 0, "asset_b_decimals": 6})
    assert p2.min_price == 0 and p2.max_price == 0 and p2.label == "pool_2"
    assert p2.compx_check_asset_id == 0


# ── TWAP math ────────────────────────────────────────────────────────────────────

def test_twap_returns_spot_with_thin_history(tmp_path):
    s = ob.TwapState(tmp_path / "t.json")
    assert s.twap(1, 1_234) == 1_234
    s.history[1] = [(1000, 999)]
    assert s.twap(1, 1_234) == 1_234


def test_twap_returns_spot_when_total_time_zero(tmp_path):
    s = ob.TwapState(tmp_path / "t.json")
    s.history[1] = [(1000, 1_000_000), (1000, 2_000_000)]
    assert s.twap(1, 1_500_000) == 1_500_000


def test_twap_trapezoidal_includes_latest_reading(tmp_path):
    s = ob.TwapState(tmp_path / "t.json")
    s.history[1] = [(0, 1_000_000), (100, 1_000_000), (200, 2_000_000)]
    assert s.twap(1, 999) == 1_250_000


def test_add_trims_to_window_and_counts(tmp_path):
    s = ob.TwapState(tmp_path / "t.json")
    for i in range(7):
        s.add(1, 1000 + i, 1_000_000 + i, window=5)
    assert s.count(1) == 5
    assert [p for _, p in s.history[1]] == [1_000_002, 1_000_003, 1_000_004, 1_000_005, 1_000_006]


def test_add_drops_readings_older_than_max_age(tmp_path):
    # F7: a reading separated by more than MAX_TWAP_AGE from the latest is discarded,
    # so we never time-weight across a downtime gap.
    s = ob.TwapState(tmp_path / "t.json")
    s.add(1, 1000, 1_000_000, window=5)
    s.add(1, 1000 + ob.MAX_TWAP_AGE + 200, 1_100_000, window=5)   # big gap
    assert s.count(1) == 1
    assert s.history[1] == [(1000 + ob.MAX_TWAP_AGE + 200, 1_100_000)]


# ── persistence ──────────────────────────────────────────────────────────────────

def test_state_roundtrips_across_instances(tmp_path):
    path = tmp_path / "twap_state.json"
    a = ob.TwapState(path)
    a.add(7, 1000, 1_000_000, window=5)
    a.add(7, 1300, 1_100_000, window=5)
    b = ob.TwapState(path)
    assert b.count(7) == 2
    assert b.history[7] == [(1000, 1_000_000), (1300, 1_100_000)]


def test_save_is_atomic_no_tmp_left(tmp_path):
    path = tmp_path / "twap_state.json"
    s = ob.TwapState(path)
    s.add(1, 1000, 1_000_000, window=5)
    assert path.exists()
    assert not (tmp_path / "twap_state.tmp").exists()


def test_corrupt_state_recovers_fresh(tmp_path):
    path = tmp_path / "twap_state.json"
    path.write_text("{ this is not valid json")
    s = ob.TwapState(path)
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


# ── _pool_reserves ───────────────────────────────────────────────────────────────

def test_pool_reserves_matches_either_ordering():
    state = {"asset_1_id": 0, "asset_2_id": 31566704,
             "asset_1_reserves": 100, "asset_2_reserves": 200}
    assert ob._pool_reserves(state, 0, 31566704) == (100, 200)
    assert ob._pool_reserves(state, 31566704, 0) == (200, 100)


def test_pool_reserves_raises_on_mismatch():
    state = {"asset_1_id": 0, "asset_2_id": 31566704,
             "asset_1_reserves": 100, "asset_2_reserves": 200}
    with pytest.raises(ValueError):
        ob._pool_reserves(state, 999, 31566704)


# ── compute_lp_price (now order-agnostic via _pool_reserves, F4) ──────────────────

def test_compute_lp_price_basic():
    pool = make_pool(asset_a_decimals=6, asset_b_decimals=6)
    state = _ids({"asset_1_reserves": 1_000_000_000, "asset_2_reserves": 1_000_000_000,
                  "issued_pool_tokens": 1_000_000_000})
    assert ob.compute_lp_price(pool, state, 1.0, 1.0) == 2_000_000


def test_compute_lp_price_order_agnostic_when_config_reversed():
    # config lists asset_a=222/asset_b=111 but on-chain asset_1=111/asset_2=222;
    # reserves must be mapped by id so price_a applies to 222's reserve.
    pool = make_pool(asset_a_id=222, asset_a_decimals=6, asset_b_id=111, asset_b_decimals=6)
    state = _ids({"asset_1_reserves": 2_000_000, "asset_2_reserves": 8_000_000,
                  "issued_pool_tokens": 1_000_000})
    # asset_a(222)=asset_2_reserves=8 → 8*1; asset_b(111)=asset_1_reserves=2 → 2*1; TVL=10/1 → 10e6
    assert ob.compute_lp_price(pool, state, 1.0, 1.0) == 10_000_000


def test_compute_lp_price_respects_decimals():
    pool = make_pool(asset_a_decimals=6, asset_b_decimals=0)
    state = _ids({"asset_1_reserves": 1_000_000, "asset_2_reserves": 5,
                  "issued_pool_tokens": 1_000_000})
    assert ob.compute_lp_price(pool, state, 1.0, 2.0) == 11_000_000


def test_compute_lp_price_zero_supply_returns_none():
    pool = make_pool()
    state = _ids({"asset_1_reserves": 1_000_000_000, "asset_2_reserves": 1_000_000_000,
                  "issued_pool_tokens": 0})
    assert ob.compute_lp_price(pool, state, 1.0, 1.0) is None


def test_compute_lp_price_zero_reserves_returns_none():
    pool = make_pool()
    state = _ids({"asset_1_reserves": 0, "asset_2_reserves": 0, "issued_pool_tokens": 1_000_000})
    assert ob.compute_lp_price(pool, state, 1.0, 1.0) is None


# ── derive_asset_price_usdc ──────────────────────────────────────────────────────

def _derive_cfg(**over):
    base = dict(
        asset_decimals={0: 6, 31566704: 6, 2537013734: 6, 3081853135: 5},
        reference_pools={
            0:          {"pool_address": "ALGOUSDC",  "quote_asset_id": 31566704},
            2537013734: {"pool_address": "TALGOALGO", "quote_asset_id": 0},
            3081853135: {"pool_address": "UTALGO",    "quote_asset_id": 2537013734},
        },
    )
    base.update(over)
    return make_cfg(**base)


_DERIVE_STATES = {
    "ALGOUSDC":  {"asset_1_id": 0, "asset_2_id": 31566704,
                  "asset_1_reserves": 1000_000000, "asset_2_reserves": 100_000000},   # ALGO=$0.10
    "TALGOALGO": {"asset_1_id": 2537013734, "asset_2_id": 0,
                  "asset_1_reserves": 1000_000000, "asset_2_reserves": 1100_000000},  # tALGO=1.1 ALGO=$0.11
    "UTALGO":    {"asset_1_id": 3081853135, "asset_2_id": 2537013734,
                  "asset_1_reserves": 1000_00000, "asset_2_reserves": 2000_000000},   # U=2 tALGO=$0.22
}


def test_derive_asset_price_usdc_chain(monkeypatch):
    monkeypatch.setattr(ob, "fetch_pool_state", lambda c, addr, amm: _DERIVE_STATES[addr])
    cfg = _derive_cfg()
    assert ob.derive_asset_price_usdc(None, 31566704, cfg) == 1.0
    assert abs(ob.derive_asset_price_usdc(None, 0, cfg) - 0.10) < 1e-9
    assert abs(ob.derive_asset_price_usdc(None, 2537013734, cfg) - 0.11) < 1e-9
    assert abs(ob.derive_asset_price_usdc(None, 3081853135, cfg) - 0.22) < 1e-9


def test_derive_asset_price_usdc_unknown_asset_raises():
    with pytest.raises(ValueError):
        ob.derive_asset_price_usdc(None, 999, make_cfg())


def test_derive_asset_price_usdc_rejects_out_of_bounds(monkeypatch):
    # F3: a per-asset plausibility bound rejects a distorted reference price.
    monkeypatch.setattr(ob, "fetch_pool_state", lambda c, addr, amm: _DERIVE_STATES[addr])
    cfg = _derive_cfg(asset_price_bounds={3081853135: (0.0, 0.10)})   # U would be $0.22
    with pytest.raises(ValueError):
        ob.derive_asset_price_usdc(None, 3081853135, cfg)


# ── CompX oracle read + cross-check ──────────────────────────────────────────────

def _compx_box(asset_id, price, updated):
    return (int(asset_id).to_bytes(8, "big") + int(price).to_bytes(8, "big")
            + int(updated).to_bytes(8, "big"))


def test_read_compx_price_decodes_tuple():
    raw = _compx_box(3081853135, 118630, 1700000000)

    class FakeClient:
        def application_box_by_name(self, app, name):
            assert name == b"prices" + (3081853135).to_bytes(8, "big")
            return {"value": base64.b64encode(raw).decode()}

    price, updated = ob.read_compx_price(FakeClient(), 3307588794, 3081853135)
    assert abs(price - 0.11863) < 1e-9 and updated == 1700000000


def test_read_compx_price_rejects_assetid_mismatch():
    raw = _compx_box(999, 118630, 1700000000)   # box for a different asset

    class FakeClient:
        def application_box_by_name(self, app, name):
            return {"value": base64.b64encode(raw).decode()}

    assert ob.read_compx_price(FakeClient(), 3307588794, 3081853135) is None


def test_read_compx_price_none_on_error():
    class FakeClient:
        def application_box_by_name(self, app, name):
            raise Exception("no box")
    assert ob.read_compx_price(FakeClient(), 1, 1) is None


def _cross_cfg():
    return make_cfg(compx_oracle_app_id=3307588794, compx_divergence_limit=0.05,
                    compx_max_age_seconds=3600)


def test_compx_cross_check_ok_within_limit(monkeypatch):
    monkeypatch.setattr(ob.time, "time", lambda: 1_000_000)
    monkeypatch.setattr(ob, "read_compx_price", lambda c, app, aid: (0.118, 1_000_000 - 60))
    pool = make_pool(compx_check_asset_id=3081853135)
    assert ob.compx_cross_check(None, _cross_cfg(), pool, 0.120) == "ok"


def test_compx_cross_check_diverged(monkeypatch):
    monkeypatch.setattr(ob.time, "time", lambda: 1_000_000)
    monkeypatch.setattr(ob, "read_compx_price", lambda c, app, aid: (0.10, 1_000_000 - 60))
    pool = make_pool(compx_check_asset_id=3081853135)
    assert ob.compx_cross_check(None, _cross_cfg(), pool, 0.20) == "diverged"


def test_compx_cross_check_unverified_when_unavailable(monkeypatch):
    monkeypatch.setattr(ob, "read_compx_price", lambda c, app, aid: None)
    pool = make_pool(compx_check_asset_id=3081853135)
    assert ob.compx_cross_check(None, _cross_cfg(), pool, 0.20) == "unverified"


def test_compx_cross_check_unverified_when_stale(monkeypatch):
    monkeypatch.setattr(ob.time, "time", lambda: 1_000_000)
    monkeypatch.setattr(ob, "read_compx_price", lambda c, app, aid: (0.10, 1))   # ancient
    pool = make_pool(compx_check_asset_id=3081853135)
    assert ob.compx_cross_check(None, _cross_cfg(), pool, 0.20) == "unverified"


def test_compx_cross_check_ok_when_disabled():
    pool = make_pool()  # compx_check_asset_id == 0
    assert ob.compx_cross_check(None, _cross_cfg(), pool, 999.0) == "ok"


# ── get_lp_price orchestration (returns (price, compx_verified)) ──────────────────

GOOD_STATE = _ids({
    "asset_1_reserves": 1_000_000_000, "asset_2_reserves": 1_000_000_000,
    "issued_pool_tokens": 1_000_000_000,
})


def _stub_pricing(monkeypatch, state, price=1.0):
    monkeypatch.setattr(ob, "fetch_pool_state", lambda *a, **k: dict(state))
    monkeypatch.setattr(ob, "derive_asset_price_usdc", lambda c, aid, cfg, memo=None: price)


def test_get_lp_price_happy(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)
    assert ob.get_lp_price(None, make_pool(), make_cfg()) == (2_000_000, True)


def test_get_lp_price_rejects_asset_id_mismatch(monkeypatch):
    bad = dict(GOOD_STATE, asset_1_id=999)
    _stub_pricing(monkeypatch, bad, price=1.0)
    assert ob.get_lp_price(None, make_pool(), make_cfg()) is None


def test_get_lp_price_none_when_derivation_fails(monkeypatch):
    monkeypatch.setattr(ob, "fetch_pool_state", lambda *a, **k: dict(GOOD_STATE))
    def boom(*a, **k):
        raise ValueError("no reference pool")
    monkeypatch.setattr(ob, "derive_asset_price_usdc", boom)
    assert ob.get_lp_price(None, make_pool(), make_cfg()) is None


def test_get_lp_price_rejects_below_sanity_floor(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)
    assert ob.get_lp_price(None, make_pool(min_price=3_000_000), make_cfg()) is None


def test_get_lp_price_rejects_above_sanity_ceiling(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)
    assert ob.get_lp_price(None, make_pool(max_price=1_000_000), make_cfg()) is None


def test_get_lp_price_passes_within_sanity_band(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)
    assert ob.get_lp_price(None, make_pool(min_price=1_500_000, max_price=2_500_000), make_cfg()) == (2_000_000, True)


def test_get_lp_price_none_on_compx_divergence(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)
    monkeypatch.setattr(ob, "compx_cross_check", lambda *a, **k: "diverged")
    pool = make_pool(compx_check_asset_id=111)
    assert ob.get_lp_price(None, pool, make_cfg(compx_oracle_app_id=1)) is None


def test_get_lp_price_unverified_flag_when_compx_unavailable(monkeypatch):
    _stub_pricing(monkeypatch, GOOD_STATE, price=1.0)
    monkeypatch.setattr(ob, "compx_cross_check", lambda *a, **k: "unverified")
    pool = make_pool(compx_check_asset_id=111)
    assert ob.get_lp_price(None, pool, make_cfg(compx_oracle_app_id=1)) == (2_000_000, False)


# ── update_pool orchestration ─────────────────────────────────────────────────────

def _capture_posts(monkeypatch):
    posts = []
    monkeypatch.setattr(ob, "post_price",
                        lambda c, oid, sk, addr, pid, price, dry: posts.append(price) or True)
    monkeypatch.setattr(ob, "read_onchain_price", lambda *a, **k: 0)
    return posts


def _run(pool, twap):
    ob.update_pool(None, make_cfg(), pool, twap, "sk", "addr", dry_run=True)


def test_update_pool_fail_stale_below_min_readings(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: (1_000_000, True))
    monkeypatch.setattr(ob.time, "time", lambda: 1900)
    twap = ob.TwapState(tmp_path / "t.json")
    _run(make_pool(), twap)
    assert posts == []


def test_update_pool_posts_once_window_filled(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: (1_000_000, True))
    monkeypatch.setattr(ob.time, "time", lambda: 1600)
    twap = ob.TwapState(tmp_path / "t.json")
    twap.history[1] = [(1000, 1_000_000), (1300, 1_000_000)]
    _run(make_pool(), twap)
    assert len(posts) == 1 and posts[0] == 1_000_000


def test_update_pool_blocks_upward_spike(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: (2_000_000, True))
    monkeypatch.setattr(ob.time, "time", lambda: 1900)
    twap = ob.TwapState(tmp_path / "t.json")
    twap.history[1] = [(1000, 1_000_000), (1300, 1_000_000), (1600, 1_000_000)]
    _run(make_pool(), twap)
    assert posts == []


def test_update_pool_allows_downward_drop(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: (600_000, True))
    monkeypatch.setattr(ob.time, "time", lambda: 1900)
    twap = ob.TwapState(tmp_path / "t.json")
    twap.history[1] = [(1000, 1_000_000), (1300, 1_000_000), (1600, 1_000_000)]
    _run(make_pool(), twap)
    assert len(posts) == 1


def test_update_pool_skips_when_price_unavailable(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: None)
    twap = ob.TwapState(tmp_path / "t.json")
    _run(make_pool(), twap)
    assert posts == [] and twap.count(1) == 0


def _twap3(tmp_path, price):
    twap = ob.TwapState(tmp_path / "t.json")
    twap.history[1] = [(1000, price), (1100, price), (1200, price)]
    return twap


def test_update_pool_unverified_refuses_upward(monkeypatch, tmp_path):
    # F1: CompX unverified + price would rise vs on-chain → refuse (fail-stale)
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: (1_200_000, False))
    monkeypatch.setattr(ob, "read_onchain_price", lambda *a, **k: 1_000_000)
    monkeypatch.setattr(ob.time, "time", lambda: 1300)
    _run(make_pool(), _twap3(tmp_path, 1_200_000))
    assert posts == []


def test_update_pool_unverified_allows_small_decline(monkeypatch, tmp_path):
    # F1: CompX unverified but a small decline (≤10%) is allowed (liveness)
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: (950_000, False))
    monkeypatch.setattr(ob, "read_onchain_price", lambda *a, **k: 1_000_000)
    monkeypatch.setattr(ob.time, "time", lambda: 1300)
    _run(make_pool(), _twap3(tmp_path, 950_000))
    assert posts == [950_000]


def test_update_pool_unverified_refuses_large_decline(monkeypatch, tmp_path):
    # F5: CompX unverified + large decline (>10%) → refuse (anti liquidation-MEV)
    posts = _capture_posts(monkeypatch)
    monkeypatch.setattr(ob, "get_lp_price", lambda *a, **k: (800_000, False))
    monkeypatch.setattr(ob, "read_onchain_price", lambda *a, **k: 1_000_000)
    monkeypatch.setattr(ob.time, "time", lambda: 1300)
    _run(make_pool(), _twap3(tmp_path, 800_000))
    assert posts == []


# ── post_price dry-run ───────────────────────────────────────────────────────────

def test_post_price_dry_run_no_network():
    assert ob.post_price(None, 1, "sk", "addr", 1, 1_000_000, dry_run=True) is True


# ── load_config ──────────────────────────────────────────────────────────────────

def test_load_config_missing_file_exits(tmp_path):
    with pytest.raises(SystemExit):
        ob.load_config(tmp_path / "nope.json")


def test_load_config_no_pools_exits(tmp_path, monkeypatch):
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
        "usdc_asa_id": 31566704,
        "compx_oracle_app_id": 3307588794,
        "asset_decimals": {"0": 6, "3081853135": 5},
        "asset_price_bounds": {"3081853135": [0.02, 1.0]},
        "reference_pools": {"0": {"pool_address": "X", "quote_asset_id": 31566704}},
        "pools": [{"pool_id": 1, "pool_address": "X", "asset_a_id": 1,
                   "asset_a_decimals": 6, "asset_b_id": 0, "asset_b_decimals": 6}],
    }))
    cfg = ob.load_config(p)
    assert cfg.oracle_app_id == 555 and cfg.amm_app_id == 1002541853
    assert cfg.usdc_asa_id == 31566704 and cfg.compx_oracle_app_id == 3307588794
    assert cfg.asset_decimals == {0: 6, 3081853135: 5}
    assert cfg.asset_price_bounds == {3081853135: (0.02, 1.0)}
    assert cfg.reference_pools[0] == {"pool_address": "X", "quote_asset_id": 31566704}
    assert len(cfg.pools) == 1 and cfg.pools[0].pool_id == 1
