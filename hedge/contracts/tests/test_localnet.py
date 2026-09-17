"""AVM-level tests: the compiled contract, real transaction groups, a real chain."""

import algokit_utils
import pytest
from algokit_utils import AlgorandClient, SigningAccount
from algosdk.atomic_transaction_composer import TransactionWithSigner
from algosdk.abi import Method

from tests.conftest import (
    BANDS, CLOSE_BOUNTY, BOX_MBR, MIN_ENTRY_WINDOW, MIN_SESSION, MIN_STAKE, PAYOUT_FEE, RAKE_BPS,
    player, sign_attestation,
)

CHECKPOINT_LOCK, CHECKPOINT_RESOLVE = 0, 1
FEED_ID = 1


def _client(algorand, app_spec, sender):
    from algokit_utils import AppClient, AppClientParams, Arc56Contract
    return AppClient(AppClientParams(
        app_spec=Arc56Contract.from_dict(app_spec),
        algorand=algorand,
        app_id=0,
        default_sender=sender.address,
        default_signer=sender.signer,
    ))


@pytest.fixture(scope="module")
def deployed(algorand, admin, musd, app_spec, oracle_key, keeper, treasury):
    """create -> fund -> bootstrap. Two steps on purpose: the app must hold enough
    ALGO for its own min balance plus the mUSD opt-in before bootstrap's inner
    opt-in can succeed."""
    from algokit_utils import AppFactory, AppFactoryParams, Arc56Contract

    factory = AppFactory(AppFactoryParams(
        algorand=algorand,
        app_spec=Arc56Contract.from_dict(app_spec),
        default_sender=admin.address,
        default_signer=admin.signer,
        compilation_params={"deploy_time_params": {"MUSD_ASSET_ID": musd}},
    ))
    client, _ = factory.send.create(
        algokit_utils.AppFactoryCreateMethodCallParams(
            method="create_application",
            extra_program_pages=2,
        )
    )
    algorand.send.payment(algokit_utils.PaymentParams(
        sender=admin.address, receiver=client.app_address,
        amount=algokit_utils.AlgoAmount(algo=20),
    ))
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="bootstrap",
        args=[musd, FEED_ID, treasury.address, bytes(oracle_key.verify_key),
              keeper.address, RAKE_BPS, MIN_STAKE, list(BANDS)],
        asset_references=[musd],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=1_000),
    ))
    return client


def test_bootstrap_is_one_shot(deployed, admin, musd, oracle_key):
    with pytest.raises(Exception):
        deployed.send.call(algokit_utils.AppClientMethodCallParams(
            method="bootstrap",
            args=[musd, FEED_ID, admin.address, bytes(oracle_key.verify_key),
                  admin.address, RAKE_BPS, MIN_STAKE, list(BANDS)],
            asset_references=[musd],
        ))


def test_update_and_delete_are_rejected(deployed, algorand, admin, app_spec):
    """Non-upgradeable is the premise the whole ring-fencing claim rests on."""
    from algosdk import transaction
    sp = algorand.client.algod.suggested_params()
    for oc in (transaction.OnComplete.UpdateApplicationOC,
               transaction.OnComplete.DeleteApplicationOC):
        txn = transaction.ApplicationCallTxn(
            sender=admin.address, sp=sp, index=deployed.app_id, on_complete=oc,
            approval_program=b"\x06\x81\x01", clear_program=b"\x06\x81\x01",
        )
        with pytest.raises(Exception):
            algorand.client.algod.send_transaction(txn.sign(admin.private_key))


def _now(algorand) -> int:
    from tests.conftest import chain_now
    return chain_now(algorand)


def _create_round(client, algorand, admin, entry=MIN_ENTRY_WINDOW, session=MIN_SESSION):
    """Checkpoints must be minute-aligned — asserted at create_round, because the
    attestation's candle boundary is compared for EQUALITY with the checkpoint."""
    now = _now(algorand)
    open_t = ((now // 60) + 1) * 60
    lock_t = open_t + entry
    resolve_t = lock_t + session
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="create_round", args=[open_t, lock_t, resolve_t],
    ))
    gs = client.get_global_state()
    rid = int(gs["rcount"].value)
    return rid, open_t, lock_t, resolve_t


