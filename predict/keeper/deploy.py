#!/usr/bin/env python3
"""Deploy VPL.

Three steps, and the third is the dangerous one.

  1. create_application     from admin, 2 extra program pages
  2. fund the app account   min balance + mUSD opt-in + round-box headroom
  3. bootstrap              ONE-SHOT AND IRREVERSIBLE

bootstrap can never be re-run: musd_asset_id is immutable afterwards and the contract
is non-upgradeable and non-deletable. Getting it wrong means abandoning the deployment
and permanently stranding its minimum balance. Hence the typed confirmation on mainnet.

Usage:
    python deploy.py --dry-run     # show what would happen, send nothing
    python deploy.py
"""

from __future__ import annotations

import argparse
import sys

import algokit_utils
from algokit_utils import (
    AppClientMethodCallParams, AppFactory, AppFactoryCreateMethodCallParams,
    AppFactoryParams, Arc56Contract,
)

from vplkeeper import chain, config
from vplkeeper.config import (
    DEFAULT_BAND_BOUNDS, DEFAULT_MIN_STAKE, DEFAULT_RAKE_BPS, PRICE_FEED_ID,
)

# base 100k + 2 extra pages 200k + 15 uints x 28.5k + 6 byte slices x 50k + opt-in 100k
MIN_BALANCE = 1_127_500
FUND_AMOUNT = 10_000_000  # 10 ALGO — min balance, two live round boxes, operating float


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cfg = config.load()
    client = chain.algorand(cfg)
    admin = chain.account(client, "VPL_ADMIN_MNEMONIC")
    keeper_addr = chain.account(client, "VPL_KEEPER_MNEMONIC").address
    treasury = __import__("os").environ.get("VPL_TREASURY_ADDRESS", admin.address)
    oracle_pub = bytes(config.load_oracle_key(cfg.oracle_key_path).verify_key)

    print(f"network        {cfg.network}")
    print(f"mUSD asset     {cfg.musd_asset_id}")
    print(f"admin          {admin.address}")
    print(f"keeper         {keeper_addr}")
    print(f"treasury       {treasury}")
    print(f"oracle pubkey  {oracle_pub.hex()}")
    print(f"rake           {DEFAULT_RAKE_BPS} bps")
    print(f"min stake      {DEFAULT_MIN_STAKE / 1e6} mUSD")
    print(f"band bounds    {DEFAULT_BAND_BOUNDS}")
    print(f"app funding    {FUND_AMOUNT / 1e6} ALGO (min balance {MIN_BALANCE / 1e6:.3f})")

    if treasury == admin.address:
        print("\n  note: treasury == admin. Fine to start; a separate treasury is "
              "tidier once rake is worth sweeping.")

    if args.dry_run:
        print("\n--dry-run: nothing sent")
        return 0

    if cfg.is_mainnet:
        print("\n  MAINNET. bootstrap is one-shot and irreversible; the contract cannot"
              "\n  be upgraded or deleted. A wrong asset id here means abandoning this"
              "\n  deployment and stranding ~1.13 ALGO permanently.")
        if input('  type "deploy mainnet" to continue: ').strip() != "deploy mainnet":
            print("aborted")
            return 1

    factory = AppFactory(AppFactoryParams(
        algorand=client,
        app_spec=Arc56Contract.from_dict(chain.app_spec(cfg)),
        default_sender=admin.address,
        default_signer=admin.signer,
        compilation_params={"deploy_time_params": {"MUSD_ASSET_ID": cfg.musd_asset_id}},
    ))

    print("\n[1/3] create_application ...")
    app, _ = factory.send.create(AppFactoryCreateMethodCallParams(
        method="create_application", extra_program_pages=2))
    print(f"      app id {app.app_id}")
    print(f"      address {app.app_address}")

    print(f"[2/3] funding {FUND_AMOUNT / 1e6} ALGO ...")
    client.send.payment(algokit_utils.PaymentParams(
        sender=admin.address, receiver=app.app_address, amount=chain.algo(FUND_AMOUNT)))

    print("[3/3] bootstrap ...")
    app.send.call(AppClientMethodCallParams(
        method="bootstrap",
        args=[cfg.musd_asset_id, PRICE_FEED_ID, treasury, oracle_pub, keeper_addr,
              DEFAULT_RAKE_BPS, DEFAULT_MIN_STAKE, list(DEFAULT_BAND_BOUNDS)],
        asset_references=[cfg.musd_asset_id],
        extra_fee=chain.algo(1_000),          # funds the inner mUSD opt-in
    ))

    print(f"\ndeployed.  export VPL_APP_ID={app.app_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
