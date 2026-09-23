# Predict Oracle

VPL settles against a price. This document covers the service that supplies it, the attestation format the contract verifies, and the trust model that follows.

**Status:** Settled — four free, keyless exchange candle endpoints, with Predict signing attestations on-chain.

---

## Requirement

VPL settles against a price, and the requirement is deliberately small:

**Four sources × two checkpoints = eight candle reads per day.**

That is below any rate limit anywhere, available free and keyless, and costs nothing. The checkpoints are the 9am reference and the 4pm settlement.

## The Settled Number

**OHLC4 of the 1-minute candle at the checkpoint — `(open + high + low + close) / 4` — median across four venues.**

Every component is published, permanent, and visible on any charting tool, so a participant can verify a settlement indefinitely. That checkability is the deterrent the product runs on.

Not the candle *open*: the open is the first executed trade of the minute, so moving it means owning one print rather than holding a level — sweep two thin venues 0.2% at the tick and unwind seconds later. And the manipulation would be invisible, because the quotes written on-chain would be the true opens. OHLC4 requires moving the open, the high, the low and the close — sustained pressure across the whole minute against arbitrage — and is exactly as checkable.

The keeper reads just after the checkpoint minute closes, since OHLC4 needs a completed candle.

**Candles are very stable, not immutable.** Exchanges occasionally bust a trade and restate historical OHLC, so a keeper reading the 16:00 candle at 16:00:30 and one backfilling it two days later could in principle see different values. Two consequences, both small: a late resolve is not bit-identical to an on-time one, and a settlement checked against a chart months later may not match if that venue has since restated. What bounds it is that the **attestation is published at signing time** — a timestamped record of what the keeper actually saw, independent of what a venue serves later — and that the median of four means one venue's restatement cannot move the settlement unless a second moves with it.

**Derivation is off-chain keeper policy.** The contract verifies a signature over a value and has no opinion on provenance, so the method can be tightened further — VWAP, a longer window — without touching the non-upgradeable contract.

## Attestation Format

One aggregate attestation per checkpoint covering all four venues:

```
message = sha256( app_id ‖ round_id ‖ checkpoint_kind ‖ present_mask
                  ‖ price_feed_id ‖ prices[4] ‖ timestamps[4] )
verify  = ed25519verify_bare(message, sig, round.oracle_pubkey)
```

Not four independent signatures. With per-source signatures and an unsigned mask, the signatures become public the moment they reach the mempool and anyone can resubmit them with a different mask, selecting from a menu of medians after seeing every value. Signing the vector and mask together leaves exactly one valid submission.

**Field provenance is part of the contract.** `app_id` comes from `Global.current_application_id`, `round_id` from the round box key, `checkpoint_kind` from the calling method's own literal, and `price_feed_id` from the round's snapshot. Only `present_mask`, `prices[4]`, `timestamps[4]` and the signature come from arguments. Reconstructing the whole preimage from ABI arguments — the natural shape of verification code — would make those bindings decorative.

**`timestamps[i]` is the candle's clock-aligned open boundary in seconds**, normalised by the keeper. Gemini returns milliseconds; passing that raw fails every round. The contract asserts **equality** with the checkpoint, which `create_round` has already required to be minute-aligned. There is no tolerance window and no inter-source bound — under a bucket-key definition a tolerance is the wrong shape, and a band of ±15s would make most checkpoints either unresolvable or silently settle on the wrong minute.

**Aggregation:** minimum 3 of 4 present. Four → median of the middle two; three → the middle one. Absent slots are written on-chain as `0`, never the submitted value.

**Spread gates at `lock` only, at 2%.** No outcome exists before lock, so buying a void there means paying to refund your own stake — the incentive that makes a spread gate dangerous at `resolve` simply is not present. At 2% the gate sits ~130× above the observed inter-venue agreement of 0.015%; it exists to catch a per-venue misconfiguration the median would otherwise absorb, not to defend against manipulation. **There is deliberately no spread gate at `resolve`**, where a participant facing a total loss could otherwise push one venue past the threshold and buy themselves a refund.

**The reference is bounded against the previous round's settlement**, 50%–200%. The ladder spans only 7% of the reference, so any reference error above ~3.5% decides the round — a wrong quote currency shifts every boundary 8% while all four venues agree and every other check passes.

## Sources

### Four exchanges, direct

**Coinbase Exchange, Kraken, Gemini, Bitstamp.** Queried at the tick, median taken.

Measured live, the reasoning is concrete:

```
Coinbase   79,128.82
Kraken     79,129.30     ← three order books agree to 0.015%
Gemini     79,133.10
CoinGecko  79,209.00     ← aggregator sits 0.10% off, on update lag
```

Three reasons for exchange-direct over aggregators:

- **Exact minute boundaries.** Exchanges publish 1-minute OHLC candles aligned to the clock, so "the 16:00 candle" is unambiguous and permanent. Aggregators publish a rolling snapshot on their own interval — there is no 16:00 candle to check later.
- **Genuine independence.** CoinGecko and CoinMarketCap share underlying exchange inputs — correlated, not independent. Three separate order books are.
- **USD, not USDT.** Every source above is a real dollar pair. A USDT pair would layer Tether depeg risk onto settlement. (Binance is geo-blocked from US infrastructure and was a USDT pair regardless.)

All four are free and keyless. Four sources means one venue can fail entirely and three remain; two can fail and settlement still proceeds.

**Aggregation:** 4 valid → median (mean of the middle two); 3 → median; **fewer than 3 → retry until the deadline, then void.**