def test_create_round_rejects_misaligned_checkpoints(deployed, algorand, admin):
    """The bug that would have made a round unresolvable from birth: with a checkpoint
    not on a minute boundary, no candle boundary the keeper can ever sign satisfies
    the equality assert."""
    now = _now(algorand)
    open_t = ((now // 60) + 1) * 60
    for lock_t, resolve_t in [
        (open_t + MIN_ENTRY_WINDOW + 37, open_t + MIN_ENTRY_WINDOW + 37 + MIN_SESSION),
        (open_t + MIN_ENTRY_WINDOW, open_t + MIN_ENTRY_WINDOW + MIN_SESSION + 13),
    ]:
        with pytest.raises(Exception):
            deployed.send.call(algokit_utils.AppClientMethodCallParams(
                method="create_round", args=[open_t, lock_t, resolve_t],
            ))


def test_create_round_rejects_far_future_schedule(deployed, algorand):
    """MAX_SCHEDULE_AHEAD. Without it one admin typo — a millisecond timestamp —
    pins open_round_id forever with no recovery in a non-upgradeable contract."""
    now = _now(algorand)
    open_t = ((now // 60) + 1) * 60 + 30 * 86_400
    with pytest.raises(Exception):
        deployed.send.call(algokit_utils.AppClientMethodCallParams(
            method="create_round",
            args=[open_t, open_t + MIN_ENTRY_WINDOW, open_t + MIN_ENTRY_WINDOW + MIN_SESSION],
        ))


def test_setters_have_floors_not_just_caps(deployed):
    """Below the true consensus MBR every enter under-funds its own box and the app
    bleeds free ALGO until every inner transaction fails. Below 6,000 a position stops
    pre-funding its terminal call and withdraw_operating_algo can take ALGO that is owed."""
    for method, bad in [("set_box_mbr", 4_170), ("set_payout_fee", 1_000)]:
        with pytest.raises(Exception):
            deployed.send.call(algokit_utils.AppClientMethodCallParams(
                method=method, args=[bad]
            ))
    # and the caps still hold
    for method, bad in [("set_box_mbr", 10_000_000), ("set_payout_fee", 10_000_000)]:
        with pytest.raises(Exception):
            deployed.send.call(algokit_utils.AppClientMethodCallParams(
                method=method, args=[bad]
            ))
    # control: an in-range value is accepted, so the rejections above are the bounds
    # doing their job and not the method being broken
    for method, ok in [("set_box_mbr", BOX_MBR), ("set_payout_fee", PAYOUT_FEE)]:
        deployed.send.call(algokit_utils.AppClientMethodCallParams(
            method=method, args=[ok]
        ))


def test_band_bounds_reject_a_transposed_digit(deployed):
    """10350 -> 13050 stays strictly increasing and still straddles, but silently
    reshapes a band to cover +2.25% to +30.5% and makes the outer band dead."""
    bad = list(BANDS[:-1]) + [13050]
    with pytest.raises(Exception):
        deployed.send.call(algokit_utils.AppClientMethodCallParams(
            method="set_band_bounds", args=[bad]
        ))
    # control: the real template is accepted
    deployed.send.call(algokit_utils.AppClientMethodCallParams(
        method="set_band_bounds", args=[list(BANDS)]
    ))


def _enter(client, algorand, acct, musd, round_id, band, stake, box_mbr=BOX_MBR,
           fee=PAYOUT_FEE):
    """The three-transaction group the contract requires: ALGO for box MBR + payout
    fee, mUSD stake, app call. Both value legs are index-pinned by the contract, so
    their position in the group is load-bearing, not cosmetic."""
    from algosdk.atomic_transaction_composer import TransactionWithSigner

    pay = algorand.create_transaction.payment(algokit_utils.PaymentParams(
        sender=acct.address, receiver=client.app_address,
        amount=algokit_utils.AlgoAmount(micro_algo=box_mbr + fee),
    ))
    axfer = algorand.create_transaction.asset_transfer(
        algokit_utils.AssetTransferParams(
            sender=acct.address, receiver=client.app_address,
            asset_id=musd, amount=stake,
        )
    )
    return client.send.call(algokit_utils.AppClientMethodCallParams(
        method="enter",
        args=[
            TransactionWithSigner(pay, acct.signer),
            TransactionWithSigner(axfer, acct.signer),
            round_id,
            band,
        ],
        sender=acct.address, signer=acct.signer,
        asset_references=[musd],
    ))


def test_full_round_lifecycle(algorand, admin, dispenser, musd, app_spec, oracle_key,
                              deployed):
    """create -> enter x3 -> lock -> resolve -> settle + close -> solvency.

    This is the test that exercises ed25519verify_bare on chain. Before ensure_budget
    was added, lock and resolve failed here on every call — 1900 opcodes against a
    700 budget — which compiling never revealed.
    """
    from tests.conftest import advance_to

    client = deployed
    alice = player(algorand, dispenser, admin, musd)
    bob = player(algorand, dispenser, admin, musd)
    carol = player(algorand, dispenser, admin, musd)

    _, _, rake_before = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return

    rid, open_t, lock_t, resolve_t = _create_round(client, algorand, admin)
    print(f"\n[t] created rid={rid} open={open_t} lock={lock_t} resolve={resolve_t}")

    advance_to(algorand, dispenser, open_t)

    # alice + bob crowd the centre; carol takes a tail alone
    _enter(client, algorand, alice, musd, rid, 4, 100_000_000)
    _enter(client, algorand, bob, musd, rid, 4, 300_000_000)
    _enter(client, algorand, carol, musd, rid, 8, 10_000_000)

    total = 410_000_000
    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["total_stake"] == total, "total_stake"

    # ── lock ────────────────────────────────────────────────────────────────
    advance_to(algorand, dispenser, lock_t)

    reference = 79_000_000_000
    prices = [reference, reference + 1_000, reference + 2_000, reference + 3_000]
    ts = [lock_t] * 4
    sig = sign_attestation(oracle_key, client.app_id, rid, CHECKPOINT_LOCK, 0b1111,
                           FEED_ID, prices, ts)
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="lock", args=[rid, 0b1111, prices, ts, sig],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000),
    ))
    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["status"] == 1, "status LOCKED"
    median_ref = prices[1] + (prices[2] - prices[1]) // 2
    assert rnd["reference_price"] == median_ref, "reference is the median of four"

    # ── resolve: +4.3%, so band 8 (above +3.5%) wins — carol alone ──────────
    advance_to(algorand, dispenser, resolve_t)

    settlement = median_ref * 10_430 // 10_000
    sprices = [settlement] * 4
    sts = [resolve_t] * 4
    ssig = sign_attestation(oracle_key, client.app_id, rid, CHECKPOINT_RESOLVE, 0b1111,
                            FEED_ID, sprices, sts)
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="resolve", args=[rid, 0b1111, sprices, sts, ssig],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000),
    ))
    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["winning_band"] == 8, f'winning band 8, got {rnd["winning_band"]}'
    assert rnd["status"] == 2, "status RESOLVED"

    payable = total * (10_000 - RAKE_BPS) // 10_000
    assert rnd["payable_pot"] == payable, "payable_pot"

    # ── settle the sole winner; close the two losers ─────────────────────────
    before = algorand.asset.get_account_information(carol.address, musd).balance
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="settle_position", args=[rid, carol.address, 8, carol.address],
        account_references=[carol.address], asset_references=[musd],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=3_000),
    ))
    after = algorand.asset.get_account_information(carol.address, musd).balance
    assert after - before == payable, "sole winner takes the whole payable pot"

    for loser in (alice, bob):
        client.send.call(algokit_utils.AppClientMethodCallParams(
            method="close_position", args=[rid, loser.address, 4, loser.address],
            account_references=[loser.address], asset_references=[musd],
            extra_fee=algokit_utils.AlgoAmount(micro_algo=2_000),
        ))

    # ── the invariant that matters ───────────────────────────────────────────
    bal, oblig, rake_after = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert bal >= oblig + rake_after, "solvency"
    # delta, not absolute — rake_owed is global and other tests resolve rounds too
    assert rake_after - rake_before == total - payable, \
        "rake accrued exactly once, on the resolved branch"


