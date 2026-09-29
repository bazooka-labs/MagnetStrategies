# Perps — what to build next

Written 2026-09-29, at the end of a working session, so the next one starts with
the reasoning rather than re-deriving it. Order is deliberate and argued below.

**None of this is built.** Everything here is a plan plus the measurements that
justify it. What IS built is in [SPEC.md](./SPEC.md#build-status--2026-09-28)
and the orders read path in
[SPEC.md](./SPEC.md#orders--read-path-built-write-path-not-2026-09-28).

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

## 1. Close write path — UNBLOCKED, build first

**Ultrade, 2026-09-29:** *"generally speaking, I would suggest always using
recall because most of the time the yield deployment doesn't leave much idle
assets… that's the safest way to ship without complicating the code or
waiting."*

That retires the question in
[YIELD-RECALL-QUESTION-FOR-ULTRADE.md](./YIELD-RECALL-QUESTION-FOR-ULTRADE.md),
and the answer is *less* code than the alternative. `yieldRecallMode` is binary,
and the SDK already derives it (`capsByAsset.some(cap => cap > 0n) ? 1 : 0`).
Always passing `1` skips the derivation; the SDK then attaches the recall
resource carriers itself — router → Folks vault → provider return path — and
adds the provider fee credit.

**Why this goes first.** A position currently has exactly two exits: the
take-profit fires, or it liquidates. That single constraint has been shaping
every other decision in the product, including the ordering of everything below
it. Closing helps everyone holding a position today; the order features help
people who do not have one yet.

**Three things to settle before building, all read-only:**

1. **Group size.** Recall adds carriers — the SDK budgets
   `3 * strategyAssets.length` for the round trip — on top of a close group that
   already carries math and budget calls. SPEC puts the ceiling at 16
   transactions. If close-with-recall does not fit, that is a design constraint,
   not a detail.
2. **Cost.** The provider fee credit has to appear in the quote the user sees
   before signing, not as a surprise in the settlement.
3. **That it simulates clean** on a real position, both markets, both sides —
   including the ALGO-profit case that raised the recall question at all.

---

## 2. Order cancel — second

`cancel_order` refunds everything. **Measured, not assumed**: paired one submit
against its own cancel and the amounts match to the microunit —
`submit_order` paid out 10.124513 USDC and 100,200 µALGO; `cancel_order`
refunded 10.124513 USDC (stake 10.073513 + keeper fee 0.051) and 100,200 µALGO.
The only cost was 34,000 µALGO of network fees across both groups. Surveyed 127
cancels overall: every one refunded, with ALGO amounts in tiers (96,500 /
99,700 / 100,200 and multiples) that track box size and how many orders were
cancelled in one call, not partial refunds.

The rule to code against is **"refunds what it took"**, not a fixed constant:
our attached-TP path paid 99,700 for its order box while `submit_order` pays
100,200, and each is refunded its own amount.

**Why before submit.** All four orders observed on chain carry
`expiry_time = 0` — good-till-cancelled. So for an order with no cancel path the
complete list of exits is (a) it executes, or (b) somebody calls the paid
cleanup, which nobody is obliged to do. Shipping submit first would create
orders nobody can retract. Cancel is also the smaller group — one app call, no
oracle payload, no price to get wrong — and the only write path here that
*reduces* locked user money.

**Guard it needs:** cancelling a take-profit on a live position removes that
position's only exit. That has to be said at the confirm step, not discovered
afterwards. Once the close path exists this is less severe, but it is still a
deliberate removal of protection.

---

## 3. Limit orders (`OPEN_LIMIT`) — third

Stage 1, reading resting orders, is built and shipped. Stage 2 is submit.

`V2_ORDER_KIND.OPEN_LIMIT = 1`, with `buildV2OpenLimitWithAttachedOrdersTransactions`
for a limit entry carrying its own take-profit.

### The B6 check is DONE, and it found the same class of defect (2026-09-29)

`OPEN_LIMIT` with an attached take-profit **builds and simulates clean** — but
only after a fix, and the unfixed failure is exactly the kind that would have
cost another week.

**Shape**, confirmed against MainNet: 7 transactions bare, 10 with a take-profit.

| | |
|---|---|
| `[0]` axfer | collateral **+ keeper fee** in one transfer (6.10 USDC for a $6 stake) |
| `[1]` pay | **100,200** µALGO — the parent order box MBR. Note this is the `submit_order` figure, not the 99,700 our market-open path pays |
| `[2]` appl | OrderOps — the `OPEN_LIMIT` parent, as `BRACKET_PARENT` |
| `[3]`–`[6]` appl | math carriers (`m2:`, `mr2:`, `mp2:`, `mo2:`, `mf2:`, `vi2:`, `ma2:`, `my2:`, `doi:`) |
| `[7]` axfer | the child's own keeper fee |
| `[8]` pay | **99,700** µALGO — the child order box MBR |
| `[9]` appl | OrderOps — `submit_linked_order` for the child |

**The defect: the SDK's builder under-declares its own box references.** Raw, it
fails at transaction `[2]` with `logic eval error: invalid Box reference
0x6f323a…` — `o2:` plus the owner. Simulating with `allowUnnamedResources: true`
passes and reports what was actually touched:

    app=3690309166 name="o2:" orderId=2
    app=3690309166 name="o2:" orderId=3

The builder declares only the **base** order's box. The contract touches the two
**sibling slots** the stride reserves — which is precisely why
`ORDER_ID_STRIDE = 3` and `allocateBaseOrderId` reserves
`[base, base+1, base+2]`. It happens **with no take-profit attached at all**, so
an `OPEN_LIMIT` as `BRACKET_PARENT` always claims its child slots.

**Fix, verified:** declare `o2:` boxes for `baseOrderId + 1` and `baseOrderId + 2`
on a carrier with spare box slots (the submit call's four are full), then
**re-assign the group id** — mutating after `grouped()` invalidates it and algod
rejects the group as incomplete. With that, both shapes simulate `ok: true`
honestly, with no `allowUnnamedResources`.

> **Do NOT set `allowUnnamedResources` in `simulateGroup` to make this pass.**
> Simulation auto-fills the missing reference; a real submission has no such
> auto-fill and would fail on chain. It would manufacture a false green on the
> one check that stands between a group and a wallet. The flag is a *diagnostic*
> — use it to learn what is missing, then declare it.

`L7RF6SLJVI…` had a working bracket on chain as a reference; note their limit
order has since executed, so that example is gone — ALGO crossed $0.14 overnight
and took several resting orders with it.

**The design problem, which is the real work.** Every risk figure the card
displays — entry, liquidation, price impact, "% away" — comes from `quoteOpen`
at the **current** index. For a limit order those are estimates at a
*hypothetical* future execution. Concretely, the resting order measured on
2026-09-28 was a short, $90 notional on a $10.08 stake, trigger $0.14 against a
$0.1316 spot: every index-derived number would have been computed at a price
6.4% away from where it fills, and the liquidation price is roughly proportional
to entry.

Worse, **the error does not reliably point the safe way** — its direction
depends on the side *and* on whether the trigger sits above or below spot, so a
long buying a dip and a short selling a rally get errors in opposite directions.
No conservative fudge covers both. Notional, stake, our fee and the keeper fee
are all fixed at submission and display correctly; it is specifically the
price-derived quantities that become hypotheticals. A naive build shows one box
where four numbers are facts and three are guesses, undistinguished.

Three honest options, none chosen yet: label them as estimates at the trigger
price; show only the figures that are facts and omit the rest; or quote them
*at* the trigger price and say so plainly.

**One risk to simulate rather than assert:** leverage is fixed at submission
(`size_usd_delta` and `collateral_amount` are both stored), but whether PEX will
*accept* that size when the keeper fires depends on open-interest headroom at
that moment. Both markets are OI-capped well below typical demand. If an order
can sit at the right price and still fail to fill because the side is full,
users have to be told — it is not intuitive.

---

## 4. Pay profit out in USDC — fourth, and opt-in

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

## Still open, unchanged

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
- **Everything after audit 7's remediation is unaudited**, including the orders
  read path shipped in `159e6e4`.
