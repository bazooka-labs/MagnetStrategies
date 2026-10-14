"""
A LocalNet rehearsal of the lean-oracle migration (ORACLE_LEAN_SPEC.md §6).

Deliverable 2 of the three that gate the swap. The existing repoint tests in
test_roles_timelock.py prove the TIMELOCK mechanics, but they propose
`proto.oracle.app_id` — the oracle already in use — so they cannot show which
oracle the vault actually prices from, and cannot exhibit the failure modes that
matter during the 48h window. This file stands up a SECOND, lean oracle beside
the live banded one and runs the real sequence.

The two oracles are deliberately seeded with DIFFERENT prices (1.00 vs 2.00).
That is the instrument: the vault's borrowing capacity is a direct readout of
which oracle it is reading, so "did the cutover happen" is answered by protocol
behaviour rather than by inspecting a global and trusting it means something.

Runs only from the banded oracle, because that is where the migration starts.
"""
import base64
import os

import pytest

from algokit_utils import AlgoAmount, AssetOptInParams, AssetTransferParams, PaymentParams

from conftest import (
    BANDED, INITIAL_PRICE, LIQ_BPS, LP_TOTAL, LTV_BPS, ONE_LP, ONE_MUSD,
    POOL_ID, RATE_BPS, TIMELOCK, VAULT_MBR,
)

pytestmark = pytest.mark.skipif(
    not BANDED,
    reason="the migration starts from the live banded oracle; run without MAGNETFI_ORACLE",
)

# The lean oracle's seed. 2x the banded oracle's, so 100 LP of collateral is
# worth 100 mUSD under the old oracle and 200 under the new one — and at a 60%
# LTV that is a 60 vs 120 borrowing cap. A 100 mUSD borrow therefore succeeds
# under exactly one of them, which is what makes the cutover observable.
LEAN_PRICE = 2 * INITIAL_PRICE
COLLATERAL = 100 * ONE_LP
# 60% LTV on 100 LP: exactly 60 mUSD at the banded oracle's 1.00, exactly 120 at
# the lean oracle's 2.00. Asserting the boundary to the micro-unit — cap ok,
# cap+1 rejected — identifies WHICH price the vault used, with no reliance on
# error text (see _fails).
OLD_CAP = 60 * ONE_MUSD
LEAN_CAP = 120 * ONE_MUSD
# Inside the lean oracle's cap, outside the banded one's.
TELLTALE_BORROW = 100 * ONE_MUSD


def _app_uint(proto, app_id: int, prefix: bytes, pool: int = POOL_ID) -> int | None:
    """Read `prefix || pool` out of any app's global state, not just proto.oracle."""
    info = proto.algod.application_info(app_id)
    kb = base64.b64encode(prefix + pool.to_bytes(8, "big")).decode()
    for kv in info["params"].get("global-state", []):
        if kv["key"] == kb:
            return kv["value"]["uint"]
    return None


def _vault_global(proto, key: bytes) -> int:
    info = proto.algod.application_info(proto.vault.app_id)
    kb = base64.b64encode(key).decode()
    for kv in info["params"].get("global-state", []):
        if kv["key"] == kb:
            return kv["value"]["uint"]
    return 0


def _rejects(fn, because: str):
    """
    Assert failure FOR THE STATED REASON.

    Only usable on a SINGLE app call. Grouped calls (every vault operation is an
    atomic group) are sent through algokit's simulate path, which reports
    `logic eval error: assert failed pc=3151` and drops the assert comment — so
    there is no reason text to match on. Use `_fails` plus a positive control
    there instead.
    """
    with pytest.raises(Exception) as e:
        fn()
    assert because in str(e.value), f"failed, but for the wrong reason: {e.value}"


def _fails(fn):
    """
    Assert a grouped call fails, where the reason is established by construction.

    Every use of this is paired with a control that isolates the cause: either a
    boundary (cap succeeds, cap+1 does not, which pins the price exactly) or a
    before/after where the single intervening change is the suspected one.
    """
    with pytest.raises(Exception):
        fn()


