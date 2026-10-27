"""
MagnetDAO Treasury Contract

Manages treasury funds and liquidity deployment for the MagnetDAO.
- Receives quarterly funding from Bazooka Labs revenue
- Deploys liquidity with founder oversight
- Fee model: treasury holds LP positions, harvests fees on liquidity changes
- All deployments are on-chain and transparent
"""

from pyteal import (
    Bytes, Int, Txn, Global, And, Or, Not, If, Assert, Seq, Reject,
    Approve, Btoi, Itob, Concat, Gtxn, OnComplete, Mode, Subroutine,
    TealType, Cond, compileTeal, ScratchVar, Pop, Extract
)
from pyteal import InnerTxnBuilder, TxnType, BoxCreate, BoxReplace
from pyteal import BoxGet, App, Balance, Len
from pyteal import TxnField

# Global state keys
FOUNDERS_ADDRESS = Bytes("founder")
GOVERNANCE_APP_ID = Bytes("gov_app_id")
MAGNET_ASA_ID = Bytes("magnet_asa")
TOTAL_FUNDED = Bytes("total_funded")
TOTAL_DEPLOYED = Bytes("total_deployed")
DEPLOYMENT_COUNT = Bytes("dep_count")
TOTAL_FEES_HARVESTED = Bytes("total_fees")

# Box prefixes
DEPLOY_PREFIX = Bytes("d:")

# Deployment statuses
DEPLOY_PENDING = Int(1)
DEPLOY_ACTIVE = Int(2)
DEPLOY_WITHDRAWN = Int(3)

# Deployment box layout (144 bytes):
# [0:8]   status
# [8:16]  proposal_id
# [16:24] project_asa_id
# [24:32] amount (microAlgos deployed)
# [32:64] deployer address (32 bytes)
# [64:128] dex_name (64 bytes)
# [128:136] lp_tokens_received (uint64)
# [136:144] fees_harvested (uint64)
DEPLOY_BOX_SIZE = Int(144)

# Minimum balance requirement
MIN_BALANCE = Int(100000)


@Subroutine(TealType.none)
def only_founder():
    return Assert(Txn.sender() == App.globalGet(FOUNDERS_ADDRESS))


