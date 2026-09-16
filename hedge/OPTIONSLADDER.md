# Option Ladder

A daily intraday ladder on BTC. Each morning a reference price is set, the day's trading session runs, and players who picked the band the price finished in split the entire pot.

Entry is open 24 hours a day. Stakes are in mUSD. Payouts are funded by everyone who was wrong — no counterparty has to volunteer for the other side, and no order can fail to fill.

**Status:** Design complete. No contract written, no deployment. Implementation detail in [OPTIONSLADDER_SPEC.md](./OPTIONSLADDER_SPEC.md).

---

## Positioning

**Intraday, defined-risk, leveraged directional exposure.** Not a hedging instrument — a seven-hour window is a trading session, not a period anyone hedges a portfolio over. The honest description is convexity with capped downside: stake a small amount on an unlikely move, and if it lands the multiple is large. Maximum loss is your stake. No margin, no liquidation, no way to lose more than committed.

The one genuine protection use is an active trader covering an overnight position through the US session. That's real but narrow, and it shouldn't drive the copy.

---

## The Daily Conveyor

```
Day 1  9:00am ET   Market A LOCKS — reference price set, pot frozen,
                   every multiple becomes known
                   Market B OPENS for entry
       9am–4pm     Market A runs — the 7-hour session
       4:00pm ET   Market A settles and pays out

Day 2  9:00am ET   Market B LOCKS. Market C OPENS.
                   ...
```

Exactly one market accepts entries at any moment, and entry windows never overlap — so all of a day's flow pools into a single ladder. Runs seven days a week; BTC has no closures and a consistent schedule is worth more than optimising around weekend volatility.

**Entry is always open.** Arrive at 9:01am and you immediately enter tomorrow's market. There is never a moment when a user cannot place a position.

---

## Bands

Nine mutually exclusive bands, defined as **percentage moves from the reference price**, not absolute prices:

| Band | Approx. probability |
|---|---|
| below −3.5% | tail |
| −3.5 to −2.25% | ~5% |
| −2.25 to −1.25% | ~13% |
| −1.25 to −0.5% | ~17% |
| **−0.5 to +0.5%** | ~28% |
| +0.5 to +1.25% | ~17% |
| +1.25 to +2.25% | ~13% |
| +2.25 to +3.5% | ~5% |
| above +3.5% | tail |

Sized against a 7-hour BTC σ of roughly 1.4%, with the outermost boundaries near 2.5σ — rare enough to pay large multiples, common enough to hit several times a month. Every band is live; none are decorative.

**The reference price is set at lock, after entry closes.** Nobody knows it when they commit, which is why bands are percentages rather than prices and why overnight drift doesn't matter.

That removes the *level* as an edge, not the *distribution*. Someone entering minutes before lock can read the volatility regime and the economic calendar in a way an entrant twenty hours earlier cannot. That is a real edge and the product does not pretend otherwise — reading vol and betting against the template is exactly the skill this market exists to reward. A parimutuel also prices it as it is taken: entering size into a thin band collapses the multiple you were entering for.

Three further benefits of percentage bands: overnight drift stops mattering, the ladder looks identical every day so users build real intuition about what each rung pays, and "protection against a 3% drop" is how people actually think about downside.

**Magnet sets the band template. Magnet never sets a payout.** Bands are a ruler — choosing to measure in ±0.5/1.25/2.25/3.5% increments expresses no view about where the price will go. Payouts express a probability claim, and those come entirely from the crowd. This distinction is the product's core safety property.

Fixed percentages rather than volatility-scaled: learnability is worth more than perfect calibration, and the template is reviewed quarterly against ~90 rounds of data.

---

## How Payouts Work

One pot. The losing bands fund the winning band.

```
40 traders stake 10,000 mUSD total. Rake 4% → payable pot 9,600.

Band              Staked     Multiple
below −3.5%          100        96×
−3.5 to −2.25%       300        32×
−2.25 to −1.25%      700      13.7×
−1.25 to −0.5%     1,400       6.9×
−0.5 to +0.5%      4,000       2.4×
+0.5 to +1.25%     1,800       5.3×
+1.25 to +2.25%    1,000       9.6×
+2.25 to +3.5%       500      19.2×
above +3.5%          200        48×
```

Every multiple is simply `payable_pot ÷ that band's stake`. No model, no quote, no counterparty.

**If BTC finishes +4.2%**, the top band wins. Its 200 mUSD of stake splits the full 9,600 — a 48× return. The other 9,800 mUSD across eight losing bands is what pays for it. The trader who put 4,000 on "nothing much happens" never agreed to underwrite a tail bet, but when the tail hit, their stake funded it.

**That is the entire funding mechanism: leverage is paid for by everyone who was wrong.**

Within the winning band, payout is **pro-rata by stake**, so everyone in the band earns the same multiple and payouts scale with what they risked:

```
your payout = payable_pot × (your stake ÷ winning band's total stake)
```

Splitting by headcount instead would make minimum stakes optimal and collapse the pot within a day.

### Odds move as money arrives

```
                    before          after +200 to the top band
pot                 10,000          10,200
payable              9,600           9,792

above +3.5%     200 → 48×       400 → 24.5×    ← crowding cuts your own payout
centre         4,000 → 2.4×   4,000 → 2.45×    ← and slightly improves everyone else's
```

Back a lonely band and your payout is large precisely because few people agree with you. **The crowd's disagreement is the pricing engine.**

---

## Strategy Surface

**Buying an unlikely band is the whole point.** If you think the crowd is underpricing a move — a vol regime they haven't noticed, an event they've dismissed — you buy that exposure for a few mUSD and take the pot when you're right. A lone holder of the winning band receives all of it. That is not a loophole in the design; it is the design, and it is uncapped.

Playing the consensus band carries its own cost. Crowding pays a low multiple when you're right and nothing when you're wrong, and every additional entrant makes both worse. The ladder prices that trade-off automatically, with no one setting odds.

One nuance worth knowing rather than learning the hard way: your multiple depends on the **final** distribution, not the one you entered against. A large, early, visible position makes its own band look unattractive and pushes later flow elsewhere — which grows the pot without diluting you. Entering early with size can therefore beat entering late with the same size, and the displayed multiple early in a window is not a prediction of where it closes. `GET /history` publishes how each band's multiple drifted from open to lock over past rounds, which is the honest guide.

**Spreading is expected.** A user may hold positions in several bands. Covering three adjacent bands lowers variance and maximum payout; barbelling both tails is a volatility bet with no directional view. The payout math is exactly neutral to splitting a position across bands or addresses.

**Covering all nine bands loses exactly the rake.** You're guaranteed to hold the winner and guaranteed to receive less than you staked. Nothing prevents it and nothing needs to.

## Rules

**Entries are final.** No withdrawal, not even before lock. Withdrawal would be a free option on the pot's composition — enter, watch, and pull out if your band crowds — exercised at everyone else's expense. Every remaining participant in every other band is strictly worse off when the pot shrinks, because they committed against a pot that included that money.

**Minimum stake: 5 mUSD.** Several hundred times the MBR cost of a position box, so dust is uneconomic without a separate fee.

**Multiple bands allowed.** Spreading across adjacent bands lowers variance and maximum payout; barbelling both tails is a volatility bet with no directional view. These strategies emerge for free.

**A round needs two occupied bands.** If every stake sits in one band at lock, the round is cancelled and everyone refunded — that configuration pays `1 − rake` and is a guaranteed collective loss. It is not a market.

The test is deliberately *not* a dollar amount. A 40 mUSD pot split across three bands is a real game with real odds; a 40,000 mUSD pot with everyone in the centre is not. It tests the only thing that matters — whether there is disagreement to price.

It is a **liveness check, not a user protection.** Occupancy only ever increases, so anyone can satisfy it by adding a minimum stake to a second band — and if they do, they are betting into a crowd concentrated elsewhere, which is exactly the sweeping the product encourages. The test stops a degenerate round running unattended; it cannot protect participants from their own concentration.

**If nobody wins, the round is void.** Full refunds, no rake. When the price lands in a band nobody entered, there is no one to pay. Rolling the pot forward would take money from players who lost to *nobody* and hand it to tomorrow's entrants, which reads as the house helping itself — and early on, with perhaps one round in eight ending this way, that would be corrosive. The frequency falls toward zero as more bands get populated.

**No seeding, no carry-forward.** A treasury subsidy has a burn rate with a countdown attached — at a 4% rake, covering a seed needs a pot fifty times its size. And unclaimed winnings go to treasury rather than into the next round's pot: rolling them forward sounds fairer, but unowned money in a pot is a free claim for anyone covering every band, which turns a guaranteed 4% loss into a risk-free profit. Cold start rests on the two-band test being easy to satisfy, the daily habit loop, and yesterday's published closes as a prior.

**Operator addresses cannot enter.** The admin, keeper and treasury are barred in the contract. An operator holding positions while running the price feed has a free option on every round; removing the position removes the motive. It is Sybil-able and therefore a commitment rather than a guarantee — but it is the clearest one available.

---

## Economics

| Parameter | Value |
|---|---|
| Base currency | mUSD (`3615600399`) |
| Rake basis | % of pot, taken only on a round that pays out |
| Rake rate | 4% |
| Rake cap | 10%, enforced in contract, not raisable |
| Rake destination | Magnet Strategies treasury **address** |
| Minimum stake | 5 mUSD |
| Viability test | ≥2 occupied bands at lock |

The rake is taken off the pot before any multiple is computed, so the figures on the ladder are already net — a band showing 48× pays 48×. At that level the product keeps genuine convexity and no user pays a cost large enough to swamp the exposure they are taking.

