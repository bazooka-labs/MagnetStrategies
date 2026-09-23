# Strategy

The DeFi strategy arm of Magnet Strategies, and the `Strategy` item in the app nav.

Strategy houses products where a user **takes a position or deploys capital into an
engineered strategy**. Some run on our contracts, some on someone else's, some on
both. The umbrella is the user's intent, not who wrote the code.

| Product | What it is | Status |
|---|---|---|
| [Perps](./perps/OVERVIEW.md) | Leveraged positions on PEX, a third-party perpetuals protocol | Design stage, integration under construction |
| CLMM strategy pools | Automated LP / concentrated-liquidity vaults, likely on **PactFi's** CLMM contracts | **Waiting on PactFi** to release the platform. Discussed, not designed; nothing written and no decisions taken |
| Strategy vaults | Other engineered exposures — looped, structured | Not started |
| Advanced trading | Surfaces for users who want the full instrument, not the simplified one | Not started |

---

## What Makes Something a Strategy Product

The line that matters is **Strategy vs Bank**, because both deploy user capital and
the boundary is otherwise a matter of taste:

- **Bank** (MagnetFi) — you deposit or borrow. Your return is a **posted rate**, and
  your risk is liquidation of your own collateral. Passive.
- **Strategy** — you take a **position**, or hand capital to an engineered strategy.
  Your return depends on a market outcome or on how the strategy performs, not on a
  rate anyone quoted you. Active.

Applied:

| | Where | Why |
|---|---|---|
| Perpetual positions | Strategy | A directional position |
| Adding liquidity to a $U pool yourself | Tokens | You hold the LP position and take the fees as they come. Nothing is engineered on top |
| Auto-compounding LP vault | Strategy | The **same underlying activity**, wrapped: someone decides when to harvest, what to re-deploy into, and on what schedule. That decision layer is the product |
| Leveraged staking loop | Strategy | Engineered exposure — **even though it runs on Bank primitives underneath** |
| Borrowing mUSD against ALGO | Bank | A rate, and liquidation of your own collateral |
| Minting or redeeming mUSD | Tokens | It is about acquiring the asset, not deploying it |
| VPL volatility ladder | Predict | Its own product line with its own guarantees — see below |

**Predict is deliberately not here.** Its identity is that its products are
mUSD-denominated and user-to-user — *"the protocol never takes the other side of a
position, holds no inventory, and carries no directional risk."* Every one of those
is a promise a Strategy product may break. Keeping it in its own tree stops a user
importing guarantees that do not hold here.

---

## Commitments

These hold for **every** product in this arm, present and future.

**Non-custodial, always.** No session keys, no server-side signing, no delegated
authority over user funds. A delegated-LogicSig design was specified for Perps and
then rejected; see the Duration section of [the Perps spec](./perps/SPEC.md) for the
six transaction fields whose omission would have made it a total-loss vulnerability.
That finding generalises: any future proposal to hold signing authority on a user's
behalf starts from a rejection, not a blank page.

**No shared dependency between Strategy and MagnetFi solvency.**

> **No Strategy product may depend on a price or state source that MagnetFi
> solvency depends on.**

The original rule was narrower — *never read the oracle MagnetFi liquidations depend
on* — because manipulating a payout and manipulating protocol solvency must never
become one action. It is stated over *state* as well as price because a shared
protocol dependency reproduces the failure with no oracle involved at all.

> **This rule is now load-bearing, and it was not before.** Perps satisfies it by
> accident: PEX is external, so it touches no MagnetFi state. A **strategy vault that
> loops through MagnetFi lending would violate it directly** — and that is one of the
> most obvious products to build next. The dependency can be spent once. Read the rule
> before designing anything that touches Bank primitives, not after.

A corollary worth stating: taking a third-party protocol's LP as MagnetFi collateral
would foreclose Strategy products built on that protocol, and vice versa.

> **Where this currently stands, as fact rather than plan.** MagnetFi's vault is wired
> to **Tinyman** — `lp_pool_id` is a Tinyman pool app ID, and VAULT.md defines a vault
> type as a Tinyman pool. **Pact** appears only as liquidity deep-links on the Tokens
> page and is not collateral anywhere.
>
> **Two separate open ideas, neither decided.** CLMM strategy pools may be built on
> Pact; AMM/CLMM LPs may become MagnetFi collateral. Both have been discussed, neither
> is resolved, and they are not currently coupled to each other.
>
> The only claim made here is that **the rule above is the thing to check them
> against** if they ever meet — a Strategy product and MagnetFi solvency reading the
> same venue's state is the shape it exists to catch. Whether that coupling actually
> arises depends on how each is built, and is analysis to do then, on real designs.
> Flagged now so the question gets asked; **not** prejudged, and neither venue is
> reserved for either arm.

**Disclosure.** Every Strategy product states, in the product surface and not only in
its docs: whose contracts hold the funds, what the counterparty is, and what can go to
zero. Products in this arm carry risks a Bank user has not agreed to, and the arm is
not a place where that gets softened.

---

## Build Standalone, Extract Later

One product is one self-contained tree. No shared module, no adapter interface, no
abstraction built for a second thing that does not exist. When a second product ships,
shared pieces get extracted then — against two real implementations rather than one
real and one hypothetical.

**What belongs in this document, and what does not.** This file holds only what is
true of every Strategy product *by definition*. The test: if you can imagine a future
Strategy product for which a statement is false, it belongs in that product's own
tree, duplicated if necessary.

Two things that specifically **do not** belong here, because Perps happens to satisfy
them and a strategy vault would not:

- *"We write no contract of our own"* — a Perps commitment, recorded in
  [perps/OVERVIEW.md](./perps/OVERVIEW.md).
- *"We take no counterparty risk"* — likewise product-specific.

Duplication across product trees is correct and expected. Copies will drift, because
they describe different products.

---

## Open Source Policy

**Strategy frontends, and any contract this arm ever gains, are public** — same repo,
same terms as the rest of Magnet Strategies.

1. **Deployed code is public regardless.** Approval programs are readable on-chain and
   any published client library carries the full ABI. Closed-sourcing an Algorand
   contract converts a one-hour read into a one-day read and obscures nothing.
2. **Trust is the binding constraint.** A Strategy user is trusting third-party
   contracts, oracles and keepers, and often further protocols transitively. Being
   legible about our own layer is the minimum we can offer against that stack.
3. **Consistency.** MagnetFi is public and custodies real collateral. A closed
   strategy layer alongside an open lending protocol reads as concealment.

**Carve-out — off-chain operations may stay private.** Keeper scheduling, redundancy
and failover are a separate service. That is where operational edge legitimately lives.

Third-party SDKs keep their own terms; ours stay under ours. PEX's SDK is
source-available under the PEX Builder License 1.0 — see
[perps/PEX.md](./perps/PEX.md).

---

## Documents

| | |
|---|---|
| [ORACLE.md](./ORACLE.md) | Price doctrine for the whole arm — the dependency-coupling rule, the shared feed capability, display vs settlement prices |
| [perps/OVERVIEW.md](./perps/OVERVIEW.md) | **Perps** — product framing and commitments |
| [perps/SPEC.md](./perps/SPEC.md) | Perps implementation — architecture, threat model, invariants |
| [perps/PEX.md](./perps/PEX.md) | PEX platform reference — facts, measured MainNet state, integration paths |
| [../predict/OVERVIEW.md](../predict/OVERVIEW.md) | **Predict** — the ladder product line, its own tree |
| [../magnetfi/OVERVIEW.md](../magnetfi/OVERVIEW.md) | **Bank** — MagnetFi lending, mUSD, PSM |
