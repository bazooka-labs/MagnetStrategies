"""LP Oracle guards: authorization, ±50% prior deviation, ±25% anchor band, re-anchor."""
import pytest
from conftest import POOL_ID, INITIAL_PRICE


def test_only_authorized_updater_can_post(proto):
    mallory = proto._account(100)
    with pytest.raises(Exception):
        proto.call(proto.oracle, "update_lp_price", [POOL_ID, 1_050_000], mallory)
    # Admin is not the updater either
    with pytest.raises(Exception):
        proto.call(proto.oracle, "update_lp_price", [POOL_ID, 1_050_000], proto.admin)
    proto.oracle_post(1_050_000)   # bot can
    assert proto.oracle_uint(b"lp_price_") == 1_050_000


def test_prior_deviation_guard_50pct(proto):
    # >50% drop vs prior (1.0 → 0.49) rejected
    with pytest.raises(Exception):
        proto.oracle_post(490_000)
    # >50% spike vs prior (1.0 → 1.51) rejected
    with pytest.raises(Exception):
        proto.oracle_post(1_510_000)
    # within band ok
    proto.oracle_post(1_200_000)
    assert proto.oracle_uint(b"lp_price_") == 1_200_000


def test_anchor_band_25pct(proto):
    # Anchor is 1.0 from add_pool. +30% (1.30) exceeds +25% band → rejected
    with pytest.raises(Exception):
        proto.oracle_post(1_300_000)
    # −30% (0.70) exceeds −25% band → rejected (also within 50%-of-prior, so anchor is the binding guard)
    with pytest.raises(Exception):
        proto.oracle_post(700_000)
    # within ±25% ok
    proto.oracle_post(1_240_000)
    assert proto.oracle_uint(b"lp_price_") == 1_240_000


def test_reanchor_enables_larger_move(proto):
    # Admin re-anchors to follow a genuine move, unblocking a post outside the old band
    proto.set_anchor(700_000)
    proto.oracle_post(700_000)        # now within band of the new anchor
    assert proto.oracle_uint(b"lp_price_") == 700_000
    assert proto.oracle_uint(b"lp_anchor_") == 700_000
    # Only admin can re-anchor
    with pytest.raises(Exception):
        proto.call(proto.oracle, "set_price_anchor", [POOL_ID, 600_000], proto.bot)


def test_stale_oracle_blocks_borrow(proto):
    from conftest import ONE_LP, ONE_MUSD
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.time_travel(7_200)          # 2h, no re-post → stale
    with pytest.raises(Exception):
        proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=50 * ONE_MUSD)
    # After refresh, borrow works
    proto.refresh_oracle()
    proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=50 * ONE_MUSD)
    assert proto.vault_box(alice).musd_borrowed == 50 * ONE_MUSD
