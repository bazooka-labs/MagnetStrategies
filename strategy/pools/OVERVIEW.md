# Strategy Pools

Deploying capital into **liquidity pools that take the other side of leveraged
trading** — you earn trading fees and yield, and you are the counterparty. A
product in the [Strategy](../OVERVIEW.md) arm, under the **Strategy** nav item,
beside [Perps](../perps/OVERVIEW.md) under **Trade**.

The split is the arm's own cut: Perps asks *do I take the position?*, Pools asks
*does a strategy take it for me?*

Magnet Strategies writes no contract here, custodies no funds and holds no
protocol role. The first venue is **PEX**, Ultrade's Algorand perpetuals
protocol — the same protocol the Trading Terminal trades on, approached from the
other side of the book. Every action is a PEX call signed by the user's wallet,
**in our UI** — the page does not hand anyone to a third-party frontend.

## What the public sees (2026-10-23)

**Only the C-Vault.** The two direct market pools render behind an admin gate on
`/strategy` — a `Shield` "Direct pools" toggle beside the Pools pill, visible
only to `MAGNETFI_ADMIN_ADDRESS` and closed until pressed. The C-Vault is the
product going in front of users first, and a page offering three destinations
invites a choice nobody has been given the context to make.

Both direct paths are *finished*, not hidden because they are unready — they are
built, asserted, simulated, and ALGO/USD has real signatures behind it. The
table below records the engineering state; this section records the visibility
decision, which is a separate thing and reversible in one boolean.

**The gate is cosmetic, by design.** Everything on the page is a PEX call signed
by the user's own wallet. Anyone can deposit to either market through PEX
directly, and no claim is made otherwise — `isAdmin` hides a card, it does not
guard an authority. Real authority is in the contracts' own admin checks. Same
pattern and same address as `/magnetfi` and `/contact`.

Two pieces of copy follow the gate rather than being written once:

- the headline split reads `$X direct · $Y via C-Vault` for an admin and
  `of which $Y is the C-Vault` for everyone else — "direct" would name a
  product the visitor cannot see, while the fact it carries (the vault is a
  *slice* of the pools, not an addition) still matters to a vault depositor;
- the grid is `md:grid-cols-3` open and `md:max-w-md` closed, because one card
  alone in a three-column grid reads as two cards that failed to load.

`LiquidityView.test.tsx` asserts what a visitor can *see*, not the boolean:
drop the gate and three tests go red (verified by mutation).

### The page is not PEX's page

Removed 2026-10-23, because `/strategy` hosts strategies and PEX is one venue
among the ones coming: the `Strategy` h1 and its paragraph about "traders on
the terminal", the two headline boxes totalling PEX pool liquidity and PEX fees
to date, and the amber caveat panel at the foot. A header describing one venue
misdescribes the rest as they arrive, and a CLMM pool's TVL summed into one
"total liquidity" beside PEX would be adding unlike things. The splash already
says "Strategy", as `/magnetfi` relies on its own.

**No disclosure was dropped.** The caveat panel was the only place that said
PEX has had no external audit, that Magnet Strategies holds no funds, and that
a positive APR can sit alongside a negative return. All three moved into the
C-Vault's About modal under "What you carry", with tests that fail if they are
removed again (mutation-verified). Look there before concluding something was
lost. Per-venue figures now live on the card for that venue.

### The card layout

The grid is **two per row, fixed** — not a column count that tracks how many
cards exist. Two earlier versions both failed by sizing to the current
contents: three columns left two obvious holes once the direct pools went
admin-only, and the single `max-w-2xl` column that replaced it gave one card a
42rem span it had no content to fill. A `NextStrategyTile` renders last and
absorbs whichever cell the row count leaves open — one strategy puts it beside
the C-Vault, three make a clean 2x2. The caveat panel sits inside the same
`max-w-5xl` column, because a card above a full-bleed amber panel made the
warning the largest object on the page.

