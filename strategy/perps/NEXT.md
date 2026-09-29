# Perps — what to build next

Written 2026-09-29, at the end of a working session, so the next one starts with
the reasoning rather than re-deriving it. Order is deliberate and argued below.

**None of this is built.** Everything here is a plan plus the measurements that
justify it. What IS built is in [SPEC.md](./SPEC.md#build-status--2026-09-29)
and the orders read path in
[SPEC.md](./SPEC.md#orders--read-and-write-paths-built-2026-09-28-extended-2026-09-29).

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

## 1. Close write path — UNBLOCKED, and now the only large gap

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

**Why this goes first.** A position still has exactly two exits: the take-profit
fires, or it liquidates. Everything else on this list is now built, so this is
the last large capability missing — and the one that every open position today
is waiting on. It is also what makes the "cancel your only exit" warning in the
orders panel stop being necessary.

### Blocked on one value (2026-09-29)

Investigated to the point of a precise question, which is drafted in
[CLOSE-RECALL-QUESTION-FOR-ULTRADE.md](./CLOSE-RECALL-QUESTION-FOR-ULTRADE.md)
and **not yet sent**.

**Recall really is required**, as Ultrade said: `decrease_or_close` with
`yieldRecallMode: 0` builds and then fails in simulation at `inner tx 0` on a
live ALGO/USD long. The no-recall path is not an option even when it looks like
one.

With `yieldRecallMode: 1` the build throws `marketYieldRegistry is required for
xALGO action recall`. That fires whenever a recall cap lands on native ALGO —
always, for an ALGO/USD long, because the PnL leg pays in ALGO. The path then
reads **exactly one field**, `xalgo_provider_fee_credit_per_call_microalgos`,
and uses it only to raise `flatFeeMicroAlgo`.

Everything else is already local: the recall caps come from our own close
quote's per-asset outputs, and `mxac:` carries the rest of the xALGO strategy
config on chain. That one fee constant is in no box we can find.

The SDK's supported route is a POST to `/v2/market-yield/action-recall-plan`.
That is a **different trust shape from the oracle** — the oracle is a static
published file with no server in the path, while this is a live service whose
response would feed a group the user signs.

### The registry is constructible from chain — build it, do not fetch it

Traced further on 2026-09-29, and the API turns out to be avoidable. Everything
`marketYieldResourceClosureFromRegistry` reads is app ids, asset ids and box
keys — configuration, not live state — and every piece is either already pinned
or sitting in a box:

| Registry field | Source |
|---|---|
| `markets_app_id`, `market_yield_vault_app_id`, `market_xalgo_yield_vault_app_id` | already pinned in `PEX_APPS` |
| `xalgo_consensus_app_id`, `xalgo_asset_id` | **`mxac:`** on the xALGO vault — read live: `1134695678` and `1134696561` |
| `folks_pool_app_id`, `f_asset_id` | **`yc2:`** on the yield vault — read live: `971372237` and `971384592` |
| `market_yield_recall_flat_fee_micro_algos`, `action_recall_uses_router` | have SDK defaults |
| `xalgo_provider_fee_credit_per_call_microalgos` | **the only one with no on-chain source** |

And that last one only raises `flatFeeMicroAlgo`. **Overpaying a fee is safe;
underpaying just fails**, and our own `MAX_GROUP_FEE_MICRO_ALGO` already bounds
how far it can go. So it can be over-provisioned and the number confirmed by
simulation rather than by asking — the chain says whether it is enough.

So the recommended shape is: derive the registry locally from the pinned ids
plus `mxac:` and `yc2:`, over-provision the fee credit, and keep the API out of
the signing path entirely. Ultrade's answer then confirms a constant rather than
unblocking the build.

**Not finished.** The build currently stops at `Input is not a 64-bit unsigned
integer`, somewhere in the field plumbing that has not been isolated, and it is
not yet established whether `xalgo_proposer_addresses` — which the xALGO branch
appends to `accounts` and which is in neither box — is needed in practice or
only when proposers must be named. Both are ordinary debugging against
simulation, not open questions.

**The other things to settle, all read-only:**

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

## 2. Limit orders — **BUILT 2026-09-29**

Place, read and cancel, each with its own assertion. Shapes, the SDK's missing
box references, the two deliberate refusals, the cancel refund measurements and
the conditional-quote decision are all in
[SPEC.md](./SPEC.md#orders--read-and-write-paths-built-2026-09-28-extended-2026-09-29).

**What is NOT done, and matters:**

- **No group on this path has been signed by a real wallet.** Same standing gap
  as the market path, now across three more write paths.
- **Cancel has never been simulated against a live order** — there were none
  resting when it was written. The assertion and four tampers are verified; the
  contract round trip is not. One placed order closes this.
- **The limit assertion has no fixture test.** Verification was a live network
  probe, which does not run in CI. `perpsGroupReal.test.ts` works from captured
  fixtures and the limit shape needs capturing the same way — the difference
  between "verified once" and "stays verified".
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
- **No group in this codebase has ever been signed by a real wallet.** The
  market open path has had one real signature — our own trade on 2026-09-28,
  which opened and closed successfully — but `openLimitOrder`, `cancelOrder`
  and the close path have had none.
- **Audit 8 has not run.** Its scope is written up in
  [AUDIT.md](./AUDIT.md#unaudited-surface-2026-09-29--scope-for-audit-8) and is
  larger than audit 7's: three new write paths, plus a deliberate **relaxation**
  of `checkMathCarriers`, which the market path also depends on.

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
