# Hedge contracts

Algorand Python (PuyaPy) implementation of the daily BTC option ladder.

- Design: [`../OPTIONSLADDER.md`](../OPTIONSLADDER.md)
- Spec (rev 6): [`../OPTIONSLADDER_SPEC.md`](../OPTIONSLADDER_SPEC.md)
- Oracle: [`../ORACLE.md`](../ORACLE.md)

## Layout

```
smart_contracts/ladder/contract.py   the contract
smart_contracts/__main__.py          build entrypoint
tests/                               pytest
```

## Build

```sh
poetry install
poetry run python -m smart_contracts build
```

Artifacts land in `smart_contracts/artifacts/ladder/`. PuyaPy is pinned to 5.9.0 to
match `magnetfi/v2/contracts`, so TEAL output is reproducible.

## Test

```sh
poetry run pytest
```

## Current build

| | |
|---|---|
| Approval bytecode | 5,835 bytes — 2 extra pages (limit 3) |
| Global state | 14 uints, 6 byte slices |
| Position box | key 42 B, value 56 B → 41,700 µALGO MBR |
| Round box | key 9 B, value 307 B → 128,900 µALGO MBR |
| ARC-28 events | 10 |

## Calling notes

**`lock` and `resolve` need extra fee.** `ed25519verify_bare` costs 1900 opcodes
against a 700 budget, so both call `ensure_budget`, which emits opup inner
transactions funded from **group credit**. A lone `lock` needs ~5,000 µALGO of group
fee, not the 1,000 minimum. Nothing in the ABI signals this and `lock`'s window is
only `LOCK_DEADLINE` wide, so a relayer paying the minimum fee will fail.

**A full batch of 8 needs ≥3 top-level app calls.** The binding limit is inner
transactions (16 per app call; settle emits 3 per entry), not references. Pad the
group with a cheap method such as `get_solvency`.

**`MUSD_ASSET_ID` is hardcoded to mainnet.** A testnet deploy rebuilds with its own id.

## Status

Compiles. Arithmetic invariants under test.

Two adversarial reviews have run against this code (correctness and exploit lenses,
fresh context, reading the compiled TEAL as well as the source); their findings are
applied. **Not deployed.** No AVM-level tests yet — every finding about resource
limits, inner-transaction counts and fee pooling came from review, not from a test
that would have caught them, and that gap is the next thing to close.
