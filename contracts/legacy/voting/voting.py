"""
MagnetDAO Voting Contract

Token-locking governance votes for MagnetDAO.
- Founder creates ballot proposals (question + 2-4 choices, 7-day window)
- Magnet holders vote by locking tokens in an atomic group
- One vote per wallet per proposal, enforced via box existence check
- Locked tokens are released in full after the 7-day vote window closes
"""

from pyteal import (
    Bytes, Int, Txn, Global, And, Or, Assert, Seq, Reject,
    Approve, Btoi, Itob, Concat, Gtxn, OnComplete, Mode, Subroutine,
    TealType, Cond, compileTeal, ScratchVar, Pop, Extract, Len
)
from pyteal import InnerTxnBuilder, TxnType, BoxCreate, BoxReplace, BoxGet, BoxDelete
from pyteal import App
from pyteal import TxnField

# Global state keys
FOUNDER_KEY = Bytes("founder")
MAGNET_ASA_KEY = Bytes("magnet_asa_id")
PROPOSAL_COUNT_KEY = Bytes("proposal_count")
PENDING_FOUNDER_KEY = Bytes("pending_founder")

# Box prefixes
PROPOSAL_PREFIX = Bytes("prop_")
VOTE_PREFIX = Bytes("vote_")

# Proposal box layout (304 bytes, fixed offsets):
# [0:8]    start_time   (uint64)
# [8:16]   end_time     (uint64) = start + 604800 (7 days)
# [16:24]  votes_a      (uint64) total Magnet weight for choice A
# [24:32]  votes_b      (uint64)
# [32:40]  votes_c      (uint64)
# [40:48]  votes_d      (uint64)
# [48:176] question     (128 bytes, padded with null bytes)
# [176:208] choice_a   (32 bytes, padded)
# [208:240] choice_b   (32 bytes, padded)
# [240:272] choice_c   (32 bytes, padded, empty = not in use)
# [272:304] choice_d   (32 bytes, padded, empty = not in use)
PROPOSAL_BOX_SIZE = Int(304)

PROP_START_TIME = Int(0)
PROP_END_TIME   = Int(8)
PROP_VOTES_A    = Int(16)
PROP_VOTES_B    = Int(24)
PROP_VOTES_C    = Int(32)
PROP_VOTES_D    = Int(40)
PROP_QUESTION   = Int(48)
PROP_CHOICE_A   = Int(176)
PROP_CHOICE_B   = Int(208)
PROP_CHOICE_C   = Int(240)
PROP_CHOICE_D   = Int(272)

# Vote box layout (16 bytes):
# [0:8]  choice        (uint64: 0=A, 1=B, 2=C, 3=D)
# [8:16] locked_amount (uint64: Magnet tokens locked)
VOTE_BOX_SIZE = Int(16)
VOTE_CHOICE = Int(0)
VOTE_AMOUNT = Int(8)

VOTE_DURATION = Int(604800)    # 7 days in seconds
DECIMAL_FACTOR = Int(100000)   # 10^5 — 1 display $U = 100,000 base units


@Subroutine(TealType.none)
def only_founder():
    return Assert(Txn.sender() == App.globalGet(FOUNDER_KEY))