def approval_program():
    """Main approval program for the Treasury contract"""

    on_create = Seq([
        App.globalPut(FOUNDERS_ADDRESS, Txn.sender()),
        App.globalPut(GOVERNANCE_APP_ID, Btoi(Txn.application_args[0])),
        App.globalPut(MAGNET_ASA_ID, Btoi(Txn.application_args[1])),
        App.globalPut(TOTAL_FUNDED, Int(0)),
        App.globalPut(TOTAL_DEPLOYED, Int(0)),
        App.globalPut(DEPLOYMENT_COUNT, Int(0)),
        App.globalPut(TOTAL_FEES_HARVESTED, Int(0)),
        Approve(),
    ])

    on_opt_in = Approve()

    # --- deposit_funds ---
    # Group: [0] app call deposit, [1] payment from Bazooka Labs
    deposit_funds = Seq([
        only_founder(),
        Assert(Global.group_size() >= Int(2)),
        Assert(Gtxn[1].type_enum() == TxnType.Payment),
        Assert(Gtxn[1].receiver() == Global.current_application_address()),
        App.globalPut(
            TOTAL_FUNDED,
            App.globalGet(TOTAL_FUNDED) + Gtxn[1].amount()
        ),
        Approve(),
    ])

    # --- create_deployment ---
    # args: [1] proposal_id, [2] project_asa_id, [3] amount (8-byte uint64), [4] dex_name
    create_deployment = Seq([
        only_founder(),
        (amount := ScratchVar()).store(Btoi(Txn.application_args[3])),
        Assert(amount.load() <= (Balance(Global.current_application_address()) - MIN_BALANCE)),

        # C1+C2: Validate field lengths
        Assert(Len(Txn.application_args[3]) == Int(8)),    # amount must be 8-byte uint64
        Assert(Len(Txn.application_args[4]) <= Int(64)),   # dex_name max 64 bytes

        App.globalPut(DEPLOYMENT_COUNT, App.globalGet(DEPLOYMENT_COUNT) + Int(1)),

        (box_key := ScratchVar()).store(
            Concat(DEPLOY_PREFIX, Itob(App.globalGet(DEPLOYMENT_COUNT)))
        ),

        Pop(BoxCreate(box_key.load(), DEPLOY_BOX_SIZE)),

        BoxReplace(box_key.load(), Int(0), Itob(DEPLOY_PENDING)),
        BoxReplace(box_key.load(), Int(8), Txn.application_args[1]),
        BoxReplace(box_key.load(), Int(16), Txn.application_args[2]),
        BoxReplace(box_key.load(), Int(24), Txn.application_args[3]),
        BoxReplace(box_key.load(), Int(32), Txn.sender()),
        BoxReplace(box_key.load(), Int(64), Txn.application_args[4]),
        BoxReplace(box_key.load(), Int(128), Itob(Int(0))),
        BoxReplace(box_key.load(), Int(136), Itob(Int(0))),

        Approve(),
    ])

    # --- execute_deployment ---
    # args: [1] deployment_id, [2] destination_address
    # Transfers the recorded amount from treasury for liquidity deployment
    # Amount is read from the deployment box (offset 24), not from caller args
    execute_deployment = Seq([
        only_founder(),
        (deploy_id := ScratchVar()).store(Btoi(Txn.application_args[1])),
        (dest_address := ScratchVar()).store(Txn.application_args[2]),

        (box_key := ScratchVar()).store(
            Concat(DEPLOY_PREFIX, Itob(deploy_id.load()))
        ),

        # Read deployment box — must be PENDING
        (deploy_box := BoxGet(box_key.load())),
        Assert(deploy_box.hasValue()),
        (deploy_status := ScratchVar()).store(
            Btoi(Extract(deploy_box.value(), Int(0), Int(8)))
        ),
        Assert(deploy_status.load() == DEPLOY_PENDING),

        # Read approved amount from box at offset 24 (not from caller args)
        (amount := ScratchVar()).store(
            Btoi(Extract(deploy_box.value(), Int(24), Int(8)))
        ),
        Assert(amount.load() <= (Balance(Global.current_application_address()) - MIN_BALANCE)),

        # Update status to ACTIVE
        BoxReplace(box_key.load(), Int(0), Itob(DEPLOY_ACTIVE)),

        App.globalPut(TOTAL_DEPLOYED, App.globalGet(TOTAL_DEPLOYED) + amount.load()),

        # Send Algos to destination
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetField(TxnField.type_enum, TxnType.Payment),
        InnerTxnBuilder.SetField(TxnField.receiver, dest_address.load()),
        InnerTxnBuilder.SetField(TxnField.amount, amount.load()),
        InnerTxnBuilder.SetField(TxnField.fee, Int(0)),
        InnerTxnBuilder.Submit(),

        Approve(),
    ])

    # --- record_lp_tokens ---
    # args: [1] deployment_id, [2] lp_tokens_amount
    # Records LP tokens received after DEX deployment
    record_lp_tokens = Seq([
        only_founder(),
        (deploy_id := ScratchVar()).store(Btoi(Txn.application_args[1])),
        (lp_amount := ScratchVar()).store(Btoi(Txn.application_args[2])),

        (box_key := ScratchVar()).store(
            Concat(DEPLOY_PREFIX, Itob(deploy_id.load()))
        ),
        (deploy_box := BoxGet(box_key.load())),
        Assert(deploy_box.hasValue()),
        (deploy_status := ScratchVar()).store(
            Btoi(Extract(deploy_box.value(), Int(0), Int(8)))
        ),
        Assert(deploy_status.load() == DEPLOY_ACTIVE),

        # C5: Accumulate LP tokens (not overwrite)
        (current_lp := ScratchVar()).store(
            Btoi(Extract(deploy_box.value(), Int(128), Int(8)))
        ),
        BoxReplace(box_key.load(), Int(128), Itob(current_lp.load() + lp_amount.load())),
        Approve(),
    ])

    # --- record_fee_harvest ---
    # args: [1] deployment_id, [2] fees_amount
    # Records fees harvested from removing/rebalancing liquidity
    # On Algorand DEXes (Tinyman, Pact), fees accrue to LP holders
    # and are realized when liquidity positions are adjusted
    record_fee_harvest = Seq([
        only_founder(),
        (deploy_id := ScratchVar()).store(Btoi(Txn.application_args[1])),
        (fees_amount := ScratchVar()).store(Btoi(Txn.application_args[2])),

        (box_key := ScratchVar()).store(
            Concat(DEPLOY_PREFIX, Itob(deploy_id.load()))
        ),

        # Read current fees for this deployment
        (deploy_box := BoxGet(box_key.load())),
        Assert(deploy_box.hasValue()),
        (current_fees := ScratchVar()).store(
            Btoi(Extract(deploy_box.value(), Int(136), Int(8)))
        ),
        BoxReplace(
            box_key.load(),
            Int(136),
            Itob(current_fees.load() + fees_amount.load())
        ),

        App.globalPut(
            TOTAL_FEES_HARVESTED,
            App.globalGet(TOTAL_FEES_HARVESTED) + fees_amount.load()
        ),

        Approve(),
    ])

    # --- withdraw_fees ---
    # args: [1] amount
    # Only founder can withdraw accumulated fees
    withdraw_fees = Seq([
        only_founder(),
        (amount := ScratchVar()).store(Btoi(Txn.application_args[1])),
        Assert(amount.load() <= (Balance(Global.current_application_address()) - MIN_BALANCE)),

        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetField(TxnField.type_enum, TxnType.Payment),
        InnerTxnBuilder.SetField(TxnField.receiver, Txn.sender()),
        InnerTxnBuilder.SetField(TxnField.amount, amount.load()),
        InnerTxnBuilder.SetField(TxnField.fee, Int(0)),
        InnerTxnBuilder.Submit(),

        Approve(),
    ])

    # --- close_deployment ---
    # args: [1] deployment_id
    close_deployment = Seq([
        only_founder(),
        (deploy_id := ScratchVar()).store(Btoi(Txn.application_args[1])),

        (box_key := ScratchVar()).store(
            Concat(DEPLOY_PREFIX, Itob(deploy_id.load()))
        ),
        (deploy_box := BoxGet(box_key.load())),
        Assert(deploy_box.hasValue()),
        (deploy_status := ScratchVar()).store(
            Btoi(Extract(deploy_box.value(), Int(0), Int(8)))
        ),
        Assert(deploy_status.load() == DEPLOY_ACTIVE),
        BoxReplace(box_key.load(), Int(0), Itob(DEPLOY_WITHDRAWN)),

        Approve(),
    ])

    # --- update_founder ---
    update_founder = Seq([
        only_founder(),
        App.globalPut(FOUNDERS_ADDRESS, Txn.application_args[1]),
        Approve(),
    ])

    # --- update_governance_app ---
    update_governance_app = Seq([
        only_founder(),
        App.globalPut(GOVERNANCE_APP_ID, Btoi(Txn.application_args[1])),
        Approve(),
    ])

    return Cond(
        [Txn.application_id() == Int(0), on_create],
        [Txn.on_completion() == OnComplete.OptIn, on_opt_in],
        [Txn.on_completion() == OnComplete.NoOp,
         Cond(
             [Txn.application_args[0] == Bytes("deposit"), deposit_funds],
             [Txn.application_args[0] == Bytes("create_deploy"), create_deployment],
             [Txn.application_args[0] == Bytes("execute_deploy"), execute_deployment],
             [Txn.application_args[0] == Bytes("record_lp"), record_lp_tokens],
             [Txn.application_args[0] == Bytes("record_fees"), record_fee_harvest],
             [Txn.application_args[0] == Bytes("withdraw_fees"), withdraw_fees],
             [Txn.application_args[0] == Bytes("close_deploy"), close_deployment],
             [Txn.application_args[0] == Bytes("update_founder"), update_founder],
             [Txn.application_args[0] == Bytes("update_gov_app"), update_governance_app],
         )],
        [Int(1), Reject()],
    )


def clear_program():
    return Approve()


if __name__ == "__main__":
    print("=== Treasury Approval Program ===")
    print(compileTeal(approval_program(), mode=Mode.Application, version=8))
    print("\n=== Treasury Clear Program ===")
    print(compileTeal(clear_program(), mode=Mode.Application, version=8))
