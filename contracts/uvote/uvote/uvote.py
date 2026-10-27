"""
UVote — Magnet Strategies founder-led governance voting (v2)

Advisory, founder-led token-locking votes over $U. The founder posts a
direction question (broad scope: liquidity, parameters, investments — anything);
$U holders signal by locking whole $U at the moment they vote. Locked $U is
returned in full once the 7-day window closes. Nothing on-chain executes on the
result — the tally is advisory input the founder acts on.

This is v2 of the deployed voting contract (mainnet App 3554779766). It carries
forward the exact model and closes the four findings from the 2026-05-22 audit,
plus widens the on-chain text fields.

Changes vs v1 (voting.py):
  [Med — token theft]     cast_vote now asserts Gtxn[1].sender() == Txn.sender()
                          so the locked $U is always funded by the wallet that is
                          credited and can later reclaim it.
  [Med — tally integrity] proposals store num_choices; cast_vote asserts the
                          chosen index is a real, in-use choice (choice < num_choices).
                          create_proposal enforces choice contiguity (D requires C).
  [Low — griefing]        one active proposal at a time (last_end global guard) so
                          the founder can't stack overlapping windows that pin
                          voter token circulation.
  [Low — ops availability] cast_vote requires the voter to pre-fund their own vote
                          box MBR via an included payment, so the contract's ALGO
                          balance can never deplete and block new votes. The MBR is
                          refunded to the voter on claim (box delete returns it).
  [Widen]                 question 128 -> 256 bytes, choices 32 -> 96 bytes each.

Deliberately NOT added: any founder token-rescue / sweep path. The contract holds
exactly the sum of locked $U and the ONLY way $U leaves is a voter reclaiming
their own recorded amount after the window closes. This preserves the hard
guarantee that funds cannot be lost and a voter can always reclaim.
"""

from pyteal import (
    Bytes, Int, Txn, Global, And, Or, Not, Assert, Seq, Reject,
    Approve, Btoi, Itob, Concat, Gtxn, OnComplete, Mode, Subroutine,
    TealType, Cond, compileTeal, ScratchVar, Pop, Extract, Len,
    InnerTxnBuilder, TxnType, BoxCreate, BoxReplace, BoxGet, BoxDelete,
    App, TxnField,
)

# ─── Global state keys ───────────────────────────────────────────────────────
FOUNDER_KEY         = Bytes("founder")
MAGNET_ASA_KEY      = Bytes("magnet_asa_id")
PROPOSAL_COUNT_KEY  = Bytes("proposal_count")
PENDING_FOUNDER_KEY = Bytes("pending_founder")
LAST_END_KEY        = Bytes("last_end")          # NEW — end_time of the most recent proposal

# ─── Box prefixes ────────────────────────────────────────────────────────────
PROPOSAL_PREFIX = Bytes("prop_")
VOTE_PREFIX     = Bytes("vote_")

# ─── Sizes ───────────────────────────────────────────────────────────────────
QUESTION_SIZE = Int(256)   # widened from 128
CHOICE_SIZE   = Int(96)    # widened from 32

# Proposal box layout (696 bytes, fixed offsets):
#  [0:8]     start_time    uint64
#  [8:16]    end_time      uint64  = start + 604800 (7 days)
#  [16:24]   votes_a       uint64  total $U weight for choice A
#  [24:32]   votes_b       uint64
#  [32:40]   votes_c       uint64
#  [40:48]   votes_d       uint64
#  [48:56]   num_choices   uint64  (2, 3, or 4)          — NEW
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
#  [8:16] locked_amount uint64 ($U base units)
VOTE_BOX_SIZE = Int(16)
VOTE_CHOICE   = Int(0)
VOTE_AMOUNT   = Int(8)

VOTE_DURATION  = Int(604800)   # 7 days in seconds
DECIMAL_FACTOR = Int(100000)   # 10^5 — 1 display $U = 100,000 base units

# Voters pre-fund their own vote-box MBR. Vote box key = "vote_" + 8 (proposal id)
# + 32 (voter pubkey) = 45 bytes; value = 16 bytes. Algorand box MBR =
# 2500 + 400*(key_len + value_len) = 2500 + 400*(45+16) = 26,900 microALGO.
VOTE_BOX_MBR = Int(26900)


@Subroutine(TealType.none)
def only_founder():
    return Assert(Txn.sender() == App.globalGet(FOUNDER_KEY))