The C-Vault is the hero: `glow-text-card` heading, a drifting blob, and the
APR in the token pages' metric box (`text-green-400`, two decimals, fees and
yield beneath). The direct pool cards keep the quieter `YieldFigure` — a page
where everything glows ranks nothing.

Three glow classes were rasterised and compared before settling: both
`magnet-glow-soft` (a drop-shadow filter tuned for the hero logo) and
`glow-text` (radii tuned for a 48-60px splash title) produced no visible halo
at heading size. Reading the class name would not have caught either.

## The C-Vault card headlines an ANNUALISED return

A product decision taken 2026-10-28, against the evidence, and recorded here so
it is not reversed by accident or repeated by mistake elsewhere.

**Annualising a realised return is not a rate.** The same vault on the same day:

| window | days | realised | annualised |
|---|---|---|---|
| 7d | 6 | +3.70% | **+812%** |
| 30d | 29 | **−2.38%** | **−26%** |
| 90d / total | 55 | +17.00% | **+183%** |

The figure measures the window as much as the vault. This repo has already
shipped that error once — a derived 15.3% APR against a real 4.83%, removed and
documented in `pools/performance.ts`.

It is displayed anyway, because the card's job includes showing what the
strategy has actually done, and +17% realised in under two months is that. The
three conditions that make it defensible are enforced in code and must not be
dropped quietly:

1. **Longest window only** — `pickLongest` refuses anything under
   `MIN_ANNUALISE_DAYS` (14) and always takes the longest available span. A
   7-day headline would be indefensible.
2. **The realised figure travels with it** — "+17.00% actually realised over 55
   days. Not a forecast." sits directly beneath, in the same box.
3. **The shorter windows stay visible** — 7d / 30d / 90d render as realised
   returns on the card, so the negative month is in the same glance. The About
   modal carries the full ladder and states the +812% / −26% / +183% spread
   outright.

It annualises the **span**, not the period label: the bundle's "90d" holds 55
days of history, and using the label would read +89% instead of +183%.

Income APR (fees + yield) is a separate quantity and is never annualised by us
— it already is a rate. It stays on the card, labelled, because on the measured
week it accounted for about 2.6% of the total return; the rest was trader P&L
and ALGO's price.

`annualise.test.ts` pins the guards: longest-window selection, the minimum
span, a negative headline when the long window is negative, and a refusal
rather than `NaN` on a total loss.

### The card carries TWO timestamps, because it has two vintages

The position, pool liquidity and share count are **chain reads** — seconds old.
The annualised figure, the realised ladder and the chart come from **PEX's
daily bundle**, regenerated around 00:10 UTC. Measured 2026-10-28 that bundle
was **16 hours old** while the chain reads were current.

So the footer states both and does not reconcile them:

```
Your position and pool figures read 12:08 · performance to Oct 28
```

A single "updated just now" would be false for half the card — and it is the
half carrying the headline number. The bundle's own `as_of` is used, not the
fetch time, and an expired bundle is flagged rather than hidden.

This matters more than it looks. A holder watching their position move during
the day is watching a live number; the +183% beside it will not change until
PEX republishes. Without the footer those two read as one snapshot.

### "Your position" measures against what left the wallet