def assert_capacity_is(proto, user, cap: int) -> None:
    """
    Pin the vault's borrowing capacity for COLLATERAL to exactly `cap`.

    Because cap is a fixed fraction of price x collateral, an exact capacity is
    an exact price — so this says which oracle the vault read, without trusting
    a global or parsing an error.
    """
    _fails(lambda: proto.open_vault(user, lp_amount=COLLATERAL, borrow=cap + 1))
    proto.open_vault(user, lp_amount=COLLATERAL, borrow=cap)
    assert proto.vault_box(user).musd_borrowed == cap


def stand_up_lean_oracle(proto, price: int = LEAN_PRICE):
    """Migration steps 1-3: deploy the lean oracle, authorize the bot, register the pool."""
    lean = proto._deploy("lean_oracle", "LeanOracle", [proto.guardian.address])
    proto._fund(lean.app_address, 2)
    proto.call(lean, "set_authorized_updater", [proto.bot.address], proto.admin)
    proto.call(lean, "add_pool", [POOL_ID, price], proto.admin)
    assert _app_uint(proto, lean.app_id, b"lp_price_") == price
    # No anchor is created, which is the whole point of the new contract.
    assert _app_uint(proto, lean.app_id, b"lp_anchor_") is None
    return lean


def post_to(proto, oracle, price: int) -> None:
    proto.call(oracle, "update_lp_price", [POOL_ID, price], proto.bot)


# ── step 4: the hazard that would have frozen the protocol ───────────────────

def test_repointing_the_only_bot_freezes_the_protocol_for_the_whole_window(proto):
    """
    Why step 4 says run a SECOND bot instead of repointing the first.

    An earlier draft of the spec said "point the bot's config at the new oracle
    — both run in parallel". The bot holds exactly one oracle id, so repointing
    it STOPS feeding the old oracle, which is still the vault's oracle for the
    whole 48h. This reproduces that: the new oracle is fresh and correct, the
    old one is merely unfed, and the protocol is frozen anyway.

    The freeze is total — borrowing AND every liquidation path — and the
    timelock applies in both directions, so there is no shortcut back.
    """
    lean = stand_up_lean_oracle(proto)
    proto.call(proto.vault, "propose_lp_oracle", [lean.app_id], proto.admin)

    alice = proto.new_user(lp=1_000 * ONE_LP)

    # The repointing mistake: from here the bot feeds only the new oracle.
    proto.time_travel(3_600)              # 1h — past the vault's 30min freshness
    post_to(proto, lean, LEAN_PRICE)      # new oracle fresh...

    # ...and the new oracle IS fresh, so the failure below is about WHICH oracle
    # the vault reads, not about there being no price anywhere.
    assert _app_uint(proto, lean.app_id, b"lp_price_") == LEAN_PRICE
    fresh_ts = _app_uint(proto, lean.app_id, b"lp_ts_")
    assert fresh_ts is not None and fresh_ts >= proto.latest_ts() - 60

    # The old oracle is past the vault's window — established from chain state,
    # not from an error string.
    old_ts = proto.oracle_uint(b"lp_ts_")
    assert old_ts is not None and old_ts + 1_800 < proto.latest_ts()

    # Frozen, although a fresh correct price exists on the new oracle.
    _fails(lambda: proto.open_vault(alice, lp_amount=COLLATERAL, borrow=10 * ONE_MUSD))

    # Recovery is just feeding the old oracle again — the ONLY thing that
    # changes between the failure above and the success below, which is what
    # identifies staleness of the old oracle as the cause.
    proto.refresh_oracle()
    proto.open_vault(alice, lp_amount=COLLATERAL, borrow=10 * ONE_MUSD)
    assert proto.vault_box(alice).musd_borrowed == 10 * ONE_MUSD