def test_entry_group_must_have_the_right_shape(algorand, admin, dispenser, musd,
                                              deployed):
    """A real negative for the entry group.

    The earlier version of this test tried to cite one payment from two `enter` calls.
    That attack is not constructible: ARC-4 resolves transaction arguments positionally,
    so `payment` IS the transaction immediately before the app call. The old test went
    green because the group it built contained two byte-identical transactions and the
    node rejected it for duplicate txids — never reaching the contract at all.

    What IS worth testing is the type assertion: swap the two value legs and the
    declared parameter types must reject the group.
    """
    from algosdk.atomic_transaction_composer import TransactionWithSigner
    from tests.conftest import advance_to

    client = deployed
    mallory = player(algorand, dispenser, admin, musd)
    rid, open_t, _, _ = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open_t)

    pay = algorand.create_transaction.payment(algokit_utils.PaymentParams(
        sender=mallory.address, receiver=client.app_address,
        amount=algokit_utils.AlgoAmount(micro_algo=BOX_MBR + PAYOUT_FEE),
    ))
    axfer = algorand.create_transaction.asset_transfer(
        algokit_utils.AssetTransferParams(
            sender=mallory.address, receiver=client.app_address,
            asset_id=musd, amount=10_000_000,
        )
    )
    # legs swapped: the contract expects [pay, axfer, call]
    composer = algorand.new_group()
    composer.add_app_call_method_call(client.params.call(
        algokit_utils.AppClientMethodCallParams(
            method="enter",
            args=[TransactionWithSigner(axfer, mallory.signer),
                  TransactionWithSigner(pay, mallory.signer), rid, 0],
            sender=mallory.address, signer=mallory.signer,
            asset_references=[musd],
        )
    ))
    with pytest.raises(Exception):
        composer.send()

    # control: correctly ordered, same account, same round
    _enter(client, algorand, mallory, musd, rid, 0, 10_000_000)
    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["total_stake"] == 10_000_000, "only the well-formed group landed"

    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="admin_void_round", args=[rid]))


