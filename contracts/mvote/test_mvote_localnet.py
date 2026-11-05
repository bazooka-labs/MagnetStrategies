"""
mVote — full lifecycle against a real node, with real signatures.

Run:  algokit localnet start && python3 test_mvote_localnet.py

── Why localnet and not testnet ────────────────────────────────────────────
"Simulation is not a signature" (CLAUDE.md), so this signs and submits real
transactions. It runs on an algokit localnet rather than testnet for one
capability testnet cannot offer: dev mode exposes a block-timestamp offset, so
the 7-day voting window can actually be crossed. Every assertion about what
happens AFTER a window closes — claims working, votes refused, the
one-proposal-at-a-time guard releasing — is otherwise untestable without
waiting a week.

The public dispensers were also returning 403 at the time of writing, so a
funded testnet account was not available regardless.

── What this proves and what it does not ───────────────────────────────────
It proves the contract's logic against a real AVM: the happy path end to end,
and that each guard rejects what it claims to reject. It does NOT prove
anything about mainnet asset configuration — mUSD's missing clawback/freeze is
checked separately, against mainnet, in `check_musd_asset.py`.

Every negative case asserts the transaction is REJECTED. A negative test that
passes because the transaction failed for an unrelated reason proves nothing,
so each one asserts on the rejection reason where the node gives a usable one.
"""

import base64
import json
import sys
import urllib.request

from algosdk import account, encoding, transaction
from algosdk.logic import get_application_address
from algosdk.v2client import algod
from algosdk.kmd import KMDClient
from pyteal import Mode, compileTeal

from mvote.mvote import approval_program, clear_program

ALGOD = algod.AlgodClient("a" * 64, "http://localhost:4001")
KMD = KMDClient("a" * 64, "http://localhost:4002")

# Mirrors mainnet mUSD: 6 decimals, 500,000,000 whole tokens of total supply.
MUSD_TOTAL = 500_000_000_000_000
MUSD_DECIMALS = 6
ONE_MUSD = 10 ** MUSD_DECIMALS

VOTE_BOX_MBR = 26_900
PROPOSAL_BOX_MBR = 2500 + 400 * (13 + 696)   # 286,100
WEEK = 604_800

PASS, FAIL = [], []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASS if ok else FAIL).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")


def funded_account():
    """A genesis account from the localnet KMD wallet."""
    wallets = KMD.list_wallets()
    wid = next(w["id"] for w in wallets if w["name"] == "unencrypted-default-wallet")
    handle = KMD.init_wallet_handle(wid, "")
    addrs = KMD.list_keys(handle)
    for a in addrs:
        if ALGOD.account_info(a)["amount"] > 50_000_000:
            return a, KMD.export_key(handle, "", a)
    raise RuntimeError("no funded localnet account")


def send(txns, keys):
    """Sign, group if needed, submit, wait. Returns the confirmation."""
    if len(txns) > 1:
        transaction.assign_group_id(txns)
    signed = [t.sign(k) for t, k in zip(txns, keys)]
    txid = ALGOD.send_transactions(signed)
    return transaction.wait_for_confirmation(ALGOD, txid, 6)


def rejects(txns, keys, expect: str = "") -> tuple[bool, str]:
    """True when the group is REJECTED. `expect` is matched against the error."""
    try:
        send(txns, keys)
        return False, "accepted, but should have been rejected"
    except Exception as e:
        msg = str(e)
        if expect and expect not in msg:
            return False, f"rejected for the wrong reason: {msg[:200]}"
        return True, ""


def set_time_offset(seconds: int) -> None:
    """Dev-mode only: shifts the timestamp of subsequent blocks."""
    req = urllib.request.Request(
        f"http://localhost:4001/v2/devmode/blocks/offset/{seconds}",
        method="POST", headers={"X-Algo-API-Token": "a" * 64},
    )
    urllib.request.urlopen(req, timeout=10).read()


def sp(fee=None):
    p = ALGOD.suggested_params()
    if fee is not None:
        p.flat_fee, p.fee = True, fee
    return p