def test_while_pending_the_vault_still_prices_from_the_old_oracle(proto):
    """
    A proposal is not a cutover.

    Proving it by capacity rather than by reading the global: the lean oracle
    says 2.00, and if the vault were reading it a 100 mUSD borrow would be
    inside the cap. It is not.
    """
    lean = stand_up_lean_oracle(proto)
    proto.call(proto.vault, "propose_lp_oracle", [lean.app_id], proto.admin)

    assert _vault_global(proto, b"lp_oracle_app_id") == proto.oracle.app_id
    assert _vault_global(proto, b"pending_lp_oracle") == lean.app_id

    # Capacity is exactly the OLD oracle's 1.00, to the micro-unit. Under the
    # lean oracle's 2.00 it would be LEAN_CAP, so this is unambiguous.
    assert_capacity_is(proto, proto.new_user(lp=1_000 * ONE_LP), OLD_CAP)
    _fails(lambda: proto.open_vault(proto.new_user(lp=1_000 * ONE_LP),
                                    lp_amount=COLLATERAL, borrow=LEAN_CAP))


# ── step 6: the cutover, and the trap inside it ──────────────────────────────

def test_cutover_moves_the_price_the_vault_borrows_against(proto):
    """Step 6 completed: after confirm, capacity reflects the LEAN oracle's price."""
    lean = stand_up_lean_oracle(proto)
    proto.call(proto.vault, "propose_lp_oracle", [lean.app_id], proto.admin)

    proto.time_travel(TIMELOCK + 10)
    # Step 5: both oracles fresh immediately before the confirm. The 48h jump
    # staled both, and the new one must be fresh the instant it goes live or the
    # cutover lands straight into a frozen protocol.
    proto.refresh_oracle()
    post_to(proto, lean, LEAN_PRICE)

    proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin)
    assert _vault_global(proto, b"lp_oracle_app_id") == lean.app_id
    assert _vault_global(proto, b"pending_lp_oracle") == 0

    # Capacity doubled to exactly the lean oracle's 2.00: the vault is pricing
    # from the new oracle, proven by protocol behaviour rather than by the
    # global read above.
    assert_capacity_is(proto, proto.new_user(lp=1_000 * ONE_LP), LEAN_CAP)


def test_after_cutover_the_old_oracle_going_stale_is_harmless(proto):
    """
    Step 8: "retiring" the old oracle is just switching its bot off.

    It cannot be deleted — no delete handler — so what matters is that letting
    it rot has no effect once the vault no longer reads it.
    """
    lean = stand_up_lean_oracle(proto)
    proto.call(proto.vault, "propose_lp_oracle", [lean.app_id], proto.admin)
    proto.time_travel(TIMELOCK + 10)
    proto.refresh_oracle()
    post_to(proto, lean, LEAN_PRICE)
    proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin)

    # Old oracle abandoned; only the lean one is fed.
    proto.time_travel(7_200)              # 2h
    post_to(proto, lean, LEAN_PRICE)

    old_ts = proto.oracle_uint(b"lp_ts_")
    assert old_ts is not None and old_ts + 1_800 < proto.latest_ts(), "old oracle should be stale"

    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=COLLATERAL, borrow=TELLTALE_BORROW)
    assert proto.vault_box(alice).musd_borrowed == TELLTALE_BORROW


