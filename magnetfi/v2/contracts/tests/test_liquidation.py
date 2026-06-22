"""Liquidation paths: micro, partial tier1/tier2, full (surplus/shortfall), settlement.

Health factor HF = lp_value × liq_threshold(0.75) / debt. With debt≈50 and 100 LP @ price p,
lp_value = 100·p, so HF = 100·p·0.75/50 = 1.5·p. Targeting HF bands by choosing p:
  tier1 [0.95,1.0):  p≈0.65 → HF 0.975
  tier2 [0.85,0.95): p≈0.60 → HF 0.90
  full  <0.85:       p≈0.55 → HF 0.825 (surplus, lp_value 55 > debt 50)
"""
import pytest
from conftest import ONE_LP, ONE_MUSD, DAYS_90, POOL_ID


def _borrower_at(proto, lp=100, borrow=50):
    u = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(u, lp_amount=lp * ONE_LP, borrow=borrow * ONE_MUSD)
    return u


def test_micro_liquidation_after_90_days(proto):
    alice = _borrower_at(proto, lp=100, borrow=50)
    proto.time_travel(DAYS_90 + 3_600)
    proto.refresh_oracle()                       # fresh price required for seizure
    proto.call(proto.vault, "mark_payment_overdue", [alice.address, POOL_ID], proto.admin)
    assert proto.vault_box(alice).vault_state == 1

    admin_lp_before = proto.lp_bal(proto.admin.address)
    proto.call(proto.vault, "trigger_micro_liquidation", [alice.address, POOL_ID], proto.admin)
    box = proto.vault_box(alice)
    assert box.vault_state == 0                   # position continues
    assert box.accrued_interest == 0             # interest cleared by seizure
    assert box.lp_amount < 100 * ONE_LP          # some LP seized
    assert proto.lp_bal(proto.admin.address) > admin_lp_before
    assert proto.circulating_musd() <= proto.psm_usdc()


def test_partial_tier1(proto):
    alice = _borrower_at(proto, lp=100, borrow=50)
    proto.set_price(650_000)                      # HF ≈ 0.975 → tier 1
    proto.call(proto.vault, "trigger_partial_liquidation",
               [alice.address, POOL_ID, 1], proto.admin)
    box = proto.vault_box(alice)
    assert box.vault_state == 2                   # awaiting settlement
    assert box.accrued_interest > 0              # settlement counter set
    assert box.lp_amount == 65 * ONE_LP          # 35% of 100 seized

    # Settle and confirm the vault returns to active
    proto.settle(alice, box.accrued_interest)
    box2 = proto.vault_box(alice)
    assert box2 is not None and box2.vault_state == 0
    assert proto.circulating_musd() <= proto.psm_usdc()


def test_partial_tier2(proto):
    alice = _borrower_at(proto, lp=100, borrow=50)
    proto.set_price(600_000)                      # HF ≈ 0.90 → tier 2
    proto.call(proto.vault, "trigger_partial_liquidation",
               [alice.address, POOL_ID, 2], proto.admin)
    box = proto.vault_box(alice)
    assert box.vault_state == 2
    assert box.lp_amount == 40 * ONE_LP          # 60% of 100 seized
    proto.settle(alice, box.accrued_interest)
    assert proto.vault_box(alice).vault_state == 0


def test_full_liquidation_with_surplus(proto):
    alice = _borrower_at(proto, lp=100, borrow=50)
    proto.set_price(550_000)                      # lp_value 55 > debt 50, HF 0.825 → full
    proto.call(proto.vault, "trigger_full_liquidation", [alice.address, POOL_ID], proto.admin)
    box = proto.vault_box(alice)
    assert box.vault_state == 2
    assert box.lp_amount == 0
    # Surplus LP (value above debt) was returned to the borrower immediately
    assert proto.lp_bal(alice.address) > 900 * ONE_LP
    settle_amt = box.accrued_interest
    proto.settle(alice, settle_amt)
    assert not proto.vault_exists(alice)         # closed
    assert proto.circulating_musd() <= proto.psm_usdc()


def test_full_liquidation_shortfall_is_bad_debt(proto):
    alice = _borrower_at(proto, lp=100, borrow=50)
    # Crash below debt in two steps (each within the ±50%-of-prior guard): 1.0→0.6→0.45
    proto.set_price(600_000)
    proto.set_price(450_000)                      # lp_value 45 < debt 50 → shortfall
    proto.call(proto.vault, "trigger_full_liquidation", [alice.address, POOL_ID], proto.admin)
    box = proto.vault_box(alice)
    assert box.vault_state == 2
    settle_amt = box.accrued_interest            # = lp_value (45), not full debt
    assert settle_amt < 50 * ONE_MUSD
    proto.settle(alice, settle_amt)
    assert not proto.vault_exists(alice)         # closed as bad-debt write-off
    # Invariant survives the shortfall (USDC was reserved at borrow time)
    assert proto.circulating_musd() <= proto.psm_usdc()


def test_partial_liquidation_blocks_when_oracle_stale(proto):
    alice = _borrower_at(proto, lp=100, borrow=50)
    proto.time_travel(7_200)                      # 2h > 30min freshness, no re-post
    with pytest.raises(Exception):
        proto.call(proto.vault, "trigger_partial_liquidation",
                   [alice.address, POOL_ID, 1], proto.admin)
