"""
mVote — Magnet Strategies founder-led governance voting, weighted by mUSD

Advisory, founder-led token-locking votes. The founder posts a direction
question (broad scope: liquidity, parameters, investments — anything); mUSD
holders signal by locking whole mUSD at the moment they vote. Locked mUSD is
returned in full once the 7-day window closes. Nothing on-chain executes on the
result — the tally is advisory input the founder acts on.

── Provenance ──────────────────────────────────────────────────────────────
This is UVote (`contracts/uvote/uvote/uvote.py`, mainnet App 3679681107) with
the voting asset changed from $U to mUSD. That lineage is the point: UVote's
logic has been through two independent adversarial audits, the second one AFTER
deploy and against the deployed bytes. Replicating it preserves that confidence;
rewriting it would spend it.

mVote REPLACES UVote rather than running beside it. $U is no longer a governance
token. Retiring UVote strands nobody: measured 2026-11-05, App 3679681107 holds
0 $U, has 0 outstanding vote boxes, and its one proposal closed 2026-08-27.

── What changed from UVote, and why each change ────────────────────────────
  [asset]     `magnet_asa_id` -> `musd_asa_id`. Set at creation, no setter —
              the same deliberate choice UVote made. An app that can be
              repointed at another asset is an app whose locked balance and
              recorded debts can be made to disagree.

  [decimals]  DECIMAL_FACTOR 10^5 -> 10^6. $U has 5 decimals, mUSD has 6, and
              the rule "one whole token, one vote" is unchanged. Read from the
              chain, not from a doc: ASA 3615600399 reports decimals=6.
              The practical effect is that the minimum vote goes from one whole
              $U (~$0.15) to one whole mUSD ($1.00).

  [audit I-1] `claim_tokens` now asserts `Global.group_size() == Int(1)`.
  [audit I-2] `create_proposal` now uses the CHECKED `BoxCreate(...) == Int(1)`
              form instead of `Pop(BoxCreate(...))`.
              Both come from UVote's post-deploy re-audit (2026-08-20), which
              recorded them as defense-in-depth that "cannot be applied to the
              live immutable app; for any FUTURE redeploy only". This is that
              redeploy. Neither closes a known hole — the auditor confirmed
              claim is already safe in any group and that monotonic
              `proposal_count` already makes the box collision unreachable —
              they make the safety self-evident rather than emergent.

              I-1 costs nothing here: the UI has always had one claim button per
              proposal card, so batched claims were never offered.

  [I-4, new]  `cast_vote` takes the group as [0] MBR payment, [1] mUSD transfer,
              [2] this app call — UVote had the app call FIRST and the payment
              last. This removes a standing-funding requirement that both of
              UVote's audits raised and neither could close, because the live
              app is immutable.

              The node checks the app account's minimum balance at the end of
              each transaction, not at the end of the group. With the app call
              at index 0 it creates the vote box — raising the app's minimum by
              26,900 — while the payment that covers it is still two
              transactions away. So the app had to hold a permanent 26,900
              buffer or the FIRST vote of every deployment would revert.
              UVote's audit filed that as deploy requirement L1: "required, not
              optional".

              Moving the payment ahead of the app call means the ALGO has
              already landed when the box is created. Measured on localnet
              rather than reasoned: funded to EXACTLY its minimum balance, zero
              spare, the first vote now succeeds. Under the old order the same
              app rejected it with "balance 486100 below min 513000".

              Every assert is unchanged, only its index moved. The transaction
              each one pins is still pinned by type, sender, receiver, amount
              and asset, so position was never what made the group safe.

  [I-3, new]  `claim_tokens` now asserts `BoxDelete(...) == Int(1)` instead of
              popping it. Not from the UVote audit — found writing this. The
              delete is unreachable-as-a-failure today, because `hasValue()` is
              asserted a few lines above and nothing between the two can remove
              the box. But a 0 there would have been swallowed: the two inner
              transfers would still run, paying out the locked amount AND the
              MBR while the vote box survived to be claimed again. The whole
              re-entrancy argument for this function rests on that delete having
              happened, so it is now checked rather than assumed.

  Everything else is unchanged, and that is verified rather than asserted:
  compile both contracts and diff the TEAL. The changes are exactly the five
  items above — the asset key in 4 places, the decimal factor, the three added
  asserts, and the group reorder. Re-run that diff after any edit here.

── Why mUSD is safe to lock, checked on chain rather than assumed ──────────
mUSD (ASA 3615600399) has **no clawback address and no freeze address**, and on
Algorand an address left unset at asset creation can never be set afterwards —
not even by the surviving manager. So the entire asset-reconfiguration attack
class is neutralised structurally: no one can freeze a voter's claim or claw
locked mUSD out of this app. The `asset_sender() == zero_address()` guard in
`cast_vote` stays anyway, as the belt to that braces.

Measured 2026-11-05 against mainnet, not read from a doc. Re-measure before any
redeploy; this is the single assumption the fund-safety guarantee rests on.

── Overflow ────────────────────────────────────────────────────────────────
Tallies are uint64 (max ~1.8e19). mUSD's total supply is capped by the ASA at
5e14 base units, so even every mUSD in existence voting one choice leaves four
orders of magnitude of headroom. The tally cannot be made to wrap.

── Deliberately NOT added ──────────────────────────────────────────────────
Any founder token-rescue / sweep path. The contract holds exactly the sum of
locked mUSD and the ONLY way mUSD leaves is a voter reclaiming their own
recorded amount after the window closes. This is what makes "funds cannot be
lost and a voter can always reclaim" a hard guarantee rather than a policy.

The cost of that guarantee is real and is accepted with open eyes: mUSD sent to
this app address by mistake — not through `cast_vote` — is stuck forever, and
mUSD is worth a dollar. There is no path that distinguishes a donation from a
lock without also being a path that moves tokens the contract does not owe.
"""

