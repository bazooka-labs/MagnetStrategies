# Audit 8 — remediation spec

Queued before any code, per the rule that changes on this surface are specified
and reviewed rather than hot-fixed.

**Scope: both ship-blockers and all four HIGH findings.** MEDIUM 7–9 and LOW
10–14 are listed at the end with a decision on each.

---

## SB1. `assertOpenLimitGroup` reads the wrong ABI offsets

**The defect.** The SDK's `submit_linked_order` arg order
(`@pdex/sdk/dist/src/transactions.js:1086-1105`) is:

    A[1] ownerOrderId   A[2] orderKind   A[3] targetKind   A[4] marketId
    A[5] side           A[6] collateralAssetId   A[7] sizeUsdDelta …

`assertOpenWithTakeProfit` uses exactly that. `assertOpenLimitGroup` reads `A[1]`
as `orderKind`, `A[3]` as `marketId` and `A[4]` as `ownerOrderId` — three reads
shifted. `A[5]` onward are correct.

**Why it passed.** `ORDER_KIND_OPEN_LIMIT`, `ORDER_TARGET_PAIR`, ALGO/USD's
`marketId` and a fresh account's `baseOrderId` are **all the literal 1**. A
four-way numeric coincidence.

**What it costs.** Verified against real SDK output: BTC/USD limit orders have
never been possible at any order id, and any account holding an `o2:` box is
locked out on both markets — which includes everyone who opened with a
take-profit, since that creates a box at `base+1`. The failure message is
*"Safety check failed, so nothing was sent"*, the wording of a security incident,
for a correct group. Separately, `orderKind` is never compared to anything, and
`targetKind` / `marketId` / `ownerOrderId` are each checked against the wrong
field.

**Fix.**
- Correct the three offsets.
- **Add the `orderKind` check that was missing entirely** — `A[2]` must equal
  `ORDER_KIND_OPEN_LIMIT`.
- **Add `targetKind`**, which nothing checked: `A[3]` must be the pinned PAIR
  target.
- Find the entry leg by `orderKind` at the RIGHT offset, so a reordered group
  still cannot have its child read as its entry.

**Why my own tamper table missed it, and what that implies.** The four tampers I
ran touched the escrow amount, the trigger (`A[9]`), a carrier account and the
MBR receiver. **None of them touched `A[1]`, `A[3]` or `A[4]`.** A tamper table
that tests around a bug reads as thorough and proves nothing. So the fix is not
complete without:
- **A real fixture-based test for `assertOpenLimitGroup` and
  `assertCancelGroup`**, which have zero coverage today. It must tamper **every
  arg position individually**, not a chosen few, so an offset error cannot hide
  in an untested index again.

## SB2. A stale limit trigger survives a market switch

`PerpsCard.tsx:250-253` resets `tpPrice` and `tpPct` on `[marketId]`.
`triggerPrice` is reset only by the mode toggle. The market toggle lives outside
the card and changes only `marketId`.

Consequence, verified live: a $0.12 trigger carried onto BTC/USD does not trip
the crossing guard (`1.2e11 >= 8.46e16` is false), so the card quotes against a
payload rescaled to the stale trigger and renders an entry of $0.120249 and a
liquidation of $0.093459 on a market at $84,573 — submit enabled.

**Fix.** Add `setTriggerPrice("")` and `setTriggerHint(null)` to the `[marketId]`
effect. One line each, and it must land with SB1 rather than after it: fixing SB1
alone converts a wrong screen into a placed order at an unreachable trigger with
collateral escrowed indefinitely.

## HIGH 3. No fee cap on the limit or cancel paths

`perpsGroup.ts:1563` and `:1776` call `checkEveryTransaction(...)` and **throw
away its return value**, which is the group's total fee. `assertOpenGroup` and
`assertCloseGroup` capture it and bound it. Verified accepted by MainNet: a 5.03
ALGO limit group and a 5 ALGO cancel, on all 3 live orders.

This is exactly what `MAX_GROUP_FEE_MICRO_ALGO`'s own docstring calls *"the one
tamper that nothing else would catch"* — and on cancel, the signature the UI
presents as the most harmless it asks for.