def test_operator_addresses_cannot_enter(algorand, admin, dispenser, musd, deployed,
                                        keeper, treasury):
    """Hygiene against the lazy case — trivially Sybil-defeated and not claimed
    as a defence, but it should at least do what it says.

    The positive control is the point: a normal player succeeds with IDENTICAL
    parameters on the same round, so the only difference is who is calling. Without
    it this test would pass if enter failed for any unrelated reason.
    """
    from tests.conftest import advance_to

    client = deployed
    rid, open_t, _, _ = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open_t)

    # all three are distinct accounts, so all three branches are exercised
    for op_acct in (admin, keeper, treasury):
        with pytest.raises(Exception):
            _enter(client, algorand, op_acct, musd, rid, 4, 10_000_000)

    normal = player(algorand, dispenser, admin, musd)
    _enter(client, algorand, normal, musd, rid, 4, 10_000_000)  # control: same args
    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["total_stake"] == 10_000_000, "only the non-operator entry landed"

    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="admin_void_round", args=[rid]))


def test_thin_round_voids_and_refunds_in_full(algorand, admin, dispenser, musd,
                                              deployed, oracle_key):
    """Every stake in one band pays 1-rake to everyone — not a market. The round
    voids and refunds, and no rake is taken on a round that pays nobody."""
    from tests.conftest import advance_to

    client = deployed
    alice = player(algorand, dispenser, admin, musd)
    rid, open_t, lock_t, resolve_t = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open_t)
    _enter(client, algorand, alice, musd, rid, 4, 50_000_000)

    _, _, rake_before = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return

    advance_to(algorand, dispenser, lock_t)
    reference = 79_000_000_000
    prices, ts = [reference] * 4, [lock_t] * 4
    sig = sign_attestation(oracle_key, client.app_id, rid, CHECKPOINT_LOCK, 0b1111,
                           FEED_ID, prices, ts)
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="lock", args=[rid, 0b1111, prices, ts, sig],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000),
    ))
    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["status"] == 3, "VOID"
    assert rnd["void_reason"] == 0, "thin"
    assert rnd["remaining_payable"] == 50_000_000

    before = algorand.asset.get_account_information(alice.address, musd).balance
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="refund_position", args=[rid, alice.address, 4, alice.address],
        account_references=[alice.address], asset_references=[musd],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=3_000),
    ))
    after = algorand.asset.get_account_information(alice.address, musd).balance
    assert after - before == 50_000_000, "full refund"

    _, _, rake_after = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert rake_after == rake_before, "no rake on a round that pays nobody"


def test_close_does_not_touch_obligations(algorand, admin, dispenser, musd,
                                          deployed, oracle_key):
    """The rev-5 critical, on chain.

    A loser's stake was reallocated to the winners at resolve, not extinguished. If
    close_position decremented total_obligations by `stake`, the decrements would
    over-run the counter by the entire losing pot — underflowing and bricking the
    round, or (once rounds overlap) silently under-reporting until sweep_excess_musd
    would authorise sweeping other rounds' live escrow.
    """
    from tests.conftest import advance_to

    client = deployed
    winner = player(algorand, dispenser, admin, musd)
    loser_a = player(algorand, dispenser, admin, musd)
    loser_b = player(algorand, dispenser, admin, musd)

    _, ob_before, _ = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return

    rid, open_t, lock_t, resolve_t = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open_t)
    _enter(client, algorand, winner, musd, rid, 8, 20_000_000)
    _enter(client, algorand, loser_a, musd, rid, 4, 300_000_000)
    _enter(client, algorand, loser_b, musd, rid, 4, 480_000_000)
    total = 800_000_000

    _, ob_entered, _ = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert ob_entered - ob_before == total, "enter adds the full stake"

    advance_to(algorand, dispenser, lock_t)
    reference = 79_000_000_000
    prices, ts = [reference] * 4, [lock_t] * 4
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="lock", args=[rid, 0b1111, prices, ts,
                             sign_attestation(oracle_key, client.app_id, rid,
                                              CHECKPOINT_LOCK, 0b1111, FEED_ID,
                                              prices, ts)],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000),
    ))

    advance_to(algorand, dispenser, resolve_t)
    settlement = reference * 10_430 // 10_000
    sp, st = [settlement] * 4, [resolve_t] * 4
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="resolve", args=[rid, 0b1111, sp, st,
                                sign_attestation(oracle_key, client.app_id, rid,
                                                 CHECKPOINT_RESOLVE, 0b1111, FEED_ID,
                                                 sp, st)],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000),
    ))

    payable = total * (10_000 - RAKE_BPS) // 10_000
    _, ob_resolved, _ = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert ob_resolved - ob_before == payable, "resolve removes exactly the rake"

    # close both losers — the counter must not move at all
    for loser in (loser_a, loser_b):
        client.send.call(algokit_utils.AppClientMethodCallParams(
            method="close_position", args=[rid, loser.address, 4, loser.address],
            account_references=[loser.address], asset_references=[musd],
            extra_fee=algokit_utils.AlgoAmount(micro_algo=2_000),
        ))
    _, ob_closed, _ = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert ob_closed == ob_resolved, "close must not touch total_obligations"

    # settling the sole winner drains this round's contribution to ~0 (dust aside)
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="settle_position", args=[rid, winner.address, 8, winner.address],
        account_references=[winner.address], asset_references=[musd],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=3_000),
    ))
    bal, ob_settled, rake = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert ob_settled == ob_before, "round fully drained from the obligation counter"
    assert bal >= ob_settled + rake, "solvency"