def approval_program():

    on_create = Seq([
        App.globalPut(FOUNDER_KEY, Txn.sender()),
        App.globalPut(MAGNET_ASA_KEY, Btoi(Txn.application_args[0])),
        App.globalPut(PROPOSAL_COUNT_KEY, Int(0)),
        App.globalPut(PENDING_FOUNDER_KEY, Bytes("")),
        App.globalPut(LAST_END_KEY, Int(0)),
        Approve(),
    ])

    on_opt_in = Reject()

    # --- optin_asa ---
    # Founder calls once after deploy so the contract can hold/transfer $U.
    optin_asa = Seq([
        only_founder(),
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetField(TxnField.type_enum, TxnType.AssetTransfer),
        InnerTxnBuilder.SetField(TxnField.asset_receiver, Global.current_application_address()),
        InnerTxnBuilder.SetField(TxnField.xfer_asset, App.globalGet(MAGNET_ASA_KEY)),
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

        Pop(BoxCreate(box_key.load(), PROPOSAL_BOX_SIZE)),

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
    # Atomic group (size 3):
    #   [0] this AppCall (cast_vote)
    #   [1] AssetTransfer  voter -> contract, whole $U (the vote weight, locked)
    #   [2] Payment        voter -> contract, exactly VOTE_BOX_MBR (funds the vote box)
    # args: [1] proposal_id as 8-byte uint64 (Itob)
    #       [2] choice_index as 8-byte uint64 (0=A,1=B,2=C,3=D)
    cast_vote = Seq([
        Assert(Global.group_size() == Int(3)),
        Assert(Txn.group_index() == Int(0)),        # this AppCall is pinned to slot 0

        # [1] $U transfer — must come FROM the voter (AppCall sender), TO the contract
        Assert(Gtxn[1].type_enum() == TxnType.AssetTransfer),
        Assert(Gtxn[1].sender() == Txn.sender()),                                   # [Med] co-signer fix
        Assert(Gtxn[1].asset_sender() == Global.zero_address()),                    # not a clawback move
        Assert(Gtxn[1].asset_receiver() == Global.current_application_address()),
        Assert(Gtxn[1].asset_close_to() == Global.zero_address()),
        Assert(Gtxn[1].xfer_asset() == App.globalGet(MAGNET_ASA_KEY)),
        Assert(Gtxn[1].asset_amount() > Int(0)),
        Assert(Gtxn[1].asset_amount() % DECIMAL_FACTOR == Int(0)),                  # whole $U only

        # [2] MBR payment — voter funds their own vote box so the app never depletes
        Assert(Gtxn[2].type_enum() == TxnType.Payment),
        Assert(Gtxn[2].sender() == Txn.sender()),
        Assert(Gtxn[2].receiver() == Global.current_application_address()),
        Assert(Gtxn[2].close_remainder_to() == Global.zero_address()),
        Assert(Gtxn[2].amount() == VOTE_BOX_MBR),

        (box_key := ScratchVar()).store(Concat(PROPOSAL_PREFIX, Txn.application_args[1])),
        (prop_box := BoxGet(box_key.load())),
        Assert(prop_box.hasValue()),

        # Voting window active: start <= now < end
        Assert(Global.latest_timestamp() >= Btoi(Extract(prop_box.value(), PROP_START_TIME, Int(8)))),
        Assert(Global.latest_timestamp() <  Btoi(Extract(prop_box.value(), PROP_END_TIME,   Int(8)))),

        # Choice must be a real, in-use option
        (choice := ScratchVar()).store(Btoi(Txn.application_args[2])),
        (num_choices := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_NUM_CHOICES, Int(8)))),
        Assert(choice.load() < num_choices.load()),                                 # [Med] tally-integrity fix

        # One vote per wallet per proposal — BoxCreate fails (0) if it already exists
        (vote_key := ScratchVar()).store(
            Concat(VOTE_PREFIX, Concat(Txn.application_args[1], Txn.sender()))
        ),
        (create_ok := ScratchVar()).store(BoxCreate(vote_key.load(), VOTE_BOX_SIZE)),
        Assert(create_ok.load() == Int(1)),

        # Record the vote
        (locked_amount := ScratchVar()).store(Gtxn[1].asset_amount()),
        BoxReplace(vote_key.load(), VOTE_CHOICE, Itob(choice.load())),
        BoxReplace(vote_key.load(), VOTE_AMOUNT, Itob(locked_amount.load())),

        # Update tally for the chosen option
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
    # Voter reclaims their locked $U after the window closes. Also refunds the
    # vote-box MBR (box delete returns MBR to the app; we forward it to the voter).
    # args: [1] proposal_id as 8-byte uint64
    claim_tokens = Seq([
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
        Pop(BoxDelete(vote_key.load())),

        # Return locked $U to the voter
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetField(TxnField.type_enum, TxnType.AssetTransfer),
        InnerTxnBuilder.SetField(TxnField.asset_receiver, Txn.sender()),
        InnerTxnBuilder.SetField(TxnField.xfer_asset, App.globalGet(MAGNET_ASA_KEY)),
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
    print("=== UVote Approval Program ===")
    print(compileTeal(approval_program(), mode=Mode.Application, version=8))
    print("\n=== UVote Clear Program ===")
    print(compileTeal(clear_program(), mode=Mode.Application, version=8))