**Fix.**
- Capture the return and bound it on both paths.
- A cancel is one or two app calls; it gets its own tight cap rather than
  inheriting the open path's 120,000.
- **Pin `sp.fee = sp.minFee`** in `openLimitOrderInner` and `cancelOrder`. It is
  pinned in `openPositionInner` and the reason given there — algod's suggestion
  scales with congestion — applies identically. Without it a congested network
  produces a multi-ALGO group honestly.

## HIGH 4. An unasserted OrderOps call rides inside a close and a bare open

`SHAPE_CLOSE`, `SHAPE_OPEN` and `SHAPE_OPEN_STORAGE` leave `orderOps` undefined,
so `checkCallBudget` falls back to `CALL_BUDGET`'s `0..1`, and neither
`assertCloseGroup` nor `assertOpenGroup` inspects OrderOps calls at all.

Verified: a real close group with an injected `cancel_order(2)` — which cancels
**that user's own take-profit** — passes the assertion and simulates. On a
partial close the position survives with its protection silently removed.

**Fix.** `orderOps: 0` on all three shapes. These flows have no legitimate
OrderOps call.

## HIGH 5. The storage payment is entirely unasserted on the bare-open path

The amount, receiver and `fund_storage` checks live only in
`assertOpenWithTakeProfit`. `assertOpenGroup` has none, and
`checkEveryTransaction` never checks a payment's receiver or amount.

Verified: **50 ALGO** moved into the user's PEX storage escrow on a group
presented as "open a $20 position", assertion green and MainNet green — into an
escrow this UI cannot withdraw from.

**Fix.** Lift the storage-payment checks out of `assertOpenWithTakeProfit` into
a shared helper both paths call: exact amount against the pinned constant,
receiver is the pinned Trading address, and the `fund_storage` call is present
when and only when the payment is.

## HIGH 6. The preflight tells the user closing works while closing refuses

`perpsPreflight.ts:91` says *"Existing positions can still be closed."*
`perpsClient.ts:1225-1232` consults the same preflight and throws. The comment at
`:87` asserts the close path "deliberately does not consult this" — it does.

Worse together: `cancelOrder` does **not** consult the preflight, so in that
state a user can remove their take-profit but cannot close.

**Decision: keep the gate, fix the claim.** Refusing to build against a drifted
manifest is right, and it is not safer because the user is trying to get out — we
would be guessing at the ABI either way. So:
- The banner stops promising closing works.
- `PositionsPanel` surfaces the preflight state and disables Close with the
  reason, instead of offering a button that throws.
- `cancelOrder` consults the preflight too, so the two write paths agree.

---

## MEDIUM and LOW — decisions

- **MEDIUM 7 (BTC positions show no payout).** Fix. ALGO is asset 0 on both
  markets and is already priceable from market 1's signed payload. A user on one
  of two markets cannot currently see what closing returns.
- **MEDIUM 8 (the "what leaves your wallet" line is wrong with no target).**
  Fix — it is a false claim on the signing screen, and the same root cause makes
  `minAlgoMicro` demand 0.16 ALGO against a real 0.034, which is trade-blocking
  at the margin.
- **MEDIUM 9 (the child keeper-fee transfer is unasserted on the limit path).**
  Fix, with SB1 — the limit path never got the hardening
  `assertOpenWithTakeProfit` has, and PEX rejecting it on chain is
  defence-in-depth, not a reason to omit ours.
- **LOW 10 (recall caps in the wrong unit).** Correct the comment, not the
  value: the error is safe in the only direction it can go, and all 11 live
  closes pass.
- **LOW 11 (registry trust root).** Compare the derived asset ids against the
  already-pinned `PEX_ASSETS.xAlgo` / `fUsdc` — free tightening — and soften the
  "the set is closed" comment to say what is actually true.
- **LOW 12–14.** Defer 12 (box references, inert). Fix 13 (band minimum labelled
  as the index) and 14 (dead mandatory-target copy) — both one-liners.
