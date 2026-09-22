# Perps

Perps is the leveraged-positions arm of Magnet Strategies: perpetual positions on Algorand, wrapped in a product surface that deliberately does not look like a trading terminal.

Perps does not operate an exchange. It integrates **PEX**, a third-party perpetuals protocol built by Ultrade. Magnet Strategies writes no exchange contracts, custodies no user funds, and holds no protocol role.

**Status:** Design stage. Nothing is built or deployed. **The product name is provisional** — "Perps" describes the instrument, not the product.

> **Its own tree, deliberately.** Perps was briefly housed under a "Hedge" arm alongside VPL, and placing it inside [`predict/`](../predict/) was considered and rejected. Predict's identity is that its products are **mUSD-denominated** and **user-to-user** — *"the protocol never takes the other side of a position, holds no inventory, and carries no directional risk."* Perps breaks all three: it is USDC-denominated, it trades against a pool that does take the other side, and it carries third-party protocol risk. A user who has learned Predict's guarantees would import them here, where they do not hold. Separate trees, separate risk models, no borrowed safety claims.

---

## What Perps Is For

**A leveraged position in four inputs.** Long or short, an amount in USDC, a risk level, and a price to take profit at. Optionally a protection level. Sign once.

It is deliberately **not** a trading terminal, and it is deliberately **not** framed as hedging. An earlier draft built it around protecting an existing holding — *"protect against a drop"* — and that framing was dropped because it forces the user to hold two models at once: their own exposure, and an instrument that moves opposite to it. **Long and short are one step.** The target user still wants speed and simplicity; they just arrive knowing which way they think the price goes. Teams wanting the full trading experience will build that; this is the quick path.

The leverage control is a **risk bar**, not a set of named tiers. That is not a cosmetic choice — it is the answer to a structural problem. Effective leverage on PEX is `10000 / max(500, side open interest)`, so any fixed multiple has an open-interest level above which it simply cannot be delivered. Named bands go dark with no story to tell the user. A bar whose ceiling tracks the venue never does, and it makes the liquidation distance a thing you watch move rather than a number attached to a tier name.

That framing carries a commercial rationale as well as a product one. PEX is new and thin — at the time of writing its two markets hold roughly $3,100 between them, with one carrying no open interest at all. **Perps is partly an attempt to bring flow to PEX.** One caveat on that, established by measurement rather than assumption: **pool growth alone does not unlock capacity.** Position size is bounded by `max_open_interest` — $960 a side on ALGO/USD — while the reserve check that scales with the pool already permits $4,977. The binding constraint is an admin-set constant roughly five times tighter than PEX's own risk model requires. More LP deposits change nothing until Ultrade raises it; more trading *reduces* available leverage unless they lower the dynamic-OI factor. Both are worth raising with them directly.

Revenue comes from PEX's native builder-fee rail — a permissionless 10 bps of notional on positions, recorded on-chain in the order box. No contract of ours, no custody, no separate fee collection.

---

## Commitments

Three hold regardless of what Perps ships.

**No contract of our own, for as long as that remains true.** Every economic action is a PEX call signed by the user's wallet. The attack surface is what our frontend constructs and what our interface claims — not what a contract of ours can be made to do. Any proposal that adds a contract changes the threat model in [perps/SPEC.md](./SPEC.md) and requires re-review.

**Non-custodial, always.** No session keys, no server-side signing, no delegated authority over user funds. A delegated-LogicSig design was specified and then **rejected** — see the Duration section of the Perps spec for why, and for the six transaction fields whose omission would have made it a total-loss vulnerability.

**No shared dependency between Perps and MagnetFi solvency.** The original rule was narrower — *Perps must never read the oracle that MagnetFi liquidations depend on* — because manipulating a payout and manipulating protocol solvency must never become one action. Integrating a third-party protocol generalises it:

> **No Perps product may depend on a price or state source that MagnetFi solvency depends on.**

Under that rule Perps is clean: it reads PEX state and touches no MagnetFi state at all. It also means taking PEX LP as MagnetFi collateral would foreclose PEX-based Perps products, and vice versa. That dependency can be spent once. Perps does not spend it.

---

## Build Standalone, Extract Later

Perps is one product, and the right structure for one product is one self-contained tree. No shared module, no adapter interface, no abstraction built for a second thing that does not exist. If a second product ships, shared pieces get extracted then — against two real implementations rather than one real and one hypothetical.

VPL's move to `predict/` is that principle applied: duplicated framing, no cross-tree dependency.

---

## Open Source Policy

**Perps's frontend and any contract it ever gains are public**, in the same repo and under the same terms as the rest of Magnet Strategies.

The reasoning is not ideological:

1. **Deployed code is public regardless.** Approval programs are readable on-chain and any published client library carries the full ABI. Closed-sourcing an Algorand contract converts a one-hour read into a one-day read and obscures nothing of substance.
2. **Trust is the binding constraint.** Perps's users are trusting PEX's contracts, PEX's oracle signer, PEX's keepers, and — transitively, because pool assets are deployed into Folks Finance and xALGO — two further protocols. Being legible about our own layer is the minimum we can offer against that stack.
3. **Consistency.** MagnetFi is public and custodies real collateral. A closed integration layer alongside an open lending protocol reads as concealment.

**Carve-out — off-chain operations may stay private.** Keeper scheduling, redundancy and failover are a separate service and are not part of any public repo. That is where operational edge legitimately lives.

Note that PEX's own SDK is **source-available, not open source**, under the PEX Builder License 1.0. Nothing in Perps conflicts with its terms; our code stays under ours, theirs under theirs.

---

## Documents

| | |
|---|---|
| [PEX.md](./PEX.md) | PEX integration — platform facts, measured MainNet state, integration paths considered |
| [perps/SPEC.md](./SPEC.md) | Perps — product definition, architecture, threat model, invariants |
| [ORACLE.md](./ORACLE.md) | Price service — sources, attestation format, trust model. Retained because perps cites it as the sector-level oracle doc for off-chain cross-checks in our own keeper aggregation |
| [../predict/OVERVIEW.md](../predict/OVERVIEW.md) | **Predict** — the ladder product line, moved to its own tree |