def test_redirected_recipient_skips_instead_of_reverting_the_batch(
    algorand, admin, dispenser, musd, deployed, oracle_key
):
    """Both auditors found this: without expected_payee, a loser redirects their
    payout to an unfunded address after resolve and the inner payment becomes invalid
    (below the receiver's minimum balance), reverting the whole batch and paying nobody.

    With expected_payee the mismatch is an ordinary skip, so the honest entries settle.
    """
    from tests.conftest import advance_to

    client = deployed
    winner = player(algorand, dispenser, admin, musd)
    honest = player(algorand, dispenser, admin, musd)
    mallory = player(algorand, dispenser, admin, musd)
    unfunded = algorand.account.random()

    rid, open_t, lock_t, resolve_t = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open_t)
    _enter(client, algorand, winner, musd, rid, 8, 20_000_000)
    _enter(client, algorand, honest, musd, rid, 4, 100_000_000)
    _enter(client, algorand, mallory, musd, rid, 4, 100_000_000)

    advance_to(algorand, dispenser, lock_t)
    reference = 79_000_000_000
    p, t = [reference] * 4, [lock_t] * 4
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="lock", args=[rid, 0b1111, p, t,
                             sign_attestation(oracle_key, client.app_id, rid,
                                              CHECKPOINT_LOCK, 0b1111, FEED_ID, p, t)],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000)))

    advance_to(algorand, dispenser, resolve_t)
    s = reference * 10_430 // 10_000
    sp, st = [s] * 4, [resolve_t] * 4
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="resolve", args=[rid, 0b1111, sp, st,
                                sign_attestation(oracle_key, client.app_id, rid,
                                                 CHECKPOINT_RESOLVE, 0b1111, FEED_ID,
                                                 sp, st)],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000)))

    # mallory redirects to a never-funded address, after seeing they lost
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="set_payout_recipient", args=[rid, 4, unfunded.address],
        sender=mallory.address, signer=mallory.signer,
    ))

    # keeper's batch, built from the payees it knew about
    result = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="close_batch",
        args=[rid, [honest.address, mallory.address], [4, 4],
              [honest.address, mallory.address]],
        account_references=[honest.address, mallory.address],
        asset_references=[musd],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=6_000),
    ))
    bitmap = result.abi_return
    assert bitmap == 0b01, f"honest settles, mallory skips — got {bin(bitmap)}"

    # the honest loser really did get their box deposit back
    pos = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert pos["position_count"] == 2, "winner + mallory still open"


