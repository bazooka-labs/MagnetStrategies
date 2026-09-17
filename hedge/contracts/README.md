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
algokit localnet start
poetry run pytest
```

21 tests. `test_obligations.py` pins the payout arithmetic in pure Python;
`test_localnet.py` deploys the **compiled** contract to a local chain and drives it
through real transaction groups — which is the only level at which opcode budget,
inner-transaction limits, fee pooling and inner-payment failure are observable.

Rounds span hours, so the suite moves the chain clock with algod's dev-mode block
offset. That offset is the delta applied to *each* new block, not an offset from wall
clock, so it is set, consumed by one block, and reset — leaving it set compounds every
subsequent block and runs the chain away.

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

**`MUSD_ASSET_ID` is a deploy-time template variable.** One artifact serves every
network; the chosen asset is substituted at deploy and baked permanently into the
deployed program. `bootstrap` is one-shot and irreversible in a non-upgradeable
contract, so the asset must not be trusted from a call argument.

## Status

Compiles. Arithmetic invariants under test.

Two adversarial reviews have run against this code (correctness and exploit lenses,
fresh context, reading the compiled TEAL as well as the source); their findings are
applied, and the ones that could be pinned by a test now are.

**Not deployed.** Next: the keeper (4-venue candle read, OHLC4, sign, publish, submit,
batch payouts), then the frontend.
