"""
Does the frontend ship the contract in this repo?

`web/src/lib/governanceAdmin.ts` embeds mVote's compiled program as base64 and
the deploy button sends exactly those bytes. Every security claim about mVote —
audited logic, immutable, no sweep path, locks mUSD — is a claim about
`mvote/mvote.py`. It transfers to the deployed app only if the embedded bytes
ARE that file, compiled.

A vitest test (`governanceBytecode.test.ts`) already checks the embedded b64
agrees with the hash documented beside it. That catches one being edited
without the other; it cannot catch BOTH being stale after a contract change,
because nothing in the web package can run PyTeal. This can.

Run before every deploy:  python3 verify_embedded.py
"""

import base64
import json
import pathlib
import re
import sys
import urllib.request

from pyteal import Mode, compileTeal

from mvote.mvote import approval_program, clear_program

ADMIN_TS = (pathlib.Path(__file__).resolve().parents[2]
            / "web" / "src" / "lib" / "governanceAdmin.ts")
ALGOD = "https://mainnet-api.algonode.cloud"


def compile_remote(teal: str) -> dict:
    req = urllib.request.Request(f"{ALGOD}/v2/teal/compile", data=teal.encode(),
                                 headers={"Content-Type": "text/plain"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def embedded(src: str, name: str) -> str:
    m = re.search(rf'const {name} =\s*\n?\s*"([A-Za-z0-9+/=]+)"', src)
    if not m:
        raise SystemExit(f"{name} not found in {ADMIN_TS}")
    return m.group(1)


def main() -> int:
    src = ADMIN_TS.read_text()
    failures = []

    for label, prog, const in (
        ("approval", approval_program(), "MVOTE_APPROVAL_B64"),
        ("clear", clear_program(), "MVOTE_CLEAR_B64"),
    ):
        built = compile_remote(compileTeal(prog, mode=Mode.Application, version=8))
        ship = embedded(src, const)
        ok = built["result"] == ship
        print(f"  {'PASS' if ok else 'FAIL'}  {label}: embedded bytes match the compiled contract")
        print(f"        compiled {built['hash']}")
        if not ok:
            print(f"        embedded hashes differently — re-embed before deploying")
            failures.append(label)
        # The documented hash in the comment must also agree.
        if built["hash"] not in src:
            print(f"  FAIL  {label}: hash {built['hash']} is not documented in governanceAdmin.ts")
            failures.append(f"{label}-hash")
        else:
            print(f"  PASS  {label}: hash is documented beside the constant")

    print("\n" + ("ALL CLEAR" if not failures else f"FAILED: {', '.join(failures)}"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
