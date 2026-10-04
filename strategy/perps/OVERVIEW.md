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

No contract is deployed because none exists. **Audit 9 has not run** — the tree is
unaudited since `5f85472`, which includes the audit-8 remediation itself.

The directory, route, component names and tab key all still say `perps`; the UI
says Trading Terminal. That is a label, not a restructure.

Detail: [SPEC.md](./SPEC.md#build-status--2026-09-29) for what is built,
[NEXT.md](./NEXT.md) for what to build next and why in that order,
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

## Documents

| | |
|---|---|
| [SPEC.md](./SPEC.md) | Product definition, architecture, threat model, invariants |
| [PEX.md](./PEX.md) | PEX integration — platform facts, measured MainNet state, integration paths considered |
| [NEXT.md](./NEXT.md) | What to build next — close, cancel, limit orders, USDC-only payout — and what each needs settled first |
| [AUDIT.md](./AUDIT.md) | Adversarial audit findings, the one-position decision, and what the earlier verification got wrong |
| [B6-QUESTION-FOR-ULTRADE.md](./B6-QUESTION-FOR-ULTRADE.md) | **Resolved.** The attached take-profit leg rejected by OrderOps — kept for the elimination method |
| [CLOSE-QUOTE-QUESTION-FOR-ULTRADE.md](./CLOSE-QUOTE-QUESTION-FOR-ULTRADE.md) | **Answered 2026-09-28.** Partial-close payout semantics — the answer found two defects in shipped code |
| [YIELD-RECALL-QUESTION-FOR-ULTRADE.md](./YIELD-RECALL-QUESTION-FOR-ULTRADE.md) | **Answered 2026-09-29.** Always recall |
| [CLOSE-RECALL-QUESTION-FOR-ULTRADE.md](./CLOSE-RECALL-QUESTION-FOR-ULTRADE.md) | **Drafted, not sent.** The one value the close path still needs — an xALGO fee credit that is not on chain |
| [AUDIT-7-REMEDIATION.md](./AUDIT-7-REMEDIATION.md) | Audit 7's findings, the fixes, and what the review of those fixes then found |
| [../ORACLE.md](../ORACLE.md) | Arm-level price doctrine — Perps consumes PEX's signed payloads and runs no feed of its own |
| [../OVERVIEW.md](../OVERVIEW.md) | The Strategy arm — admission criterion and arm-wide commitments |