The card shows a holder's change since they deposited — `+$0.32 since you paid
$25.00`. The basis is the **amount that actually left the wallet**, read from
their own `v2_cva_deposited` receipt (field 4), verified against chain: the
2026-10-23 deposit logs `25_000_000` and the group transfers exactly
`25.000000` USDC.

**Not the credited value.** After the 0.2% entry spread that deposit bought
~$24.95 of shares, and measuring from there would quietly hide the spread —
$0.05 on $25.00, a fifth of the first week's gain. Hiding the entry cost inside
the performance figure is precisely the flattering default this exists to
avoid, and it is the one thing a real position knows that no published series
can show: a position's percentage return is identical to the share price's, so
the share price alone tells a holder nothing new.

**It does no withdrawal accounting.** It asks a narrower question that needs
none — *what did the shares you hold right now cost?* — by walking deposits
newest-first and accumulating until their minted shares equal the shares held.
A wallet that deposited $7, exited fully, then deposited $25 resolves cleanly
to $25.00. Anything that does not reconcile exactly returns null.

That asymmetry is deliberate: an overstated basis understates a gain, which is
annoying; an understated basis **overstates** it, which is not acceptable on a
money surface. `costBasis.test.ts` pins the refusals — partial exits, missing
receipts, deposits that cannot cover the balance, and an indexer that is down.

The read is separate from `readStrategyLiquidity` and allowed to fail alone: it
needs the indexer, the pool read needs algod, and a basis we cannot fetch must
cost the one line that shows it rather than the position value.

### The card carries one number; the modal carries the detail

A depositor arriving at the card is asking two things — what is the strategy,
and what does it return. Every extra metric competes with those. The card is
now three elements and nothing else:

```
ANNUALISED RETURN — DERIVED FROM PAST 55 DAYS PERFORMANCE
+183%
Returns are generated by earnings from opposite trade positions,
ALGO/USDC price movement, and pool swap fees.
```

**The derivation lives in the label, not in a sentence beneath the number.**
That is deliberate and worth preserving: "+183%" alone is a claim, "+183%
derived from past 55 days performance" is a measurement carrying its own basis,
and a label cannot be skimmed past the way a following sentence can.

Everything that calibrates the figure — the 7d/30d/90d spread including the
negative month, the benchmark chart, the income/fee split, the risk disclosure
— is in the About modal, one click away. The card carries no APR, no yield
split, no benchmark figure and no per-window ladder.

The sources are listed in contribution order — *earnings from losing trades,
ALGO/USDC price movement, swap fees* — so the ordering carries the weighting
without numbers. Fees come last because they are 0–3% of income. This page
previously led with them.

**The benchmark comparison moved to a chart.** `vs_holding_bps` is the only
figure that measures the strategy rather than the market, but "+11.37pp against
a geometric 50/50 benchmark" is too much to hold at a glance. The About modal
plots the vault against the benchmark over the full real window instead —
`PerformanceChart`, two SVG polylines, no library, every point a day PEX
recorded and nothing extrapolated. The shape says what the number could not:
the two track together through the rally, then the benchmark falls away while
the vault holds.

The figures behind it:

| window | share price | benchmark | vs holding |
|---|---|---|---|
| 7d | +3.70% | −4.49% | **+8.19pp** |
| 30d | **−2.38%** | −12.42% | **+10.04pp** |
| 90d | +17.00% | +5.63% | **+11.37pp** |

The headline return swings 19 points across those windows; the outperformance
moves three. **The swing is ALGO's price**, which the vault does not choose and
a depositor can hedge. The 30-day row is the one to keep in mind: the vault was
*down* 2.38% while beating the benchmark by 10.04pp, because ALGO fell 12.42%.

Income is almost none of it. The 5.11% APR pro-rates to **0.41%** over 30 days
against **+10.04pp** of outperformance — so roughly **96% of what the vault adds
is trader P&L**, money from traders on the losing side. That is the engine, and
it is why "deposits earn a share of trading fees" is a poor description of this
product: fee income across all three pools runs **0–3% of LP income**, and
BTC/USD earned **$0.00** in fees over the measured week.

**This figure is never annualised.** The same relative outperformance
annualises to +14,813% from 6 days and +97% from 55 — short windows are
nonsense here too.

## Status (2026-10-22)

| Pool | Venue | Deposit | Withdraw | Notes |
|---|---|---|---|---|
| ALGO/USD (market 1) | PEX direct LP | **Live** | **Live** | Admin-only in the UI; built, asserted and simulated against MainNet |
| BTC/USD (market 2) | PEX direct LP | **Live** | **Live** | Admin-only in the UI; synthetic index — holds no BTC, backed with ALGO + USDC |
| C-Vault | PEX managed vault | **Live** | **Live** | **The public one.** Mark preamble assembled by the SDK; withdrawals denominated in USD |
| CLMM pools | PactFi | Not started | — | Waiting on PactFi to release the platform |
| Structured vaults | Ours | Not started | — | Not designed |

**All three destinations deposit and withdraw in our own UI** — "Live" above
means the path works, not that it is public; see the section above. Nothing
links out. Measured on MainNet:

| action | group | fee | note |
|---|---|---|---|
| pool deposit | 6 txns | 55,000 µALGO | +26,500 `ml2:` box MBR on a first deposit |
| pool withdraw | 10 txns | 117,000 µALGO | recalls both yield legs |
| vault deposit | 8 txns | 74,000 µALGO | +32,900 `gu2:` box MBR on a first deposit |
| vault withdraw | 15 txns | 178,000 µALGO | 2 `mark_market` legs + recall |

Read paths are live too — pool sizes, composition, your position, open interest
against PEX's admin-set cap, and PEX's published APR.

### Real signatures so far

Simulation is not a signature, and this repo has been caught by that distinction
before. What has actually settled on chain:

| path | status |
|---|---|
| ALGO/USD deposit | ✅ 2026-10-22 — $5.00, first-time depositor: created the `ml2:` box and paid the 26,500 µALGO MBR |
| ALGO/USD withdraw | ✅ 2026-10-22 — full exit, box deleted and MBR refunded (both assets; the all-USDC default shipped after) |
| ALGO/USD all-USDC | not yet — now the default, never signed |
| BTC/USD either way | not yet |
| C-Vault deposit | ✅ 2026-10-23 — $7.00, first-timer: `gu2:` box created, 32,900 µALGO MBR, mark preamble ran |
| C-Vault withdraw | ✅ 2026-10-23 — full single-asset exit, **two groups in one prompt** (rounds 66273320 and 66273322) |

The C-Vault exit measured, end to end: 5.874225 shares out, 15.474755 ALGO
converted, **6.962619 USDC + 0.189211 ALGO** received, `gu2:` box deleted and
its MBR refunded. $7.00 in, ~$6.98 out over ~1.4 hours, against two 20 bps
spreads, the swap fee and ~0.25 ALGO of network fees.

Dust landed at **1.21%**, not ≤1%: the swap is sized from the SIMULATED payout
and the actual came in higher, so the remainder exceeds 1% of what actually
arrived. Cosmetic at this size, and the reason the UI says "roughly 1%".

**`/strategy` is in the nav as of 2026-10-23**, between Trade and Contact. The
bar written into `Navbar.tsx` was "the C-Vault signs here too and the direct
pools have real round trips behind them". The first clause is met outright. The
second resolved differently than it was written and is worth stating exactly:
ALGO/USD's all-USDC default and BTC/USD in either direction still have no
signature — those paths did not get signed, they stopped being **public**. Both
direct pool cards are admin-only now, so the only thing the nav entry exposes to
a visitor is the C-Vault, which is the path with the round trip.

If the direct pools are made public again, the nav entry is downstream of that
decision.

## The 0.2% spreads are NOT a fee to PEX

`cva_mint_spread_bps = 20` and `cva_burn_spread_bps = 20` on app 3690309167,
both admin-settable, both read live rather than hardcoded. A $25.00 deposit
arrives as about $24.95 of shares.

**Nobody collects the difference.** Verified 2026-10-26 against the deployed
program (sha256 `b2fd9b6f…`, matching our pin):

- the burn-spread routine is `proto 1 1` — one value in, one out. It returns
  `v - v*bps/10000` and performs no transfer, writes no global, touches no
  address;
- every outbound payment in all 6,578 lines goes to `txn Sender` or to a
  market app's `AppAddress` (allocating capital, plus the 26,500 µALGO box
  MBR). There is no third recipient;
- none of the 26 globals the contract writes is a fee destination or
  accumulator, and the strings `fee`, `treasury`, `collect`, `protocol` and
  `revenue` appear nowhere in the program.

It is a **dilution guard**: the mover pays it, the stayers receive it, which is
what stops someone entering or exiting against a stale NAV mark from taking
value off the people who sat still.

**The credited value is `deposit / (1 + s)`, not `deposit × (1 - s)`.** The
contract adds the spread to the NAV denominator before dividing (cva.teal
`label51`: `nav + nav*bps/10000`, then `value * shares / nav'`). The two forms
diverge as size grows — on $10,000, $9,980.04 against $9,980.00 — and the
deposit form shows the division, because the figure sits next to a signature.