**Treasury address, not router.** A splitter contract routing to treasury, PSM reserves, or $U buyback can be slotted in later without touching the contract.

---

## Payouts Are Pushed

Winners never click a claim button. Seconds after resolution the keeper batches `settle_position` calls and mUSD lands in wallets. Losers get `close_position`, which returns the ALGO box deposit they funded at entry.

Entry costs about **$0.01 of ALGO** beyond the mUSD stake — a refundable box deposit plus a small prepaid fee covering that position's one outbound transaction. Pre-funding it means the operator is never out of pocket for pushing a payout, and it funds a small bounty so anyone can close out a stale position and collect for doing it.

Push payouts are a convenience layered on a permissionless base. **Every payout path can be called by anyone**, so if the keeper stops running, users are delayed — never locked out.

## Settlement

**OHLC4 of the 4pm one-minute candle — the average of its open, high, low and close — median across four exchanges**: Coinbase, Kraken, Gemini, Bitstamp. Same method at the 9am reference.

Every component is published, permanent, and visible on every charting tool, so anyone can check a settlement against the chart themselves, today or in a year. That verifiability is the point: the operator signs the price, and what stops a wrong one is that it would be obvious and permanent, not a mechanism. Averaging the whole minute rather than taking a single print also means a settlement cannot be moved by one trade at the tick.

All four quotes are written on-chain alongside the median, so each venue can be checked against its own public record. Attestations are pinned to the checkpoint minute while submission may be late — a keeper delayed by an outage still posts the correct price, and cannot shop for a better minute.

Source disagreement never voids a round. The median already excludes a stale venue, and gating on spread would make a void purchasable by whoever faced the largest loss. Full detail in [ORACLE.md](./ORACLE.md).

## Bot API

A read/write API plus an MCP server, so bots and AI agents can trade directly.

Bots watch the ladder, compare each band's implied probability against their own model, and enter where they see value. That deepens pots and improves calibration — the product's two structural weaknesses. It's self-correcting, since entering an underpriced band moves it toward fair and shrinks the bot's own edge.

The surface is small because the product is simple: read the ladder, read history, submit an entry. No cancel — entries are final. No settlement call — payouts are automatic.

**The honest risk:** a bot with a decent volatility model beats retail who cluster in the centre band, and over time retail funds the bot. It's bounded — a bot can't deploy size without destroying its own edge in a small pot — but it's worth watching once pots get meaningful.

---

## Why Parimutuel

An order book requires someone to choose the unattractive side of your bet. The empirical record on that, from a comparable Algorand product, is unambiguous: **1,473 orders, 91 matches, an 89% cancellation rate**, and the conventional matching path never fired once in the platform's life. Every trade that happened was a cross-match pairing two opposing buyers.

That failure was primarily **fragmentation** — 208 concurrent markets and 550 order books averaging 2.7 orders each — and concentration would have helped enormously. But two structural findings survive concentration:

- **Users won't price.** 47% of all orders were placed at exactly 50¢, with the rest clustering on round numbers. Asked for a probability, people decline to give one.
- **A book that needs a counterparty can leave your position unfilled.** For a product whose value is taking a position, "your order didn't fill and the move happened" is the worst available failure.

Parimutuel has neither problem. Every entry fills, because there is nothing to match. Nobody has to price, because the distribution of stakes *is* the price.

**Trade-off accepted:** your multiple isn't known until lock. What softens it is that the position has no exposure before lock anyway — the reference price doesn't exist yet — so it holds a fully-defined multiple for 100% of its live span. The live ladder and yesterday's published closes are the prior you enter against.

### Rejected

- **Order books and matching engines** — the liquidity and fill problems above, plus a privileged matcher key users must trust and cannot verify.
- **Binary strikes with tradeable contracts** — requires splitting one pot into several books, needs a matcher with a privileged key, and leaves a position unfilled if nobody takes it. A hedge that doesn't fill is the worst available failure.
- **House-banked fixed odds** — the treasury will not take the other side of user positions.
- **An mUSD LP pool underwriting payouts** — viable architecture, but it makes probability pricing mandatory with other people's money behind it, and on-chain options pools have a poor record against adverse selection. Revisit only with real distribution data from this product.
- **Locked-at-entry odds derived from pot capacity** — systematically rewards late entrants, since your rate reflects how deep the pot was when you arrived. Everyone waits, nobody enters early, the market never starts.
- **User-defined bands** — recreates the fragmentation that killed the prior art.

---

## Remaining Open

| Decision | Notes |
|---|---|
| Data provider terms | All four exchanges are free and keyless at 8 calls/day. Confirming that on-chain publication of a signed reference price is permitted is being handled separately. |
| Band template review cadence | Quarterly assumed. First review after ~90 rounds. |
| Naming | "Option Ladder" is a working title. Current positioning is intraday speculation, not hedging, and the name should follow. |
