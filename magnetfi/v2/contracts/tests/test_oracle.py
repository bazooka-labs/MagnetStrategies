"""LP Oracle guards: authorization, ±50% prior deviation, ±25% anchor band, re-anchor.

The band tests are skipped unless the oracle under test HAS a band; the
authorization test runs for every oracle that has a privileged writer.
"""
import pytest

from conftest import BANDED, RELAY
from conftest import POOL_ID, INITIAL_PRICE


# Not skipped under `lean`: the writer gate is the lean oracle's ONLY remaining
# check, so this is the test that matters most there. Skipped under `relay`
# only, where `update_lp_price` does not exist — the raises would pass because
# the method is absent, not because a gate rejected the sender.
@pytest.mark.skipif(RELAY, reason="v5 has no privileged writer at all — see test_relay_liveness for a stranger posting a valid price.")
def test_only_authorized_updater_can_post(proto):
    mallory = proto._account(100)
    with pytest.raises(Exception):
        proto.call(proto.oracle, "update_lp_price", [POOL_ID, 1_050_000], mallory)
    # Admin is not the updater either
    with pytest.raises(Exception):
        proto.call(proto.oracle, "update_lp_price", [POOL_ID, 1_050_000], proto.admin)
    proto.oracle_post(1_050_000)   # bot can
    assert proto.oracle_uint(b"lp_price_") == 1_050_000


@pytest.mark.skipif(not BANDED, reason="the lean oracle and v5 both remove this bound by design — ORACLE_LEAN_SPEC.md, ORACLE_V5_SPEC.md §2.6. Kept so it still guards the LPOracle while that is the vault's oracle.")
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


@pytest.mark.skipif(not BANDED, reason="the lean oracle and v5 both remove this bound by design — ORACLE_LEAN_SPEC.md, ORACLE_V5_SPEC.md §2.6. Kept so it still guards the LPOracle while that is the vault's oracle.")
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


@pytest.mark.skipif(not BANDED, reason="the lean oracle and v5 both remove this bound by design — ORACLE_LEAN_SPEC.md, ORACLE_V5_SPEC.md §2.6. Kept so it still guards the LPOracle while that is the vault's oracle.")
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


# ── the removal itself, asserted positively ──────────────────────────────────

def _rejects(proto, pool_id, price, sender, because: str):
    """
    Assert the post fails FOR THE STATED REASON.

    A bare `pytest.raises(Exception)` would also pass on a fee error, a resource
    error, or a typo in the test — passing while proving nothing. The contract
    puts its reason in the assert comment, so match on it.
    """
    with pytest.raises(Exception) as e:
        proto.call(proto.oracle, "update_lp_price", [pool_id, price], sender)
    assert because in str(e.value), f"failed, but for the wrong reason: {e.value}"


@pytest.mark.skipif(BANDED, reason="the LPOracle HAS a band — the three tests above are its coverage")
@pytest.mark.skipif(RELAY, reason="v5 takes signed payloads, not bare prices; see test_relay_oracle")
def test_unbanded_oracle_accepts_any_move(proto):
    """
    The point of the lean oracle: no bound, so no freeze.

    These are the exact posts the band tests above assert are REJECTED. Running
    them as acceptances is what makes the removal demonstrated rather than
    inferred from a skipped test — an absent test proves nothing, and a skip is
    an absent test.
    """
    # +30%: the shape of the 2026-08-21 freeze, which the ±25% band rejected
    # while the price was perfectly valid.
    proto.oracle_post(1_300_000)
    assert proto.oracle_uint(b"lp_price_") == 1_300_000

    # −62% against the prior post, tripping what was the ±50%-vs-prior guard.
    # No re-anchor in between, because there is nothing to re-anchor.
    proto.oracle_post(490_000)
    assert proto.oracle_uint(b"lp_price_") == 490_000

    # A 20x, far outside anything the banded oracle would have taken.
    proto.oracle_post(10_000_000)
    assert proto.oracle_uint(b"lp_price_") == 10_000_000

    # And no anchor key exists at all, which is WHY none of the above needed one.
    assert proto.oracle_uint(b"lp_anchor_") is None


@pytest.mark.skipif(RELAY, reason="v5 validates inside the payload instead; see test_relay_oracle")
def test_gates_that_survive_the_band_removal(proto):
    """
    What the lean oracle still refuses.

    Dropping the bands leaves three asserts, and on the lean oracle these are
    the ONLY protection the contract offers — so they are worth pinning by
    message rather than trusting the band tests to have covered the area.
    """
    mallory = proto._account(100)
    _rejects(proto, POOL_ID, 1_050_000, mallory, "not authorized updater")
    # A zero price permanently bricks the pool (AUD-042): the vault's own
    # `assert price > 0` would then fail closed on every read, forever.
    _rejects(proto, POOL_ID, 0, proto.bot, "price must be > 0")
    _rejects(proto, POOL_ID + 777, 1_050_000, proto.bot, "pool not in whitelist")
    # None of the three rejections moved the price.
    assert proto.oracle_uint(b"lp_price_") == INITIAL_PRICE