Do not try to reconcile the exact bps from the deposit/withdraw receipts: they
mix the spread with oracle valuation of the two legs across two markets, and
the implied haircut comes out 0.28% and 0.93% on two real deposits. The clean
confirmation is the position a depositor actually sees ($25.00 → $24.95).

## Why the C-Vault was second, not first

It looked like the easy one — it is the best-performing destination and the one
to put in front of users. It is the hardest shape by a distance, and shipping it
second was right even though the stated priority was the other way round:

- the vault asserts `gm2:[40..48] == global Round`, **exact equality**, plus a
  verified `mark_market` leg for that market **in the same group**
- so a deposit carries a pricing preamble whose length depends on vault state
- its NAV ran 36–257 rounds stale against a 5-round limit while this was built,
  which is exactly the condition that makes an unprepared deposit fail
- it has a $5 withdrawal floor that an exact-$5 deposit does not clear until the
  vault has earned ~0.40% — a wait of days, surfaced as a notice rather than
  blocked (§11.11). The minimum is $5.00, matching Mallow.

An audit reversed the original release order on these grounds. See
[`SIGNING.md`](./SIGNING.md) §9.1 and §11.7.

The estimate was still too pessimistic in one place: the mark preamble is
**not** ours to assemble. `planV2CvaWithdraw` picks the route and the SDK's
builders emit the `mark_market` legs when given `activeMarketIds` and
`activeMarketOracles`. That was the bulk of the feared cost, and it does not
exist.

