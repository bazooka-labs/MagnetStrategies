#!/usr/bin/env python3
"""Pre-flight checks. Run before deploying, and again from the VPS before migrating.

Read-only — signs nothing, sends nothing.
"""

from __future__ import annotations

import sys
import time

from vplkeeper import chain, config
from vplkeeper.prices import VENUES, median, read_all

OK, BAD = "  ok ", " FAIL"


def check_venues() -> bool:
    """All four must respond FROM THIS HOST. Three is the quorum floor — landing there
    with no margin means one venue hiccup voids a round. A datacenter IP is not the
    same request as your laptop, which is why this is re-run before migrating."""
    checkpoint = (int(time.time()) // 60) * 60 - 120
    try:
        prices, _ts, mask = read_all(checkpoint)
    except RuntimeError as e:
        print(f"{BAD}  venues: {e}")
        return False
    n = bin(mask).count("1")
    for i, v in enumerate(VENUES):
        present = mask & (1 << i)
        print(f"{OK if present else BAD}  {v:10} "
              + (f"OHLC4 {prices[i] / 1e6:>12,.2f}" if present else "no candle"))
    present_prices = [p for i, p in enumerate(prices) if mask & (1 << i)]
    spread_bps = (max(present_prices) - min(present_prices)) / min(present_prices) * 10_000
    print(f"{OK if n == 4 else BAD}  {n}/4 venues, median {median(prices, mask) / 1e6:,.2f}, "
          f"spread {spread_bps:.2f} bps (lock cap 200)")
    return n == 4


def check_musd(cfg, client) -> bool:
    """bootstrap asserts all of these, and it is one-shot and irreversible. The two
    that carry the MagnetFi isolation are clawback and freeze — decimals and a unit
    name are forgeable by any third party's ASA."""
    if not cfg.musd_asset_id:
        print(f"{BAD}  VPL_MUSD_ASSET_ID unset")
        return False
    info = client.client.algod.asset_info(cfg.musd_asset_id)["params"]
    checks = [
        ("decimals == 6", info.get("decimals") == 6),
        ('unit-name == "mUSD"', info.get("unit-name") == "mUSD"),
        ("clawback is zero address", not info.get("clawback", "").strip("A") or
         info.get("clawback") == "A" * 55 + "Y5HFKQ" or not info.get("clawback")),
        ("freeze is zero address", not info.get("freeze", "").strip("A") or
         info.get("freeze") == "A" * 55 + "Y5HFKQ" or not info.get("freeze")),
        ("total > 0", int(info.get("total", 0)) > 0),
    ]
    allok = True
    print(f"\n  asset {cfg.musd_asset_id} ({info.get('name')})")
    for label, passed in checks:
        print(f"{OK if passed else BAD}  {label}")
        allok &= passed
    return allok


def check_accounts(cfg, client) -> bool:
    allok = True
    for label, env in (("admin", "VPL_ADMIN_MNEMONIC"), ("keeper", "VPL_KEEPER_MNEMONIC")):
        try:
            acct = chain.account(client, env)
        except SystemExit as e:
            print(f"{BAD}  {label}: {e}")
            allok = False
            continue
        bal = client.account.get_information(acct.address).amount.micro_algo
        enough = bal >= 1_000_000
        print(f"{OK if enough else BAD}  {label:7} {acct.address[:8]}… {bal / 1e6:.3f} ALGO")
        allok &= enough
    return allok


def main() -> int:
    cfg = config.load()
    client = chain.algorand(cfg)
    print(f"network: {cfg.network}\n")

    results = [
        ("venues reachable from this host", check_venues()),
        ("mUSD asset satisfies bootstrap", check_musd(cfg, client)),
        ("accounts funded", check_accounts(cfg, client)),
    ]
    try:
        config.load_oracle_key(cfg.oracle_key_path)
        print(f"{OK}  oracle key at {cfg.oracle_key_path}")
        results.append(("oracle key present and mode 600", True))
    except SystemExit as e:
        print(f"{BAD}  {e}")
        results.append(("oracle key present and mode 600", False))

    print()
    for label, passed in results:
        print(f"{OK if passed else BAD}  {label}")
    failed = [l for l, p in results if not p]
    print("\nPREFLIGHT PASS" if not failed else f"\nPREFLIGHT FAIL: {len(failed)} check(s)")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
