# Perps

Perpetual positions on Algorand, wrapped in a product surface that deliberately does
not look like a trading terminal. A product in the [Strategy](../OVERVIEW.md) arm.

Perps does not operate an exchange. It integrates **PEX**, a third-party perpetuals
protocol built by Ultrade. Magnet Strategies writes no exchange contracts, custodies
no user funds, and holds no protocol role.

**Status:** Integration under construction — config, on-chain reads, the risk-bar
solver, oracle verification and the quote layer are built and verified against
MainNet. No contract is deployed because none exists. **The product name is
provisional** — "Perps" describes the instrument, not the product.

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

It is deliberately **not** a trading terminal, and deliberately **not** framed as
hedging. An earlier draft built it around protecting an existing holding — *"protect
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

## Documents

| | |
|---|---|
| [SPEC.md](./SPEC.md) | Product definition, architecture, threat model, invariants |
| [PEX.md](./PEX.md) | PEX integration — platform facts, measured MainNet state, integration paths considered |
| [../ORACLE.md](../ORACLE.md) | Arm-level price doctrine — Perps consumes PEX's signed payloads and runs no feed of its own |
| [../OVERVIEW.md](../OVERVIEW.md) | The Strategy arm — admission criterion and arm-wide commitments |