## What a depositor is actually taking on

Stated here because the page states it and the two must not drift:

- **You are the counterparty to every trade.** The APR is income only — fees and
  yield — and PEX is explicit that it excludes asset price moves and net trader
  P&L. A positive APR can sit alongside a negative pool return.
- **Open interest is capped per market by PEX's admin**, not by pool size.
  Depositing moves a pool-derived reserve check and does nothing to the cap.
  Market 1 sat at 99.8% of its cap when this shipped.
- **PEX has had no external audit.**
- **A deposit restarts a withdrawal cool-down on the whole position**, not just
  the amount added — 1 hour on the direct pools (`LatestTimestamp >= updated_at
  + 3600`, asserted in the Markets app), ~56 minutes on the C-Vault (1,200
  rounds off `last_deposit_round`). Both are consensus-enforced, not advisory.
- **The C-Vault costs 0.2% in and 0.2% out**, flat — there is no time-based
  penalty and no lockup beyond the cool-down. The direct pools have no spread.
  A $5.00 vault deposit therefore sits just under the $5 withdrawal floor until
  the vault earns ~0.40%, which the UI states rather than hides (§11.11).
- **A full exit is possible in one transaction.** Verified by planning a
  holder's entire $757 position against a $1,640 vault. A single market
  allocation has a ceiling, so PEX picks a market that can serve the amount.

## Documents

| | |
|---|---|
| [`SPEC.md`](./SPEC.md) | The product: destinations, what is shown, what is not claimed |
| [`SIGNING.md`](./SIGNING.md) | Deposits and withdrawals in our UI. §11 is the corrections the build forced |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Code layout, the two naming traps, how to add a pool |

PEX protocol notes shared with the terminal live in
[`../perps/PEX.md`](../perps/PEX.md).
