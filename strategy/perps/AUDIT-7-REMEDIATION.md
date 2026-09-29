# Audit 7 — remediation spec

Queued before any code is written, per the working rule that changes on this
surface are specified and reviewed rather than hot-fixed.

**Scope: every MEDIUM and above, plus the two test gaps.** LOW 8–12 are
deliberately deferred and listed at the end so they are not lost. Findings are
numbered as audit 7 numbered them.

---

## 1. Complete the signing freeze (SHIP-BLOCKER)

**Defect.** `frozen` captures four values — `quote`, `notional`,
`collateralUsd`, `tpPrice` — but the render reads six more derived flags
straight from live state: `liquidatable`, `tradable`, `tpValid`, `tpPayoff`,
`ceilingUsd`, `indexUsd`, plus `bar.minLeverage` and `bar.binding`. All of those
track `usePerpsMarket`, which replaces `data` every ten seconds, throughout a
20–40 second wallet prompt.

Worst case: one failed refresh sets `error`, which collapses
`dataTrusted → tradable → notional → quote → liquidatable` to false, and the
card — still rendering the frozen quote — prints **"Liquidation: None … it
cannot be liquidated"** over a leveraged position the user is at that moment
being asked to approve. The reverse case renders `$0.000000` as a liquidation
price, a defect previously fixed and reachable again this way.

**Fix — structural, not site-by-site.** Patching the six call sites leaves the
seventh to be found by the next audit. Instead:

- Assemble every display-derived value into one `live` object.
- `const view = frozen ?? live` — unchanged in spirit, complete in fact.
- `setFrozen(live)` on submit, so the freeze is definitionally whole.
- **Every render site reads `view.*`.** No JSX may reference a live derived
  value directly; that is the invariant, and it is what makes the next added
  field safe by default.

Snapshot fields: `quote`, `notional`, `collateralUsd`, `tpPrice`, `tradable`,
`liquidatable`, `tpValid`, `tpPayoff`, `ceilingUsd`, `indexUsd`, `minLeverage`,
`binding`.

Deliberately **not** frozen: `tpHint` (set only from the input's `onChange`,
which is `disabled` while submitting, so it cannot drift); the `CardOverlay`
effect (the chart should keep showing where the market actually is mid-signature
— that is the one place live is correct, and it is already documented as such).

## 2. The positions headline must be net of exit costs (SHIP-BLOCKER)

**Defect.** `PositionsPanel` renders `close.pnlUsd` as the bold coloured
figure with no label. `pnlUsd` is `effective_profit_usd − loss_usd` — **price
PnL only**. `closeFeeUsd`, `builderFeeUsd`, `fundingFeeUsd`, `borrowingFeeUsd`
and `impactUsd` are all present on the quote and rendered nowhere. Exit price
impact dominates. Measured across all seven live MainNet positions every row is
wrong and **two flip sign**, showing green on a position that returns less than
its collateral.

**Fix.**

- The headline becomes **net**: `payoutUsd − collateralUsd`, i.e. what the
  position actually returns against what went in. That is the number the chain
  honours, and it is already computed correctly by the `be6c092` aggregation.
- It renders **only when `payoutUsd !== null`**. An unpriceable leg withholds
  the headline exactly as it already withholds the total — a half-priced net
  figure is the same class of defect being fixed.
- Label it. An unlabelled coloured number invites the reader to supply their own
  definition, and the two available definitions differ by the amount at issue.
- Add the cost breakdown beneath, so the number is explainable rather than
  merely different: close fee, Magnet fee, funding, borrowing, price impact.
- `pnlUsd` stays visible as **"Price move"**, distinct from the net figure. It
  is not wrong, it was mislabelled; deleting it would lose the one number that
  answers "did my call go the right way".

## 3. Quick-picks must refuse an unreachable target (HIGH)

**Defect.** `priceForPayoff` solves `move = pct / leverage`. The risk bar's left
end is the $5 notional floor, so minimum leverage is 0.10×, where "+50% of
stake" is a **+500% price move** — a take-profit at 6× spot, reported valid. The
only existing guard is the typo bound at 10× entry, which does not fire. With no
close path, the result is a position whose only exit is unreachable.

**Fix.** A new bound, `MAX_QUICK_PICK_MOVE_BPS = 5000` in `perps.ts` — a quick
pick may not imply a price move of more than 50%.

- Over the bound: **write nothing**, clear the target, and say why in terms the
  user can act on — that the target needs a larger move than the bound at this
  risk level, and that raising the risk level or choosing a smaller target fixes
  it. Silently clamping would relight the chip against a price that is not what
  it says.