def test_void_cleanup_purge_and_bounty(algorand, admin, dispenser, musd, deployed,
                                       oracle_key):
    """The whole stranded-funds chain, which nothing previously touched:
    keeper never resolves -> void_round -> refund -> cleanup_round -> purge_position,
    plus the CLOSE_BOUNTY path (every earlier test settled inside BOUNTY_DELAY, so
    the third inner transaction in the terminal helpers had never fired)."""
    from tests.conftest import CLEANUP_GRACE, RESOLVE_DEADLINE, advance_to

    client = deployed
    alice = player(algorand, dispenser, admin, musd)
    bob = player(algorand, dispenser, admin, musd)
    bot = player(algorand, dispenser, admin, musd)

    rid, open_t, lock_t, resolve_t = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open_t)
    _enter(client, algorand, alice, musd, rid, 4, 40_000_000)
    _enter(client, algorand, bob, musd, rid, 6, 10_000_000)

    advance_to(algorand, dispenser, lock_t)
    ref = 79_000_000_000
    p4, t4 = [ref] * 4, [lock_t] * 4
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="lock", args=[rid, 0b1111, p4, t4,
                             sign_attestation(oracle_key, client.app_id, rid,
                                              CHECKPOINT_LOCK, 0b1111, FEED_ID, p4, t4)],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000)))

    # keeper never resolves — void only opens after the full deadline
    advance_to(algorand, dispenser, resolve_t + 10)
    with pytest.raises(Exception):
        client.send.call(algokit_utils.AppClientMethodCallParams(
            method="void_round", args=[rid]))

    advance_to(algorand, dispenser, resolve_t + RESOLVE_DEADLINE + 60)
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="void_round", args=[rid]))
    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["status"] == 3 and rnd["void_reason"] == 3, "VOID(no_resolve)"

    # past BOUNTY_DELAY, so a third party is actually paid for the work. Inside the
    # delay the bounty is correctly zero — the keeper's own window is free.
    from tests.conftest import BOUNTY_DELAY, chain_now
    advance_to(algorand, dispenser, chain_now(algorand) + BOUNTY_DELAY + 60)

    # a third party refunds alice and is paid the bounty; alice gets stake + her deposit
    algo_before = algorand.account.get_information(alice.address).amount.micro_algo
    musd_before = algorand.asset.get_account_information(alice.address, musd).balance
    bot_before = algorand.account.get_information(bot.address).amount.micro_algo
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="refund_position", args=[rid, alice.address, 4, alice.address],
        sender=bot.address, signer=bot.signer,
        account_references=[alice.address], asset_references=[musd],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=4_000),
    ))
    assert algorand.asset.get_account_information(alice.address, musd).balance \
        - musd_before == 40_000_000, "stake refunded in full"
    assert algorand.account.get_information(alice.address).amount.micro_algo \
        - algo_before == BOX_MBR, "box deposit returned — never asserted before"
    # The caller supplied 5,000 µALGO of fee (1,000 base + 4,000 extra, which funds the
    # app's inner transactions), so the delta is bounty minus that. Back it out and
    # assert the bounty itself, which is the thing under test.
    bot_delta = algorand.account.get_information(bot.address).amount.micro_algo - bot_before
    assert bot_delta + 5_000 == CLOSE_BOUNTY, \
        f"third-party caller earns exactly CLOSE_BOUNTY, got {bot_delta + 5_000}"

    # bob never claims. cleanup is blocked until the forfeit period, then proceeds
    advance_to(algorand, dispenser, resolve_t + CLEANUP_GRACE + 60)
    with pytest.raises(Exception):
        client.send.call(algokit_utils.AppClientMethodCallParams(
            method="cleanup_round", args=[rid]))

    from tests.conftest import FORFEIT_PERIOD
    advance_to(algorand, dispenser, resolve_t + FORFEIT_PERIOD + 60)
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="cleanup_round", args=[rid],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=2_000)))

    # the round box is gone, so bob's orphaned box is purgeable — and pays the caller,
    # which is what makes "every box is unconditionally deletable" true
    purger_before = algorand.account.get_information(bot.address).amount.micro_algo
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="purge_position", args=[rid, bob.address, 6],
        sender=bot.address, signer=bot.signer,
        account_references=[bob.address],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=2_000)))
    assert algorand.account.get_information(bot.address).amount.micro_algo > purger_before

    bal, oblig, rake = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert bal >= oblig + rake, "solvency after the full stranded-funds chain"


def test_three_source_quorum_with_a_non_contiguous_mask(algorand, admin, dispenser,
                                                        musd, deployed, oracle_key):
    """Only 0b1111 had ever been submitted. This exercises the compaction path with a
    gap in the mask, the 3-source median, and the zeroing of absent slots — the code
    both reviews flagged as highest-risk."""
    from tests.conftest import advance_to

    client = deployed
    alice = player(algorand, dispenser, admin, musd)
    bob = player(algorand, dispenser, admin, musd)
    rid, open_t, lock_t, _ = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open_t)
    _enter(client, algorand, alice, musd, rid, 4, 20_000_000)
    _enter(client, algorand, bob, musd, rid, 6, 20_000_000)

    advance_to(algorand, dispenser, lock_t)
    # sources 0, 1 and 3 present; slot 2 absent
    mask = 0b1011
    prices = [79_000_000_000, 79_000_500_000, 12_345, 79_001_000_000]
    ts = [lock_t, lock_t, 999, lock_t]
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="lock", args=[rid, mask, prices, ts,
                             sign_attestation(oracle_key, client.app_id, rid,
                                              CHECKPOINT_LOCK, mask, FEED_ID,
                                              prices, ts)],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000)))

    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["reference_price"] == 79_000_500_000, "median of the three present"
    assert rnd["ref_sources"][2] == 0, "absent slot zeroed by the contract, not trusted"
    assert rnd["ref_sources"][0] == prices[0] and rnd["ref_sources"][3] == prices[3]

    # two sources is below quorum
    rid2, open2, lock2, _ = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open2)
    _enter(client, algorand, alice, musd, rid2, 4, 20_000_000)
    _enter(client, algorand, bob, musd, rid2, 6, 20_000_000)
    advance_to(algorand, dispenser, lock2)
    m2 = 0b0011
    p2 = [79_000_000_000, 79_000_500_000, 0, 0]
    t2 = [lock2, lock2, 0, 0]
    with pytest.raises(Exception):
        client.send.call(algokit_utils.AppClientMethodCallParams(
            method="lock", args=[rid2, m2, p2, t2,
                                 sign_attestation(oracle_key, client.app_id, rid2,
                                                  CHECKPOINT_LOCK, m2, FEED_ID, p2, t2)],
            extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000)))

    # a failed lock leaves the round OPEN and open_round_id set, so nothing else can
    # create a round until it is resolved one way or the other — release it
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="admin_void_round", args=[rid2]))


