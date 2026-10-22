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

## Status (2026-10-21)

| Pool | Venue | Deposit | Withdraw | Notes |
|---|---|---|---|---|
| ALGO/USD (market 1) | PEX direct LP | **Live** | **Live** | Built, asserted and simulated against MainNet |
| BTC/USD (market 2) | PEX direct LP | **Live** | **Live** | Synthetic index — holds no BTC, backed with ALGO + USDC |
| C-Vault | PEX managed vault | Not built | Not built | Needs a same-round mark preamble — see below |
| CLMM pools | PactFi | Not started | — | Waiting on PactFi to release the platform |
| Structured vaults | Ours | Not started | — | Not designed |

**Read paths are live on `/strategy`** for all three PEX destinations — pool
sizes, composition, your position, open interest against PEX's admin-set cap,
and PEX's published APR.

**`/strategy` is deliberately not in the nav.** The two direct pools sign in our
UI and pass their tests, but nothing has round-tripped real funds through this
path yet. It is reached by typing the path while it is exercised. It rejoins the
nav when the C-Vault signs here too and there are real round trips behind it.

## Why the C-Vault is second, not first

It looked like the easy one — it is the best-performing destination and the one
to put in front of users. It is the hardest shape by a distance:

- the vault asserts `gm2:[40..48] == global Round`, **exact equality**, plus a
  verified `mark_market` leg for that market **in the same group**
- so a deposit carries a pricing preamble whose length depends on vault state
- its NAV ran 36–257 rounds stale against a 5-round limit while this was built,
  which is exactly the condition that makes an unprepared deposit fail
- it has a $5 withdrawal floor that an exact-$5 deposit cannot clear after two
  20 bps spreads, so the product minimum is $5.25

An audit reversed the original release order on these grounds. See
[`SIGNING.md`](./SIGNING.md) §9.1 and §11.7.

## What a depositor is actually taking on

Stated here because the page states it and the two must not drift:

- **You are the counterparty to every trade.** The APR is income only — fees and
  yield — and PEX is explicit that it excludes asset price moves and net trader
  P&L. A positive APR can sit alongside a negative pool return.
- **Open interest is capped per market by PEX's admin**, not by pool size.
  Depositing moves a pool-derived reserve check and does nothing to the cap.
  Market 1 sat at 99.8% of its cap when this shipped.
- **PEX has had no external audit.**
- **A deposit restarts a 1 hour withdrawal cool-down on the whole position**,
  not just the amount added — it is consensus-enforced, not advisory.

## Documents

| | |
|---|---|
| [`SPEC.md`](./SPEC.md) | The product: destinations, what is shown, what is not claimed |
| [`SIGNING.md`](./SIGNING.md) | Deposits and withdrawals in our UI. §11 is the corrections the build forced |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Code layout, the two naming traps, how to add a pool |

PEX protocol notes shared with the terminal live in
[`../perps/PEX.md`](../perps/PEX.md).
