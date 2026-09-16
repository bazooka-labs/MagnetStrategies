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
| Approval bytecode | 5,100 bytes — needs 2 extra pages (limit 3) |
| Global state | 14 uints, 6 byte slices |
| Position box | key 42 B, value 56 B → 41,700 µALGO MBR |

## Status

Compiles. Arithmetic invariants under test. **Not deployed, not audited against the
implementation** — the five review rounds so far were against the spec, not this code.