from pyteal import (
    Bytes, Int, Txn, Global, Or, Assert, Seq, Reject,
    Approve, Btoi, Itob, Concat, Gtxn, OnComplete, Mode, Subroutine,
    TealType, Cond, compileTeal, ScratchVar, Extract, Len,
    InnerTxnBuilder, TxnType, BoxCreate, BoxReplace, BoxGet, BoxDelete,
    App, TxnField,
)

# ─── Global state keys ───────────────────────────────────────────────────────
FOUNDER_KEY         = Bytes("founder")
MUSD_ASA_KEY        = Bytes("musd_asa_id")
PROPOSAL_COUNT_KEY  = Bytes("proposal_count")
PENDING_FOUNDER_KEY = Bytes("pending_founder")
LAST_END_KEY        = Bytes("last_end")          # end_time of the most recent proposal

# ─── Box prefixes ────────────────────────────────────────────────────────────
# Unchanged from UVote, deliberately. These are 5 bytes each, and the vote-box
# MBR below is derived from that length — a "nicer" prefix like "mvote_" would
# silently change the exact payment the contract demands in `cast_vote` and
# the exact refund it makes on claim. There is no collision risk: a different
# app has a different box namespace.
PROPOSAL_PREFIX = Bytes("prop_")
VOTE_PREFIX     = Bytes("vote_")

# ─── Sizes ───────────────────────────────────────────────────────────────────
QUESTION_SIZE = Int(256)
CHOICE_SIZE   = Int(96)

# Proposal box layout (696 bytes, fixed offsets):
#  [0:8]     start_time    uint64
#  [8:16]    end_time      uint64  = start + 604800 (7 days)
#  [16:24]   votes_a       uint64  total mUSD weight for choice A
#  [24:32]   votes_b       uint64
#  [32:40]   votes_c       uint64
#  [40:48]   votes_d       uint64
#  [48:56]   num_choices   uint64  (2, 3, or 4)
#  [56:312]  question      256 bytes (null-padded)
#  [312:408] choice_a       96 bytes (null-padded)
#  [408:504] choice_b       96 bytes
#  [504:600] choice_c       96 bytes (all-null = unused)
#  [600:696] choice_d       96 bytes (all-null = unused)
PROPOSAL_BOX_SIZE = Int(696)

