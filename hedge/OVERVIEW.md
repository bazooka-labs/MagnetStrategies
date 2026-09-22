# Hedge

Hedge is the leveraged-positions arm of Magnet Strategies: perpetual positions on Algorand, wrapped in a product surface that deliberately does not look like a trading terminal.

Hedge does not operate an exchange. It integrates **PEX**, a third-party perpetuals protocol built by Ultrade. Magnet Strategies writes no exchange contracts, custodies no user funds, and holds no protocol role.

**Status:** Design stage. One product scoped — **Cover**. Nothing is built or deployed.

> **VPL moved to [`predict/`](../predict/).** It shipped first and lives under the `/predict` route, so it has its own self-contained tree — docs, contract, keeper. The sector framing it needs is duplicated there rather than cross-linked, so neither tree depends on the other. This overview now describes Hedge as the perps arm.

---

## What Hedge Is For

Cover exists to make a leveraged hedge legible to someone who is not a trader: buy a number of fixed-size units, pick how aggressively to size them, name a price to take profit at, sign once.

That framing carries a commercial rationale as well as a product one. PEX is new and thin — at the time of writing its two markets hold roughly $3,100 between them, with one carrying no open interest at all. **Cover is partly an attempt to bring flow to PEX**, which is why its sizing is written as a function of live depth rather than a fixed constant: the product scales with the exchange instead of needing a release each time the exchange grows.

Revenue comes from PEX's native builder-fee rail — a permissionless 10 bps of notional on positions, recorded on-chain in the order box. No contract of ours, no custody, no separate fee collection.

---

## Commitments

Three hold regardless of what Hedge ships.

**No contract of our own, for as long as that remains true.** Every economic action is a PEX call signed by the user's wallet. The attack surface is what our frontend constructs and what our interface claims — not what a contract of ours can be made to do. Any proposal that adds a contract changes the threat model in [perps/COVER_SPEC.md](./perps/COVER_SPEC.md) and requires re-review.

**Non-custodial, always.** No session keys, no server-side signing, no delegated authority over user funds. A delegated-LogicSig design was specified and then **rejected** — see the Duration section of the Cover spec for why, and for the six transaction fields whose omission would have made it a total-loss vulnerability.

**No shared dependency between Hedge and MagnetFi solvency.** The original rule was narrower — *Hedge must never read the oracle that MagnetFi liquidations depend on* — because manipulating a payout and manipulating protocol solvency must never become one action. Integrating a third-party protocol generalises it:

> **No Hedge product may depend on a price or state source that MagnetFi solvency depends on.**

Under that rule Cover is clean: it reads PEX state and touches no MagnetFi state at all. It also means taking PEX LP as MagnetFi collateral would foreclose PEX-based Hedge products, and vice versa. That dependency can be spent once. Cover does not spend it.

---

## Build Standalone, Extract Later

Hedge is one product, and the right structure for one product is one self-contained tree. No shared module, no adapter interface, no abstraction built for a second thing that does not exist. If a second product ships, shared pieces get extracted then — against two real implementations rather than one real and one hypothetical.

VPL's move to `predict/` is that principle applied: duplicated framing, no cross-tree dependency.

---

## Open Source Policy

**Hedge's frontend and any contract it ever gains are public**, in the same repo and under the same terms as the rest of Magnet Strategies.

The reasoning is not ideological:

1. **Deployed code is public regardless.** Approval programs are readable on-chain and any published client library carries the full ABI. Closed-sourcing an Algorand contract converts a one-hour read into a one-day read and obscures nothing of substance.
2. **Trust is the binding constraint.** Cover's users are trusting PEX's contracts, PEX's oracle signer, PEX's keepers, and — transitively, because pool assets are deployed into Folks Finance and xALGO — two further protocols. Being legible about our own layer is the minimum we can offer against that stack.
3. **Consistency.** MagnetFi is public and custodies real collateral. A closed integration layer alongside an open lending protocol reads as concealment.

**Carve-out — off-chain operations may stay private.** Keeper scheduling, redundancy and failover are a separate service and are not part of any public repo. That is where operational edge legitimately lives.

Note that PEX's own SDK is **source-available, not open source**, under the PEX Builder License 1.0. Nothing in Cover conflicts with its terms; our code stays under ours, theirs under theirs.

---

## Documents

| | |
|---|---|
| [perps/OVERVIEW.md](./perps/OVERVIEW.md) | PEX integration — platform facts, measured MainNet state, integration paths considered |
| [perps/COVER_SPEC.md](./perps/COVER_SPEC.md) | Cover — product definition, architecture, threat model, invariants |
| [ORACLE.md](./ORACLE.md) | Price service — sources, attestation format, trust model. Retained because perps cites it as the sector-level oracle doc for off-chain cross-checks in our own keeper aggregation |
| [../predict/OVERVIEW.md](../predict/OVERVIEW.md) | **Predict** — the ladder product line, moved to its own tree |
