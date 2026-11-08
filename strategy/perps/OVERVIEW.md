# Perps

Perpetual positions on Algorand, shipped as a full trading surface — **"Trading
Terminal"** in the UI. A product in the [Strategy](../OVERVIEW.md) arm.

> This opened as a deliberately non-terminal five-input purchase flow, and said so
> right here. That decision was reversed on 2026-09-29 once the surface grew market
> and limit entries, an optional take-profit, closing and cancelling. The reasoning
> on both sides is kept below rather than deleted.

Perps does not operate an exchange. It integrates **PEX**, a third-party perpetuals
protocol built by Ultrade. Magnet Strategies writes no exchange contracts, custodies
no user funds, and holds no protocol role.

**Status (2026-10-04):** The **open path is complete** — config, on-chain reads, the
risk-bar solver, oracle verification, the quote layer, group construction and the
signing flow, including an attached take-profit. The **full lifecycle has now run on
MainNet** — opened, and closed by its own take-profit, unattended, 2026-09-29.
**The write paths are complete** (2026-09-29) — open at market or as a resting
limit order, read, cancel and **close**, each with its own group assertion.
Closing verified across every live MainNet position. A take-profit is now
optional rather than mandatory, which it could not be until closing existed.
**All four write paths have now been signed by a real wallet and settled on chain**
(2026-10-04) — `openPosition` (with and without a take-profit), `openLimitOrder`,
`closePosition`, `cancelOrder`. That gap stood open across eight audits. The one
group shape still unexercised by a real signature is `SHAPE_OPEN_STORAGE`, which
needs a first-time trader opening with no target.

No contract is deployed because none exists. **Audit 9 ran on 2026-10-04** —
five findings, no ship-blocker — and was remediated in `d45f0f5`.

**Stop-loss ships on market entries** (2026-10-05), one protective leg at a
time: take-profit or stop-loss, never both, until PEX's sibling cleanup is
observed on TestNet. Limit entries do not carry one yet.