PROP_START_TIME  = Int(0)
PROP_END_TIME    = Int(8)
PROP_VOTES_A     = Int(16)
PROP_VOTES_B     = Int(24)
PROP_VOTES_C     = Int(32)
PROP_VOTES_D     = Int(40)
PROP_NUM_CHOICES = Int(48)
PROP_QUESTION    = Int(56)
PROP_CHOICE_A    = Int(312)
PROP_CHOICE_B    = Int(408)
PROP_CHOICE_C    = Int(504)
PROP_CHOICE_D    = Int(600)

# Vote box layout (16 bytes):
#  [0:8]  choice        uint64 (0=A, 1=B, 2=C, 3=D)
#  [8:16] locked_amount uint64 (mUSD base units)
VOTE_BOX_SIZE = Int(16)
VOTE_CHOICE   = Int(0)
VOTE_AMOUNT   = Int(8)

VOTE_DURATION  = Int(604800)    # 7 days in seconds
# 10^6 — one whole mUSD is 1,000,000 base units, and one whole mUSD is one vote.
# UVote used 10^5 because $U carries 5 decimals. mUSD carries 6; read from the
# asset on mainnet, not inferred from USDC's convention.
DECIMAL_FACTOR = Int(1000000)

# Voters pre-fund their own vote-box MBR. Vote box key = "vote_" + 8 (proposal
# id) + 32 (voter pubkey) = 45 bytes; value = 16 bytes. Algorand box MBR =
# 2500 + 400*(key_len + value_len) = 2500 + 400*(45+16) = 26,900 microALGO.
VOTE_BOX_MBR = Int(26900)


@Subroutine(TealType.none)
def only_founder():
    return Assert(Txn.sender() == App.globalGet(FOUNDER_KEY))


