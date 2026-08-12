"""Liquidation-penalty upgrade (see LIQUIDATION.md "Planned Upgrade").

Health-factor liquidations now charge a penalty that prices the protocol's adverse-execution
cost (fees/slippage from unwinding seized LP into a falling market):

  Tier 1 (0.95 ≤ HF < 1.0):  seize 35%, 5% penalty
  Tier 2 (0.85 ≤ HF < 0.95): seize 77% (recalibrated so the penalty still restores HF ≥ 1.06)
  Tier 3 (HF < 0.85):        seize ALL — no snapshot-priced surplus refund; remainder → treasury

HF = lp_value × liq_threshold(0.75) / debt, lp_value = 100·p for 100 LP. So p picks the band:
  tier1 worst  p≈0.6334 → HF 0.95     tier1 mid p=0.65  → HF 0.975
  tier2 near-worst p=0.57 → HF 0.855   tier2 mid p=0.60  → HF 0.90

The penalty is carved from debt relief: seized_lp_value = debt_retired × (1 + penalty), so the
settlement counter (mUSD owed back to PSM) is `debt_retired`; the admin keeps the difference.
"""
import pytest
from conftest import ONE_LP, ONE_MUSD, POOL_ID, LIQ_BPS


def _borrower(proto, lp=100, borrow=50):
    u = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(u, lp_amount=lp * ONE_LP, borrow=borrow * ONE_MUSD)
    return u


def _total_debt(box) -> int:
    return box.musd_borrowed + box.accrued_interest