**Spread never gates settlement.** It is computed, published, and used for monitoring only. The median already excludes a stale or broken venue — one bad source cannot move it by more than the gap to the next venue, roughly 0.005% when the venues agree to 0.015%. Gating on spread instead would make a VOID purchasable by pushing one venue past a threshold (cheapest exactly when a participant faces the largest loss), would void on routine single-venue staleness, and would fire most often during genuine dislocations — which are the days the tail bands win.

**Timestamps are pinned to the checkpoint, and to each other.** Each attested price must be within **15s** of the checkpoint, and all submitted timestamps within **10s** of one another. The transaction posting them may be late.

Checking staleness against *now* would let a keeper submit a genuine, correctly-signed price from a minute of their choosing. Checking each source against the checkpoint alone still leaves a menu of 4 venues × 121 seconds — the full range of the two minutes around the tick, which straddles a band boundary in roughly one round in six. Both bounds together collapse that to ~$25 of range against boundaries $750+ apart.

Bounds are looser than the tightest defensible values, because thinner books report lagged last-trade timestamps and needless retries cost more than the residual discretion. Tune on testnet.

**One aggregate attestation, not four signatures.** The message commits to `app_id ‖ round_id ‖ checkpoint_kind ‖ present_mask ‖ price_feed_id ‖ prices[4] ‖ timestamps[4]`.

Four independent signatures with an unsigned mask are worse than they look: once the keeper broadcasts, the signatures are public, and **anyone** can copy them and resubmit with a different mask — picking whichever subset settles in their favour from a menu of eleven medians and midpoints, chosen after seeing every value. Signing the vector and the mask together leaves exactly one valid submission.

**Attestations are published the instant they are signed**, and `lock`/`resolve` verify a signature rather than a sender — so anyone can relay them. That is a backup, not a dependency: the keeper submits every round in normal operation. It exists so a keeper failure between signing and submitting cannot strand a round, and so withholding submission is not a power the operator holds.

**All four quoted prices are published on-chain** alongside the median, so any settlement can be independently recomputed and checked against public data afterwards.

Identical vendor set, median rule, and guards at both the reference and the settlement checkpoint. A reference taken one way and a settlement another introduces a bias that is hard to spot and impossible to explain.

### Licensing

> **Publishing a signed price on-chain is redistribution.** Commercial data licenses routinely separate internal use, end-user display, and redistribution or derived works.

Exchange-direct is likely the easier path here — venues publish their own market data as a byproduct, where aggregators sell aggregation as the product. At eight calls a day, neither rate limits nor commercial tiers are a practical constraint. Confirmation is being handled separately.

## Display Prices Are Not Settlement Prices

An important cost and risk separation:

- **Settlement prices** are signed, verified on-chain, and decide who gets paid. They are needed exactly twice per round.
- **Display prices** drive the UI: the live oracle marker on the ladder histogram, a running leaderboard during a contest. They are needed constantly and are never verified by a contract.

Only settlement prices need the commercial tier's defensibility and the signing key. Display prices can come from a cheaper source, a cached feed, or a lower tier — they influence nothing that moves money.

Conflating the two would mean buying institutional-grade data at UI refresh rates for no benefit.

---

## Trust Model

Paying for data solves licensing. It does not remove the trust question — it relocates it.

**Predict signs the prices.** The contracts verify a signature against a registered pubkey; they cannot verify that the signed number is the true market price. A player must trust that the operator signed honestly.

What limits that exposure:

- **The contracts are public** ([open source policy](./OVERVIEW.md#open-source-policy)), so verification logic, staleness bounds, and admin powers are all auditable. Trust narrows to the price itself rather than the whole mechanism.
- **Attestations are permanent and public.** Every signed price lands on-chain with its timestamp. A dishonest price is not deniable after the fact and can be checked against any independent source forever.
- **The signing key is separate from the MagnetFi vault oracle key.** Per the [ring-fencing rule](./OVERVIEW.md#ring-fencing-from-magnetfi), compromising the Predict oracle can never touch protocol solvency.
- **Publishing the source and methodology** — naming the provider and the aggregation method — makes any signed price independently checkable, which is most of the way to verifiable without the cost of a decentralised feed.

The residual risk is honest and should be stated plainly rather than engineered around at this stage: a compromised or dishonest signing key can decide game outcomes. Key custody is therefore an operational security question, not a contract question.

---

## Operations

The oracle service is **off-chain and private**, per the [open source carve-out](./OVERVIEW.md#open-source-policy). Its scheduling, provider calls, aggregation, outlier handling, redundancy, and failover are not part of any public game repo.

Its on-chain footprint is small: post signed attestations at the two daily checkpoints. Because settlement is permissionless, an oracle outage delays resolution — it never blocks users from being paid once a price is posted, and a prolonged outage voids the round with full refunds rather than stranding funds.

---

## Open Decisions

Largely closed. What remains is legal and operational, not technical.

| # | Decision | Status |
|---|---|---|
| 1 | **Ladder sources** | **Closed** — Coinbase Exchange, Kraken, Gemini, Bitstamp. OHLC4 of the 1-minute candle, median, minimum 3 of 4. Spread gated at lock only. |
| 2 | **Ladder price definition** | **Closed** — OHLC4 of the checkpoint minute's 1-minute candle. Identical at reference and settlement. |
| 3 | **Ladder outage fallback** | **Closed** — retry within a bounded window, then VOID with full refunds and no rake. |
| 4 | **Timestamp binding** | **Closed** — the candle boundary must equal the checkpoint exactly; checkpoints are asserted minute-aligned at round creation. No tolerance, no inter-source bound. Submission allowed until the round deadline. |
| 5 | **On-chain redistribution rights** | Open, handled separately. At eight calls a day the commercial constraint is negligible; the question is whether publishing a signed price on-chain is permitted. |
| 6 | **Signing key custody** | Open. Where the key lives, rotation policy, response to suspected compromise. Operational, and the sector's largest residual trust surface. |
