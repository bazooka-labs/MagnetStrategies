"""Vault borrower lifecycle: open, LTV cap, interest, repay, collateral, borrow_more."""
import pytest
from conftest import ONE_LP, ONE_MUSD, SECONDS_PER_YEAR, VAULT_MBR


def test_open_deferred_draw_then_borrow(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=0)
    box = proto.vault_box(alice)
    assert box.musd_borrowed == 0 and box.lp_amount == 100 * ONE_LP
    assert proto.musd_bal(alice.address) == 0
    # Draw later
    proto.borrow_more(alice, 40 * ONE_MUSD)
    assert proto.musd_bal(alice.address) == 40 * ONE_MUSD
    assert proto.vault_box(alice).musd_borrowed == 40 * ONE_MUSD


def test_borrow_above_ltv_rejected(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    # 100 LP @ 1.0 = 100 value; 60% LTV → max 60. Borrowing 61 must fail.
    with pytest.raises(Exception):
        proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=61 * ONE_MUSD)
    assert not proto.vault_exists(alice)


def test_borrow_more_respects_ltv(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=30 * ONE_MUSD)
    proto.borrow_more(alice, 30 * ONE_MUSD)            # total 60 == cap, ok
    assert proto.vault_box(alice).musd_borrowed == 60 * ONE_MUSD
    with pytest.raises(Exception):
        proto.borrow_more(alice, 1 * ONE_MUSD)         # 61 > cap
    assert proto.vault_box(alice).musd_borrowed == 60 * ONE_MUSD


def test_pay_interest_clears_and_reduces(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=200 * ONE_LP, borrow=100 * ONE_MUSD)
    proto.time_travel(SECONDS_PER_YEAR)
    # Alice pays from her borrowed mUSD: 12 covers ~10 interest; the surplus trims principal.
    proto.pay_interest(alice, 12 * ONE_MUSD)
    box = proto.vault_box(alice)
    assert box.accrued_interest == 0
    assert box.vault_state == 0
    assert box.musd_borrowed < 100 * ONE_MUSD        # small overpayment reduced principal


def test_overpayment_reduces_principal(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=200 * ONE_LP, borrow=100 * ONE_MUSD)
    # Negligible interest (no time travel). Pay 30 from borrowed funds → ~30 trims principal.
    proto.pay_interest(alice, 30 * ONE_MUSD)
    box = proto.vault_box(alice)
    assert box.accrued_interest == 0
    assert 69 * ONE_MUSD <= box.musd_borrowed <= 71 * ONE_MUSD
    assert box.vault_state == 0
    # Full close is covered separately by repay_principal.


def test_repay_principal_partial_then_full(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=200 * ONE_LP, borrow=100 * ONE_MUSD)
    proto.repay_principal(alice, 40 * ONE_MUSD)
    assert proto.vault_box(alice).musd_borrowed == 60 * ONE_MUSD
    proto.repay_principal(alice, 60 * ONE_MUSD)
    assert not proto.vault_exists(alice)
    assert proto.lp_bal(alice.address) == 1_000 * ONE_LP


def test_add_collateral_raises_capacity(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=60 * ONE_MUSD)  # at cap
    with pytest.raises(Exception):
        proto.borrow_more(alice, 30 * ONE_MUSD)
    proto.add_collateral(alice, 100 * ONE_LP)   # now 200 value → cap 120
    proto.borrow_more(alice, 30 * ONE_MUSD)
    assert proto.vault_box(alice).musd_borrowed == 90 * ONE_MUSD
