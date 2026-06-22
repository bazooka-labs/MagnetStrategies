"""Two-role model: admin/guardian rotation, distinctness, pause, 48h timelock + veto."""
import pytest
from conftest import ONE_LP, ONE_MUSD, POOL_ID, TIMELOCK


def test_admin_rotation_two_step(proto):
    new_admin = proto._account(100)
    # Only admin/guardian can propose; random cannot
    mallory = proto._account(100)
    with pytest.raises(Exception):
        proto.call(proto.vault, "propose_admin", [new_admin.address], mallory)

    proto.call(proto.vault, "propose_admin", [new_admin.address], proto.admin)
    # Wrong account cannot accept
    with pytest.raises(Exception):
        proto.call(proto.vault, "accept_admin", [], mallory)
    proto.call(proto.vault, "accept_admin", [], new_admin)

    # Old admin no longer authorized; new admin is
    with pytest.raises(Exception):
        proto.call(proto.vault, "set_rate", [POOL_ID, 1_500], proto.admin)
    proto.call(proto.vault, "set_rate", [POOL_ID, 1_500], new_admin)


def test_guardian_can_recover_admin(proto):
    new_admin = proto._account(100)
    # Guardian path enables recovery of a lost/compromised hot key
    proto.call(proto.vault, "propose_admin", [new_admin.address], proto.guardian)
    proto.call(proto.vault, "accept_admin", [], new_admin)
    proto.call(proto.vault, "set_rate", [POOL_ID, 1_500], new_admin)


def test_admin_guardian_must_differ(proto):
    # Cannot propose the guardian as admin (would collapse the two-role model)
    with pytest.raises(Exception):
        proto.call(proto.vault, "propose_admin", [proto.guardian.address], proto.admin)
    # Cannot propose the admin as guardian
    with pytest.raises(Exception):
        proto.call(proto.vault, "propose_guardian", [proto.admin.address], proto.guardian)


def test_pause_blocks_borrowing_guardian_only_unpause(proto):
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=200 * ONE_LP, borrow=30 * ONE_MUSD)

    proto.call(proto.vault, "pause", [], proto.guardian)
    with pytest.raises(Exception):
        proto.borrow_more(alice, 10 * ONE_MUSD)        # new borrowing blocked
    # Repayment still works while paused (user exit always open)
    proto.repay_principal(alice, 10 * ONE_MUSD)

    with pytest.raises(Exception):
        proto.call(proto.vault, "unpause", [], proto.admin)   # admin cannot unpause
    proto.call(proto.vault, "unpause", [], proto.guardian)
    proto.borrow_more(alice, 10 * ONE_MUSD)            # works again


def test_oracle_repoint_timelock_and_veto(proto):
    # Propose a (dummy) new oracle app id; cannot confirm before 48h
    new_oracle = proto.oracle.app_id   # any non-zero id for the test
    proto.call(proto.vault, "propose_lp_oracle", [new_oracle], proto.admin)
    with pytest.raises(Exception):
        proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin)

    # Guardian veto cancels it; confirm then fails (nothing pending)
    proto.call(proto.vault, "cancel_pending_lp_oracle", [], proto.guardian)
    proto.time_travel(TIMELOCK + 10)
    with pytest.raises(Exception):
        proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin)


def test_oracle_repoint_confirms_after_timelock(proto):
    target = proto.oracle.app_id
    proto.call(proto.vault, "propose_lp_oracle", [target], proto.admin)
    proto.time_travel(TIMELOCK + 10)
    proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin)   # succeeds after 48h


def test_psm_vault_contract_timelock(proto):
    # Re-registering the vault is timelocked on the PSM too
    proto.call(proto.psm, "propose_vault_contract", [proto.vault.app_id], proto.admin)
    with pytest.raises(Exception):
        proto.call(proto.psm, "confirm_vault_contract", [], proto.admin)
    proto.time_travel(TIMELOCK + 10)
    proto.call(proto.psm, "confirm_vault_contract", [], proto.admin)