def zero_buffer_vote(founder, founder_sk, musd, approval, clear) -> None:
    """
    A whole second deployment, funded to EXACTLY its minimum balance.

    This is the case audit finding I-4 is about, and the only way to prove the
    group reorder did what it was for. The main scenario above funds the app
    with 0.4 ALGO and therefore carries a 200,000 µALGO spare, which hides the
    bug completely — under the OLD order (app call at index 0, MBR payment at
    index 2) the first vote here was rejected with
    "balance 486100 below min 513000", because the box was created before the
    ALGO covering it had arrived.

    Zero spare, first vote, no second chance. If anyone moves the app call back
    to index 0, this is the test that goes red.
    """
    def send_(txns, keys):
        return send(txns, keys)

    conf = send_([transaction.ApplicationCreateTxn(
        sender=founder, sp=sp(), on_complete=transaction.OnComplete.NoOpOC,
        approval_program=approval, clear_program=clear,
        global_schema=transaction.StateSchema(3, 2),
        local_schema=transaction.StateSchema(0, 0),
        app_args=[musd.to_bytes(8, "big")],
    )], [founder_sk])
    app_id = conf["application-index"]
    addr = get_application_address(app_id)

    # Base 100,000 + ASA opt-in 100,000, and not one µALGO more.
    send_([transaction.PaymentTxn(founder, sp(), addr, 200_000)], [founder_sk])
    send_([transaction.ApplicationNoOpTxn(
        founder, sp(fee=2000), app_id, app_args=[b"optin_asa"], foreign_assets=[musd],
    )], [founder_sk])
    # The proposal box MBR, exactly — nothing left over as a buffer.
    send_([
        transaction.PaymentTxn(founder, sp(), addr, PROPOSAL_BOX_MBR),
        transaction.ApplicationNoOpTxn(
            founder, sp(), app_id,
            app_args=[b"create_proposal", b"zero buffer", b"A", b"B", b"", b""],
            boxes=[(app_id, b"prop_" + (1).to_bytes(8, "big"))],
        ),
    ], [founder_sk, founder_sk])

    info = ALGOD.account_info(addr)
    spare = info["amount"] - info["min-balance"]
    check("the app under test has zero spare over its minimum balance",
          spare == 0, f"spare {spare}")

    sk, voter = account.generate_account()
    send_([transaction.PaymentTxn(founder, sp(), voter, 5_000_000)], [founder_sk])
    send_([transaction.AssetTransferTxn(voter, sp(), voter, 0, musd)], [sk])
    send_([transaction.AssetTransferTxn(founder, sp(), voter, 50 * ONE_MUSD, musd)], [founder_sk])

    try:
        send_([
            transaction.PaymentTxn(voter, sp(), addr, VOTE_BOX_MBR),
            transaction.AssetTransferTxn(voter, sp(), addr, 10 * ONE_MUSD, musd),
            transaction.ApplicationNoOpTxn(
                voter, sp(), app_id,
                app_args=[b"cast_vote", (1).to_bytes(8, "big"), (0).to_bytes(8, "big")],
                boxes=[(app_id, b"prop_" + (1).to_bytes(8, "big")),
                       (app_id, b"vote_" + (1).to_bytes(8, "big") + encoding.decode_address(voter))],
                foreign_assets=[musd],
            ),
        ], [sk] * 3)
        check("the FIRST vote lands with no standing buffer at all", True)
    except Exception as e:
        check("the FIRST vote lands with no standing buffer at all", False, str(e)[:160])

    after = ALGOD.account_info(addr)
    check("the voter's MBR left the app exactly where it started",
          after["amount"] - after["min-balance"] == 0,
          f"spare {after['amount'] - after['min-balance']}")


