"""Smoke test: validates the harness deploys, wires, and runs a basic borrow/repay."""
from conftest import POOL_ID, LTV_BPS, INITIAL_PRICE, ONE_LP, ONE_MUSD, VAULT_MBR


def test_deploy_and_wire(proto):
    # Oracle seeded with price + anchor
    assert proto.oracle_uint(b"lp_price_") == INITIAL_PRICE
    assert proto.oracle_uint(b"lp_anchor_") == INITIAL_PRICE
    # PSM holds full reserve, ceiling opened with USDC, circulating starts at 0
    assert proto.circulating_musd() == 0
    assert proto.psm_usdc() == 100_000 * ONE_MUSD
    # Vault registered on PSM after timelock
    assert proto.psm_global(b"vault_app_id") == proto.vault.app_id


def test_open_borrow_and_repay(proto):
    alice = proto.new_user(lp=1000 * ONE_LP)
    # Deposit 100 LP (value 100 mUSD @ price 1.0), borrow 50 mUSD (under 60% LTV cap)
    proto.open_vault(alice, lp_amount=100 * ONE_LP, borrow=50 * ONE_MUSD)

    box = proto.vault_box(alice)
    assert box is not None
    assert box.lp_amount == 100 * ONE_LP
    assert box.musd_borrowed == 50 * ONE_MUSD
    assert box.vault_state == 0
    # Borrower received the borrowed mUSD; PSM circulating rose to match
    assert proto.musd_bal(alice.address) == 50 * ONE_MUSD
    assert proto.circulating_musd() == 50 * ONE_MUSD

    # Repay full principal (no interest yet — same block-ish). Clear any tiny interest first.
    box = proto.vault_box(alice)
    if box.accrued_interest > 0:
        proto.pay_interest(alice, box.accrued_interest)
    proto.repay_principal(alice, 50 * ONE_MUSD)

    # Vault closed, collateral + MBR returned, circulating back to 0
    assert not proto.vault_exists(alice)
    assert proto.lp_bal(alice.address) == 1000 * ONE_LP
    assert proto.circulating_musd() == 0
