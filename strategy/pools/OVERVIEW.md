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

## Status (2026-10-22)

| Pool | Venue | Deposit | Withdraw | Notes |
|---|---|---|---|---|
| ALGO/USD (market 1) | PEX direct LP | **Live** | **Live** | Built, asserted and simulated against MainNet |
| BTC/USD (market 2) | PEX direct LP | **Live** | **Live** | Synthetic index — holds no BTC, backed with ALGO + USDC |
| C-Vault | PEX managed vault | **Live** | **Live** | Mark preamble assembled by the SDK; withdrawals denominated in USD |
| CLMM pools | PactFi | Not started | — | Waiting on PactFi to release the platform |
| Structured vaults | Ours | Not started | — | Not designed |

**All three destinations deposit and withdraw in our own UI.** Nothing links
out. Measured on MainNet:

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

**`/strategy` is deliberately not in the nav.** Not because it cannot sign — it
can — but because only one of six paths has a real signature behind it. It is
reached by typing the path while it is exercised, and rejoins the nav when there
are real round trips behind each destination.

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
