# Perps — what to build next

Written 2026-09-29, at the end of a working session, so the next one starts with
the reasoning rather than re-deriving it. Order is deliberate and argued below.

**Sections 1 and 2 have since been built and signed** — they are kept with their
reasoning intact rather than deleted, because the argument for the order is still
the record of why it was done that way. Section 3 onward is still a plan plus the
measurements that justify it.

For what is built, read [SPEC.md](./SPEC.md#build-status--2026-09-29) — which
carries the current status line — rather than this file's section headings.

---

## 0. First, what stopped being a question

**The full position lifecycle has now run end to end on MainNet.** Opened
2026-09-28 19:59 UTC, take-profit executed by a keeper 2026-09-29 05:02 UTC at
round 65496626. Both boxes — `p2:` and `o2:` — are gone. On a $6 stake the
account received **40.393029 ALGO + 5.744601 USDC**, about **$11.38** at the
trigger, plus 0.0997 ALGO of order-box MBR refunded on execution.

Three things that settles:

1. **Keepers execute.** Not just in aggregate (376 calls this month) but on our
   own order, at our own trigger, unattended.
2. **The two-leg payout is real, not a quirk of the quote.** Collateral returned
   in USDC, profit paid in ALGO — exactly the shape `collateral_delta` was
   hiding, now confirmed by settlement rather than by a quote.
3. **The keeper fee is a cost, not float.** It is refunded on *cancel*; on
   *execution* the keeper keeps it. We escrow $0.10 where the other builder
   escrows $0.051. Raised and consciously declined — it is five cents — but the
   earlier note calling it refundable float was wrong.

---

## 1. Close write path — **BUILT 2026-09-29**

Place, read, cancel and now **close**. Every live MainNet position closes:
**20 of 20** attempts — ten positions, full and half, both markets, both sides —
clear every guard, the assertion and simulation and reach the wallet.

**No call to Ultrade's API.** `readYieldRegistry` builds the SDK's
`marketYieldRegistry` from chain; see its own docstring for where each value
comes from. Only `xalgo_provider_fee_credit_per_call_microalgos` is invented,
and it only raises `flatFeeMicroAlgo`, so overpaying is safe and simulation
confirms sufficiency before a wallet opens.

Three things decided this, each found by simulation rather than reasoning:

1. **The proposer set is mandatory.** Without it, `unavailable Account …` inside
   the consensus app at a `balance` opcode. They are in the `pr` box on that
   app, and a subset is not enough.
2. **`action_recall_uses_router` must be true.** Left at the SDK's default of
   false, a close whose only recall is the collateral leg fails with
   `unavailable App 3690309169` — Trading calls the xALGO vault and nothing has
   referenced it. It only showed on positions paying out in USDC alone, because
   those have no ALGO leg to bring the vault in by the other route. That is why
   two of ten failed and the rest looked fine.
3. **Two recall shapes, tightest first.** Recalling both legs can squeeze the
   vault out of the reference budget on larger positions; the index leg alone
   fits. Both are asserted and simulated before signing, so the fallback costs a
   round trip and risks nothing.

The assertion is **tighter** here than elsewhere: because we build the registry,
`DisplayedClose` carries the closed set of accounts, assets and apps a recall may
touch, and anything outside it fails.

~~**Still true:** no group on this path has been signed by a real wallet.~~
**Signed 2026-10-04.** Close ran on MainNet: 7 transactions, 20.87 xALGO
recalled, group fee exactly 120,000 µALGO as measured. The index-leg-only
recall shape was the one that fit.

## 2. Limit orders — **BUILT 2026-09-29**

Place, read and cancel, each with its own assertion. Shapes, the SDK's missing
box references, the two deliberate refusals, the cancel refund measurements and
the conditional-quote decision are all in
[SPEC.md](./SPEC.md#orders--read-and-write-paths-built-2026-09-28-extended-2026-09-29).

**What is NOT done, and matters:**

- ~~**No group on this path has been signed by a real wallet.**~~ **Signed
  2026-10-04.** A limit order posted and was then cancelled with every escrowed
  amount refunded — 6 USDC collateral, 0.1 USDC keeper fee, 100,200 µALGO MBR.
- ~~**Cancel has never been simulated against a live order.**~~ **Closed, and it
  cost us.** This bullet predicted the only defect in this product that a user
  found before an audit did. Cancelling a bracket parent failed in production
  with `invalid Box reference o2:…0000000000000002`: `cancel_order` probes both
  reserved child slots, and a box reference must be declared even when the box
  does not exist. Fixed in `430fcbf`.

  **Why no sweep caught it:** every simulated cancel had run against an order
  that already had children — including the audit-8 review's own tests, which
  used the three live protection orders. A resting limit entry with no child was
  a state no test had ever constructed. Third occurrence of the reserved-stride
  root cause; see [AUDIT.md](./AUDIT.md).
- ~~**The limit assertion has no fixture test.**~~ **Closed.**
  `perpsLimitAssert.test.ts` (6 tests, sweeping every entry-leg arg position) and
  `perpsCancelAssert.test.ts` (13 tests, including the stride cases) both run in
  CI. 277 tests pass.
- **The storage-funding variant is refused, not supported.** A first-time trader
  cannot place a limit order until they have opened once at market. The shape
  has never been simulated, so the refusal is honest rather than lazy — but it
  is a real first-user limitation.

---

## 3. Pay profit out in USDC — next, and opt-in

**PEX already does this; we would not build a swap.** `output_swap_mode` is a
field on the order, and `V2_OUTPUT_SWAP.PNL_TO_COLLATERAL = 1` converts the PnL
leg into the collateral asset so the user receives USDC only. All four orders
observed on chain have it set to `0` (NONE), ours included — nobody is using it.

So the change is one field on the take-profit we already submit, plus
`min_primary_output_amount`, which is the slippage floor and is currently `0`,
meaning "accept any price". **That field is not optional if the swap is on.**

**The catch, and it lands on the worst path.** The swap goes through PEX's own
pool, not an external DEX (`quoteV2SwapExactIn` against `input.pool`), and the
quote runs `checkOutputSwapReservesNotWorsened`. If the swap would push pool
reserves past that guard — or the output falls below the minimum — **the whole
decrease fails**. Enabling this turns the exit from "fires when price hits the
trigger" into "fires when price hits the trigger *and* the pool can absorb the
swap". The take-profit that executed cleanly this morning would have become
conditional on pool state at 05:02.

**Therefore: opt-in, defaulting OFF**, until measured. And note it is chosen at
**open** time, because it is a field on the take-profit attached then — so it is
a checkbox on the order form, not a decision at close.

**Measure before coding.** Quote both modes against live pool state across the
size range we actually support and count how often `PNL_TO_COLLATERAL` fails.
If it never fails at our sizes, this is easy. If it fails at $90 notional, it is
a trap and the honest answer is to keep paying out in two assets and explain it
better in the UI.

**Useful interaction:** always-recall (item 1) pulls idle assets back into the
pool, which is exactly what `checkOutputSwapReservesNotWorsened` evaluates. So
the recall decision likely makes this swap *more* likely to succeed. Measure the
two together rather than separately.

---

## Still open

- **Everything after audit 7's remediation is unaudited**, including the orders
  read path shipped in `159e6e4`.
- ~~**No group in this codebase has ever been signed by a real wallet.**~~
  **CLOSED 2026-10-04.** All four write paths are signed: `openPosition`,
  `openLimitOrder`, `closePosition`, `cancelOrder` — the last confirmed by a
  full refund (6 USDC + 0.1 USDC keeper fee + 100,200 µALGO MBR). See
  [AUDIT.md](./AUDIT.md#cancel-measured-end-to-end-2026-10-04).
- ~~**Stop-loss is not built, but the codebase reads as though it were.**~~
  **BUILT 2026-10-05, stage one: market entries.** Optional, alongside an
  optional take-profit, in the reserved base+2 slot. `PROTECTION_ENABLED` is
  true and the placeholder that said it was not enabled is gone — the panel's
  kind-3 label and the chart's amber overlay line are reachable for the first
  time, having been written for this and inert since.

  The assertion was generalised to N legs on the way, which was the real work:
  `assertOpenWithTakeProfit` located the keeper-fee escrow by elimination ("the
  transfer that is not the collateral"), unambiguous with one child and wrong
  with two — one leg would have been checked twice and the other not at all.
  Legs are now bound by the note the SDK stamps with their own child order id.
  Six hand-maintained shape constants became `openShape(legs, storage)`,
  asserted equal to every measured constant rather than replacing them.

  **One protective leg at a time** — take-profit or stop-loss, never both —
  enforced in the card and again in the client. `PROTECTION_ENABLED`'s own
  docstring says to allow a linked pair only after a TestNet TP/SL has one leg
  execute and the sibling is observed removed. That is still unobserved; with a
  single leg there is no sibling, so the precondition is satisfied rather than
  waived. Lifting the rule needs that TestNet run and a funded TestNet account.

  **Limit entries still have no stop-loss.** `assertOpenLimitGroup` locates its
  child the same way (`submits.find(t => t !== entry)`) and so breaks
  identically, and its child leg is only partly arg-checked already. Stage two.

- ~~**Audit 9 has not run.**~~ **Ran 2026-10-04, remediated in `d45f0f5`.**
  Five findings, no ship-blocker; the serious one was a user who could not EXIT
  because the panel gated closes on the open rule. Its remediation's own review
  then caught a defect the remediation introduced — see
  [AUDIT-9-REMEDIATION.md](./AUDIT-9-REMEDIATION.md).
- **Audit 10 has not run.** Unaudited since `d45f0f5`, which is the audit-9
  remediation plus the stop-loss change (`e2adc4d`). The latter is the larger
  surface: `assertOpenWithTakeProfit` was replaced by an N-leg
  `assertOpenWithAttachedOrders`, six shape constants became a derivation, and
  the stop-loss direction guard was rebuilt twice — the first version compared
  against the index point where PEX uses the band, which review caught.

---

## Closed recently

Kept because each records HOW it was settled, which is usually the reusable part.

- ~~`doi:` is pinned against nothing.~~ **Closed** — the manifest declares it as
  `dynamic_oi_margin_config`, and `dynamicOiLayoutProblem()` checks the SDK, the
  manifest and the live box against each other. Verified agreeing 2026-09-29.
- ~~The funding field does not reconcile.~~ **Resolved 2026-09-29 by reading the
  SDK, without asking Ultrade.** `funding_fee_collateral_amount` is a GROSS
  accrued cost, forced non-negative by `max(0n, fundingFee - snapshot)` in
  `settledPosition`, so it was never a settlement and has no sign.
  `collateral_funding_net_amount` is the signed net
  (`collateralIncrease - collateralDecrease`) and equals
  `collateral_delta - collateral_amount` on **9 of 9 live positions**. Longs
  credit more often than shorts because the funding claimable TO a position can
  exceed its accrued cost, which is exactly why the gross field disagreed on
  longs and looked fine on shorts. The exit-cost itemisation is restored.
- ~~H1's keeper-fee leg was never re-tested after B6 cleared.~~ **Closed
  2026-09-29** — run, and PEX rejects a redirected keeper-fee escrow, a
  redirected collateral transfer and an inflated escrow, all with
  `assert failed`. Note the method trap recorded in
  [AUDIT.md](./AUDIT.md#open): a tamper test against a transfer must use an
  **opted-in** receiver, or "rejected" only means the receiver could not hold
  the asset.
- ~~LOW 8–12 from audit 7.~~ **Closed 2026-09-29.** The chart now uses the
  card's `formatPriceUsd` instead of a second, coarser copy; the quick-pick
  clamp says so instead of leaving the chip lit against a target it did not
  deliver; payout legs lead with the collateral asset rather than being ordered
  by raw micro-amounts across different assets; the advanced chart states that
  position lines are not drawn there; and the four false comments are corrected
  — including `parseMoney("1.")`, which returns 1 and not null.
- ~~`quoteClose`'s own assembly has no test.~~ **Closed 2026-09-29** —
  `perpsCloseAssembly.test.ts` mocks the SDK and covers the mapping layer: that
  funding and borrowing are NOT subtracted from the payout, that funding is
  reported signed from `collateral_funding_net_amount` rather than the gross
  field, that `collateral_delta` is ignored entirely, the `platform_fee_amount`
  fallback, signed impact, and withholding `payoutUsd` on an unpriceable leg.