def _hf(box, price) -> float:
    """Health factor from a box at a given oracle price (state 0)."""
    lp_value = box.lp_amount * price // 1_000_000
    debt = _total_debt(box)
    if debt == 0:
        return float("inf")
    return (lp_value * LIQ_BPS // 10_000) / debt


def _carve(seized_value: int, penalty_bps: int) -> int:
    """debt_retired = floor(seized / (1 + penalty)) — mirrors the contract's WideRatio."""
    return seized_value * 10_000 // (10_000 + penalty_bps)


# ── Tier 1: penalty accrues to the protocol, health restored ────────────────────

def test_tier1_penalty_accrues_to_protocol(proto):
    alice = _borrower(proto, lp=100, borrow=50)
    proto.set_price(650_000)                                  # HF ≈ 0.975 → tier 1
    admin_lp_before = proto.lp_bal(proto.admin.address)

    proto.call(proto.vault, "trigger_partial_liquidation",
               [alice.address, POOL_ID, 1], proto.admin)
    box = proto.vault_box(alice)

    seized_value = 35 * ONE_LP * 650_000 // 1_000_000        # 22_750_000
    expected_retired = _carve(seized_value, 500)             # 21_666_666
    # Settlement counter = debt retired (NOT the full seized value) — the ~5% gap is the penalty.
    assert box.accrued_interest == expected_retired
    assert box.accrued_interest < seized_value
    assert proto.lp_bal(proto.admin.address) == admin_lp_before + 35 * ONE_LP  # full seized LP to admin

    # Only `debt_retired` is settled to the PSM — proven by the counter above (settle asserts
    # musd_amount ≤ counter). The penalty stays with the admin as the seized-LP value beyond it.
    proto.settle(alice, box.accrued_interest)

    box2 = proto.vault_box(alice)
    assert box2.vault_state == 0
    assert _hf(box2, 650_000) >= 1.06                        # health restored with buffer
    assert proto.circulating_musd() <= proto.psm_usdc()


def test_tier1_penalty_makes_borrower_pay(proto):
    """No free value: after a penalised partial the borrower's equity strictly falls, and HF ≥ 1.0
    (no cascade). The penalty is real cost borne by the borrower, not the protocol."""
    alice = _borrower(proto, lp=100, borrow=50)
    proto.set_price(650_000)
    pre = proto.vault_box(alice)
    pre_equity = (pre.lp_amount * 650_000 // 1_000_000) - _total_debt(pre)

    proto.call(proto.vault, "trigger_partial_liquidation",
               [alice.address, POOL_ID, 1], proto.admin)
    proto.settle(alice, proto.vault_box(alice).accrued_interest)
    post = proto.vault_box(alice)
    post_equity = (post.lp_amount * 650_000 // 1_000_000) - _total_debt(post)

    assert post_equity < pre_equity                          # borrower paid the penalty
    assert _hf(post, 650_000) >= 1.0                         # never left liquidatable


# ── Tier 2: 77% seizure restores health despite the 7% penalty ──────────────────

def test_tier2_seize_77_restores_health_midband(proto):
    alice = _borrower(proto, lp=100, borrow=50)
    proto.set_price(600_000)                                 # HF ≈ 0.90 → tier 2
    proto.call(proto.vault, "trigger_partial_liquidation",
               [alice.address, POOL_ID, 2], proto.admin)
    box = proto.vault_box(alice)
    assert box.lp_amount == 23 * ONE_LP                      # 77% seized

    seized_value = 77 * ONE_LP * 600_000 // 1_000_000
    assert box.accrued_interest == _carve(seized_value, 700)

    proto.settle(alice, box.accrued_interest)
    box2 = proto.vault_box(alice)
    assert box2.vault_state == 0
    assert _hf(box2, 600_000) >= 1.06


def test_tier2_near_worst_case_no_cascade(proto):
    """Near the tier-2 lower boundary (HF ≈ 0.855) the 77%/7% liquidation still lifts HF clear of
    1.0 in a single shot — the recalibration prevents the immediate re-liquidation cascade a naive
    penalty on the old 60% seizure would cause."""
    alice = _borrower(proto, lp=100, borrow=50)
    proto.set_price(570_000)                                 # HF ≈ 0.855 → low in tier 2
    proto.call(proto.vault, "trigger_partial_liquidation",
               [alice.address, POOL_ID, 2], proto.admin)
    proto.settle(alice, proto.vault_box(alice).accrued_interest)
    box = proto.vault_box(alice)
    assert box.vault_state == 0
    assert _hf(box, 570_000) >= 1.06                         # comfortably healthy, no cascade


# ── Full liquidation: seize-all, remainder is protocol revenue ──────────────────

def test_full_liq_seize_all_remainder_is_revenue(proto):
    alice = _borrower(proto, lp=100, borrow=50)
    admin_lp_before = proto.lp_bal(proto.admin.address)
    proto.set_price(550_000)                                 # lp_value 55 > debt 50, HF 0.825
    proto.call(proto.vault, "trigger_full_liquidation", [alice.address, POOL_ID], proto.admin)
    box = proto.vault_box(alice)

    # Entire position seized to admin; settlement counter = min(debt, lp_value) = debt (~50 mUSD,
    # capped below the 55 mUSD LP value — the ~5 mUSD remainder is the protocol's cushion, kept by
    # the admin, NOT refunded to the borrower).
    assert box.lp_amount == 0
    assert proto.lp_bal(proto.admin.address) == admin_lp_before + 100 * ONE_LP
    assert 50 * ONE_MUSD <= box.accrued_interest < 51 * ONE_MUSD
    assert proto.lp_bal(alice.address) == 900 * ONE_LP       # borrower got NO surplus

    proto.settle(alice, box.accrued_interest)
    assert not proto.vault_exists(alice)
    assert proto.lp_bal(alice.address) == 900 * ONE_LP       # only MBR returned, still no LP


# ── set_liq_penalty setter: bounded, downward-safe, admin-only ──────────────────

def test_set_liq_penalty_cap_enforced(proto):
    # Within cap: OK.
    proto.call(proto.vault, "set_liq_penalty", [1, 300], proto.admin)
    proto.call(proto.vault, "set_liq_penalty", [1, 500], proto.admin)   # exactly the cap
    proto.call(proto.vault, "set_liq_penalty", [2, 700], proto.admin)   # exactly the cap
    # Above cap: rejected (cannot raise beyond the calibrated max without a redeploy).
    with pytest.raises(Exception):
        proto.call(proto.vault, "set_liq_penalty", [1, 501], proto.admin)
    with pytest.raises(Exception):
        proto.call(proto.vault, "set_liq_penalty", [2, 701], proto.admin)
    # Bad tier rejected.
    for bad_tier in (0, 3, 99):
        with pytest.raises(Exception):
            proto.call(proto.vault, "set_liq_penalty", [bad_tier, 100], proto.admin)


def test_set_liq_penalty_admin_only(proto):
    mallory = proto.new_user()
    with pytest.raises(Exception):
        proto.call(proto.vault, "set_liq_penalty", [1, 100], mallory)


def test_set_liq_penalty_zero_is_equity_neutral(proto):
    """Setting a tier's penalty to 0 reverts it to the old equity-neutral behavior: the settlement
    counter equals the full seized value (no carve). Downward-safe — no protocol harm."""
    proto.call(proto.vault, "set_liq_penalty", [1, 0], proto.admin)
    alice = _borrower(proto, lp=100, borrow=50)
    proto.set_price(650_000)
    proto.call(proto.vault, "trigger_partial_liquidation",
               [alice.address, POOL_ID, 1], proto.admin)
    box = proto.vault_box(alice)
    seized_value = 35 * ONE_LP * 650_000 // 1_000_000
    assert box.accrued_interest == seized_value              # no penalty carved
    proto.settle(alice, box.accrued_interest)
    assert proto.vault_box(alice).vault_state == 0


def test_lower_penalty_reduces_protocol_take(proto):
    """A lower penalty leaves the borrower with more debt relief (higher post-HF) and the protocol
    with less revenue — confirming the setter only ever moves value toward the borrower."""
    proto.call(proto.vault, "set_liq_penalty", [1, 200], proto.admin)   # 2% instead of 5%
    alice = _borrower(proto, lp=100, borrow=50)
    proto.set_price(650_000)
    proto.call(proto.vault, "trigger_partial_liquidation",
               [alice.address, POOL_ID, 1], proto.admin)
    box = proto.vault_box(alice)
    seized_value = 35 * ONE_LP * 650_000 // 1_000_000
    assert box.accrued_interest == _carve(seized_value, 200)  # more debt retired than at 5%
    assert box.accrued_interest > _carve(seized_value, 500)
