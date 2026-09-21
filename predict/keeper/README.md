# VPL keeper

The unattended service that drives VPL. Four scheduled jobs a day, one signing key,
no human step.

```
09:01:05   read the 09:00 candle from 4 venues -> OHLC4 -> median
           sign -> PUBLISH -> submit lock()
09:01:10   create tomorrow's round
16:01:05   read the 16:00 candle -> OHLC4 -> median
           sign -> PUBLISH -> submit resolve()
16:01:15   settle_batch winners, close_batch losers
```

Reads run just after the checkpoint minute closes, because OHLC4 needs a completed
candle.

## Three obligations the contract cannot enforce

Each is a defect if the keeper gets it wrong, and none of them can be checked on-chain.

**1. Sign once per `(round_id, checkpoint)`. Persist it. Resubmit identical bytes on
retry — never re-sign.** If a submission fails and the keeper signs again with, say, a
venue that has since dropped out of the mask, both attestations are valid and both are
public. `lock`/`resolve` are permissionless, so a participant picks whichever median
lands in their band.

**2. Over-pay fees on `lock` and `resolve`.** Signature verification costs 1,900
opcodes against a 700 budget, so the contract raises its own via opup funded from
*group credit*. A caller paying the 1,000 µALGO minimum fails. Budget ~5,000.

**3. Pad batches to four app calls, using `noop`.** A full 8-entry batch needs four
top-level calls — references are pooled for use but each transaction may only declare
8, of which at most 4 are accounts. Readonly methods cannot pad: clients route them
through simulate and they never reach the submitted group.

## What failure costs

Nothing the keeper does is load-bearing for fund safety — every payout path is
permissionless, so failure is delay, never loss.

| Failure | Outcome |
|---|---|
| Dies before signing at lock | Keeper has 1h to recover and backfill the same candle; past that the round voids and refunds |
| Dies before signing at resolve | 72h to backfill. The 16:00 candle is still there tomorrow |
| Signs but cannot submit | Anyone relays the published attestation — 120s at lock, 72h at resolve |
| Cannot push payouts | Users self-settle free; third parties settle for them and collect a bounty |
| Dies permanently | Every round drains through its void path. Nothing is stranded |

## Not in this repo

Per the [open-source carve-out](../OVERVIEW.md#open-source-policy) the running service
— scheduling, credentials, retry and failover, key custody — stays private. What lives
here is the reference implementation of the parts that must be publicly checkable:
how OHLC4 is computed, how the attestation preimage is built, and how prices are read.

## Layout

```
vplkeeper/prices.py    venue clients, OHLC4, median-of-four
vplkeeper/attest.py    the signed preimage — must match the contract byte for byte
```
