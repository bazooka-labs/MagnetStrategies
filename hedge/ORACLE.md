# Hedge Oracle

Price doctrine for the Hedge arm. **This is not a feed specification** — it is the set
of rules a Hedge product must satisfy about where its prices come from, plus the shared
capability available to any of them.

Each product's concrete instance lives with that product:

| Product | Its price situation |
|---|---|
| **Cover** (perps, [perps/COVER_SPEC.md](./perps/COVER_SPEC.md)) | Consumes **PEX's** signed oracle payloads. Runs no feed of its own |
| **VPL** (ladder, moved to [`predict/`](../predict/ORACLE.md)) | Runs the Magnet four-venue feed; settles on OHLC4 of a 1-minute candle |

---

## The dependency-coupling rule

The founding constraint, and the one that generalises:

> **No Hedge product may depend on a price *or state* source that MagnetFi's solvency
> machinery depends on.**

It was originally written narrowly — *Hedge must never read the oracle MagnetFi
liquidations depend on* — because if a payout feed and a liquidation feed are the same
feed, then manipulating a payout and manipulating protocol solvency become a single
action.

**PEX makes the gap in the narrow phrasing visible.** If PEX state ever feeds MagnetFi
solvency (through LP collateral) *and* a Hedge product also depends on PEX state, the
same failure mode returns with PEX as the shared dependency — no Magnet-run oracle
involved anywhere. The rule is therefore about the *property*, not about a particular
oracle app — which is why the blockquote above says *price or state* rather than price
alone. A price-only phrasing would permit exactly what [Invariant 5](./perps/COVER_SPEC.md#invariants)
forbids: PEX state feeding MagnetFi solvency. The generalised form is stated identically
in [OVERVIEW.md](./OVERVIEW.md) and [perps/OVERVIEW.md](./perps/OVERVIEW.md); this doc
owns the price half of it.

Two corollaries worth stating outright:

- **Separate signing keys, separate apps.** A Hedge product's oracle key must never be
  the MagnetFi vault oracle key, so compromising one cannot reach the other.
- **Separation is only as strong as its weakest layer.** Contract-level isolation does
  not survive two private keys sitting on one machine. That is an operational question,
  not a contract one.

---

## Why Magnet runs its own feed at all

There is no credible third-party price oracle on Algorand today. Pyth is not deployed
here; Gora is moribund. Every protocol on this chain that needs a price runs its own
feed, and Hedge is no exception.

That is a statement about the chain, not a preference. m-of-n signing across
independent parties is the path that would remove the residual trust, and it remains
out of scope at this stage.

---

## The shared capability

A four-venue exchange-direct aggregation — **Coinbase Exchange, Kraken, Gemini,
Bitstamp**. Real BTC-USD order books, no USDT pairs, no aggregators, all free and
keyless. Measured live, their agreement sits around 1–2 bps.

Any Hedge product may use it. VPL settles on it. **Cover does not** — PEX payloads are
target-bound, signed for a specific PEX application, and must be rejected on target
mismatch; they cannot be consumed on-chain by any Magnet Strategies contract. What the
Magnet feed offers Cover is a **free, independent off-chain cross-check** in our own
keeper aggregation: if PEX's payload and our own reading diverge beyond a threshold, a
keeper can decline to act rather than trade against a price it cannot corroborate.

### Licensing

> **Publishing a signed price on-chain is redistribution.** Commercial data licenses
> routinely separate internal use, end-user display, and redistribution or derived works.

Exchange-direct is the easier path here — venues publish their own market data as a
byproduct, where aggregators sell aggregation as the product. At a handful of calls a
day, neither rate limits nor commercial tiers are a practical constraint.

---

## Display prices are not settlement prices

A cost and risk separation that applies to every product on this arm:

- **Settlement prices** are signed, verified on-chain, and decide who gets paid. They
  are needed rarely — twice a round for VPL, per-action for Cover.
- **Display prices** drive the UI. They are needed constantly and are never verified by
  a contract.

Only settlement prices need a signing key and defensible provenance. Display prices can
come from a cheaper source, a cached feed, or a lower tier — they influence nothing
that moves money. Conflating the two means buying institutional-grade data at UI
refresh rates for no benefit.

---

## Trust model

Paying for data solves licensing. It does not remove the trust question — it relocates it.

Where a Hedge product signs its own prices, the contracts verify a signature against a
registered pubkey; they cannot verify that the signed number is the true market price.
A user must trust that the operator signed honestly.

What limits that exposure:

- **The contracts are public** ([open source policy](./OVERVIEW.md#open-source-policy)),
  so verification logic, staleness bounds and admin powers are auditable. Trust narrows
  to the price itself rather than the whole mechanism.
- **Attestations are permanent and public.** Every signed price lands on-chain with its
  timestamp and its component quotes. A dishonest price is not deniable after the fact
  and can be checked against any independent source forever.
- **The signing key is separate from the MagnetFi vault oracle key**, per the rule above.
- **Publishing the sources and the method** makes any signed price independently
  checkable, which is most of the way to verifiable without the cost of a decentralised
  feed.

The residual risk stated plainly rather than engineered around: a compromised or
dishonest signing key can decide outcomes. **Key custody is an operational security
question, not a contract question** — and it is the question that most deserves
attention as pot sizes grow.

Where a product consumes someone else's oracle instead — Cover with PEX — the trust
question does not disappear, it transfers. The operator is then trusting PEX's signing
key and its target-binding, which is why an independent cross-check is worth having
even though it cannot be enforced on-chain.
