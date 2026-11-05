"""
Mutation check for test_mvote_localnet.py.

A negative test asserts "this transaction is REJECTED", and a transaction can be
rejected for reasons that have nothing to do with the guard under test — a
malformed box reference, a missing foreign asset, an unfunded account. Such a
test passes whether or not the guard exists, which makes it worse than no test:
it reports safety it never checked.

So each guard below is deleted from mvote.py, the suite is re-run against a
freshly deployed app, and the named test MUST flip to FAIL. A guard whose
removal changes nothing is a guard the suite is not actually testing.

Run:  algokit localnet start && python3 mutate_mvote.py
"""

import pathlib
import re
import subprocess
import sys

SRC = pathlib.Path(__file__).parent / "mvote" / "mvote.py"

# (label, the exact source line to delete, the test name that must then fail)
#
# A mutation may be listed in EXPECTED_SURVIVORS when a second mechanism
# enforces the same property, so deleting one guard does not change the
# outcome. That is redundancy, not a hole — but it is only honest to claim it
# with the rejection measured, never reasoned. Each entry carries what the node
# actually said.
EXPECTED_SURVIVORS = {
    "no vote on record":
        "the claim is still refused by `Extract(vote_box.value(), VOTE_AMOUNT, 8)` "
        "on an empty value — measured on localnet with the window closed and the "
        "assert deleted: 'extraction start 8 is beyond length: 0', pc=334, "
        "opcodes `store 21; load 21; extract 8 8`. The hasValue() assert is "
        "defense-in-depth over a failure the AVM already forces.",
}

MUTATIONS = [
    ("whole-token check",
     "Assert(Gtxn[1].asset_amount() % DECIMAL_FACTOR == Int(0)),",
     "fractional mUSD is refused (whole tokens only)"),
    ("choice bound",
     "Assert(choice.load() < num_choices.load()),",
     "choice index beyond num_choices is refused"),
    ("exact MBR",
     "Assert(Gtxn[0].amount() == VOTE_BOX_MBR),",
     "a short MBR payment is refused"),
    ("voter funds their own lock",
     "Assert(Gtxn[1].sender() == Txn.sender()),",
     "mUSD funded by a different wallet than the voter is refused"),
    ("one vote per wallet",
     "Assert(create_ok.load() == Int(1)),",
     "the same wallet cannot vote twice"),
    ("no vote on record",
     "Assert(vote_box.hasValue()),",
     "claim with no vote on record is refused"),
    ("window must be closed to claim",
     "Assert(Global.latest_timestamp() >= Btoi(Extract(prop_box.value(), PROP_END_TIME, Int(8)))),",
     "claim before the window closes is refused"),
    ("claim stands alone (audit I-1)",
     "Assert(Global.group_size() == Int(1)),",
     "claim grouped with anything else is refused (audit I-1)"),
    ("one proposal at a time",
     "Assert(Global.latest_timestamp() >= App.globalGet(LAST_END_KEY)),",
     "cannot stack a second proposal while one is open"),
    ("founder-only proposals",
     "only_founder(),\n\n        # Only one active proposal at a time",
     "non-founder cannot create a proposal"),
    ("choice contiguity",
     "Assert(Or(Len(Txn.application_args[5]) == Int(0), Len(Txn.application_args[4]) > Int(0))),",
     "choice D requires choice C (contiguity)"),
]


def run_suite() -> dict[str, bool]:
    out = subprocess.run([sys.executable, "test_mvote_localnet.py"],
                         cwd=SRC.parent.parent, capture_output=True, text=True).stdout
    results = {}
    for line in out.splitlines():
        m = re.match(r"\s+(PASS|FAIL)\s\s(.+?)(?:\s\s—\s.*)?$", line)
        if m:
            results[m.group(2).strip()] = m.group(1) == "PASS"
    return results


def main() -> int:
    original = SRC.read_text()
    baseline = run_suite()
    if not baseline or not all(baseline.values()):
        print("baseline is not green — fix that before mutating")
        return 1
    print(f"baseline: {len(baseline)} tests, all green\n")

    survivors = []
    try:
        for label, snippet, test_name in MUTATIONS:
            if snippet not in original:
                print(f"  ERROR   {label}: snippet not found in source")
                survivors.append(label)
                continue
            # Deleting `only_founder(),` alone would leave the comment dangling,
            # so that mutation carries its trailing context and puts it back.
            replacement = ("# Only one active proposal at a time"
                           if snippet.startswith("only_founder") else "")
            SRC.write_text(original.replace(snippet, replacement, 1))
            res = run_suite()
            caught = res.get(test_name) is False
            if not caught and label in EXPECTED_SURVIVORS:
                print(f"  redundant  {label}  ->  \"{test_name}\"")
                print(f"             {EXPECTED_SURVIVORS[label]}")
                continue
            print(f"  {'caught ' if caught else 'SURVIVED'}  {label}"
                  f"  ->  \"{test_name}\"")
            if not caught:
                survivors.append(label)
    finally:
        SRC.write_text(original)

    caught_n = len(MUTATIONS) - len(survivors) - len(EXPECTED_SURVIVORS)
    print(f"\n{caught_n} caught, {len(EXPECTED_SURVIVORS)} redundant, "
          f"{len(survivors)} SURVIVED  (of {len(MUTATIONS)})")
    if survivors:
        print("SURVIVED (the suite does not actually test these):")
        for s in survivors:
            print("  -", s)
        return 1
    print("source restored; re-running to confirm")
    final = run_suite()
    print("restored baseline green:", all(final.values()))
    return 0 if all(final.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