def test_an_admin_rotation_mid_window_silently_restarts_the_48h(proto):
    """
    The trap flagged at step 6: `accept_admin` clears `pending_lp_oracle`
    (vault/contract.py:288-292).

    Nothing reverts and nothing warns. The operator waits out what they believe
    is the remaining window, calls confirm, and finds there is no proposal — so
    the clock starts again from the rotation, not from the original propose.
    """
    lean = stand_up_lean_oracle(proto)
    proto.call(proto.vault, "propose_lp_oracle", [lean.app_id], proto.admin)
    assert _vault_global(proto, b"pending_lp_oracle") == lean.app_id

    proto.time_travel(TIMELOCK // 2)      # 24h in

    new_admin = proto._account(100)
    proto.call(proto.vault, "propose_admin", [new_admin.address], proto.admin)
    proto.call(proto.vault, "accept_admin", [], new_admin)

    # Silently gone.
    assert _vault_global(proto, b"pending_lp_oracle") == 0

    # Past the ORIGINAL eta, there is nothing to confirm.
    proto.time_travel(TIMELOCK // 2 + 60)
    proto.refresh_oracle()
    _rejects(lambda: proto.call(proto.vault, "confirm_lp_oracle", [], new_admin),
             "no pending")

    # Re-proposing works, but the full 48h runs again from here.
    proto.call(proto.vault, "propose_lp_oracle", [lean.app_id], new_admin)
    _rejects(lambda: proto.call(proto.vault, "confirm_lp_oracle", [], new_admin), "timelock")
    proto.time_travel(TIMELOCK + 10)
    proto.refresh_oracle()
    post_to(proto, lean, LEAN_PRICE)
    proto.call(proto.vault, "confirm_lp_oracle", [], new_admin)
    assert _vault_global(proto, b"lp_oracle_app_id") == lean.app_id


# ── rollback ─────────────────────────────────────────────────────────────────

def test_rollback_has_a_working_feed_behind_it(proto):
    """
    The claim at the end of §6: rollback is real here, unlike under v5.

    Going back is still a 48h wait, but the old oracle works and the bot can
    post to it, so the wait happens with a FUNCTIONING feed rather than a dead
    one. That is only true if its bot instance was not torn down early — which
    is why step 8 comes after the window, not during it.
    """
    lean = stand_up_lean_oracle(proto)
    proto.call(proto.vault, "propose_lp_oracle", [lean.app_id], proto.admin)
    proto.time_travel(TIMELOCK + 10)
    proto.refresh_oracle()
    post_to(proto, lean, LEAN_PRICE)
    proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin)
    assert _vault_global(proto, b"lp_oracle_app_id") == lean.app_id

    # Something is wrong with the new oracle; go back.
    proto.call(proto.vault, "propose_lp_oracle", [proto.oracle.app_id], proto.admin)
    _rejects(lambda: proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin), "timelock")

    # Through the window the lean oracle keeps serving, so the protocol is live
    # while waiting — this is the part that is NOT true of a rollback from v5.
    proto.time_travel(3_600)
    post_to(proto, lean, LEAN_PRICE)
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=COLLATERAL, borrow=TELLTALE_BORROW)

    proto.time_travel(TIMELOCK + 10)
    proto.refresh_oracle()                # the old oracle, still fed
    post_to(proto, lean, LEAN_PRICE)
    proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin)
    assert _vault_global(proto, b"lp_oracle_app_id") == proto.oracle.app_id

    # Back on the banded oracle's 1.00, capacity is exactly halved again.
    assert_capacity_is(proto, proto.new_user(lp=1_000 * ONE_LP), OLD_CAP)


# ── do open positions have to be closed first? ───────────────────────────────

