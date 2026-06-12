"""
MagnetDAO Governance Contract

Manages quarterly proposal lifecycle and on-chain voting for the MagnetDAO.
- Proposals are submitted with project details (name, pair, capital, timeline, risks)
- Voting uses 1 Magnet = 1 Vote weighting (checked via asset_holding_get)
- Double-vote prevention via box existence check
- On-chain vote tallying per proposal
- Founder retains final approval authority with tally reference
"""

from pyteal import (
    Bytes, Int, Txn, Global, And, Or, Not, If, Assert, Seq, Reject,
    Approve, Btoi, Itob, Concat, Gtxn, OnComplete, Mode, Subroutine,
    TealType, Cond, compileTeal, ScratchVar, Pop, Extract
)
from pyteal import InnerTxnBuilder, TxnType, BoxCreate, BoxReplace
from pyteal import BoxGet, App, AssetHolding, Len
from pyteal import TxnField

# Global state keys
FOUNDERS_ADDRESS = Bytes("founder")
MAGNET_ASA_ID = Bytes("magnet_asa")
CURRENT_QUARTER = Bytes("quarter")
QUARTER_START = Bytes("q_start")
PROPOSAL_COUNT = Bytes("p_count")
VOTING_OPEN = Bytes("vote_open")
QUARTER_SECONDS = Bytes("q_secs")
TOTAL_VOTES_CAST = Bytes("total_votes")
PENDING_FOUNDER = Bytes("pending_founder")

# Box name prefixes
PROPOSAL_PREFIX = Bytes("p:")
VOTE_PREFIX = Bytes("v:")

# Proposal statuses
STATUS_PENDING = Int(1)
STATUS_VOTING = Int(2)
STATUS_APPROVED = Int(3)
STATUS_REJECTED = Int(4)
STATUS_DEPLOYED = Int(5)

# Quarter duration: 90 days in seconds
DEFAULT_QUARTER_SECONDS = Int(7776000)

# Proposal box layout (fixed offsets, 256 bytes):
# [0:8]   status (uint64)
# [8:16]  quarter (uint64)
# [16:24] votes_for total (uint64)
# [24:32] votes_against total (uint64)
# [32:64] submitter address (32 bytes)
# [64:128] app_name (64 bytes)
# [128:192] liquidity_pair (64 bytes)
# [192:200] capital_requested (uint64)
# [200:208] timeline_days (uint64)
# [208:256] risk_hash (48 bytes)
PROPOSAL_BOX_SIZE = Int(256)

# Vote box layout (16 bytes):
# [0:8]  vote weight (Magnet balance snapshot)
# [8:16] vote direction (1=for, 0=against)
VOTE_BOX_SIZE = Int(16)


@Subroutine(TealType.none)
def only_founder():
    """Assert sender is the founder"""
    return Assert(Txn.sender() == App.globalGet(FOUNDERS_ADDRESS))