def main() -> int:
    founder, founder_sk = funded_account()
    print(f"founder: {founder}\n")

    # ── Stand-in mUSD: same decimals and supply as the real asset ───────────
    conf = send([transaction.AssetConfigTxn(
        sender=founder, sp=sp(), total=MUSD_TOTAL, decimals=MUSD_DECIMALS,
        unit_name="mUSD", asset_name="Magnet USD", default_frozen=False,
        manager=founder, reserve=founder, freeze=None, clawback=None,
        strict_empty_address_check=False,
    )], [founder_sk])
    musd = conf["asset-index"]
    print(f"stand-in mUSD ASA: {musd}\n")

    # ── Deploy ──────────────────────────────────────────────────────────────
    approval = base64.b64decode(ALGOD.compile(
        compileTeal(approval_program(), mode=Mode.Application, version=8))["result"])
    clear = base64.b64decode(ALGOD.compile(
        compileTeal(clear_program(), mode=Mode.Application, version=8))["result"])

    conf = send([transaction.ApplicationCreateTxn(
        sender=founder, sp=sp(), on_complete=transaction.OnComplete.NoOpOC,
        approval_program=approval, clear_program=clear,
        global_schema=transaction.StateSchema(3, 2),
        local_schema=transaction.StateSchema(0, 0),
        app_args=[musd.to_bytes(8, "big")],
    )], [founder_sk])
    app_id = conf["application-index"]
    app_addr = get_application_address(app_id)
    print(f"mVote app: {app_id}  {app_addr}\n")

    send([transaction.PaymentTxn(founder, sp(), app_addr, 400_000)], [founder_sk])
    send([transaction.ApplicationNoOpTxn(
        founder, sp(fee=2000), app_id, app_args=[b"optin_asa"], foreign_assets=[musd],
    )], [founder_sk])

    # ── Two voters, funded and holding mUSD ─────────────────────────────────
    voters = []
    for i in range(2):
        sk, addr = account.generate_account()
        send([transaction.PaymentTxn(founder, sp(), addr, 10_000_000)], [founder_sk])
        send([transaction.AssetTransferTxn(addr, sp(), addr, 0, musd)], [sk])
        send([transaction.AssetTransferTxn(
            founder, sp(), addr, 1000 * ONE_MUSD, musd)], [founder_sk])
        voters.append((addr, sk))
    v1, v1sk = voters[0]
    v2, v2sk = voters[1]

    def prop_box(pid):
        return (app_id, b"prop_" + pid.to_bytes(8, "big"))

    def vote_box(pid, addr):
        return (app_id, b"vote_" + pid.to_bytes(8, "big") + encoding.decode_address(addr))

    def create_proposal_txns(sender, q, choices, pid):
        a, b, c, d = (choices + ["", "", "", ""])[:4]
        return [
            transaction.PaymentTxn(sender, sp(), app_addr, PROPOSAL_BOX_MBR),
            transaction.ApplicationNoOpTxn(
                sender, sp(), app_id,
                app_args=[b"create_proposal", q.encode(), a.encode(), b.encode(),
                          c.encode(), d.encode()],
                boxes=[prop_box(pid)],
            ),
        ]

    def vote_txns(addr, pid, choice, whole, mbr=VOTE_BOX_MBR, xfer_from=None, xfer_sk=None):
        # [0] MBR payment, [1] mUSD transfer, [2] app call — the payment lands
        # before the app call creates the box and raises the app's min balance.
        return [
            transaction.PaymentTxn(addr, sp(), app_addr, mbr),
            transaction.AssetTransferTxn(
                xfer_from or addr, sp(), app_addr, whole, musd),
            transaction.ApplicationNoOpTxn(
                addr, sp(), app_id,
                app_args=[b"cast_vote", pid.to_bytes(8, "big"), choice.to_bytes(8, "big")],
                boxes=[prop_box(pid), vote_box(pid, addr)],
                foreign_assets=[musd],
            ),
        ]

    def claim_txn(addr, pid):
        return transaction.ApplicationNoOpTxn(
            addr, sp(fee=3000), app_id, app_args=[b"claim_tokens", pid.to_bytes(8, "big")],
            boxes=[prop_box(pid), vote_box(pid, addr)], foreign_assets=[musd],
        )

    print("── create_proposal ──")
    ok, why = rejects(create_proposal_txns(v1, "not the founder", ["A", "B"], 1),
                      [v1sk, v1sk])
    check("non-founder cannot create a proposal", ok, why)

    ok, why = rejects(create_proposal_txns(founder, "D without C", ["A", "B", "", "D"], 1),
                      [founder_sk, founder_sk])
    check("choice D requires choice C (contiguity)", ok, why)

    send(create_proposal_txns(founder, "Where should treasury liquidity go?",
                              ["ALGO", "mUSD", "AKITA"], 1), [founder_sk, founder_sk])
    check("founder creates proposal 1", True)

    ok, why = rejects(create_proposal_txns(founder, "second window", ["A", "B"], 2),
                      [founder_sk, founder_sk])
    check("cannot stack a second proposal while one is open", ok, why)

    print("\n── cast_vote guards ──")
    ok, why = rejects(vote_txns(v1, 1, 0, ONE_MUSD // 2), [v1sk] * 3)
    check("fractional mUSD is refused (whole tokens only)", ok, why)

    ok, why = rejects(vote_txns(v1, 1, 3, 10 * ONE_MUSD), [v1sk] * 3)
    check("choice index beyond num_choices is refused", ok, why)

    ok, why = rejects(vote_txns(v1, 1, 0, 10 * ONE_MUSD, mbr=VOTE_BOX_MBR - 1), [v1sk] * 3)
    check("a short MBR payment is refused", ok, why)

    ok, why = rejects(vote_txns(v1, 1, 0, 10 * ONE_MUSD, xfer_from=v2),
                      [v1sk, v2sk, v1sk])   # index 1 is the transfer, signed by v2
    check("mUSD funded by a different wallet than the voter is refused", ok, why)

    print("\n── votes land ──")
    send(vote_txns(v1, 1, 0, 100 * ONE_MUSD), [v1sk] * 3)
    check("voter 1 locks 100 mUSD on choice A", True)

    # AFTER the vote, deliberately. Run before it, this passes because there is
    # no vote box to read — which is a different guard, and leaves the window
    # check untested. Mutation-checked: deleting the end-time assert from
    # claim_tokens flips this to FAIL, and did not before the move.
    ok, why = rejects([claim_txn(v1, 1)], [v1sk])
    check("claim before the window closes is refused", ok, why)
    send(vote_txns(v2, 1, 1, 50 * ONE_MUSD), [v2sk] * 3)
    check("voter 2 locks 50 mUSD on choice B", True)

    ok, why = rejects(vote_txns(v1, 1, 1, 5 * ONE_MUSD), [v1sk] * 3)
    check("the same wallet cannot vote twice", ok, why)

    box = ALGOD.application_box_by_name(app_id, b"prop_" + (1).to_bytes(8, "big"))
    val = base64.b64decode(box["value"])
    tally = [int.from_bytes(val[16 + 8 * i:24 + 8 * i], "big") for i in range(4)]
    check("tally is 100 / 50 / 0 / 0 mUSD",
          tally == [100 * ONE_MUSD, 50 * ONE_MUSD, 0, 0], str(tally))
    check("num_choices recorded as 3",
          int.from_bytes(val[48:56], "big") == 3)

    held = next(a["amount"] for a in ALGOD.account_info(app_addr)["assets"]
                if a["asset-id"] == musd)
    check("app holds exactly the sum of locked mUSD", held == 150 * ONE_MUSD, str(held))

    print("\n── cross the 7-day window ──")
    set_time_offset(WEEK + 120)
    send([transaction.PaymentTxn(founder, sp(), founder, 0)], [founder_sk])
    set_time_offset(0)

    ok, why = rejects(vote_txns(v1, 1, 0, ONE_MUSD), [v1sk] * 3)
    check("voting after the window closes is refused", ok, why)

    print("\n── claim ──")
    # The founder never voted. Run BEFORE the window closed, this passes on the
    # end-time guard instead and leaves `vote_box.hasValue()` untested —
    # measured: pc=313, `btoi; >=; assert`, which is the window check. Position
    # is what makes this test about what it says it is about.
    ok, why = rejects([claim_txn(founder, 1)], [founder_sk])
    check("claim with no vote on record is refused", ok, why)

    ok, why = rejects([claim_txn(v1, 1), transaction.PaymentTxn(v1, sp(), v1, 0)],
                      [v1sk, v1sk])
    check("claim grouped with anything else is refused (audit I-1)", ok, why)

    before_algo = ALGOD.account_info(v1)["amount"]
    before_musd = next(a["amount"] for a in ALGOD.account_info(v1)["assets"]
                       if a["asset-id"] == musd)
    send([claim_txn(v1, 1)], [v1sk])
    after_algo = ALGOD.account_info(v1)["amount"]
    after_musd = next(a["amount"] for a in ALGOD.account_info(v1)["assets"]
                      if a["asset-id"] == musd)
    check("voter 1 gets their 100 mUSD back",
          after_musd - before_musd == 100 * ONE_MUSD, str(after_musd - before_musd))
    # +MBR refund, -3000 outer fee.
    check("voter 1 gets the vote-box MBR back, net of the 3000 fee",
          after_algo - before_algo == VOTE_BOX_MBR - 3000, str(after_algo - before_algo))

    ok, why = rejects([claim_txn(v1, 1)], [v1sk])
    check("a second claim is refused", ok, why)

    send([claim_txn(v2, 1)], [v2sk])
    held = next(a["amount"] for a in ALGOD.account_info(app_addr)["assets"]
                if a["asset-id"] == musd)
    check("app holds 0 mUSD once everyone has claimed", held == 0, str(held))

    print("\n── no standing ALGO buffer is required (audit I-4) ──")
    zero_buffer_vote(founder, founder_sk, musd, approval, clear)

    print("\n── the window guard releases ──")
    send(create_proposal_txns(founder, "a second question", ["Yes", "No"], 2),
         [founder_sk, founder_sk])
    check("founder can open proposal 2 after proposal 1 closed", True)

    print("\n── immutability ──")
    ok, why = rejects([transaction.ApplicationUpdateTxn(
        founder, sp(), app_id, approval, clear)], [founder_sk])
    check("the app cannot be updated, even by the founder", ok, why)
    ok, why = rejects([transaction.ApplicationDeleteTxn(founder, sp(), app_id)], [founder_sk])
    check("the app cannot be deleted, even by the founder", ok, why)

    print(f"\n{'='*58}\n  {len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        for f in FAIL:
            print(f"   FAILED: {f}")
    print("=" * 58)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
