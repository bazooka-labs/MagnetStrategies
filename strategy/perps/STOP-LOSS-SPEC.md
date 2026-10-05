# Stop-loss — build spec

Written before the code, 2026-10-05. Closes the gap recorded in
[NEXT.md](./NEXT.md): `stopLossPrice12` exists, is hardcoded `null`, and nothing
can create a `DECREASE_STOP_LOSS` order — while `PositionsPanel` labels order
kind 3 "Stop loss" and `PerpsView` draws an amber line for it. The code reads as
though the feature ships.

## What is being built

A stop-loss is an optional second attached order, on the same footing as the
optional take-profit.

**Staged, and this change is stage one: MARKET entries only.** All four
combinations on that path — bare, TP only, SL only, TP and SL.

The limit path is deliberately left for a second change. Not because it is
hard, but because `assertOpenLimitGroup` locates its child the same way the
market path did — `submits.find((t) => t !== entry)`, by elimination — so it
breaks identically with two legs and needs the same generalisation. That is a
second substantial edit to the module audit 8's ship-blocker lived in, and
audit 9 already recorded that the limit child leg is only partly arg-checked
(`C[1..6]`, `C[8]`, `C[11..14]` unchecked). Compounding a known weakness and
rewriting a locate in one change is how SB1 happened. One at a time, each
reviewed.

PEX already supports this. `V2MarketOpenWithAttachedOrdersInput` and
`V2OpenLimitWithAttachedOrdersInput` both carry `takeProfit?` and `stopLoss?` as
independent `V2AttachedOrderLegInput`s, and `ORDER_ID_STRIDE` already reserves
base+2 for exactly this (`v2ExpectedLinkedChildOrderId`: TP is base+1, SL is
base+2). Nothing new is needed from the protocol.

---

## 1. The assertion must stop locating the leg by elimination

**This is the part that matters, and it is a correctness fix regardless of
stop-loss.**

`assertOpenWithTakeProfit` finds the keeper-fee escrow like this:

```ts
const escrow = transfers.find((t) => big(t.assetTransfer!.amount) !== shownOpen.collateralAmountMicro);
```

"The transfer that is not the collateral." With one child that is unambiguous.
With two children there are **two** such transfers and `.find` returns the first,
so one leg's escrow — amount, receiver, asset, cap, note — would go completely
unchecked, and the leg that *was* checked might be the other one.

The escrow carries a note the SDK stamps with the child's order id:
`pdex-v2-linked-escrow-<childOrderId>`. The assertion already verifies that note.
**Locate by it instead**, so each leg is bound to its own transfer by identity
rather than by exclusion.

Any transfer that is neither the collateral nor a recognised leg escrow is a
finding, not an ignored extra.

### Generalise the signature

```ts
export type DisplayedLeg = DisplayedTakeProfit & {
  /** V2_ORDER_KIND: 2 = take-profit, 3 = stop-loss. */
  orderKind: number;
  /** base+1 for a take-profit, base+2 for a stop-loss. */
  childOrderId: bigint;
};

export function assertOpenWithAttachedOrders(
  txnsIn: unknown[], shownOpen: DisplayedOpen, legs: DisplayedLeg[],
): GroupAssertion
```

`assertOpenWithTakeProfit` is **removed**, not kept as a wrapper. A wrapper would
leave the single-leg locate-by-elimination path alive, which is the defect.

Every field the take-profit leg checks today is checked per leg, including the
one the current comment singles out: the child's **own** `builderFee`, which
overrides the parent's because the child input spreads `...parent, ...leg`.
Pointed at an attacker that takes 10 bps of close notional from inside PEX with
no transfer in our group at all. That check must run for the stop-loss leg too —
it is the whole reason this is not a cosmetic change.

Each leg additionally asserts its `orderKind` is the kind the screen named, and
that its `childOrderId` is the slot that kind belongs in (`base+1` / `base+2`).
Crossing those silently turns a stop-loss into a take-profit.

## 2. Derive the shapes, do not hand-write four more

There are `SHAPE_OPEN`, `SHAPE_OPEN_STORAGE`, `SHAPE_OPEN_TP`,
`SHAPE_OPEN_TP_STORAGE`, `SHAPE_OPEN_LIMIT`, `SHAPE_OPEN_LIMIT_TP`. Adding a
second leg naively doubles that to twelve hand-maintained constants.

Each attached leg costs exactly: **+1 axfer** (keeper fee), **+1 pay** (order-box
MBR), **+1 OrderOps call**. So:

```ts
export const openShape = (legs: number, fundsStorage: boolean): GroupShape => ({
  axfer: 1 + legs,
  pay: legs + (fundsStorage ? 1 : 0),
  applMin: 1 + legs + (fundsStorage ? 1 : 0),
  applMax: 9 + legs + (fundsStorage ? 1 : 0),
  trading: fundsStorage ? 2 : 1,
  orderOps: legs,
});
```

The existing constants are kept and **asserted equal** to `openShape(0|1, …)` in
a test. If the derivation disagrees with a shape that was verified against real
MainNet output, the derivation is wrong — the measured constant wins, and the
test says so. Audit 8's SB1 was a shape/offset error that passed everything
anyone ran; a derivation checked against the measured values is the cheapest
guard against repeating it.

`orderOps` on the open shapes is currently `0` (audit 8 HIGH 4 — an injected
`cancel_order` in a close group). It becomes the leg count, which preserves that
control: a group may carry exactly as many OrderOps calls as it has legs.

## 3. Direction: a stop-loss trigger sits on the other side of the index

`quoteTakeProfitCrossed` refuses a take-profit already past the index. The
stop-loss mirror:

| side | take-profit | stop-loss |
|---|---|---|
| long | **above** the index | **below** the index |
| short | **below** the index | **above** the index |

A stop-loss on the wrong side fires immediately on submission, closing the
position at a loss the moment it opens. Refuse it in the client, and grey the
submit in the card with the reason — the same treatment the crossed take-profit
gets.