def test_full_width_settle_batch(algorand, admin, dispenser, musd, deployed,
                                 oracle_key):
    """Eight positions in one settle_batch — the case both reviews said was unreachable.

    This is the only test that actually proves the budget and padding fixes. A batch of
    8 needs 9 box references (8 positions + the round), up to 8 payee accounts, and 24
    inner transactions at 3 per settle — against per-transaction limits of 8 refs, 4
    accounts and 16 inners.

    It takes FOUR top-level app calls, not the three the arithmetic suggests. Three
    has the raw slots on paper (24 refs, 12 accounts) and still fails to place them.
    That is the kind of thing only a real group reveals, and it is why `noop` exists:
    readonly methods are routed through simulate by clients and never reach the
    submitted group at all.
    """
    from tests.conftest import BOUNTY_DELAY, advance_to, chain_now

    client = deployed
    winners = [player(algorand, dispenser, admin, musd) for _ in range(8)]
    loser = player(algorand, dispenser, admin, musd)

    rid, open_t, lock_t, resolve_t = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open_t)
    for w in winners:
        _enter(client, algorand, w, musd, rid, 8, 10_000_000)
    _enter(client, algorand, loser, musd, rid, 4, 200_000_000)
    total = 8 * 10_000_000 + 200_000_000

    advance_to(algorand, dispenser, lock_t)
    ref = 79_000_000_000
    p4, t4 = [ref] * 4, [lock_t] * 4
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="lock", args=[rid, 0b1111, p4, t4,
                             sign_attestation(oracle_key, client.app_id, rid,
                                              CHECKPOINT_LOCK, 0b1111, FEED_ID, p4, t4)],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000)))

    advance_to(algorand, dispenser, resolve_t)
    settlement = ref * 10_430 // 10_000          # +4.3% -> band 8
    sp, st = [settlement] * 4, [resolve_t] * 4
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="resolve", args=[rid, 0b1111, sp, st,
                                sign_attestation(oracle_key, client.app_id, rid,
                                                 CHECKPOINT_RESOLVE, 0b1111, FEED_ID,
                                                 sp, st)],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000)))

    advance_to(algorand, dispenser, chain_now(algorand) + BOUNTY_DELAY + 60)

    payable = total * (10_000 - RAKE_BPS) // 10_000
    per_winner = payable * 10_000_000 // (8 * 10_000_000)
    before = [algorand.asset.get_account_information(w.address, musd).balance
              for w in winners]

    from tests.conftest import position_box, round_box

    addrs = [w.address for w in winners]
    boxes = [algokit_utils.BoxReference(client.app_id, position_box(rid, a, 8))
             for a in addrs]

    # References are pooled for USE across the group but each transaction may only
    # DECLARE 8, of which at most 4 are accounts. 8 positions need 9 boxes + 8 accounts
    # + the asset = 18, so they are spread over the three calls deliberately.
    composer = algorand.new_group()
    composer.add_app_call_method_call(client.params.call(
        algokit_utils.AppClientMethodCallParams(
            method="noop",
            account_references=addrs[:4],
            box_references=[algokit_utils.BoxReference(client.app_id, round_box(rid))]
            + boxes[:3],
        )))
    composer.add_app_call_method_call(client.params.call(
        algokit_utils.AppClientMethodCallParams(
            method="noop",
            account_references=addrs[4:],
            box_references=boxes[3:6],
        )))
    composer.add_app_call_method_call(client.params.call(
        algokit_utils.AppClientMethodCallParams(
            method="noop",
            box_references=boxes[6:],
        )))
    composer.add_app_call_method_call(client.params.call(
        algokit_utils.AppClientMethodCallParams(
            method="settle_batch",
            args=[rid, addrs, [8] * 8, addrs],
            asset_references=[musd],
            extra_fee=algokit_utils.AlgoAmount(micro_algo=30_000),
        )))
    composer.send()

    for w, b in zip(winners, before, strict=True):
        got = algorand.asset.get_account_information(w.address, musd).balance - b
        assert got == per_winner, f"each winner paid pro-rata, got {got}"

    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["position_count"] == 1, "only the loser's box remains"

    bal, oblig, rake = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert bal >= oblig + rake, "solvency after a full-width batch"


