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
the C-Vault, three make a clean 2x2.

The page's amber caveat panel was removed as PEX-specific chrome: `/strategy`
hosts more than PEX. Every disclosure it carried moved into the Learn more
modal, and `CvaAbout.test.tsx` pins each one there — deleting a box is not a
reason to stop saying what it said.

The C-Vault is the hero: `glow-text-card` heading, a drifting blob, and the
headline in the token pages' metric box (`text-green-400`) inside a white neon
ring. The direct pool cards keep the quieter `YieldFigure` — a page where
everything glows ranks nothing.

**Neon needs an edge.** `.glow-white` was three blurs and no border, and it
rendered as haze rather than as the neon the card frame has. What makes
`MAGNET_GLOW` read as neon is `ring-1 ring-magnet-400/60` — a crisp 1px lit
edge with the bloom behind it; a blur alone has nothing to bloom off. The
class now mirrors that structure in white (ring, outer bloom, inner lift) and
is asserted by `src/app/glowWhite.test.ts`, which parses the declaration with
comments stripped, because the class carries a long comment that a grep-based
test would match on prose alone.

Measured rather than eyeballed: the white ring peaks at luminance **167**
against the card ring's **114**, so the box deliberately sits 1.46x above the
frame it rests on, and the bloom reads **70.0** at 8px out against a **38.7**
background.

**Two glows need room between them.** The heading carries `glow-text-card`
(radii to 34px) and the box a 60px bloom, so at the original `mt-1` the halos
overlapped across the entire gap and read as one bright band rather than two
elements. Swept the margin and sampled the luminance trough in the column
under the heading glyphs:

| `mt` | gap | trough | vs card background |
|---|---|---|---|
| 4px | 20px | 27.4 | **1.53x** — merged |
| 12px | 28px | 19.3 | 1.08x |
| **16px** | **32px** | **16.4** | **0.91x** — separated |
| 24px | 40px | 14.4 | 0.81x — diminishing |

16px is where the trough reaches the card background; past it the gap grows
without separating anything further. The shipped build measures 16.4, matching
the sweep exactly. There is no test for this — jsdom has no layout engine, and
asserting the literal class would be the grep-style test this repo already got
burned by — so the table lives in the code comment, where anyone tempted to
tighten the spacing will see what it costs.

**Card typography is ~15% up from the original**, landing on the sizes the
Tokens and MagnetFi cards already use: 12px stat labels and 16px mono values
against `HeaderMetric`'s 12px/18px. Verified from `getComputedStyle` on the
rendered page, not from the class names — 25px heading, 17px rate label, 33px
figure, 12px subtext, 11.5px footer. At 390px the rate box wraps its figure
beneath the label and the page has no horizontal overflow
(`scrollWidth === clientWidth`); only decorative SVG extends past, clipped.

Three glow classes were rasterised and compared before settling: both
`magnet-glow-soft` (a drop-shadow filter tuned for the hero logo) and
`glow-text` (radii tuned for a 48-60px splash title) produced no visible halo
at heading size. Reading the class name would not have caught either.

## The C-Vault card headlines an ANNUALIZED return

A product decision taken 2026-10-28, against the evidence, and recorded here so
it is not reversed by accident or repeated by mistake elsewhere.

**Annualizing a realised return is not a rate.** The same vault on the same day:

| window | days | realised | annualized |
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
   `MIN_ANNUALIZE_DAYS` (14) and always takes the longest available span. A
   7-day headline would be indefensible.
2. **The span travels with it** — `Derived from past 57 days performance` sits
   directly beneath the figure, in the same box. A reader is never shown the
   annualized number without the window it was extrapolated from.
3. **The spread stays one click away** — the card carries ONE figure; the full
   7d / 30d / 90d / all-time ladder is in the Learn more modal, shown as
   realized returns and **never annualized**, with the +812% / −26% / +183%
   dispersion stated outright. The modal also says why the headline's window
   reads longer than the ladder's.

It annualizes the **span**, not the period label: the bundle's "90d" holds 55
days of history, and using the label would read +89% instead of +183%.

Income APR (fees + yield) is a separate quantity and is never annualized by us
— it already is a rate. It stays on the card, labelled, because on the measured
week it accounted for about 2.6% of the total return; the rest was trader P&L
and ALGO's price.

`annualize.test.ts` pins the guards: longest-window selection, the minimum
span, a negative headline when the long window is negative, a refusal rather
than `NaN` on a total loss, and — for the live extension below — that the
window never shortens, that a missing or zero live price falls back instead of
reporting −100%, and that a fallen share price still moves the headline down.
Each was verified by mutation: break the guard, watch its test go red.

### The headline runs to the LIVE share price, not to the bundle's last day

PEX republishes once a day — `as_of` 00:00 UTC, posted around 00:10 — so a
figure taken straight from the bundle is up to 24 hours stale and moves once a
day. Measured 2026-10-28 it was **23.8 hours old** while the chain reads beside
it were current.

The vault's share price, by contrast, moves on **every re-mark**. So the window
runs from the bundle's FIRST day to the live `total_nav_usd / total_cva_shares`:

| | window | realised | annualized |
|---|---|---|---|
| bundle only | 55.0d | +17.01% | **184%** |
| bundle + live price | 57.0d | +17.27% | **177%** |

The property that makes this safe is that it only moves the **end** of the
window forward. The window lengthens — 55 days became 57 and keeps growing — so
none of the short-window volatility above is reintroduced. Shortening it to the
user's own position, which was considered, would have done exactly that: their
$25 is days old, and a 7-day window on this vault reads +812%.

It falls back to the bundle's own figure whenever the live price or the start
anchor is missing. A fresher figure is worth having, never at the cost of
inventing one. `annualize.live.test.ts` runs the real path against the real
bundle, because a `share_price_usd` parse that silently returns null would
degrade to the stale figure without ever throwing — the same failure mode that
shipped once in `costBasis`.

### The card carries TWO timestamps, because it has two vintages

Every **dollar** on the card is a chain read, seconds old — and so is the end
of the return window. What is still a daily snapshot is PEX's **history**: the
series the return is measured across, the ladder in the modal, and the chart.

```
All figures read 12:08 · PEX history to Oct 28
```

It used to read `performance to Oct 28`, which became wrong the moment the
headline started ending at the live mark: the performance figure is current,
its history is not. The bundle's own `as_of` is used, not the fetch time, and
an expired bundle is flagged rather than hidden.

### One basis for every dollar: the contract's `total_nav_usd`

Pool liquidity, Your position and the share price all read the vault's own
`total_nav_usd` global. Mallow reads the same global, so the figures agree.

Until 2026-10-28 Pool liquidity showed something else — a figure **we derived**
from each market's `long_pool_amount` / `short_pool_amount` at spot ALGO, while
the stat beside it priced the user's slice off the contract. The card
contradicted itself, and a holder comparing it with Mallow found the pool
figure low:

| | |
|---|---|
| contract `total_nav_usd` (and Mallow) | **$1735.12** |
| our derivation | **$1589.81** — 9.2% low |

Price was ruled out by measurement: reproducing the contract's mark from those
pools needs ALGO at **$0.1403** against a spot of $0.1041. What the derivation
misses is the vault's claim on **accrued fees and open positions**, neither of
which is in the pool amounts. It is a floor on the vault's value, not a measure
of it, and survives only as the fallback for when the globals cannot be read.

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
12 MONTH ANNUALIZED RETURN — DERIVED FROM PAST 57 DAYS PERFORMANCE
+177%
Pool liquidity · Participants · Your position · Unrealized gain/loss
```

Two prose panels came off it on 2026-10-28, and neither was deleted:

| What it said | Where it went | Why |
|---|---|---|
| "Takes ALGO + USDC. You do not pick a market — the vault allocates across both and rebalances itself." | Learn more → **How PEX manages it** | It explains how the product works. The modal already covered the allocation and the rebalancing; it did not name the deposit ASSETS, so that sentence was added there. |
| "Costs 0.2% in and 0.2% out ... Plus a ~1 hour withdrawal cooldown and a $5 minimum withdrawal." | The **deposit/withdraw panel**, split in three | It mixed an entry cost, an exit cost and a timing constraint into one paragraph, so each applied to a different moment and none appeared at the moment it mattered. |

The cost split is the more useful change. Each note now sits beneath the
fields it applies to, and every rate is read from the vault's own globals:

- **Deposit** — `Withdrawals open 56 minutes after a deposit. Every deposit
  restarts it, including a top-up to a position you already hold.` and
  `0.20% deposit fee — $25.00 buys about $24.95 of shares.`
- **Withdraw** — `0.20% withdrawal fee` and `Minimum withdrawal is $5.00`.

The cool-down is a **deposit-side** fact: it is keyed off `last_deposit_round`,
so depositing starts it, but it only ever BLOCKS a withdrawal — where it
already existed as a gate. A gate is too late to act on, because the money is
in by then.

The exit spread had **no home at all** before this. The card's panel was the
only place it appeared, so moving the entry half without it would have deleted
the other half outright.

"Stays in the vault, not paid to PEX" did not follow the cost into the panel.
It is true, verified, and in the modal — but it answers "where does my money
go", and the question in front of someone about to sign is simply what it
costs them.

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

**This figure is never annualized.** The same relative outperformance
annualizes to +14,813% from 6 days and +97% from 55 — short windows are
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

  Re-verified in the deployed vault 2026-10-28, on the branch that handles a
  deposit into an **existing** box:

  ```teal
  box_get ; assert            # the gu2: box is already there — a top-up
  ... replace2 0              # new share total at offset 0
  global Round ; itob ; replace2 8
  ```

  Offset 8 is the field the cool-down assert reads at `label58`, so the clock
  resets on the whole position. The deposit UI states this rather than letting
  it read as a one-time onboarding cost.
- **The C-Vault costs 0.2% in and 0.2% out**, flat — there is no time-based
  penalty and no lockup beyond the cool-down. The direct pools have no spread,
  though they are admin-only now, so the page no longer shows that comparison.
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