**Route: `/trade`, nav: Trade** (2026-10-05). The product outgrew living under
"Strategy" — nobody scans a nav for that word wanting a leveraged perps screen —
so the nav now splits the arm by what the user is actually doing. The arm itself
is unchanged and still groups this with the CLMM pools and vaults to come; see
[../OVERVIEW.md](../OVERVIEW.md#why-the-arm-spans-two-nav-items). `/strategy`
308-redirected here at the time; that redirect was removed on 2026-10-20 when
Strategy Pools took the route, and both are now nav items in their own right.

The directory and component names still say `perps` and `strategy`; the UI says
Trading Terminal and Trade. Those are labels, not a restructure.

**No sub-brand, deliberately.** MagnetFi has its own wordmark because it is a
Magnet protocol. This is an INTERFACE onto PEX — we write no exchange contracts,
custody no funds and hold no protocol role, and the About modal says so. A
"MagnetTrade" mark would claim the opposite, and a logo asserts that more loudly
than any sentence can withdraw it. The arrival splash uses the parent mark with
the product name set in type. If we ever run our own matching engine, it gets a
brand then, when the claim is true.

Detail: [SPEC.md](./SPEC.md#build-status--2026-09-29) for what is built,
the Open items below for what is left,
[AUDIT.md](./AUDIT.md#open) for what is open.

> **Its own tree inside Strategy, deliberately.** Perps was briefly its own top-level
> arm, and placing it inside [`predict/`](../../predict/) was considered and rejected.
> Predict's identity is that its products are **mUSD-denominated** and
> **user-to-user** — *"the protocol never takes the other side of a position, holds no
> inventory, and carries no directional risk."* Perps breaks all three: it is
> USDC-denominated, it trades against a pool that does take the other side, and it
> carries third-party protocol risk. A user who has learned Predict's guarantees would
> import them here, where they do not hold.

---

## What Perps Is For

**A leveraged position in five inputs.** A market, long or short, an amount in USDC,
a risk level, and a price to take profit at. Optionally a protection level. Sign once.

**Two markets, both live: ALGO/USD and BTC/USD.** They are not interchangeable and
nothing about them is shared. BTC/USD is **synthetic** — the pool owes
BTC-denominated PnL while holding ALGO and USDC, with nothing offsetting — and its
dynamic-OI factor is 641,026 against ALGO's 1,000,000, so a ceiling solved with
ALGO's number is wrong on BTC. Every figure the card shows is read per market,
including the price, which comes from that market's own verified oracle payload
rather than a separate display feed.

**Renamed in the UI to "Trading Terminal" on 2026-09-29.** The paragraph below is
kept because it records a real decision and why it was reversed, not because it
still holds. The product shipped as a five-input purchase flow that deliberately
avoided the term; it has since grown market and limit entries, an optional
take-profit, closing, cancelling, charts with drawing tools and live funding
rates. At that point insisting it is not a terminal misleads the user rather than
protecting them. The route, the component names and the `perps` tab key are
unchanged — this is a label, not a restructure.

The original position, now retired: it was deliberately **not** a trading
terminal, and deliberately **not** framed as hedging. An earlier draft built it around protecting an existing holding — *"protect
against a drop"* — and that framing was dropped because it forces the user to hold two
models at once: their own exposure, and an instrument that moves opposite to it.
**Long and short are one step.** The target user still wants speed and simplicity;
they just arrive knowing which way they think the price goes. Teams wanting the full
trading experience will build that; this is the quick path.

The leverage control is a **risk bar**, not a set of named tiers. That is not
cosmetic — it is the answer to a structural problem. Effective leverage on PEX falls
as side open interest rises, so any fixed multiple has an open-interest level above
which it simply cannot be delivered. Named bands go dark with no story to tell the
user. A bar whose ceiling tracks the venue never does, and it makes liquidation
distance something you watch move rather than a number attached to a tier name.

Revenue comes from PEX's native builder-fee rail — a permissionless 10 bps of notional
on positions, recorded on-chain in the order box. No contract of ours, no custody, no
separate fee collection.

### Bringing flow to a thin venue

PEX is new and thin, and Perps is partly an attempt to bring flow to it. One caveat,
established by measurement rather than assumption: **pool growth alone does not unlock
capacity.** Position size is bounded by `max_open_interest`, an admin-set constant,
while the reserve check that scales with the pool sits well above it.

That gap was raised with Ultrade and acted on — the ALGO/USD cap moved from $960 to
**$1,500** a side on 2026-09-23, and they intend to keep raising it incrementally
against observed liquidity. The structural point stands regardless of the number:
more LP deposits change nothing until Ultrade raises the cap, and more trading
*reduces* available leverage unless they lower the dynamic-OI factor. Current measured
figures live in [SPEC.md](./SPEC.md#measured-mainnet-state--2026-09-21); treat any
figure quoted in prose as stale.

---

## Commitments

Arm-wide commitments — non-custodial, no shared dependency with MagnetFi solvency,
disclosure — are in [Strategy's OVERVIEW](../OVERVIEW.md#commitments) and are not
repeated here. One commitment is specific to this product:

**No contract of our own, for as long as that remains true.** Every economic action is
a PEX call signed by the user's wallet. The attack surface is what our frontend
constructs and what our interface claims — not what a contract of ours can be made to
do. Any proposal that adds a contract changes the threat model in [SPEC.md](./SPEC.md)
and requires re-review.

This is **not** an arm-level guarantee. Other Strategy products may ship their own
contracts; a user must not carry this assurance across from Perps to them.

Under the arm's dependency rule Perps is clean: it reads PEX state and touches no
MagnetFi state at all.

---

## Open items

Carried over from the former `NEXT.md` on 2026-10-27 and each re-checked
against the code at that date.

**ALGO collateral is LIVE — 2026-11-05.** Supersedes the "PARKED" note that
stood here: ALGO opens and closes both work and are no longer refused before
signing. The assertions were widened in `35b988d` (`pinnedPoolAssets`, which
admits ALGO and USDC only and fails `pool_asset_unpinned` on anything else),
and the UI gate that outlived that fix was lifted in `b5a3472`. A real close
settled on 2026-11-05: 196.888673 ALGO collateral in, 194.386612 ALGO +
12.259258 USDC out, builder fee exactly 10 bps, reconciled to the microALGO by
two independent audits.

**The post-hoc review is closed — `65d2755`, 2026-11-06.** The gate lift was
shipped before the review this repo's rules require on a money path, because
funds were trapped; the review ran afterwards and both reviewers confirmed the
lift itself was safe. They found four defects *around* it, all now fixed and
specified in [SPEC.md](./SPEC.md#the-close-panels-figures--what-may-be-shown):

- `closeColUsd` returned base units as dollars for non-USD collateral — a
  2,070,238 µALGO builder fee rendered **"$2.07" against a true $0.19**. It
  returns `null` now and the cost fields are nullable, so the compiler found
  every consumer.
- The "Exit costs, net" itemisation did not sum to its own headline; the gap
  was the claimable funding leg. The panel reconciles and withholds on
  disagreement.
- The card printed figures from quotes **PEX had already refused** — `ok:
  false` still carries whatever the SDK computed before giving up.
- The close path read no account state, so a holder not opted into the payout
  asset had **no exit** and a raw logic-eval error. Pre-emptive: all 33
  position boxes were checked and every holder was already opted in.

The lesson is recorded as doctrine, not just a fix: a gate added as a
workaround needs a test naming the condition that removes it, or it outlives
its cause. This one disabled ALGO closes for two days after the assertion it
was waiting on had already been widened.

### What a close actually pays out — measured, all eight (2026-11-08)

Recorded here because this was re-derived from scratch during a design
discussion, and the absence of a written answer cost an hour.

A close pays out **by asset**, aggregating four fields: `primary_output_amount`
(net collateral), `pnl_output_amount`, and `claimable_long_token_output` /
`claimable_short_token_output` — see `aggregateCloseOutputs` in
`pex/quote.ts`. On market 1 the long and short assets are ALGO and USDC, so a
claimable funding leg can pay ALGO out of a USDC position and vice versa.

Every close either wallet has made:

| Date | Collateral in | Paid out |
|---|---|---|
| 10-04 | 15 USDC | 25.656776 ALGO + 5.918314 USDC |
| 10-05 | 6 USDC | 6.859498 USDC |
| 10-07 | 10 USDC | 8.877715 USDC |
| 10-07 | 7 USDC | 13.140676 USDC |
| 11-04 | 150 ALGO | 149.557022 ALGO + 0.074016 USDC |
| 11-05 | 200 ALGO | 196.456850 ALGO + 12.259258 USDC |
| 11-05 | 210 ALGO | 203.455452 ALGO + 10.407770 USDC |
| 11-08 | 200 ALGO | 194.553455 ALGO + 3.810866 USDC |

**A single-asset payout is not a property of USDC collateral.** Three USDC
closes paid USDC alone and one paid 25.66 ALGO beside it; the difference is
whether a claimable funding leg accrued, which scales with time held — the
two-asset one ran about two days, the clean ones hours. Do not read "USDC in,
USDC out" as a guarantee.

**The terminal signs ONE group for a close.** `closePosition` is the only
thing `doClose` calls, the group on chain is `Trading.82f0edaf` plus nine
price calls, and `outputSwapMode` is pinned to `0` at every call site and
asserted as `0` by the group check. There is no swap leg in it.

**The USDC leg is converted afterwards, in a separate group.** Measured at
+43s, +52s and +71s after the three ALGO closes, for amounts matching the
close exactly (10.407770 and 3.810866 USDC), routed through different DEX
apps that share one fee address — an aggregator. Haystack appears in exactly
four files in the tree, all of them the Magnet Token page's swap widget, and
none under `strategy/`.

> **Answered 2026-11-08.** The automatic two-group swap is real, and it is
> the **C-Vault exit in Strategy → Vaults**, not the Trading Terminal. Traced
> from round 66620036: a 13-transaction `cvaVault` group
> (`withdrawFromMarket` 92ad0e57 + `markMarket` 7eda6c29) at 02:23:22Z,
> followed **five seconds later** by a 7-transaction `SwapOps` group turning
> 106.740994 ALGO into 9.716760 USDC. Five seconds is one user action, not
> two.
>
> `cvaClient.ts` builds both under the heading *"One signature, two groups"*:
> a withdrawal (15 txns) plus a swap (7) exceeds Algorand's 16-transaction
> GROUP cap, but a signing REQUEST has none — ARC-0001 `signTxns` takes an
> array spanning several groups, the wallet prompts once, and each group
> evaluates independently. It also explains the rest of the founder's
> description exactly: the groups are **not atomic with each other**, so a
> swap that fails leaves the user holding both assets, and the swap is sized
> to the exit's on-chain **floor** rather than its simulated output —
> `dustAlgoMicro` is the deliberate remainder, surfaced in `CvaActions` as
> "plus N ALGO that could not be converted".
>
> So the terminal still signs one group and still pays two assets. Nothing
> about the close path changes. What changes is the **estimate for building
> it**: the pattern, the group-cap workaround, the one-prompt signing, the
> floor-based sizing and the dust accounting all already exist in this
> repo and are proven on mainnet. A perps version is a port of
> `buildAlgoToUsdcSwap` run in the other direction, not a design problem.

### Open, pinned for a decision — ALGO close (2026-11-05)

Neither of these loses money. Both are judgement calls deliberately left to
the founder rather than settled in passing.

1. **"Net vs collateral" values ALGO collateral at the CLOSING price**, so it
   hides the collateral's own dollar move. On the close above the card showed
   **+$12.03**; against what that ALGO was worth when it was deposited the
   result was about **+$10.85** — the card flatters a falling-ALGO trade by
   ~11%. The label does say the basis, but a green figure reads as profit. The
   original stake is not recoverable from `p2:` (it carries post-fee collateral
   only), so changing this means choosing a different definition of "net", not
   just fixing a number. **Specified and then declined 2026-11-08** —
   [SPEC.md → ALGO-denominated result](./SPEC.md#algo-denominated-result-on-algo-collateral-positions--spec-declined-for-now).
   The founder reviewed it as a mockup against a real closed position and
   declined on panel clutter, not on the reasoning: showing both
   denominations puts two numbers on every changed line. Still pinned. The
   single-asset payout would change the calculus, because the ALGO figure
   becomes exact and could then replace the dollar one instead of joining it.

   One finding from that round is worth keeping regardless of the display:
   **leverage needs no ALGO version.** It is notional over collateral, so the
   price cancels and 10x is 10x in any unit. What is misleading is that it
   DRIFTS — notional is fixed in USD, ALGO collateral is not, so the same
   position reads 10x at $0.10 and 20x at $0.05, moving the wrong way on a
   correlated long. `correlatedRisk.ts` already states the consequence.
   Effective-leverage-now is a separate, still-open idea.
2. **No minimum-receive is shown**, because the signed close has no output
   floor — `minPrimaryOutputAmount` and `minSecondaryOutputAmount` are both 0.
   The only protection is `acceptablePrice`, anchored to a quote up to 30s old,
   at `DEFAULT_SLIPPAGE_BPS = 50` applied one-sided: **0.5% of notional
   adverse, ~5% of collateral at 10x**. Never a theft vector — the fill is the
   signed oracle price — but the panel does not state the bound.

### Known liveness limits on the close path — NOT fund safety

Every failure below refuses with nothing signed. The risk is being unable to
exit *through this terminal*, not losing anything.

- **Market 2 (BTC) ALGO closes are asserted-OK but never chain-simulated.**
  No market-2 position exists anywhere to simulate against, so a mocked one
  fails at `pc=1759` regardless of collateral — including a USDC control. This
  is unproven, not proven-good. Open one small market-2 position and run
  `algoclose.live.test.ts` against it before relying on it.
- **The close fee cap is a real ceiling and its headroom is unmeasured.**
  `MAX_CLOSE_GROUP_FEE_MICRO_ALGO` is 200,000, set at ~1.7x a measured 120,000.
  The close above came to 122,000, of which **114,000 was the Trading call
  alone** — that call pools the fees of its inner transactions, so the total
  scales with the number of yield-recall legs, NOT with group size
  (`SHAPE_CLOSE` already caps the group at 16 app calls and no transfers). A
  position with substantially more recall legs could exceed 200,000 and be
  refused `fee_cap`.

  Do **not** raise the cap to make a failure go away. That is widening a
  fund-safety bound, which is the exact mistake pattern that produced the gate
  in `b5a3472`. Measure the real ceiling against a large position first.

**The close refund is larger than its parts, and one constant may be stale.**
The first ALGO round trip (2026-11-04) returned two inner payments: the trade
payout, and **201,989 µALGO** of storage/box refund. That does not decompose
as `V2_POSITION_BOX_MBR_MICRO_ALGO` (70,900) + storage escrow (100,200) =
171,100 — it is 30,889 more. `201,989 − 100,200 = 101,789` would be consistent
with a position-box MBR of 101,789 rather than 70,900, and SPEC.md:472 warns
that **both order- and position-box MBR are layout-derived and move at
cutover**, having already caught the order-box constant stale once.

Not currently reachable: every storage payment ever made to the Trading app is
**100,200** (43 occurrences on chain, no other value), so the assertion's
`amt === POSITION_BOX_MBR_MICRO_ALGO` branch — the "top-up" case in
`storage_payment_unpinned` — has never fired. If the real MBR is 101,789 and a
group ever pays it, our assertion would REFUSE a correct group.

**Unresolved:** derive the position-box MBR from the live box rather than the
SDK constant, or pin it from a real top-up when one appears. The refund being
bigger than expected costs the user nothing; the stale pin could cost them a
trade.

**The leverage assertion in `group.ts` is a tautology, for USDC too.**
`argLev = sizeUsdDelta / legAmount` versus
`shownLev = shown.sizeUsdDeltaMicro / shown.collateralAmountMicro` is implied
by the `transfer_amount` and `size_usd_delta` checks that run before it, so
both sides are the same two numbers and it cannot fail. SPEC.md:117 calls the
leverage binding "the whole point" of the open assertion, because
`sizeUsdDelta` is otherwise a free frontend integer bound only by the
transfer. That binding exists (via `transfer_amount`); what does NOT exist is
any check that the group matches the leverage the USER WAS SHOWN. Found by
independent review 2026-11-03. **Not ALGO-specific and worth fixing on its own
merits** — a real check binds the displayed figure to the price inside the
group's own signed oracle message, never to a caller-supplied price.

**A private test surface, gated to the admin wallet.** Proposed 2026-11-03: a
hidden Admin route, in the nav only for the admin address, that can exercise
money paths against MainNet without shipping the controls to users — the ALGO
open and close being the immediate case, since both currently need a real
signature to learn anything. Would want the gate to be honest about what it is
(a convenience, not a security boundary: anything the browser can reach, a
determined visitor can reach), so it must not be the only thing standing
between a user and a dangerous control.

**`PerpsCard.tsx` has no behavioural test.** It is 1,994 lines on the money
path. The *blocker* that NEXT.md recorded — "no React component here can be
tested behaviourally", no jsdom, no `.tsx` in the vitest glob — **is fixed**:
`vitest.config.ts` now includes `src/**/*.test.tsx`, testing-library is
installed, and the environment is chosen per file by docblock. `FormSection`
and the liquidity components are mounted and asserted. PerpsCard itself still
is not; the tests naming it (`perpsCardLayout`, `perpsFormSections`, …) are
lib-level assertions about it, not mounts of it. The harness is no longer the
excuse.

**Audit 11 — four display findings open.** None on the group, none on the money
path. MEDIUM 5 (a failed first proposal read renders as "no live proposals" for
the page session, on `/tokens`); LOW 7 (the 24h strip mixes the PEX oracle with
Coinbase candles and its window is 23–24h); LOW 8 (`PositionsPanel`'s signature
guard fires on nearly every poll — harmless, but its comment claims otherwise);
LOW 10 (a freeze-contract comment says "never a live derived value" beside
eleven bare live reads — the comment is what is wrong). Detail in
[AUDIT.md](./AUDIT.md).

**A take-profit and a stop-loss at the same time** — still one protective leg
per position, pending PEX's sibling-cleanup behaviour being observed on
TestNet.

**Pay profit out in USDC** — specified, unbuilt.

**Partial close, add collateral, reclaim** — unbuilt.

**The unsent letter.** [CLOSE-QUOTE-QUESTION-FOR-ULTRADE.md](./CLOSE-QUOTE-QUESTION-FOR-ULTRADE.md)
was drafted 2026-09-28 and never sent.

---

## Documents

| | |
|---|---|
| [SPEC.md](./SPEC.md) | Product definition, architecture, threat model, invariants |
| [PEX.md](./PEX.md) | PEX integration — platform facts, measured MainNet state, integration paths considered |
| [history/BUILD_LOG.md](./history/BUILD_LOG.md) | How the write paths were sequenced and why. History — the plan half is now "Open items" above |
| [AUDIT.md](./AUDIT.md) | Adversarial audit findings, the one-position decision, and what the earlier verification got wrong |
| [CLOSE-QUOTE-QUESTION-FOR-ULTRADE.md](./CLOSE-QUOTE-QUESTION-FOR-ULTRADE.md) | **Drafted, NOT sent, unanswered.** Which `quoteV2DecreasePosition` fields scale on a PARTIAL close. Blocks nothing — partial close is not built — and is the only one of the four Ultrade letters still live |
| [AUDIT-7-REMEDIATION.md](../../archive/AUDIT-7-REMEDIATION.md) | Audit 7's findings, the fixes, and what the review of those fixes then found |
| [../ORACLE.md](../ORACLE.md) | Arm-level price doctrine — Perps consumes PEX's signed payloads and runs no feed of its own |
| [../OVERVIEW.md](../OVERVIEW.md) | The Strategy arm — admission criterion and arm-wide commitments |