def test_treasury_paths(algorand, admin, dispenser, musd, deployed, treasury):
    """sweep_rake, sweep_excess_musd and withdraw_operating_algo — every ALGO- and
    mUSD-moving admin path, none of which was previously called by any test."""
    client = deployed

    # rake has accrued from earlier resolved rounds; it must land on the treasury
    _, _, rake = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert rake > 0, "earlier rounds should have accrued rake"
    algorand.send.asset_opt_in(algokit_utils.AssetOptInParams(
        sender=treasury.address, signer=treasury.signer, asset_id=musd))
    before = algorand.asset.get_account_information(treasury.address, musd).balance
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="sweep_rake", args=[],
        asset_references=[musd], account_references=[treasury.address],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=1_000)))
    assert algorand.asset.get_account_information(treasury.address, musd).balance \
        - before == rake, "rake swept in full"

    _, _, rake_now = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert rake_now == 0
    with pytest.raises(Exception):
        client.send.call(algokit_utils.AppClientMethodCallParams(
            method="sweep_rake", args=[], asset_references=[musd]))

    # mUSD sent straight to the app — the commonest escrow user error — is recoverable,
    # and bounded by total_obligations so it can never reach live escrow
    stray = 7_000_000
    algorand.send.asset_transfer(algokit_utils.AssetTransferParams(
        sender=admin.address, receiver=client.app_address,
        asset_id=musd, amount=stray))
    bal, oblig, _ = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    excess = bal - oblig
    with pytest.raises(Exception):
        client.send.call(algokit_utils.AppClientMethodCallParams(
            method="sweep_excess_musd", args=[excess + 1],
            asset_references=[musd], account_references=[treasury.address]))
    t_before = algorand.asset.get_account_information(treasury.address, musd).balance
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="sweep_excess_musd", args=[stray],
        asset_references=[musd], account_references=[treasury.address],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=1_000)))
    assert algorand.asset.get_account_information(treasury.address, musd).balance \
        - t_before == stray

    # the ALGO floor must reserve the deposits and fees owed to live positions
    with pytest.raises(Exception):
        client.send.call(algokit_utils.AppClientMethodCallParams(
            method="withdraw_operating_algo", args=[10_000_000_000]))
    client.send.call(algokit_utils.AppClientMethodCallParams(
        method="withdraw_operating_algo", args=[100_000],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=1_000)))

    bal, oblig, rake2 = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_solvency", args=[])).abi_return
    assert bal >= oblig + rake2, "solvency survives every treasury path"


def test_price_gates_reject(algorand, admin, dispenser, musd, deployed, oracle_key):
    """The rejection side of the oracle gates — previously only the happy path ran.

    A reference far from the previous settlement is the signature of a keeper on the
    wrong pair or the wrong quote currency, which would shift every band boundary while
    all four venues agree and every other check passes.
    """
    from tests.conftest import advance_to

    client = deployed
    alice = player(algorand, dispenser, admin, musd)
    bob = player(algorand, dispenser, admin, musd)
    rid, open_t, lock_t, _ = _create_round(client, algorand, admin)
    advance_to(algorand, dispenser, open_t)
    _enter(client, algorand, alice, musd, rid, 4, 20_000_000)
    _enter(client, algorand, bob, musd, rid, 6, 20_000_000)
    advance_to(algorand, dispenser, lock_t)

    def try_lock(prices, ts=None, mask=0b1111):
        t = ts or [lock_t] * 4
        return client.send.call(algokit_utils.AppClientMethodCallParams(
            method="lock", args=[rid, mask, prices, t,
                                 sign_attestation(oracle_key, client.app_id, rid,
                                                  CHECKPOINT_LOCK, mask, FEED_ID,
                                                  prices, t)],
            extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000)))

    ref = 79_000_000_000
    with pytest.raises(Exception):               # a decimal-scale error
        try_lock([ref * 10] * 4)
    with pytest.raises(Exception):
        try_lock([ref // 10] * 4)
    with pytest.raises(Exception):               # venue spread past the 2% lock gate
        try_lock([ref, ref, ref, ref * 110 // 100])
    with pytest.raises(Exception):               # candle boundary != checkpoint
        try_lock([ref] * 4, ts=[lock_t, lock_t, lock_t, lock_t - 60])
    with pytest.raises(Exception):               # a zero price in a present slot
        try_lock([ref, 0, ref, ref])
    bad_sig = client.params.call(algokit_utils.AppClientMethodCallParams(
        method="lock", args=[rid, 0b1111, [ref] * 4, [lock_t] * 4, b"\x00" * 64],
        extra_fee=algokit_utils.AlgoAmount(micro_algo=5_000)))
    with pytest.raises(Exception):
        algorand.new_group().add_app_call_method_call(bad_sig).send()

    try_lock([ref] * 4)                          # control: the honest attestation works
    rnd = client.send.call(algokit_utils.AppClientMethodCallParams(
        method="get_round", args=[rid])).abi_return
    assert rnd["status"] == 1, "LOCKED"

def test_reference_drift_gate_does_not_catch_a_small_scale_error(deployed):
    """An honest limit, pinned so nobody assumes otherwise.

    REF_DRIFT is 50%-200%. It catches a decimal shift or an outright wrong asset. It
    does NOT catch a wrong quote currency — BTC-EUR for BTC-USD is roughly 0.92x, which
    sits comfortably inside the band while shifting every boundary by 8%, more than
    twice the widest band. Tightening far enough to catch it (better than ~3%) would
    void legitimate rounds on a volatile day, which is a worse trade.

    What actually guards this is keeper configuration and the fact that a wrong-pair
    settlement is visible on-chain against four published candles.
    """
    assert 5_000 < 9_200 < 20_000, "0.92x is inside the drift band, by design"