def test_a_position_opened_before_the_swap_survives_it(proto):
    """
    No. Open loans do NOT need to be unwound for this migration.

    The "every open position must be closed on the old vault and reopened on the
    new one" requirement (REVAMP_PLAN.md:22) is a consequence of deploying a new
    VAULT — the one contract with no repointing path. ORACLE_V5_SPEC.md:84
    tabulates it as the v4-vs-v5 difference: "unwind every open position | yes |
    no".

    This migration repoints the ORACLE, through `propose_lp_oracle` →
    `confirm_lp_oracle`. The vault app is never redeployed and its boxes are
    never touched. So a position taken out before the swap should carry straight
    through it and still be serviceable afterwards — which is what this asserts,
    rather than leaving it as an inference from two documents.

    Both oracles are seeded at the SAME price here, modelling the real migration
    (step 3 says add_pool each pool with a fresh price). The capacity
    discriminator used elsewhere in this file is deliberately not in play: the
    question here is continuity, not which oracle is live.
    """
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=COLLATERAL, borrow=50 * ONE_MUSD)
    before = proto.vault_box(alice)
    assert before is not None and before.musd_borrowed == 50 * ONE_MUSD

    # Migrate underneath the open loan, same price on both sides.
    lean = stand_up_lean_oracle(proto, INITIAL_PRICE)
    proto.call(proto.vault, "propose_lp_oracle", [lean.app_id], proto.admin)
    proto.time_travel(TIMELOCK + 10)
    proto.refresh_oracle()
    post_to(proto, lean, INITIAL_PRICE)
    proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin)
    assert _vault_global(proto, b"lp_oracle_app_id") == lean.app_id

    # The box is untouched: same borrower, same principal, same collateral.
    after = proto.vault_box(alice)
    assert after is not None, "the position vanished across the swap"
    assert after.musd_borrowed == before.musd_borrowed
    assert after.lp_amount == before.lp_amount

    # Surviving is not the same as being PRICED. Repayment alone would not show
    # this: `pay_interest` reads neither the price nor the freshness, so every
    # assertion above still holds if the new oracle had no price for this pool at
    # all — which is a real migration hazard, not a hypothetical (missing an
    # `add_pool` at step 3 does exactly that). `borrow_more` reads both, and
    # against the SURVIVING box rather than a fresh one, so it only succeeds if
    # the new oracle is serving this pool.
    #
    # No exact boundary here: the cap is 60 (100 LP x 1.00 x 60% LTV) but it is
    # checked against TOTAL debt, and 48h of accrued interest on the 50 already
    # drawn eats into the headroom. Asserting 10 exactly fails for that reason —
    # so take a clearly-inside draw and a clearly-outside one.
    proto.borrow_more(alice, 5 * ONE_MUSD)
    drawn = proto.vault_box(alice)
    assert drawn is not None and drawn.musd_borrowed == 55 * ONE_MUSD
    # The LTV cap still binds, priced off the new oracle.
    _fails(lambda: proto.borrow_more(alice, 20 * ONE_MUSD))

    # And it is still closeable — repay in full, which closes the vault and
    # returns the LP. Nothing about the swap stranded the position.
    #
    # The interest buffer has to cover 48h of accrual here, not the seconds a
    # normal test takes: interest is charged before principal, so too small a
    # buffer silently leaves a residue instead of closing the vault.
    proto.repay_principal(alice, drawn.musd_borrowed, cover=ONE_MUSD)
    assert proto.vault_box(alice) is None, "full repayment should close the vault"


def test_repayment_does_not_need_a_fresh_oracle(proto):
    """
    Why a stalled feed does not trap a borrower.

    `pay_interest` is the single repayment path and it is NOT among the methods
    gated on `_oracle_is_fresh` — only `open_vault`, `borrow_more` and the three
    `trigger_*_liquidation` paths are. So the direction that ADDS risk is gated
    and the direction that REMOVES it is not, which is the right way round: a
    dead feed must never prevent someone from getting out.

    Relevant right now, with the feed down since 2026-10-13.
    """
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=COLLATERAL, borrow=50 * ONE_MUSD)

    proto.time_travel(7_200)        # 2h — well past the 30 minute window
    old_ts = proto.oracle_uint(b"lp_ts_")
    assert old_ts is not None and old_ts + 1_800 < proto.latest_ts()

    # Borrowing more is refused — and `borrow_more` is a single app call, so the
    # reason survives and is pinned rather than assumed.
    _rejects(lambda: proto.borrow_more(alice, 1 * ONE_MUSD), "oracle stale")
    # ...but repaying, and closing out entirely, is not.
    box = proto.vault_box(alice)
    assert box is not None
    proto.repay_principal(alice, box.musd_borrowed)
    assert proto.vault_box(alice) is None


# ── the pool you forgot ──────────────────────────────────────────────────────

def _wire_second_pool(proto):
    """Register a second collateral pool on the OLD oracle and the vault."""
    pool2 = POOL_ID + 1
    lp2 = proto._create_asset("U/USDC LP", "TMPOOL3", LP_TOTAL)
    proto.call(proto.oracle, "add_pool", [pool2, INITIAL_PRICE], proto.admin)
    proto.call(proto.vault, "opt_in_asset", [lp2], proto.admin)
    proto.call(proto.vault, "set_rate", [pool2, RATE_BPS], proto.admin)
    proto.call(proto.vault, "set_liq_threshold", [pool2, LIQ_BPS], proto.admin)
    proto.call(proto.vault, "set_ltv", [pool2, LTV_BPS], proto.admin)
    proto.call(proto.vault, "set_lp_asa_id", [pool2, lp2], proto.admin)
    return pool2, lp2


def _borrower_for(proto, lp2: int, lp_amount: int):
    u = proto.new_user(lp=0)
    proto.algorand.send.asset_opt_in(AssetOptInParams(sender=u.address, asset_id=lp2))
    proto._give(u.address, lp2, lp_amount)
    return u


