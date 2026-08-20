"""
UVote Voting Contract (v2) — Deployment Script

Deploys uvote/uvote.py to mainnet (default) or testnet in three steps:
  1. Create the app (founder = deployer, magnet_asa_id from network, schema uints=3)
  2. Fund the contract account (base 0.1 + ASA opt-in 0.1 + standing MBR buffer)
  3. Call optin_asa so the contract can hold/transfer $U

Prerequisites:
  pip install py-algorand-sdk pyteal

Usage (run from the contracts/magnetdao/ directory, in YOUR OWN terminal so the
seed phrase never lands in a shared session/transcript):
  export FUNDER_MNEMONIC='word1 word2 ... word25'
  python deploy_uvote.py                    # mainnet
  python deploy_uvote.py --network testnet  # testnet

Founder authority:
  The deployer wallet becomes `founder`. If you deploy from a throwaway wallet,
  transfer authority to the real founder afterward via update_founder (from the
  throwaway) then accept_founder (from the real founder). Simplest path: deploy
  directly from the founder wallet so no transfer is needed.

After a successful deploy, set in the frontend config:
  UVOTE_APP_ID  = <printed App ID>
Then ship the /vote route.
"""

import os
import sys
import base64
import argparse

from algosdk import account, mnemonic
from algosdk.logic import get_application_address
from algosdk.v2client import algod
from algosdk.transaction import (
    ApplicationCreateTxn,
    ApplicationNoOpTxn,
    OnComplete,
    StateSchema,
    PaymentTxn,
    wait_for_confirmation,
)
from pyteal import compileTeal, Mode

from uvote.uvote import approval_program, clear_program


# ─── Config ────────────────────────────────────────────────────────────────────

ALGOD_URLS = {
    "mainnet": "https://mainnet-api.algonode.cloud",
    "testnet": "https://testnet-api.algonode.cloud",
}

MAGNET_ASA_ID = {
    "mainnet": 3081853135,
    "testnet": 761651596,
}

# uvote.py global state:
#   uints:  magnet_asa_id, proposal_count, last_end
#   bytes:  founder, pending_founder
GLOBAL_SCHEMA = StateSchema(num_uints=3, num_byte_slices=2)
LOCAL_SCHEMA  = StateSchema(num_uints=0, num_byte_slices=0)

# ALGO sent to the contract account before optin_asa.
# Covers: base min-balance (100k) + ASA opt-in min-balance (100k) + a standing
# vote-box MBR buffer (audit L1: the box is created at group index 0 but the
# voter's MBR payment settles at index 2, so the app must already hold >= one
# vote-box MBR of 26,900 to admit the first vote). 400k gives comfortable margin.
CONTRACT_FUND_AMOUNT = 400_000  # microALGO (0.4 ALGO)

TEAL_VERSION = 8


# ─── Helpers ───────────────────────────────────────────────────────────────────

def get_client(network: str) -> algod.AlgodClient:
    return algod.AlgodClient("", ALGOD_URLS[network])


def compile_b64(client: algod.AlgodClient, teal: str) -> bytes:
    resp = client.compile(teal)
    return base64.b64decode(resp["result"])


# ─── Steps ─────────────────────────────────────────────────────────────────────

def create_app(network: str, private_key: str, magnet_asa: int) -> int:
    """Compile and deploy uvote.py. Returns the new App ID."""
    client = get_client(network)
    sender = account.address_from_private_key(private_key)
    params = client.suggested_params()

    print("  Compiling TEAL from uvote/uvote.py...")
    approval_teal = compileTeal(approval_program(), mode=Mode.Application, version=TEAL_VERSION)
    clear_teal    = compileTeal(clear_program(),    mode=Mode.Application, version=TEAL_VERSION)

    approval_bytes = compile_b64(client, approval_teal)
    clear_bytes    = compile_b64(client, clear_teal)

    txn = ApplicationCreateTxn(
        sender=sender,
        sp=params,
        on_complete=OnComplete.NoOpOC,
        approval_program=approval_bytes,
        clear_program=clear_bytes,
        global_schema=GLOBAL_SCHEMA,
        local_schema=LOCAL_SCHEMA,
        app_args=[magnet_asa.to_bytes(8, "big")],
    )

    signed = txn.sign(private_key)
    tx_id  = client.send_transaction(signed)
    print(f"  Tx: {tx_id}")
    result = wait_for_confirmation(client, tx_id, 4)
    return result["application-index"]