def approval_program():

    on_create = Seq([
        App.globalPut(FOUNDER_KEY, Txn.sender()),
        App.globalPut(MUSD_ASA_KEY, Btoi(Txn.application_args[0])),
        App.globalPut(PROPOSAL_COUNT_KEY, Int(0)),
        App.globalPut(PENDING_FOUNDER_KEY, Bytes("")),
        App.globalPut(LAST_END_KEY, Int(0)),
        Approve(),
    ])

    on_opt_in = Reject()

    # --- optin_asa ---
    # Founder calls once after deploy so the contract can hold/transfer mUSD.
    optin_asa = Seq([
        only_founder(),
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetField(TxnField.type_enum, TxnType.AssetTransfer),
        InnerTxnBuilder.SetField(TxnField.asset_receiver, Global.current_application_address()),
        InnerTxnBuilder.SetField(TxnField.xfer_asset, App.globalGet(MUSD_ASA_KEY)),
        InnerTxnBuilder.SetField(TxnField.asset_amount, Int(0)),
        InnerTxnBuilder.SetField(TxnField.fee, Int(0)),
        InnerTxnBuilder.Submit(),
        Approve(),
    ])

    # --- create_proposal ---
    # Founder only. Starts a 7-day window immediately. One active proposal at a time.
    # args: [1] question (max 256 bytes)
    #       [2] choice_a  (1..96 bytes, required)
    #       [3] choice_b  (1..96 bytes, required)
    #       [4] choice_c  (0..96 bytes, optional — empty = unused)
    #       [5] choice_d  (0..96 bytes, optional — empty = unused; requires choice_c)
    create_proposal = Seq([
        only_founder(),

        # Only one active proposal at a time (prevents overlapping token-lock windows)
        Assert(Global.latest_timestamp() >= App.globalGet(LAST_END_KEY)),

        Assert(Len(Txn.application_args[1]) <= QUESTION_SIZE),   # question
        Assert(Len(Txn.application_args[2]) > Int(0)),           # choice_a required
        Assert(Len(Txn.application_args[2]) <= CHOICE_SIZE),
        Assert(Len(Txn.application_args[3]) > Int(0)),           # choice_b required
        Assert(Len(Txn.application_args[3]) <= CHOICE_SIZE),
        Assert(Len(Txn.application_args[4]) <= CHOICE_SIZE),     # choice_c optional
        Assert(Len(Txn.application_args[5]) <= CHOICE_SIZE),     # choice_d optional
        # Contiguity: choice_d cannot be used unless choice_c is used
        Assert(Or(Len(Txn.application_args[5]) == Int(0), Len(Txn.application_args[4]) > Int(0))),

        App.globalPut(PROPOSAL_COUNT_KEY, App.globalGet(PROPOSAL_COUNT_KEY) + Int(1)),

        (proposal_id := ScratchVar()).store(App.globalGet(PROPOSAL_COUNT_KEY)),
        (box_key := ScratchVar()).store(Concat(PROPOSAL_PREFIX, Itob(proposal_id.load()))),
        (now := ScratchVar()).store(Global.latest_timestamp()),
        (end := ScratchVar()).store(now.load() + VOTE_DURATION),
        (num_choices := ScratchVar()).store(
            Int(2)
            + (Len(Txn.application_args[4]) > Int(0))
            + (Len(Txn.application_args[5]) > Int(0))
        ),

        # [audit I-2] CHECKED create. UVote popped the result, which was safe only
        # because `proposal_count` is monotonic and so the key is always fresh.
        # That is a correct argument that has to be re-derived by every reader;
        # this asserts it instead. A 0 here would mean the box already existed,
        # which would mean the id space had been reused — and silently writing a
        # new question over a closed proposal's tally is the worst available
        # failure, because the box still decodes.
        Assert(BoxCreate(box_key.load(), PROPOSAL_BOX_SIZE) == Int(1)),

        BoxReplace(box_key.load(), PROP_START_TIME,  Itob(now.load())),
        BoxReplace(box_key.load(), PROP_END_TIME,    Itob(end.load())),
        BoxReplace(box_key.load(), PROP_VOTES_A,     Itob(Int(0))),
        BoxReplace(box_key.load(), PROP_VOTES_B,     Itob(Int(0))),
        BoxReplace(box_key.load(), PROP_VOTES_C,     Itob(Int(0))),
        BoxReplace(box_key.load(), PROP_VOTES_D,     Itob(Int(0))),
        BoxReplace(box_key.load(), PROP_NUM_CHOICES, Itob(num_choices.load())),
        BoxReplace(box_key.load(), PROP_QUESTION,    Txn.application_args[1]),
        BoxReplace(box_key.load(), PROP_CHOICE_A,    Txn.application_args[2]),
        BoxReplace(box_key.load(), PROP_CHOICE_B,    Txn.application_args[3]),
        BoxReplace(box_key.load(), PROP_CHOICE_C,    Txn.application_args[4]),
        BoxReplace(box_key.load(), PROP_CHOICE_D,    Txn.application_args[5]),

        App.globalPut(LAST_END_KEY, end.load()),
        Approve(),
    ])

    # --- cast_vote ---
    # Atomic group (size 3), in this order for the reason in [I-4] above:
    #   [0] Payment        voter -> contract, exactly VOTE_BOX_MBR (funds the vote box)
    #   [1] AssetTransfer  voter -> contract, whole mUSD (the vote weight, locked)
    #   [2] this AppCall (cast_vote)
    # The payment comes FIRST so the ALGO has landed before this call creates
    # the box and raises the app's minimum balance.
    # args: [1] proposal_id as 8-byte uint64 (Itob)
    #       [2] choice_index as 8-byte uint64 (0=A,1=B,2=C,3=D)
    cast_vote = Seq([
        Assert(Global.group_size() == Int(3)),
        Assert(Txn.group_index() == Int(2)),        # this AppCall is pinned to slot 2

        # [0] MBR payment — voter funds their own vote box, before it is created
        Assert(Gtxn[0].type_enum() == TxnType.Payment),
        Assert(Gtxn[0].sender() == Txn.sender()),
        Assert(Gtxn[0].receiver() == Global.current_application_address()),
        Assert(Gtxn[0].close_remainder_to() == Global.zero_address()),
        Assert(Gtxn[0].amount() == VOTE_BOX_MBR),

        # [1] mUSD transfer — must come FROM the voter (AppCall sender), TO the contract
        Assert(Gtxn[1].type_enum() == TxnType.AssetTransfer),
        Assert(Gtxn[1].sender() == Txn.sender()),
        Assert(Gtxn[1].asset_sender() == Global.zero_address()),                    # not a clawback move
        Assert(Gtxn[1].asset_receiver() == Global.current_application_address()),
        Assert(Gtxn[1].asset_close_to() == Global.zero_address()),
        Assert(Gtxn[1].xfer_asset() == App.globalGet(MUSD_ASA_KEY)),
        Assert(Gtxn[1].asset_amount() > Int(0)),
        Assert(Gtxn[1].asset_amount() % DECIMAL_FACTOR == Int(0)),                  # whole mUSD only

        (box_key := ScratchVar()).store(Concat(PROPOSAL_PREFIX, Txn.application_args[1])),
        (prop_box := BoxGet(box_key.load())),
        Assert(prop_box.hasValue()),

        # Voting window active: start <= now < end
        Assert(Global.latest_timestamp() >= Btoi(Extract(prop_box.value(), PROP_START_TIME, Int(8)))),
        Assert(Global.latest_timestamp() <  Btoi(Extract(prop_box.value(), PROP_END_TIME,   Int(8)))),

        # Choice must be a real, in-use option
        (choice := ScratchVar()).store(Btoi(Txn.application_args[2])),
        (num_choices := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_NUM_CHOICES, Int(8)))),
        Assert(choice.load() < num_choices.load()),

        # One vote per wallet per proposal — BoxCreate returns 0 if it already exists
        (vote_key := ScratchVar()).store(
            Concat(VOTE_PREFIX, Concat(Txn.application_args[1], Txn.sender()))
        ),
        (create_ok := ScratchVar()).store(BoxCreate(vote_key.load(), VOTE_BOX_SIZE)),
        Assert(create_ok.load() == Int(1)),

        # Record the vote
        (locked_amount := ScratchVar()).store(Gtxn[1].asset_amount()),
        BoxReplace(vote_key.load(), VOTE_CHOICE, Itob(choice.load())),
        BoxReplace(vote_key.load(), VOTE_AMOUNT, Itob(locked_amount.load())),

        # Update tally for the chosen option. The four current values are read
        # from `prop_box.value()`, which was loaded before any write above, so
        # these are the pre-write figures and exactly one of them is replaced.
        (cur_a := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_VOTES_A, Int(8)))),
        (cur_b := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_VOTES_B, Int(8)))),
        (cur_c := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_VOTES_C, Int(8)))),
        (cur_d := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_VOTES_D, Int(8)))),
        Cond(
            [choice.load() == Int(0),
             BoxReplace(box_key.load(), PROP_VOTES_A, Itob(cur_a.load() + locked_amount.load()))],
            [choice.load() == Int(1),
             BoxReplace(box_key.load(), PROP_VOTES_B, Itob(cur_b.load() + locked_amount.load()))],
            [choice.load() == Int(2),
             BoxReplace(box_key.load(), PROP_VOTES_C, Itob(cur_c.load() + locked_amount.load()))],
            [choice.load() == Int(3),
             BoxReplace(box_key.load(), PROP_VOTES_D, Itob(cur_d.load() + locked_amount.load()))],
        ),

        Approve(),
    ])

    # --- claim_tokens ---
    # Voter reclaims their locked mUSD after the window closes. Also refunds the
    # vote-box MBR (box delete returns MBR to the app; we forward it to the voter).
    # args: [1] proposal_id as 8-byte uint64
    claim_tokens = Seq([
        # [audit I-1] Claim stands alone. It is already safe in any group — the
        # box is deleted before the inner transfers, the key is scoped to
        # Txn.sender(), and a second claim in the same group fails its own
        # BoxGet — but "already safe" is an argument, and this is a fact. The UI
        # has one claim button per proposal card, so nothing batched was lost.
        Assert(Global.group_size() == Int(1)),

        (prop_key := ScratchVar()).store(Concat(PROPOSAL_PREFIX, Txn.application_args[1])),
        (prop_box := BoxGet(prop_key.load())),
        Assert(prop_box.hasValue()),

        # Vote period must be over
        Assert(Global.latest_timestamp() >= Btoi(Extract(prop_box.value(), PROP_END_TIME, Int(8)))),

        (vote_key := ScratchVar()).store(
            Concat(VOTE_PREFIX, Concat(Txn.application_args[1], Txn.sender()))
        ),
        (vote_box := BoxGet(vote_key.load())),
        Assert(vote_box.hasValue()),

        (amount_to_return := ScratchVar()).store(
            Btoi(Extract(vote_box.value(), VOTE_AMOUNT, Int(8)))
        ),
        Assert(amount_to_return.load() > Int(0)),

        # Delete the vote box BEFORE the inner transfers (re-entrancy guard).
        # Deletion refunds VOTE_BOX_MBR to the app account.
        Assert(BoxDelete(vote_key.load()) == Int(1)),

        # Return locked mUSD to the voter
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetField(TxnField.type_enum, TxnType.AssetTransfer),
        InnerTxnBuilder.SetField(TxnField.asset_receiver, Txn.sender()),
        InnerTxnBuilder.SetField(TxnField.xfer_asset, App.globalGet(MUSD_ASA_KEY)),
        InnerTxnBuilder.SetField(TxnField.asset_amount, amount_to_return.load()),
        InnerTxnBuilder.SetField(TxnField.fee, Int(0)),
        InnerTxnBuilder.Submit(),

        # Refund the vote-box MBR the voter pre-funded
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetField(TxnField.type_enum, TxnType.Payment),
        InnerTxnBuilder.SetField(TxnField.receiver, Txn.sender()),
        InnerTxnBuilder.SetField(TxnField.amount, VOTE_BOX_MBR),
        InnerTxnBuilder.SetField(TxnField.fee, Int(0)),
        InnerTxnBuilder.Submit(),

        Approve(),
    ])

    # --- update_founder / accept_founder (2-step transfer) ---
    update_founder = Seq([
        only_founder(),
        Assert(Len(Txn.application_args[1]) == Int(32)),   # must be a real 32-byte address
        App.globalPut(PENDING_FOUNDER_KEY, Txn.application_args[1]),
        Approve(),
    ])

    accept_founder = Seq([
        Assert(Txn.sender() == App.globalGet(PENDING_FOUNDER_KEY)),
        App.globalPut(FOUNDER_KEY, App.globalGet(PENDING_FOUNDER_KEY)),
        App.globalPut(PENDING_FOUNDER_KEY, Bytes("")),
        Approve(),
    ])

    # UpdateApplication and DeleteApplication fall through to Reject(): the app
    # is immutable and non-deletable, so the founder can never add a sweep path
    # or brick the claim logic. This is a structural guarantee, not a policy.
    return Cond(
        [Txn.application_id() == Int(0), on_create],
        [Txn.on_completion() == OnComplete.OptIn, on_opt_in],
        [Txn.on_completion() == OnComplete.NoOp,
         Cond(
             [Txn.application_args[0] == Bytes("optin_asa"),       optin_asa],
             [Txn.application_args[0] == Bytes("create_proposal"), create_proposal],
             [Txn.application_args[0] == Bytes("cast_vote"),       cast_vote],
             [Txn.application_args[0] == Bytes("claim_tokens"),    claim_tokens],
             [Txn.application_args[0] == Bytes("update_founder"),  update_founder],
             [Txn.application_args[0] == Bytes("accept_founder"),  accept_founder],
         )],
        [Int(1), Reject()],
    )


def clear_program():
    return Approve()


if __name__ == "__main__":
    print("=== mVote Approval Program ===")
    print(compileTeal(approval_program(), mode=Mode.Application, version=8))
    print("\n=== mVote Clear Program ===")
    print(compileTeal(clear_program(), mode=Mode.Application, version=8))