def approval_program():

    on_create = Seq([
        App.globalPut(FOUNDER_KEY, Txn.sender()),
        App.globalPut(MAGNET_ASA_KEY, Btoi(Txn.application_args[0])),
        App.globalPut(PROPOSAL_COUNT_KEY, Int(0)),
        App.globalPut(PENDING_FOUNDER_KEY, Bytes("")),
        Approve(),
    ])

    on_opt_in = Reject()

    # --- optin_asa ---
    # Founder calls once after deploy so the contract can hold/transfer Magnet tokens.
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
    # Founder only. Starts a 7-day vote window immediately.
    # args: [1] question (max 128 bytes)
    #       [2] choice_a (max 32 bytes, required)
    #       [3] choice_b (max 32 bytes, required)
    #       [4] choice_c (max 32 bytes, optional — pass empty bytes if not used)
    #       [5] choice_d (max 32 bytes, optional — pass empty bytes if not used)
    create_proposal = Seq([
        only_founder(),

        Assert(Len(Txn.application_args[1]) <= Int(128)),  # question
        Assert(Len(Txn.application_args[2]) <= Int(32)),   # choice_a (required)
        Assert(Len(Txn.application_args[2]) > Int(0)),
        Assert(Len(Txn.application_args[3]) <= Int(32)),   # choice_b (required)
        Assert(Len(Txn.application_args[3]) > Int(0)),
        Assert(Len(Txn.application_args[4]) <= Int(32)),   # choice_c (optional)
        Assert(Len(Txn.application_args[5]) <= Int(32)),   # choice_d (optional)

        App.globalPut(PROPOSAL_COUNT_KEY, App.globalGet(PROPOSAL_COUNT_KEY) + Int(1)),

        (proposal_id := ScratchVar()).store(App.globalGet(PROPOSAL_COUNT_KEY)),
        (box_key := ScratchVar()).store(Concat(PROPOSAL_PREFIX, Itob(proposal_id.load()))),
        (now := ScratchVar()).store(Global.latest_timestamp()),

        Pop(BoxCreate(box_key.load(), PROPOSAL_BOX_SIZE)),

        BoxReplace(box_key.load(), PROP_START_TIME, Itob(now.load())),
        BoxReplace(box_key.load(), PROP_END_TIME,   Itob(now.load() + VOTE_DURATION)),
        BoxReplace(box_key.load(), PROP_VOTES_A,    Itob(Int(0))),
        BoxReplace(box_key.load(), PROP_VOTES_B,    Itob(Int(0))),
        BoxReplace(box_key.load(), PROP_VOTES_C,    Itob(Int(0))),
        BoxReplace(box_key.load(), PROP_VOTES_D,    Itob(Int(0))),
        BoxReplace(box_key.load(), PROP_QUESTION,   Txn.application_args[1]),
        BoxReplace(box_key.load(), PROP_CHOICE_A,   Txn.application_args[2]),
        BoxReplace(box_key.load(), PROP_CHOICE_B,   Txn.application_args[3]),
        BoxReplace(box_key.load(), PROP_CHOICE_C,   Txn.application_args[4]),
        BoxReplace(box_key.load(), PROP_CHOICE_D,   Txn.application_args[5]),

        Approve(),
    ])

    # --- cast_vote ---
    # Atomic group: [0] this AppCall, [1] AssetTransfer (voter → contract, Magnet tokens)
    # args: [1] proposal_id as 8-byte uint64 (Itob)
    #       [2] choice_index as 8-byte uint64 (0=A, 1=B, 2=C, 3=D)
    cast_vote = Seq([
        # Verify atomic group includes Magnet ASA transfer to this contract
        Assert(Global.group_size() == Int(2)),
        Assert(Gtxn[1].type_enum() == TxnType.AssetTransfer),
        Assert(Gtxn[1].asset_receiver() == Global.current_application_address()),
        Assert(Gtxn[1].xfer_asset() == App.globalGet(MAGNET_ASA_KEY)),
        Assert(Gtxn[1].asset_amount() > Int(0)),
        # Approach 2: only whole $U accepted — no fractional dust locked in contract
        Assert(Gtxn[1].asset_amount() % DECIMAL_FACTOR == Int(0)),

        (box_key := ScratchVar()).store(
            Concat(PROPOSAL_PREFIX, Txn.application_args[1])
        ),
        (prop_box := BoxGet(box_key.load())),
        Assert(prop_box.hasValue()),

        # Verify voting window is active
        Assert(Global.latest_timestamp() >= Btoi(Extract(prop_box.value(), PROP_START_TIME, Int(8)))),
        Assert(Global.latest_timestamp() <  Btoi(Extract(prop_box.value(), PROP_END_TIME,   Int(8)))),

        # Validate choice index (0–3)
        (choice := ScratchVar()).store(Btoi(Txn.application_args[2])),
        Assert(choice.load() <= Int(3)),

        # Create vote box — Assert fails if this voter already voted (box exists)
        (vote_key := ScratchVar()).store(
            Concat(VOTE_PREFIX, Concat(Txn.application_args[1], Txn.sender()))
        ),
        (create_ok := ScratchVar()).store(BoxCreate(vote_key.load(), VOTE_BOX_SIZE)),
        Assert(create_ok.load() == Int(1)),

        # Record vote
        (locked_amount := ScratchVar()).store(Gtxn[1].asset_amount()),
        BoxReplace(vote_key.load(), VOTE_CHOICE, Txn.application_args[2]),
        BoxReplace(vote_key.load(), VOTE_AMOUNT, Itob(locked_amount.load())),

        # Update tally for the selected choice
        (cur_votes_a := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_VOTES_A, Int(8)))),
        (cur_votes_b := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_VOTES_B, Int(8)))),
        (cur_votes_c := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_VOTES_C, Int(8)))),
        (cur_votes_d := ScratchVar()).store(Btoi(Extract(prop_box.value(), PROP_VOTES_D, Int(8)))),

        Cond(
            [choice.load() == Int(0),
             BoxReplace(box_key.load(), PROP_VOTES_A, Itob(cur_votes_a.load() + locked_amount.load()))],
            [choice.load() == Int(1),
             BoxReplace(box_key.load(), PROP_VOTES_B, Itob(cur_votes_b.load() + locked_amount.load()))],
            [choice.load() == Int(2),
             BoxReplace(box_key.load(), PROP_VOTES_C, Itob(cur_votes_c.load() + locked_amount.load()))],
            [choice.load() == Int(3),
             BoxReplace(box_key.load(), PROP_VOTES_D, Itob(cur_votes_d.load() + locked_amount.load()))],
        ),

        Approve(),
    ])

    # --- claim_tokens ---
    # Caller retrieves their locked Magnet tokens after the vote window closes.
    # args: [1] proposal_id as 8-byte uint64
    claim_tokens = Seq([
        (prop_key := ScratchVar()).store(
            Concat(PROPOSAL_PREFIX, Txn.application_args[1])
        ),
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

        # Delete vote box before inner txn to prevent re-entrancy
        Pop(BoxDelete(vote_key.load())),

        # Return locked tokens to caller
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetField(TxnField.type_enum, TxnType.AssetTransfer),
        InnerTxnBuilder.SetField(TxnField.asset_receiver, Txn.sender()),
        InnerTxnBuilder.SetField(TxnField.xfer_asset, App.globalGet(MAGNET_ASA_KEY)),
        InnerTxnBuilder.SetField(TxnField.asset_amount, amount_to_return.load()),
        InnerTxnBuilder.SetField(TxnField.fee, Int(0)),
        InnerTxnBuilder.Submit(),

        Approve(),
    ])

    # --- update_founder / accept_founder ---
    update_founder = Seq([
        only_founder(),
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
    print("=== Voting Approval Program ===")
    print(compileTeal(approval_program(), mode=Mode.Application, version=8))
    print("\n=== Voting Clear Program ===")
    print(compileTeal(clear_program(), mode=Mode.Application, version=8))