- **Hand-typed prices are untouched.** They remain governed by
  `takeProfitBounds`. The defect is specific to hiding a price behind a
  percentage; a typed price is visible by construction.
- Show the implied price move next to the profit line regardless, so the
  relationship between "+25%" and a price is legible at every leverage.

## 4. Disable the market toggle while signing (MEDIUM)

**Defect.** The card disables its own direction, amount, slider, chips and TP
input on `submitting`, but the market selector moved into `PerpsChartPanel` in
`6f83f0f` and `submitting` was never threaded to it. The signed group is
unaffected — `submit()` closes over `marketId` — but the labels around the
frozen quote switch markets, and once market-2 data lands the card can compute
an ALGO liquidation price against a BTC index and print "100.0% away".

**Fix.** `PerpsCard` reports busy state up via `onBusyChange`, `PerpsView` holds
it, `PerpsChartPanel` takes `disabled` and passes it to `MarketToggle`. Same
one-directional shape as `onOverlayChange`; no new coupling direction.

## 5. The info modal describes a UI that no longer exists (MEDIUM)

Two false statements, both in the section about which price you trade at — the
most safety-relevant text in the product:

- *"That figure is shown above the chart"* — the oracle badge was removed
  yesterday. It is now a dashed line **on** the basic chart, and in the order
  card's header.
- *"It is TradingView showing Coinbase"* — true only of the advanced view; the
  default is now the basic chart, Coinbase candles rendered by us.

**Fix.** Say what is actually on screen, in both views.

## 6. The chart's oracle line must clear when it stops being live (MEDIUM)

**Defect.** The `.catch` sets nothing, so the previous price persists
indefinitely while still captioned "PEX's live oracle price". `getOraclePayload`
**throws** on an over-age payload, so an oracle stall lands exactly here — the
card disables trading and the chart beside it keeps drawing a stale price. The
chart also ignores `signatureVerified`, so it draws a price the card has
refused.

**Fix.** Null the price on failure, and require `signatureVerified` before
drawing it. A missing line is honest; a stale one labelled live is not.

## 7. Positions must clear on a wallet switch (MEDIUM)

**Defect.** The effect clears `positions` only when `owner` is null. On
`A → B`, if B's load throws, A's rows stay on screen under B's wallet behind a
banner that reads as a load failure.

**Fix.** Clear at the top of the effect, as `usePerpsMarket` already does and
documents.

## 8. Tests for the two untested money-path functions

`priceForPayoff` and `quoteClose`'s output aggregation have **zero** coverage.
One is the arithmetic behind a signed trigger price; the other is the function
`be6c092` rewrote after it was found wrong in both directions on live positions.

- `priceForPayoff`: direction per side, the `pct / leverage` relationship, the
  low-leverage regime that finding 3 is about, and the null return when a
  profit exceeds what the position can pay.
- `quoteClose` aggregation: legs summed **by asset id**; two legs on the same
  asset merged; funding/borrowing **not** subtracted again; `payoutUsd` null
  when any leg is unpriceable and a number when all are priceable; zero and
  negative legs excluded.

Both against fixtures, so they run without a network.

---

## Deferred — LOW 8–12 — **all closed 2026-09-29** (`7601b12`)

Recorded so they are not lost: the chart's duplicate price formatter (one digit
coarser than the card's single source of truth); the silent quick-pick clamp,
which is within 13% of firing on ALGO longs; payout legs sorted by raw
micro-amount rather than value; no visible notice that position lines are absent
in the advanced view; and four comments that are now false (`PerpsChart`'s
"SAME signed payload", `PerpsInfoModal`'s claim about what is on screen without
interaction, `perpsChart.ts` on 1W candles, `perpsInput.ts` on `parseMoney("1.")`).

## Out of scope, and still open

The close **write** path remains blocked on Ultrade's yield-recall answer.
Nothing here adds one.

---

## What review changed, after the fact

The spec above was written before the code. A fresh review of the finished
change then found the following, all fixed before the push. Recorded because
three of them are the *same defect class the change was written to fix*, which
is worth knowing about this surface.

**The itemised cost breakdown was wrong, and is gone.** Item 2 called for
"close fee, Magnet fee, funding, borrowing, price impact" beneath the headline.
Measured against all 8 live positions, that decomposition did not add up on any
of the 5 longs — off by $0.14–$0.18 on stakes as small as $5.50 — and the entire
residual was funding: `funding_fee_collateral_amount` reports a **cost** on 5 of
8 positions where the chain in fact **credited** the trader, so the line
inverted the largest term's sign and printed it under a heading saying "costs".
`impactUsd` is also signed-favourable, so `+$0.04` under "Costs to exit" read as
$0.04 of cost.

