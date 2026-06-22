"""PSM: mint, redeem (fee routing), invariant guard, pause semantics."""
import pytest
from conftest import ONE_MUSD, ONE_LP


def test_mint_one_to_one(proto):
    u = proto.new_user(usdc=1_000 * ONE_MUSD)
    before_circ = proto.circulating_musd()
    proto.mint_musd(u, 100 * ONE_MUSD)
    assert proto.musd_bal(u.address) == 100 * ONE_MUSD
    assert proto.usdc_bal(u.address) == 900 * ONE_MUSD
    assert proto.circulating_musd() == before_circ + 100 * ONE_MUSD
    # Invariant intact
    assert proto.circulating_musd() <= proto.psm_usdc()


def test_redeem_applies_fee_to_treasury(proto):
    u = proto.new_user(usdc=1_000 * ONE_MUSD)
    proto.mint_musd(u, 100 * ONE_MUSD)
    t_before = proto.usdc_bal(proto.treasury.address)
    proto.redeem_musd(u, 100 * ONE_MUSD)
    # 1% default fee: user gets 99 USDC back, treasury gets 1 USDC
    assert proto.usdc_bal(u.address) == 999 * ONE_MUSD
    assert proto.usdc_bal(proto.treasury.address) == t_before + 1 * ONE_MUSD
    assert proto.musd_bal(u.address) == 0


def test_withdraw_cannot_break_invariant(proto):
    # Create circulating mUSD by borrowing.
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=200 * ONE_LP, borrow=100 * ONE_MUSD)
    excess = proto.psm_usdc() - proto.circulating_musd()
    # Withdrawing exactly the excess is fine; one more than excess must fail.
    with pytest.raises(Exception):
        proto.call(proto.psm, "withdraw_usdc", [excess + 1], proto.admin)
    # Sanity: invariant still holds and withdraw of excess succeeds
    proto.call(proto.psm, "withdraw_usdc", [excess], proto.admin)
    assert proto.circulating_musd() <= proto.psm_usdc()


def test_pause_blocks_mint_but_not_redeem(proto):
    u = proto.new_user(usdc=1_000 * ONE_MUSD)
    proto.mint_musd(u, 100 * ONE_MUSD)  # works before pause

    proto.call(proto.psm, "pause", [], proto.guardian)
    with pytest.raises(Exception):
        proto.mint_musd(u, 10 * ONE_MUSD)          # mint blocked
    proto.redeem_musd(u, 50 * ONE_MUSD)            # redeem still open

    # Admin cannot unpause (guardian-only)
    with pytest.raises(Exception):
        proto.call(proto.psm, "unpause", [], proto.admin)
    proto.call(proto.psm, "unpause", [], proto.guardian)
    proto.mint_musd(u, 10 * ONE_MUSD)              # works again