def _open_on(proto, user, pool_id: int, lp_asa: int, lp_amount: int, borrow: int):
    """conftest's open_vault pinned to POOL_ID/lp_id; this is the same group for any pool."""
    grp = proto.algorand.new_group()
    grp.add_payment(PaymentParams(
        sender=user.address, receiver=proto.vault.app_address,
        amount=AlgoAmount.from_micro_algo(VAULT_MBR), note=os.urandom(8)))
    grp.add_app_call_method_call(proto.mc(proto.vault, "open_vault", [pool_id, borrow], user))
    grp.add_asset_transfer(AssetTransferParams(
        sender=user.address, receiver=proto.vault.app_address,
        asset_id=lp_asa, amount=lp_amount, note=os.urandom(8)))
    proto.send_group(grp)


def test_a_pool_missing_from_the_new_oracle_dies_at_cutover(proto):
    """
    Migration step 3 says `add_pool` for EVERY pool. Miss one and that pool dies.

    `confirm_lp_oracle` swaps `lp_oracle_app_id` for the whole vault at once and
    validates only that a proposal exists and the timelock elapsed
    (`vault/contract.py:985-1005`) — there is no per-pool check that the incoming
    oracle actually has a price. So a pool omitted at step 3 goes from working to
    dead the instant the swap confirms, and `_oracle_price` fails closed on it
    ("oracle price not set", `vault/contract.py:209`).

    That kills borrowing AND all three liquidation paths for that pool, while
    repayment keeps working — which is the worse direction, because underwater
    positions stop being liquidatable. Recovery needs another full 48h timelock.

    The rest of this file exercises one pool; production has two wired
    (u-talgo `3163770927`, u-usdc `3673941603`), so this shape is reachable.
    """
    pool2, lp2 = _wire_second_pool(proto)

    # Control: before the swap, pool 2 works.
    bob = _borrower_for(proto, lp2, 1_000 * ONE_LP)
    _open_on(proto, bob, pool2, lp2, COLLATERAL, 10 * ONE_MUSD)

    # The mistake: the lean oracle is given pool 1 and NOT pool 2.
    lean = stand_up_lean_oracle(proto, INITIAL_PRICE)
    assert _app_uint(proto, lean.app_id, b"lp_price_", pool2) is None, "pool 2 must be absent"

    proto.call(proto.vault, "propose_lp_oracle", [lean.app_id], proto.admin)
    proto.time_travel(TIMELOCK + 10)
    proto.refresh_oracle()
    post_to(proto, lean, INITIAL_PRICE)
    proto.call(proto.vault, "confirm_lp_oracle", [], proto.admin)

    # Pool 1 is fine...
    alice = proto.new_user(lp=1_000 * ONE_LP)
    proto.open_vault(alice, lp_amount=COLLATERAL, borrow=10 * ONE_MUSD)

    # ...and pool 2 is dead. Same action that succeeded above, same collateral,
    # same borrower profile — the only thing that changed is which oracle the
    # vault reads, which is what identifies the cause.
    carol = _borrower_for(proto, lp2, 1_000 * ONE_LP)
    _fails(lambda: _open_on(proto, carol, pool2, lp2, COLLATERAL, 10 * ONE_MUSD))

    # Bob's existing pool-2 position cannot be liquidated either, though it can
    # still be repaid — the asymmetry that makes this worse than a lockup.
    #
    # This is a single app call, so the reason survives, and it is worth pinning
    # for a reason beyond rigour: the failure reads **"oracle stale"**, NOT
    # "oracle price not set". `_oracle_is_fresh` is checked before the price
    # (`vault/contract.py:793` then `:209`) and an unregistered pool has no
    # `lp_ts_` at all, so ts = 0 reads as stale. An operator debugging this would
    # go hunting for a dead bot — the bot is fine; the pool was never registered
    # on the new oracle. Belongs in the step-3 checklist.
    _rejects(lambda: proto.call(proto.vault, "trigger_full_liquidation",
                                [bob.address, pool2], proto.admin),
             "oracle stale")
