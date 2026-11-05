"""
The one assumption mVote's fund-safety guarantee rests on, checked against mainnet.

mVote custodies locked mUSD and returns it on claim. If mUSD could be frozen,
a voter's claim could be blocked forever; if it could be clawed back, locked
mUSD could be taken out of the app while the contract still owed it. Neither is
possible today — but "today" is a measurement, not a property of the design, so
it gets a script instead of a sentence in a doc.

Algorand makes this permanent rather than merely current: an address left unset
at asset creation can never be set afterwards, not even by the surviving
manager. So a pass here is a pass forever for this ASA. Run it anyway before
any redeploy, because the thing being checked is which ASA the contract points
at as much as how that ASA is configured.

Run:  python3 check_musd_asset.py
"""

import json
import sys
import urllib.request

MUSD_ASA_ID = 3615600399
ALGOD = "https://mainnet-api.algonode.cloud"
EXPECTED_DECIMALS = 6   # DECIMAL_FACTOR in mvote.py is 10**this


def main() -> int:
    with urllib.request.urlopen(f"{ALGOD}/v2/assets/{MUSD_ASA_ID}", timeout=30) as r:
        params = json.load(r)["params"]

    failures = []

    def check(name: str, ok: bool, detail: str) -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  — {detail}")
        if not ok:
            failures.append(name)

    print(f"mUSD ASA {MUSD_ASA_ID} ({params.get('name')} / {params.get('unit-name')})")

    # An absent key means the zero address, which means unset and unsettable.
    clawback = params.get("clawback")
    freeze = params.get("freeze")
    check("no clawback address", not clawback, clawback or "unset — permanently")
    check("no freeze address", not freeze, freeze or "unset — permanently")
    check("not default-frozen", params.get("default-frozen") is False,
          str(params.get("default-frozen")))

    dec = params.get("decimals")
    check(f"decimals == {EXPECTED_DECIMALS}", dec == EXPECTED_DECIMALS,
          f"{dec} — mvote.py DECIMAL_FACTOR must be 10**{dec}")

    # Tallies are uint64. This is the headroom behind "the tally cannot wrap".
    total = int(params.get("total", 0))
    check("total supply leaves uint64 headroom", total < 2**63,
          f"{total:,} base units, {(2**64 - 1) // max(total, 1):,}x margin")

    print(f"\n{'ALL CLEAR' if not failures else 'FAILED: ' + ', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
