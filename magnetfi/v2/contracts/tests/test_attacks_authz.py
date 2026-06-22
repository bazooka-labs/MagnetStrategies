"""Adversarial — authorization & cross-contract bypass.

The highest-stakes guards: nobody but the registered vault may mint mUSD, and every
privileged method must reject non-admin callers.
"""
import pytest
from conftest import ONE_LP, ONE_MUSD, POOL_ID


# ── cross-contract bypass: the mUSD minting guard ──────────────────────────────

def test_direct_issue_musd_rejected(proto):
    """If anyone could call PSM.issue_musd directly they could mint unlimited mUSD."""
    attacker = proto.new_user()
    with pytest.raises(Exception):
        proto.call(proto.psm, "issue_musd", [attacker.address, 1_000_000 * ONE_MUSD], attacker)
    assert proto.musd_bal(attacker.address) == 0
    assert proto.circulating_musd() == 0


def test_admin_cannot_issue_musd_directly(proto):
    """Even the admin is not the registered vault — only the vault app address may mint."""
    with pytest.raises(Exception):
        proto.call(proto.psm, "issue_musd", [proto.admin.address, ONE_MUSD], proto.admin)


def test_direct_receive_musd_rejected(proto):
    """receive_musd is vault-only accounting; an attacker must not be able to spoof it."""
    attacker = proto.new_user()
    with pytest.raises(Exception):
        proto.call(proto.psm, "receive_musd", [ONE_MUSD], attacker)


def test_attacker_cannot_drain_via_repeated_issue(proto):
    """Sanity: a loop of direct issue attempts changes nothing."""
    attacker = proto.new_user()
    for _ in range(3):
        with pytest.raises(Exception):
            proto.call(proto.psm, "issue_musd", [attacker.address, ONE_MUSD], attacker)
    assert proto.musd_bal(attacker.address) == 0


# ── admin-only access control sweep across all three contracts ──────────────────

def test_vault_admin_methods_reject_non_admin(proto):
    m = proto.new_user()
    cases = [
        ("set_rate", [POOL_ID, 500]),
        ("set_ltv", [POOL_ID, 5_000]),
        ("set_liq_threshold", [POOL_ID, 8_000]),
        ("set_lp_asa_id", [POOL_ID, proto.lp_id]),
        ("collect_fees", []),
        ("collect_algo", [1_000]),
        ("opt_in_asset", [proto.lp_id]),
        ("advance_accrual", [m.address, POOL_ID]),
        ("mark_payment_overdue", [m.address, POOL_ID]),
        ("trigger_micro_liquidation", [m.address, POOL_ID]),
        ("trigger_partial_liquidation", [m.address, POOL_ID, 1]),
        ("trigger_full_liquidation", [m.address, POOL_ID]),
        ("settle_health_liquidation", [m.address, POOL_ID, 1]),
        ("propose_lp_oracle", [proto.oracle.app_id]),
        ("confirm_lp_oracle", []),
    ]
    for method, args in cases:
        with pytest.raises(Exception):
            proto.call(proto.vault, method, args, m)


def test_psm_admin_methods_reject_non_admin(proto):
    m = proto.new_user()
    cases = [
        ("withdraw_usdc", [1]),
        ("set_redeem_fee", [200]),
        ("set_treasury", [m.address]),
        ("propose_vault_contract", [proto.vault.app_id]),
        ("confirm_vault_contract", []),
        ("opt_in_asset", [proto.usdc_id]),
    ]
    for method, args in cases:
        with pytest.raises(Exception):
            proto.call(proto.psm, method, args, m)


def test_oracle_admin_methods_reject_non_admin(proto):
    m = proto.new_user()
    cases = [
        ("set_authorized_updater", [m.address]),
        ("add_pool", [999, ONE_MUSD]),
        ("remove_pool", [POOL_ID]),
        ("set_price_anchor", [POOL_ID, ONE_MUSD]),
    ]
    for method, args in cases:
        with pytest.raises(Exception):
            proto.call(proto.oracle, method, args, m)


# ── liquidations cannot be triggered by the borrower (self-liquidation / grief) ─

def test_borrower_cannot_liquidate_self(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=50 * ONE_MUSD)
    proto.set_price(650_000)                      # make it actually liquidatable
    for method, args in [
        ("trigger_micro_liquidation", [alice.address, POOL_ID]),
        ("trigger_partial_liquidation", [alice.address, POOL_ID, 1]),
        ("trigger_full_liquidation", [alice.address, POOL_ID]),
    ]:
        with pytest.raises(Exception):
            proto.call(proto.vault, method, args, alice)
    assert proto.vault_box(alice).vault_state == 0


def test_guardian_cannot_perform_admin_ops(proto):
    """Guardian is containment-only: it cannot set params or trigger liquidations."""
    with pytest.raises(Exception):
        proto.call(proto.vault, "set_rate", [POOL_ID, 500], proto.guardian)
    with pytest.raises(Exception):
        proto.call(proto.vault, "collect_fees", [], proto.guardian)
    with pytest.raises(Exception):
        proto.call(proto.psm, "withdraw_usdc", [1], proto.guardian)


def test_bot_cannot_touch_admin_or_funds(proto):
    """Oracle bot key is least-privilege: prices only, nothing else."""
    with pytest.raises(Exception):
        proto.call(proto.oracle, "add_pool", [999, ONE_MUSD], proto.bot)
    with pytest.raises(Exception):
        proto.call(proto.vault, "set_rate", [POOL_ID, 500], proto.bot)
