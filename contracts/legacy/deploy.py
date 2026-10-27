"""
MagnetDAO Contract Deployment Script

Usage:
  # Compile and deploy:
  python deploy.py --network testnet --deploy

  # Compile only (dry run):
  python deploy.py --network testnet

Prerequisites:
  - Funded Algorand account
  - .env file with FUNDER_MNEMONIC
"""

import os
import sys
import json
import argparse
import base64
from algosdk import account, mnemonic
from algosdk.v2client import algod
from algosdk.transaction import (
    ApplicationCreateTxn, OnComplete,
    StateSchema, wait_for_confirmation
)

from governance.governance import approval_program as gov_approval, clear_program as gov_clear
from treasury.treasury import approval_program as tre_approval, clear_program as tre_clear

from pyteal import compileTeal, Mode


ALGOD_URLS = {
    "testnet": "https://testnet-api.algonode.cloud",
    "mainnet": "https://mainnet-api.algonode.cloud",
}


def get_client(network: str) -> algod.AlgodClient:
    url = ALGOD_URLS.get(network, ALGOD_URLS["testnet"])
    return algod.AlgodClient("", url)


def compile_program(client: algod.AlgodClient, teal_source: str) -> bytes:
    compile_response = client.compile(teal_source)
    return base64.b64decode(compile_response["result"])


def deploy_contract(
    client: algod.AlgodClient,
    private_key: str,
    approval_teal: str,
    clear_teal: str,
    global_schema: StateSchema,
    local_schema: StateSchema,
    app_args: list[bytes] | None = None,
) -> int:
    sender = account.address_from_private_key(private_key)
    params = client.suggested_params()

    approval = compile_program(client, approval_teal)
    clear = compile_program(client, clear_teal)

    txn = ApplicationCreateTxn(
        sender=sender,
        sp=params,
        on_complete=OnComplete.NoOpOC,
        approval_program=approval,
        clear_program=clear,
        global_schema=global_schema,
        local_schema=local_schema,
        app_args=app_args,
    )

    signed = txn.sign(private_key)
    tx_id = client.send_transaction(signed)
    result = wait_for_confirmation(client, tx_id, 4)
    app_id = result["application-index"]
    print(f"Deployed! App ID: {app_id}")
    return app_id


def main():
    parser = argparse.ArgumentParser(description="Deploy MagnetDAO contracts")
    parser.add_argument("--network", default="testnet", choices=["testnet", "mainnet"])
    parser.add_argument("--magnet-asa", type=int, default=3081853135)
    parser.add_argument("--deploy", action="store_true",
                        help="Actually deploy contracts (default: compile only)")
    parser.add_argument("--compile-only", action="store_true",
                        help="Only compile TEAL, don't deploy")
    args = parser.parse_args()

    gov_approval_teal = compileTeal(gov_approval(), mode=Mode.Application, version=8)
    gov_clear_teal = compileTeal(gov_clear(), mode=Mode.Application, version=8)
    tre_approval_teal = compileTeal(tre_approval(), mode=Mode.Application, version=8)
    tre_clear_teal = compileTeal(tre_clear(), mode=Mode.Application, version=8)

    print("=== Compiled TEAL ===")
    print(f"Governance approval: {len(gov_approval_teal)} chars")
    print(f"Governance clear:    {len(gov_clear_teal)} chars")
    print(f"Treasury approval:   {len(tre_approval_teal)} chars")
    print(f"Treasury clear:      {len(tre_clear_teal)} chars")

    # Write compiled TEAL to files for inspection
    os.makedirs("build", exist_ok=True)
    with open("build/governance_approval.teal", "w") as f:
        f.write(gov_approval_teal)
    with open("build/governance_clear.teal", "w") as f:
        f.write(gov_clear_teal)
    with open("build/treasury_approval.teal", "w") as f:
        f.write(tre_approval_teal)
    with open("build/treasury_clear.teal", "w") as f:
        f.write(tre_clear_teal)
    print("Wrote TEAL files to contracts/build/")

    if args.compile_only or not args.deploy:
        print("\nCompile complete. Use --deploy to deploy on-chain.")
        if not args.deploy and not args.compile_only:
            print("(No --deploy flag provided, skipping deployment)")
        return

    # --- Deploy ---
    mnemonic_phrase = os.getenv("FUNDER_MNEMONIC")
    if not mnemonic_phrase:
        print("\nError: Set FUNDER_MNEMONIC environment variable to deploy")
        print("Export it: export FUNDER_MNEMONIC='your 25 word mnemonic'")
        sys.exit(1)

    private_key = mnemonic.to_private_key(mnemonic_phrase)
    sender = account.address_from_private_key(private_key)
    client = get_client(args.network)

    print(f"\n=== Deploying to {args.network} ===")
    print(f"Deployer: {sender}")
    print(f"Magnet ASA: {args.magnet_asa}")

    gov_schema = StateSchema(num_uints=8, num_byte_slices=4)
    local_schema = StateSchema(num_uints=0, num_byte_slices=0)

    print("\n--- Deploying Governance Contract ---")
    gov_app_id = deploy_contract(
        client, private_key,
        gov_approval_teal, gov_clear_teal,
        gov_schema, local_schema,
        app_args=[args.magnet_asa.to_bytes(8, "big")],
    )

    print(f"\n--- Deploying Treasury Contract ---")
    tre_app_id = deploy_contract(
        client, private_key,
        tre_approval_teal, tre_clear_teal,
        gov_schema, local_schema,
        app_args=[
            gov_app_id.to_bytes(8, "big"),
            args.magnet_asa.to_bytes(8, "big"),
        ],
    )

    print("\n=== Deployment Complete ===")
    print(f"Governance App ID: {gov_app_id}")
    print(f"Treasury App ID:   {tre_app_id}")
    print(f"Network:           {args.network}")

    output = {
        "network": args.network,
        "governance_app_id": gov_app_id,
        "treasury_app_id": tre_app_id,
        "magnet_asa_id": args.magnet_asa,
        "deployer": sender,
    }
    with open("deployment.json", "w") as f:
        json.dump(output, f, indent=2)
    print("Saved deployment.json")


if __name__ == "__main__":
    main()