def fund_contract(network: str, private_key: str, contract_address: str) -> None:
    """Send ALGO to the contract account (min-balance + inner-txn + MBR buffer)."""
    client = get_client(network)
    sender = account.address_from_private_key(private_key)
    params = client.suggested_params()

    txn    = PaymentTxn(sender, params, contract_address, CONTRACT_FUND_AMOUNT)
    signed = txn.sign(private_key)
    tx_id  = client.send_transaction(signed)
    print(f"  Tx: {tx_id}")
    wait_for_confirmation(client, tx_id, 4)


def call_optin_asa(network: str, private_key: str, app_id: int) -> None:
    """Call optin_asa so the contract can hold/transfer $U.

    The contract sets the inner txn fee to 0 (fee pooling), so the outer AppCall
    must cover both fees: flat_fee=True, fee=2000 microALGO.
    """
    client = get_client(network)
    sender = account.address_from_private_key(private_key)
    params = client.suggested_params()
    params.flat_fee = True
    params.fee      = 2_000  # outer fee covers inner txn via fee pooling

    magnet_asa = MAGNET_ASA_ID[network]
    txn    = ApplicationNoOpTxn(
        sender, params, app_id,
        app_args=[b"optin_asa"],
        foreign_assets=[magnet_asa],
    )
    signed = txn.sign(private_key)
    tx_id  = client.send_transaction(signed)
    print(f"  Tx: {tx_id}")
    wait_for_confirmation(client, tx_id, 4)


# ─── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Deploy UVote voting contract (v2)")
    parser.add_argument(
        "--network", default="mainnet", choices=["mainnet", "testnet"],
        help="Target network (default: mainnet)"
    )
    args = parser.parse_args()

    mnemonic_phrase = os.getenv("FUNDER_MNEMONIC")
    if not mnemonic_phrase:
        print("Error: FUNDER_MNEMONIC is not set.")
        print("  export FUNDER_MNEMONIC='word1 word2 ... word25'")
        sys.exit(1)

    private_key = mnemonic.to_private_key(mnemonic_phrase)
    sender      = account.address_from_private_key(private_key)
    magnet_asa  = MAGNET_ASA_ID[args.network]

    print(f"\n{'='*48}")
    print(f"  UVote Voting Contract Deployment (v2)")
    print(f"{'='*48}")
    print(f"  Network:    {args.network}")
    print(f"  Deployer:   {sender}  (becomes founder)")
    print(f"  Magnet ASA: {magnet_asa}")
    print()

    # Step 1 — Create app
    print("Step 1/3 — Creating app...")
    app_id        = create_app(args.network, private_key, magnet_asa)
    contract_addr = get_application_address(app_id)
    print(f"  ✓ App ID:           {app_id}")
    print(f"  ✓ Contract address: {contract_addr}")

    # Step 2 — Fund contract account
    print(f"\nStep 2/3 — Funding contract account ({CONTRACT_FUND_AMOUNT / 1_000_000} ALGO)...")
    fund_contract(args.network, private_key, contract_addr)
    print(f"  ✓ Contract funded")

    # Step 3 — optin_asa
    print(f"\nStep 3/3 — Calling optin_asa (ASA {magnet_asa})...")
    call_optin_asa(args.network, private_key, app_id)
    print(f"  ✓ Contract opted in to Magnet ASA")

    # Summary
    print(f"""
{'='*48}
  Deployment Complete
{'='*48}
  App ID:           {app_id}
  Contract address: {contract_addr}
  Network:          {args.network}
  Magnet ASA:       {magnet_asa}
  Founder:          {sender}

  Next steps:
  1. Set UVOTE_APP_ID = {app_id} in the frontend config.
  2. (If deployed from a throwaway) update_founder -> accept_founder to the real founder.
  3. Ship the /vote route; retire old app 3554779766 from the UI.
  4. Founder canary: create a first proposal + self-vote + claim before announcing.
{'='*48}
""")


if __name__ == "__main__":
    main()