Also **warn, do not block**, when a long's stop-loss sits at or below the
liquidation price (or a short's at or above): the position is liquidated before
the stop can fire, so the protection is decorative. The user may still want it
— liquidation price moves with funding — so this is a sentence on the card, not
a refusal.

## 4. What leaves the wallet

`moves` already derives the keeper-fee count and box MBR from whether a target is
set. Both become **leg counts**:

```ts
const legs = (tpSet ? 1 : 0) + (slSet ? 1 : 0);
```

A second leg is a second $0.10 keeper fee and a second 99,700 µALGO box. The
disclosure understating that is exactly the regression audit 8 recorded, so the
fee table in that comment gains the two-leg rows **measured**, not assumed —
this spec does not claim figures it has not seen.

## 5. UI

A stop-loss input mirroring the take-profit one: optional, same validation
shape, its own quick-pick percentages (below for a long, above for a short),
its own hint line. Both inputs live in the same section with the take-profit
first.

`CardSnapshot` gains the stop-loss fields. Audit 7's lesson applies directly:
every displayed value is frozen at signing, and a field added to the card
without being added to the snapshot is read live at the render site. The
snapshot is the default; the JSX reads `view.*` only.

`PositionsPanel`'s kind-3 label and `PerpsView`'s amber overlay line stop being
dead scaffolding and start being reachable. No change needed to either — which
is the point: they were written for this and have been inert.

## 6. Tests

- The arg sweep that `perpsLimitAssert.test.ts` applies to the entry leg,
  applied to a **stop-loss** leg: every argument position bound, including
  `orderKind` and the child's own builder tuple.
- A two-leg group where the TP and SL escrows are **swapped**: must fail. This
  is the case locate-by-elimination cannot catch and is the reason for §1.
- A two-leg group with a second escrow whose note names neither child: must
  fail rather than be ignored.
- Direction: a long with a stop-loss above the index is refused; below is
  accepted. Mirror for a short.
- `openShape(0, false)` equals `SHAPE_OPEN`, `openShape(1, false)` equals
  `SHAPE_OPEN_TP`, and so on for every existing measured constant.
- Each new guard verified to FAIL when its fix is reverted, as with the audit-9
  work. A guard that has not been seen to fail is not known to be a guard.

## 7. Out of scope

- **Adding a stop-loss to an existing position.** That is a standalone
  `submit_linked_order` against a live position, a different write path with its
  own shape and its own assertion. Attach-at-open first; the panel can gain
  "add protection" later.
- **Editing or moving a stop-loss.** Cancel and re-place.
- **Trailing stops.** PEX has no trailing order kind; it would have to be
  client-side, which means it stops working when the tab closes. Not worth
  shipping as a protection feature that silently depends on a browser being open.

## Done means

`tsc` clean, `next build` clean, the full suite green, every new guard seen to
fail when reverted, and the fee figures in `moves` measured on a real group
rather than predicted. Then a fresh adversarial review before pushing, per the
standing rule — the last two changes to this module both had a defect that only
review caught.

---

# What the pre-push review changed

Two ship blockers, both **outside** the assertion rewrite. The rewrite itself
came back clean: all 46 `fail()` codes from the old single-leg function have a
counterpart, four folded into stronger checks, and two early-returns became
`continue` so a later check now runs that used to be skipped.

## BLOCKER 1 — the direction guard compared against a POINT; PEX uses the BAND

The guard was `trigger >= oracle.indexPrice12` for a long. PEX's own rule,
`v2OrderCrossedByOracle`:

```js
DECREASE_STOP_LOSS: crossed = side === LONG ? indexMin <= trigger : indexMax >= trigger
```

and `indexMin <= indexPrice <= indexMax`. So **every long stop in
`[indexMin, indexPrice)` passed the guard and was crossed by PEX** — firing on
arrival, opening and closing the position in one group, under a card that had
just said the loss was capped.

This codebase had already measured that exact window for the take-profit:
`perpsQuote.ts` records a 0.188% gap on live ALGO/USD costing **$1.58 on a $50
stake, 3.2%, and no position**. The fix then was to move the edge to the band
plus `CROSS_MARGIN_BPS`. The stop-loss got neither — under a comment calling
itself "the mirror of the take-profit crossing guard".

Fixed with both layers the take-profit has: `stopLossBounds` (band + margin) in
the client and the card, then PEX's own verdict via
`quoteProtectiveOrderCrossed`, which was `quoteTakeProfitCrossed` with the kind
hardcoded — the only thing missing was the argument.

The guard had **no tests**, which is why it survived. It has them now, including
one that fails if the edge regresses toward the index point.

## BLOCKER 2 — the input was live on the limit path, which discards it

`PROTECTION_ENABLED ?` had no `!isLimit`. `openLimitOrder` takes no
`stopLossPrice12`, so a limit user was offered a stop, told it capped their
loss, had `legCount` charge them a second keeper fee and a second 99,700 µALGO
box the group never creates, could be blocked from submitting by a stop that
would never exist — and the mode toggle did not clear it, so a stop typed in
market mode followed them into limit mode. `NEXT.md` documented the limitation
and the UI did not enforce it.

Gated on `!isLimit`, cleared on toggle, excluded from `legCount` and `slOk`.

## `PROTECTION_ENABLED` was flipped past its own precondition

The docstring three lines above said to flip it **only** after a TestNet
TP/SL pair has one leg execute and the sibling is observed removed. That is
unobserved, and the code asserted both states at once.

Resolved rather than waived: the flag is on, and **one protective leg at a time**
— take-profit or stop-loss, never both — enforced in the card and again in the
client. The precondition is about OCO; with a single leg there is no sibling to
orphan, so the question does not arise. The two-leg machinery stays built,
asserted and tested behind that rule, and lifting it needs the TestNet
observation the docstring always asked for.

## Smaller findings, all fixed

- **The two-leg fee was 53,000, described as erring high. It erred LOW by
  15,000.** The OrderOps submit is 14,000 — a flat protocol fee, not a 1,000
  congestion minimum — and a second child forces a second Math carrier. 68,000,
  derived from the captured fixture. Unreachable behind the one-leg rule, but a
  wrong number waiting behind a flag is still wrong.
- **`GROUP_FEE_HEADROOM_MICRO` was flat 60,000**, sized for one leg. Two legs
  could pass the ALGO check and then be rejected by the node for overspend. Now
  `groupFeeHeadroomMicro(legs)`.
- **`orderKind` lost its pinned anchor** in the rewrite: it became
  caller-supplied with nothing constraining it, so kind 7 fell through to
  "take-profit" and base+1 and asserted green. Range-checked against the two
  pinned kinds. This was the single genuine weakening in the rewrite.

## Still open, and honest about it

- No **two-leg group has ever been built**, in production or in test. The
  swapped-escrow and unknown-note cases from §6 remain unwritten because there
  is no two-leg fixture to write them against. The one-leg rule means nothing
  reaches that path today, which is a reason it is safe to ship, not a reason
  the tests are unnecessary.
- `applMax`'s comment claimed only a second leg adds one call; it adds two
  (`buildV2LinkedOrderMarketResourceCarrierCalls` emits two carriers above one
  child). The bound still holds; the stated reason was wrong.
