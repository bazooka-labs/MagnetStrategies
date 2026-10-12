"""
The property the whole v5 re-scope exists for.

ORACLE_V5_SPEC.md §1: *"the price must never be the reason a liquidation cannot
run."* Three oracle freezes to date have each meant the opposite — the feed
stops, the vault fails closed, and borrowing AND all three liquidation paths
revert for as long as it is down.

v5's answer is that anyone may publish a signed price. So a liquidator facing a
dead feed does not wait for it: they carry a payload and refresh the price
inside their own atomic group, and the vault reads a price zero seconds old.

These tests put a real stale feed in front of a real vault and prove it. They
are the executable form of the claim, and they only run against the relay
oracle — there is nothing to test on the posted-price oracle, where a stale feed
simply means a dead protocol.

Run with:  MAGNETFI_ORACLE=relay .venv-test/bin/python -m pytest tests/test_relay_liveness.py -q
"""

from __future__ import annotations

import pytest

from conftest import ONE_LP, ONE_MUSD, POOL_ID, RELAY

pytestmark = pytest.mark.skipif(
    not RELAY, reason="v5-only — set MAGNETFI_ORACLE=relay")

# The vault's own constant (vault/contract.py:45). A price older than this and
# every borrow and liquidation path reverts.
ORACLE_FRESHNESS = 1_800


def _borrower_at(proto, lp: int, borrow: int):
    u = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(u, lp_amount=lp * ONE_LP, borrow=borrow * ONE_MUSD)
    return u


def _go_stale(proto) -> None:
    """Let the feed die — further past the freshness window than any real outage."""
    proto.time_travel(ORACLE_FRESHNESS * 3)


def test_the_vault_really_does_fail_closed_when_the_feed_dies(proto):
    """
    The premise. If this stops failing, the tests below prove nothing, because
    they would pass on a vault that never needed a fresh price at all.
    """
    alice = _borrower_at(proto, lp=100, borrow=50)
    proto.set_price(550_000)        # underwater: lp_value 55 vs debt 50
    _go_stale(proto)
    with pytest.raises(Exception) as e:
        proto.call(proto.vault, "trigger_full_liquidation",
                   [alice.address, POOL_ID], proto.admin)
    assert "oracle" in str(e.value).lower() or "fresh" in str(e.value).lower(), \
        f"failed, but not on freshness: {e.value}"


def test_a_liquidation_succeeds_on_a_dead_feed_when_the_price_rides_along(proto):
    """
    **The whole point of v5.**

    Identical setup to the test above — a feed stale by three times the vault's
    window — except the liquidator prepends a signed price to their own group.
    The post writes lp_ts_ in the same block the vault reads it, so the price is
    zero seconds old and the window cannot bite.
    """
    alice = _borrower_at(proto, lp=100, borrow=50)
    proto.set_price(550_000)
    _go_stale(proto)

    msg, sig = proto.sign_payload(550_000)
    grp = proto.group()
    grp.add_app_call_method_call(
        proto.mc(proto.oracle, "post_signed_price", [msg, sig], proto.admin))
    grp.add_app_call_method_call(
        proto.mc(proto.vault, "trigger_full_liquidation",
                 [alice.address, POOL_ID], proto.admin))
    proto.send_group(grp)

    box = proto.vault_box(alice)
    assert box.vault_state == 2, "liquidation did not complete"
    assert box.lp_amount == 0
    assert proto.circulating_musd() <= proto.psm_usdc()


def test_a_stranger_can_do_it_too(proto):
    """
    The relay has no privileged writer, so the liquidator needs no role to
    refresh the price — only a payload and a fee. Without that, "anyone can
    liquidate" would quietly mean "anyone the operator has blessed."
    """
    alice = _borrower_at(proto, lp=100, borrow=50)
    proto.set_price(550_000)
    _go_stale(proto)

    stranger = proto.new_user()
    msg, sig = proto.sign_payload(550_000)
    grp = proto.group()
    grp.add_app_call_method_call(
        proto.mc(proto.oracle, "post_signed_price", [msg, sig], stranger))
    # The liquidation itself is still admin-gated today; only the PRICE is open.
    grp.add_app_call_method_call(
        proto.mc(proto.vault, "trigger_full_liquidation",
                 [alice.address, POOL_ID], proto.admin))
    proto.send_group(grp)
    assert proto.vault_box(alice).vault_state == 2


def test_borrowing_also_recovers_without_waiting_for_the_relay(proto):
    """
    Not just liquidation. A borrower blocked by a stale feed can unblock
    themselves the same way — which is what turns a staleness problem into an
    availability problem that self-heals.
    """
    alice = _borrower_at(proto, lp=100, borrow=20)
    _go_stale(proto)
    with pytest.raises(Exception):
        proto.borrow_more(alice, 5 * ONE_MUSD)

    msg, sig = proto.sign_payload(1_000_000)
    proto.call(proto.oracle, "post_signed_price", [msg, sig], alice)
    proto.borrow_more(alice, 5 * ONE_MUSD)      # must now succeed
