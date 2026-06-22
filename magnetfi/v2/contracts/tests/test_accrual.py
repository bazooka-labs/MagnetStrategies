"""Interest accrual correctness, the P21-01 multi-year lost-time fix, and rate lock."""
import pytest
from conftest import ONE_LP, ONE_MUSD, SECONDS_PER_YEAR, RATE_BPS, POOL_ID


def _approx(actual, expected, rel=0.01):
    return abs(actual - expected) <= max(1, int(expected * rel))


def test_one_year_interest_matches_formula(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=200 * ONE_LP, borrow=100 * ONE_MUSD)
    proto.time_travel(SECONDS_PER_YEAR)
    proto.call(proto.vault, "advance_accrual", [alice.address, POOL_ID], proto.admin)
    box = proto.vault_box(alice)
    # 10% APR on 100 mUSD ≈ 10 mUSD after one year
    assert _approx(box.accrued_interest, 10 * ONE_MUSD, rel=0.02)


def test_p21_multiyear_catchup(proto):
    """P21-01: a >1yr-dormant vault charges only 1yr per call, but advance_accrual
    must genuinely catch up across repeated calls (the pre-fix bug forgave the excess)."""
    from conftest import POOL_ID
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=400 * ONE_LP, borrow=100 * ONE_MUSD)
    proto.time_travel(3 * SECONDS_PER_YEAR)

    # First call: capped at 1 year (~10 mUSD)
    proto.call(proto.vault, "advance_accrual", [alice.address, POOL_ID], proto.admin)
    assert _approx(proto.vault_box(alice).accrued_interest, 10 * ONE_MUSD, rel=0.02)

    # Second call: another year → ~20 mUSD (proves the clock advanced by 1yr, not to now)
    proto.call(proto.vault, "advance_accrual", [alice.address, POOL_ID], proto.admin)
    assert _approx(proto.vault_box(alice).accrued_interest, 20 * ONE_MUSD, rel=0.02)

    # Third call: caught up to ~3 years total
    proto.call(proto.vault, "advance_accrual", [alice.address, POOL_ID], proto.admin)
    assert _approx(proto.vault_box(alice).accrued_interest, 30 * ONE_MUSD, rel=0.02)

    # Fourth call: now caught up → negligible additional interest
    before = proto.vault_box(alice).accrued_interest
    proto.call(proto.vault, "advance_accrual", [alice.address, POOL_ID], proto.admin)
    after = proto.vault_box(alice).accrued_interest
    assert after - before < ONE_MUSD  # essentially nothing left to catch up


def test_rate_is_locked_at_open(proto):
    from conftest import POOL_ID
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=200 * ONE_LP, borrow=50 * ONE_MUSD)
    assert proto.vault_box(alice).rate_bps == RATE_BPS

    # Admin doubles the global rate
    proto.call(proto.vault, "set_rate", [POOL_ID, 2_000], proto.admin)

    # Existing vault keeps its locked rate
    assert proto.vault_box(alice).rate_bps == RATE_BPS
    # A new vault picks up the new rate
    bob = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(bob, lp_amount=200 * ONE_LP, borrow=50 * ONE_MUSD)
    assert proto.vault_box(bob).rate_bps == 2_000