def approval_program():
    """Main approval program for the Governance contract"""

    on_create = Seq([
        App.globalPut(FOUNDERS_ADDRESS, Txn.sender()),
        App.globalPut(MAGNET_ASA_ID, Btoi(Txn.application_args[0])),
        App.globalPut(CURRENT_QUARTER, Int(1)),
        App.globalPut(QUARTER_START, Global.latest_timestamp()),
        App.globalPut(PROPOSAL_COUNT, Int(0)),
        App.globalPut(VOTING_OPEN, Int(0)),
        App.globalPut(QUARTER_SECONDS, DEFAULT_QUARTER_SECONDS),
        App.globalPut(TOTAL_VOTES_CAST, Int(0)),
        App.globalPut(PENDING_FOUNDER, Bytes("")),
        Approve(),
    ])

    on_opt_in = Approve()

    # --- create_proposal ---
    # Group: [0] app call create_proposal, [1] payment 1 Algo deposit
    # args: [1] app_name, [2] liquidity_pair, [3] capital_requested (8-byte uint64), [4] timeline_days (8-byte uint64), [5] risk_hash
    create_proposal = Seq([
        Assert(App.globalGet(VOTING_OPEN) == Int(0)),
        Assert(Global.group_size() >= Int(2)),
        Assert(Gtxn[1].type_enum() == TxnType.Payment),
        Assert(Gtxn[1].amount() >= Int(1000000)),
        Assert(Gtxn[1].receiver() == Global.current_application_address()),

        # C1+C2: Validate field lengths before writing
        Assert(Len(Txn.application_args[1]) <= Int(64)),   # app_name max 64 bytes
        Assert(Len(Txn.application_args[2]) <= Int(64)),   # liquidity_pair max 64 bytes
        Assert(Len(Txn.application_args[3]) == Int(8)),    # capital_requested must be 8-byte uint64
        Assert(Len(Txn.application_args[4]) == Int(8)),    # timeline_days must be 8-byte uint64
        Assert(Len(Txn.application_args[5]) <= Int(48)),   # risk_hash max 48 bytes

        App.globalPut(PROPOSAL_COUNT, App.globalGet(PROPOSAL_COUNT) + Int(1)),

        (box_key := ScratchVar()).store(
            Concat(
                PROPOSAL_PREFIX,
                Concat(
                    Itob(App.globalGet(CURRENT_QUARTER)),
                    Itob(App.globalGet(PROPOSAL_COUNT))
                )
            )
        ),

        Pop(BoxCreate(box_key.load(), PROPOSAL_BOX_SIZE)),

        BoxReplace(box_key.load(), Int(0), Itob(STATUS_PENDING)),
        BoxReplace(box_key.load(), Int(8), Itob(App.globalGet(CURRENT_QUARTER))),
        BoxReplace(box_key.load(), Int(16), Itob(Int(0))),
        BoxReplace(box_key.load(), Int(24), Itob(Int(0))),
        BoxReplace(box_key.load(), Int(32), Txn.sender()),
        BoxReplace(box_key.load(), Int(64), Txn.application_args[1]),
        BoxReplace(box_key.load(), Int(128), Txn.application_args[2]),
        BoxReplace(box_key.load(), Int(192), Txn.application_args[3]),
        BoxReplace(box_key.load(), Int(200), Txn.application_args[4]),
        BoxReplace(box_key.load(), Int(208), Txn.application_args[5]),

        Approve(),
    ])

    # --- open_voting ---
    # Only founder can open voting phase
    open_voting = Seq([
        only_founder(),
        Assert(App.globalGet(VOTING_OPEN) == Int(0)),
        App.globalPut(VOTING_OPEN, Int(1)),
        Approve(),
    ])

    # --- set_proposal_voting ---
    # args: [1] proposal_id (bytes uint64)
    # Explicitly transitions a single proposal from PENDING to VOTING
    set_proposal_voting = Seq([
        only_founder(),
        (proposal_key := ScratchVar()).store(
            Concat(
                PROPOSAL_PREFIX,
                Concat(
                    Itob(App.globalGet(CURRENT_QUARTER)),
                    Txn.application_args[1]
                )
            )
        ),
        (proposal_box := BoxGet(proposal_key.load())),
        Assert(proposal_box.hasValue()),
        (current_status := ScratchVar()).store(
            Btoi(Extract(proposal_box.value(), Int(0), Int(8)))
        ),
        Assert(current_status.load() == STATUS_PENDING),
        BoxReplace(proposal_key.load(), Int(0), Itob(STATUS_VOTING)),
        Approve(),
    ])

    # --- cast_vote ---
    # args: [1] proposal_id (bytes uint64), [2] vote_direction (bytes: 1=for, 0=against)
    # Uses asset_holding_get to snapshot voter's Magnet ASA balance as vote weight
    # Double-vote prevention: BoxCreate fails if box already exists
    cast_vote = Seq([
        # Voting must be open globally
        Assert(App.globalGet(VOTING_OPEN) == Int(1)),

        # C3: Read target proposal box once — reused for status check and tally update
        (target_proposal_key := ScratchVar()).store(
            Concat(
                PROPOSAL_PREFIX,
                Concat(
                    Itob(App.globalGet(CURRENT_QUARTER)),
                    Txn.application_args[1]
                )
            )
        ),
        (proposal_box := BoxGet(target_proposal_key.load())),
        Assert(proposal_box.hasValue()),
        # Verify STATUS_VOTING
        Assert(Btoi(Extract(proposal_box.value(), Int(0), Int(8))) == STATUS_VOTING),

        # Build vote box key: "v:" + itob(quarter) + itob(proposal_id) + voter
        (vote_key := ScratchVar()).store(
            Concat(
                VOTE_PREFIX,
                Concat(
                    Itob(App.globalGet(CURRENT_QUARTER)),
                    Concat(
                        Txn.application_args[1],  # proposal_id as bytes
                        Txn.sender()
                    )
                )
            )
        ),

        # Double-vote prevention: BoxCreate fails if box exists (returns 0)
        (create_result := ScratchVar()).store(
            BoxCreate(vote_key.load(), VOTE_BOX_SIZE)
        ),
        Assert(create_result.load() == Int(1)),

        # Get voter's Magnet ASA balance as vote weight
        (magnet_balance := AssetHolding.balance(
            Txn.sender(),
            App.globalGet(MAGNET_ASA_ID)
        )),
        Assert(magnet_balance.hasValue()),
        Assert(magnet_balance.value() > Int(0)),

        # Store vote data
        BoxReplace(vote_key.load(), Int(0), Itob(magnet_balance.value())),
        BoxReplace(vote_key.load(), Int(8), Txn.application_args[2]),

        # C3: Update tally using already-read proposal_box (no second BoxGet)
        If(Btoi(Txn.application_args[2]) == Int(1))
        .Then(
            (cur_for := ScratchVar()).store(
                Btoi(Extract(proposal_box.value(), Int(16), Int(8)))
            ),
            BoxReplace(target_proposal_key.load(), Int(16), Itob(cur_for.load() + magnet_balance.value()))
        )
        .Else(
            (cur_against := ScratchVar()).store(
                Btoi(Extract(proposal_box.value(), Int(24), Int(8)))
            ),
            BoxReplace(target_proposal_key.load(), Int(24), Itob(cur_against.load() + magnet_balance.value()))
        ),

        App.globalPut(TOTAL_VOTES_CAST, App.globalGet(TOTAL_VOTES_CAST) + Int(1)),

        Approve(),
    ])

    # --- close_voting ---
    # Only founder can close voting
    close_voting = Seq([
        only_founder(),
        Assert(App.globalGet(VOTING_OPEN) == Int(1)),
        App.globalPut(VOTING_OPEN, Int(0)),
        Approve(),
    ])

    # --- finalize_proposal ---
    # args: [1] proposal_id (bytes uint64)
    # Reads on-chain tally and sets status to APPROVED or REJECTED
    finalize_proposal = Seq([
        only_founder(),
        Assert(App.globalGet(VOTING_OPEN) == Int(0)),

        (proposal_key := ScratchVar()).store(
            Concat(
                PROPOSAL_PREFIX,
                Concat(
                    Itob(App.globalGet(CURRENT_QUARTER)),
                    Txn.application_args[1]
                )
            )
        ),

        # Read current status
        (proposal_box := BoxGet(proposal_key.load())),
        Assert(proposal_box.hasValue()),
        (current_status := ScratchVar()).store(
            Btoi(Extract(proposal_box.value(), Int(0), Int(8)))
        ),
        # Accept PENDING or VOTING as valid pre-finalize states
        Assert(Or(
            current_status.load() == STATUS_PENDING,
            current_status.load() == STATUS_VOTING
        )),

        # Read tallies
        (votes_for := ScratchVar()).store(
            Btoi(Extract(proposal_box.value(), Int(16), Int(8)))
        ),
        (votes_against := ScratchVar()).store(
            Btoi(Extract(proposal_box.value(), Int(24), Int(8)))
        ),

        # Determine outcome: for > against = approved
        If(votes_for.load() > votes_against.load())
        .Then(BoxReplace(proposal_key.load(), Int(0), Itob(STATUS_APPROVED)))
        .Else(BoxReplace(proposal_key.load(), Int(0), Itob(STATUS_REJECTED))),

        Approve(),
    ])

    # --- override_proposal ---
    # args: [1] proposal_id (bytes uint64), [2] new_status (bytes uint64)
    # Founder override safety valve
    override_proposal = Seq([
        only_founder(),
        (proposal_key := ScratchVar()).store(
            Concat(
                PROPOSAL_PREFIX,
                Concat(
                    Itob(App.globalGet(CURRENT_QUARTER)),
                    Txn.application_args[1]
                )
            )
        ),
        (proposal_box := BoxGet(proposal_key.load())),
        Assert(proposal_box.hasValue()),
        (new_status := ScratchVar()).store(Btoi(Txn.application_args[2])),
        Assert(Or(new_status.load() == STATUS_APPROVED, new_status.load() == STATUS_REJECTED)),
        BoxReplace(proposal_key.load(), Int(0), Itob(new_status.load())),
        Approve(),
    ])

    # --- mark_deployed ---
    # args: [1] proposal_id (bytes uint64)
    mark_deployed = Seq([
        only_founder(),
        (proposal_key := ScratchVar()).store(
            Concat(
                PROPOSAL_PREFIX,
                Concat(
                    Itob(App.globalGet(CURRENT_QUARTER)),
                    Txn.application_args[1]
                )
            )
        ),
        (proposal_box := BoxGet(proposal_key.load())),
        Assert(proposal_box.hasValue()),
        (current_status := ScratchVar()).store(
            Btoi(Extract(proposal_box.value(), Int(0), Int(8)))
        ),
        Assert(current_status.load() == STATUS_APPROVED),
        BoxReplace(proposal_key.load(), Int(0), Itob(STATUS_DEPLOYED)),
        Approve(),
    ])

    # --- advance_quarter ---
    advance_quarter = Seq([
        only_founder(),
        App.globalPut(CURRENT_QUARTER, App.globalGet(CURRENT_QUARTER) + Int(1)),
        App.globalPut(QUARTER_START, Global.latest_timestamp()),
        App.globalPut(PROPOSAL_COUNT, Int(0)),
        App.globalPut(VOTING_OPEN, Int(0)),
        App.globalPut(TOTAL_VOTES_CAST, Int(0)),
        Approve(),
    ])

    # --- update_founder ---
    # C6: Two-step founder transfer — propose new address
    update_founder = Seq([
        only_founder(),
        App.globalPut(PENDING_FOUNDER, Txn.application_args[1]),
        Approve(),
    ])

    # --- accept_founder ---
    # C6: New founder must accept to complete transfer
    accept_founder = Seq([
        Assert(Txn.sender() == App.globalGet(PENDING_FOUNDER)),
        App.globalPut(FOUNDERS_ADDRESS, App.globalGet(PENDING_FOUNDER)),
        App.globalPut(PENDING_FOUNDER, Bytes("")),
        Approve(),
    ])

    # --- refund_proposal_deposit ---
    # C4: Refund 1 Algo deposit for rejected or finalized proposals
    # args: [1] proposal_id (bytes uint64)
    refund_proposal_deposit = Seq([
        only_founder(),
        (proposal_key := ScratchVar()).store(
            Concat(
                PROPOSAL_PREFIX,
                Concat(
                    Itob(App.globalGet(CURRENT_QUARTER)),
                    Txn.application_args[1]
                )
            )
        ),
        (proposal_box := BoxGet(proposal_key.load())),
        Assert(proposal_box.hasValue()),
        # Can only refund if proposal is in a terminal state
        (p_status := ScratchVar()).store(
            Btoi(Extract(proposal_box.value(), Int(0), Int(8)))
        ),
        Assert(Or(
            p_status.load() == STATUS_REJECTED,
            p_status.load() == STATUS_APPROVED,
            p_status.load() == STATUS_DEPLOYED
        )),
        # Read submitter address at offset 32
        (submitter := ScratchVar()).store(
            Extract(proposal_box.value(), Int(32), Int(32))
        ),
        # Refund 1 Algo to submitter
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetField(TxnField.type_enum, TxnType.Payment),
        InnerTxnBuilder.SetField(TxnField.receiver, submitter.load()),
        InnerTxnBuilder.SetField(TxnField.amount, Int(1000000)),
        InnerTxnBuilder.SetField(TxnField.fee, Int(0)),
        InnerTxnBuilder.Submit(),
        Approve(),
    ])

    # Main router
    return Cond(
        [Txn.application_id() == Int(0), on_create],
        [Txn.on_completion() == OnComplete.OptIn, on_opt_in],
        [Txn.on_completion() == OnComplete.NoOp,
         Cond(
             [Txn.application_args[0] == Bytes("create_proposal"), create_proposal],
             [Txn.application_args[0] == Bytes("open_voting"), open_voting],
             [Txn.application_args[0] == Bytes("set_voting"), set_proposal_voting],
             [Txn.application_args[0] == Bytes("cast_vote"), cast_vote],
             [Txn.application_args[0] == Bytes("close_voting"), close_voting],
             [Txn.application_args[0] == Bytes("finalize"), finalize_proposal],
             [Txn.application_args[0] == Bytes("override"), override_proposal],
             [Txn.application_args[0] == Bytes("mark_deployed"), mark_deployed],
             [Txn.application_args[0] == Bytes("advance_quarter"), advance_quarter],
             [Txn.application_args[0] == Bytes("update_founder"), update_founder],
             [Txn.application_args[0] == Bytes("accept_founder"), accept_founder],
             [Txn.application_args[0] == Bytes("refund_deposit"), refund_proposal_deposit],
         )],
        [Int(1), Reject()],
    )


def clear_program():
    return Approve()


if __name__ == "__main__":
    print("=== Governance Approval Program ===")
    print(compileTeal(approval_program(), mode=Mode.Application, version=8))
    print("\n=== Governance Clear Program ===")
    print(compileTeal(clear_program(), mode=Mode.Application, version=8))
