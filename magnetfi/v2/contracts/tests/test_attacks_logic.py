"""Adversarial — group manipulation, state-machine abuse, liquidation correctness, griefing.

Builds malformed/raw transaction groups and probes edge states an attacker would target.
"""
import os
import pytest
from algokit_utils import (
    AlgoAmount, AssetOptInParams, AssetOptOutParams, AssetTransferParams, PaymentParams,
)
from conftest import ONE_LP, ONE_MUSD, POOL_ID, VAULT_MBR


def _maxed(proto, lp=100, borrow=50):
    u = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(u, lp_amount=lp * ONE_LP, borrow=borrow * ONE_MUSD)
    return u


# ── group composition manipulation: open_vault ─────────────────────────────────

def test_open_vault_mbr_underpay_rejected(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    grp = proto.group()
    grp.add_payment(PaymentParams(sender=alice.address, receiver=proto.vault.app_address,
                                  amount=AlgoAmount.from_micro_algo(VAULT_MBR - 1), note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.vault, "open_vault", [POOL_ID, 0], alice))
    grp.add_asset_transfer(AssetTransferParams(sender=alice.address, receiver=proto.vault.app_address,
                                               asset_id=proto.lp_id, amount=100 * ONE_LP, note=os.urandom(8)))
    with pytest.raises(Exception):
        proto.send_group(grp)
    assert not proto.vault_exists(alice)


def test_open_vault_mbr_wrong_receiver_rejected(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    attacker = proto.new_user()
    grp = proto.group()
    grp.add_payment(PaymentParams(sender=alice.address, receiver=attacker.address,  # not the vault
                                  amount=AlgoAmount.from_micro_algo(VAULT_MBR), note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.vault, "open_vault", [POOL_ID, 0], alice))
    grp.add_asset_transfer(AssetTransferParams(sender=alice.address, receiver=proto.vault.app_address,
                                               asset_id=proto.lp_id, amount=100 * ONE_LP, note=os.urandom(8)))
    with pytest.raises(Exception):
        proto.send_group(grp)


def test_open_vault_wrong_lp_asset_rejected(proto):
    # Deposit USDC while claiming it's the pool's LP token.
    alice = proto.new_user(lp=1_000 * ONE_LP, usdc=1_000 * ONE_MUSD)
    grp = proto.group()
    grp.add_payment(PaymentParams(sender=alice.address, receiver=proto.vault.app_address,
                                  amount=AlgoAmount.from_micro_algo(VAULT_MBR), note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.vault, "open_vault", [POOL_ID, 0], alice))
    grp.add_asset_transfer(AssetTransferParams(sender=alice.address, receiver=proto.vault.app_address,
                                               asset_id=proto.usdc_id, amount=100 * ONE_MUSD, note=os.urandom(8)))
    with pytest.raises(Exception):
        proto.send_group(grp)


def test_open_vault_lp_wrong_receiver_rejected(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    attacker = proto.new_user()
    grp = proto.group()
    grp.add_payment(PaymentParams(sender=alice.address, receiver=proto.vault.app_address,
                                  amount=AlgoAmount.from_micro_algo(VAULT_MBR), note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.vault, "open_vault", [POOL_ID, 0], alice))
    grp.add_asset_transfer(AssetTransferParams(sender=alice.address, receiver=attacker.address,  # not the vault
                                               asset_id=proto.lp_id, amount=100 * ONE_LP, note=os.urandom(8)))
    with pytest.raises(Exception):
        proto.send_group(grp)


def test_open_vault_zero_lp_rejected(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    grp = proto.group()
    grp.add_payment(PaymentParams(sender=alice.address, receiver=proto.vault.app_address,
                                  amount=AlgoAmount.from_micro_algo(VAULT_MBR), note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.vault, "open_vault", [POOL_ID, 0], alice))
    grp.add_asset_transfer(AssetTransferParams(sender=alice.address, receiver=proto.vault.app_address,
                                               asset_id=proto.lp_id, amount=0, note=os.urandom(8)))
    with pytest.raises(Exception):
        proto.send_group(grp)


def test_open_vault_standalone_rejected(proto):
    """No surrounding group → relative-index reads must fail closed."""
    alice = proto.new_user(lp=1_000 * ONE_LP)
    with pytest.raises(Exception):
        proto.call(proto.vault, "open_vault", [POOL_ID, 0], alice)


# ── group composition manipulation: PSM mint ───────────────────────────────────

def test_mint_amount_mismatch_rejected(proto):
    """Claim to mint more mUSD than the USDC actually deposited."""
    u = proto.new_user(usdc=1_000 * ONE_MUSD)
    grp = proto.group()
    grp.add_asset_transfer(AssetTransferParams(sender=u.address, receiver=proto.psm.app_address,
                                               asset_id=proto.usdc_id, amount=100 * ONE_MUSD, note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.psm, "mint_musd", [200 * ONE_MUSD], u))
    with pytest.raises(Exception):
        proto.send_group(grp)
    assert proto.musd_bal(u.address) == 0


def test_mint_wrong_receiver_rejected(proto):
    u = proto.new_user(usdc=1_000 * ONE_MUSD)
    attacker = proto.new_user()
    grp = proto.group()
    grp.add_asset_transfer(AssetTransferParams(sender=u.address, receiver=attacker.address,  # not PSM
                                               asset_id=proto.usdc_id, amount=100 * ONE_MUSD, note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.psm, "mint_musd", [100 * ONE_MUSD], u))
    with pytest.raises(Exception):
        proto.send_group(grp)


def test_cannot_double_mint_one_deposit(proto):
    """Two mint calls cannot both claim the same single USDC deposit."""
    u = proto.new_user(usdc=1_000 * ONE_MUSD)
    grp = proto.group()
    grp.add_asset_transfer(AssetTransferParams(sender=u.address, receiver=proto.psm.app_address,
                                               asset_id=proto.usdc_id, amount=100 * ONE_MUSD, note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.psm, "mint_musd", [100 * ONE_MUSD], u))
    grp.add_app_call_method_call(proto.mc(proto.psm, "mint_musd", [100 * ONE_MUSD], u))  # reads the appcall, not a transfer
    with pytest.raises(Exception):
        proto.send_group(grp)


# ── group composition manipulation: repay / pay routing ────────────────────────

def test_repay_to_wrong_receiver_rejected(proto):
    alice = _maxed(proto)
    grp = proto.group()
    grp.add_app_call_method_call(proto.mc(proto.vault, "repay_principal", [POOL_ID], alice))
    grp.add_asset_transfer(AssetTransferParams(sender=alice.address, receiver=proto.vault.app_address,  # must be PSM
                                               asset_id=proto.musd_id, amount=10 * ONE_MUSD, note=os.urandom(8)))
    with pytest.raises(Exception):
        proto.send_group(grp)


def test_pay_interest_to_wrong_receiver_rejected(proto):
    alice = _maxed(proto)
    grp = proto.group()
    grp.add_asset_transfer(AssetTransferParams(sender=alice.address, receiver=proto.psm.app_address,  # must be vault
                                               asset_id=proto.musd_id, amount=5 * ONE_MUSD, note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.vault, "pay_interest", [POOL_ID], alice))
    with pytest.raises(Exception):
        proto.send_group(grp)


# ── state-machine abuse ────────────────────────────────────────────────────────

def test_state2_blocks_all_borrower_ops(proto):
    alice = _maxed(proto)
    proto.set_price(650_000)
    proto.call(proto.vault, "trigger_partial_liquidation", [alice.address, POOL_ID, 1], proto.admin)
    assert proto.vault_box(alice).vault_state == 2
    with pytest.raises(Exception):
        proto.borrow_more(alice, ONE_MUSD)
    with pytest.raises(Exception):
        proto.pay_interest(alice, ONE_MUSD)
    with pytest.raises(Exception):
        proto.add_collateral(alice, ONE_LP)
    with pytest.raises(Exception):
        proto.repay_principal(alice, ONE_MUSD)


def test_borrow_more_on_overdue_rejected(proto):
    alice = _maxed(proto)
    from conftest import DAYS_90
    proto.time_travel(DAYS_90 + 3_600)
    proto.refresh_oracle()
    proto.call(proto.vault, "mark_payment_overdue", [alice.address, POOL_ID], proto.admin)
    assert proto.vault_box(alice).vault_state == 1
    with pytest.raises(Exception):
        proto.borrow_more(alice, ONE_MUSD)        # cannot draw on a delinquent vault


# ── liquidation correctness ────────────────────────────────────────────────────

def test_cannot_liquidate_healthy_vault(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=30 * ONE_MUSD)   # HF = 2.5
    with pytest.raises(Exception):
        proto.call(proto.vault, "trigger_partial_liquidation", [alice.address, POOL_ID, 1], proto.admin)
    with pytest.raises(Exception):
        proto.call(proto.vault, "trigger_partial_liquidation", [alice.address, POOL_ID, 2], proto.admin)
    with pytest.raises(Exception):
        proto.call(proto.vault, "trigger_full_liquidation", [alice.address, POOL_ID], proto.admin)
    assert proto.vault_box(alice).vault_state == 0


def test_tier_mismatch_prevents_overseizure(proto):
    """At a tier-1 health factor the admin cannot seize the larger tier-2 fraction."""
    alice = _maxed(proto)
    proto.set_price(650_000)          # HF ≈ 0.975 → tier 1 only
    with pytest.raises(Exception):
        proto.call(proto.vault, "trigger_partial_liquidation", [alice.address, POOL_ID, 2], proto.admin)
    proto.call(proto.vault, "trigger_partial_liquidation", [alice.address, POOL_ID, 1], proto.admin)
    assert proto.vault_box(alice).vault_state == 2


def test_invalid_tier_rejected(proto):
    alice = _maxed(proto)
    proto.set_price(650_000)
    for bad in (0, 3, 99):
        with pytest.raises(Exception):
            proto.call(proto.vault, "trigger_partial_liquidation", [alice.address, POOL_ID, bad], proto.admin)


def test_double_liquidation_rejected(proto):
    alice = _maxed(proto)
    proto.set_price(650_000)
    proto.call(proto.vault, "trigger_partial_liquidation", [alice.address, POOL_ID, 1], proto.admin)
    with pytest.raises(Exception):
        proto.call(proto.vault, "trigger_partial_liquidation", [alice.address, POOL_ID, 1], proto.admin)
    with pytest.raises(Exception):
        proto.call(proto.vault, "trigger_full_liquidation", [alice.address, POOL_ID], proto.admin)


def test_micro_liq_timing_and_state_guards(proto):
    alice = _maxed(proto)
    # Not yet 90 days overdue, still active
    with pytest.raises(Exception):
        proto.call(proto.vault, "mark_payment_overdue", [alice.address, POOL_ID], proto.admin)
    with pytest.raises(Exception):
        proto.call(proto.vault, "trigger_micro_liquidation", [alice.address, POOL_ID], proto.admin)


def test_settle_over_counter_rejected(proto):
    alice = _maxed(proto)
    proto.set_price(650_000)
    proto.call(proto.vault, "trigger_partial_liquidation", [alice.address, POOL_ID, 1], proto.admin)
    counter = proto.vault_box(alice).accrued_interest
    with pytest.raises(Exception):
        proto.settle(alice, counter + 100 * ONE_MUSD)        # exceeds settlement counter
    assert proto.vault_box(alice).vault_state == 2           # still pending


def test_settle_healthy_vault_rejected(proto):
    alice = _maxed(proto)                                     # state 0, not in liquidation
    with pytest.raises(Exception):
        proto.settle(alice, ONE_MUSD)


# ── dust / zero-amount ─────────────────────────────────────────────────────────

def test_zero_borrow_rejected(proto):
    alice = _maxed(proto)
    with pytest.raises(Exception):
        proto.borrow_more(alice, 0)


def test_zero_mint_rejected(proto):
    u = proto.new_user(usdc=1_000 * ONE_MUSD)
    grp = proto.group()
    grp.add_asset_transfer(AssetTransferParams(sender=u.address, receiver=proto.psm.app_address,
                                               asset_id=proto.usdc_id, amount=0, note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.psm, "mint_musd", [0], u))
    with pytest.raises(Exception):
        proto.send_group(grp)


# ── griefing: opt-out to block a refund/liquidation transfer ───────────────────

def test_optout_griefing_is_bounded(proto):
    """A borrower can opt out of the LP ASA to block a surplus-returning full liquidation,
    but only while equity exists; once underwater past the debt, full-liq needs no
    borrower-bound transfer and proceeds. So the grief delays, it does not prevent."""
    alice = proto._account(100)
    proto.algorand.send.asset_opt_in(AssetOptInParams(sender=alice.address, asset_id=proto.lp_id))
    proto.algorand.send.asset_opt_in(AssetOptInParams(sender=alice.address, asset_id=proto.musd_id))
    proto._give(alice.address, proto.lp_id, 100 * ONE_LP)
    proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=50 * ONE_MUSD)   # alice now holds 0 LP
    # Opt out of LP (zero balance) so any LP transfer back to alice would fail.
    proto.algorand.send.asset_opt_out(
        AssetOptOutParams(sender=alice.address, asset_id=proto.lp_id, creator=proto.admin.address))

    # With surplus (lp_value 55 > debt 50, HF 0.825) full-liq returns surplus LP → blocked.
    proto.set_price(550_000)
    with pytest.raises(Exception):
        proto.call(proto.vault, "trigger_full_liquidation", [alice.address, POOL_ID], proto.admin)

    # Once underwater past debt (lp_value 45 < 50), there is no surplus transfer → succeeds.
    proto.set_price(450_000)
    proto.call(proto.vault, "trigger_full_liquidation", [alice.address, POOL_ID], proto.admin)
    assert proto.vault_box(alice).vault_state == 2