It was not sign-corrected at the time, because the mechanism was not
established. **It has since been resolved** — by reading Ultrade's SDK rather
than asking them, on 2026-09-29: `funding_fee_collateral_amount` is a GROSS
accrued cost, forced non-negative in `settledPosition`, and the signed
settlement is `collateral_funding_net_amount`. The itemisation is restored and
the draft question was deleted rather than sent. See
[NEXT.md](./NEXT.md#closed-recently).
Publishing a decomposition we cannot derive is the same mistake as
`collateral_delta`: internally plausible, wrong at the boundary. The panel now
shows one figure — the difference between the payout and the collateral — which
is exact by construction because both ends are verified and it is defined as
their gap. The headline itself was correct and is unchanged.

**"Net" was measured against the wrong thing, and the comment said so falsely.**
The spec and the docstring both said "against what went into it".
`collateral_amount` is collateral *after* the open and builder fees: verified
exactly on the real trade, where `quoteOpen` returns `netCollateralUsd =
5.858426` for a $6 stake and the on-chain value is 5.858426. With the $0.10
keeper fee that is $0.24 of a $6 stake, 4%, invisible — and a window up to that
size where the figure reads green on a losing round trip. The original stake is
**not recoverable from chain state** (`p2:` carries only post-fee collateral),
so the basis is right and the description was wrong: the label is now "Net vs
collateral" and a note under the list states the basis.

**The freeze invariant was stated but not held.** Four live reads remained in
the JSX. One was `indexUsd` at a *second* render site — the card header — which
is exactly the "seventh site the next audit finds" that the structural fix was
chosen to prevent, and it is the value passed as `asRenderedIndexPrice12`, so
the header had stopped showing the number the drift guard guards. The other
three were advice strings derived from live `bar`/`tradable`, any of which could
turn on mid-prompt and print "No size on this side currently clears the
exchange's checks. Try a different amount." directly beneath a frozen "Position
size $174.78" the user was being asked to approve. Those three are now
suppressed while frozen rather than snapshotted: advice is only actionable when
the user can act, and during a wallet prompt they cannot.

**The chips resolved live while their message was frozen**, so they could grey
out against a payoff line still quoting the old target. Now resolved from one
memo that is frozen with everything else — which also stopped the rule being
recomputed three times per render. A *selected* chip that became unreachable was
also left green and `disabled`, so the one gesture that clears it did nothing;
selection now stays clickable and turns amber.

**The newly-displayed "a X% price move" came from the unclamped price.** Swept
3,060 resolutions: the clamp fires on 16 (0.52%), every one the +10% chip on a
$6 ALGO long at 9.5x–11x — the exact regime of the only real trade — where the
card read "a 0.98% price move" over a price that moves 1.05%. Now reported on
the price actually written.

**Clearing positions on every effect run made Refresh blank the list**, because
`tick` is a dependency. Keyed on the owner instead, so the button and the 30s
interval behave alike.

**Both oracle-line captions promised a line that can legitimately be absent** —
the chart's fetch is independent and uncached, so a transient failure removes
the line for up to 10s with no banner anywhere. Both now say it is drawn only
while the price can be read and verified.

Also: a dead `priceForPayoff` import (nothing lints in `web/`, so nothing caught
it), no `false` emitted from `onBusyChange` on unmount, and the negative-leg
case the spec asked for but the tests only covered at zero.

**Confirmed clean by the same review**, worth recording because each was a
specific worry: the freeze lifecycle clears on all four exit paths including
`SubmissionUnknownError`; `setFrozen` lands in the same React batch as
`submitting`, so there is no stale-`frozen` window; `onBusyChange` cannot loop
even with an inline lambda; the `aggregate`/`value` extraction is
behaviour-identical to the inline code including the empty case; and
`MAX_QUICK_PICK_MOVE_BPS` refuses **nothing** at or above 1.00x leverage across
3,060 swept resolutions, with 0 of 3,060 accepted chips falling outside the true
`takeProfitBounds` the write path enforces — so it is not a trade-blocking
guard.

**Still not covered by tests:** `quoteClose`'s own assembly, including the
"funding/borrowing not subtracted again" rule, which cannot be reached through
the extracted functions.
