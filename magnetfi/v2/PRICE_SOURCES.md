# MagnetFi — Oracle Price Sources

**Status: SPEC, nothing built. Written 2026-11-10, after the outage that day.**
Bot-side only — no contract change. The contract side is
[ORACLE_LEAN_SPEC.md](./ORACLE_LEAN_SPEC.md); this is what feeds it.

---

## 1. Why this exists

On 2026-11-10 borrowing and all liquidations reverted on U/tALGO and U/ALGO.
Nothing was compromised and no price was wrong.

**This was the second time.** The same failure ran 96 minutes on 2026-10-27,
and [OVERVIEW.md](./OVERVIEW.md) already recorded both the dependency and the
three candidate remedies: *"a second verification source, a longer tolerance
with an explicit staleness alarm, or allowing a bounded raise when
unverified."* This spec takes the first two and declines the third — §4
replaces the veto rather than loosening it, because a bounded raise when
nothing can verify the price is the one option that weakens the guard instead
of widening it.

The chain of events:

1. **CompX's Flux oracle went stale.** `$U` last updated **2026-11-08
   06:26:22Z** — 58 hours against the bot's 1-hour limit. Read straight off
   their box (`3307588794`), so it is their outage and not our fetch.
2. **`compx_verified` went false**, which switches off the divergence guard and
   leaves `update_pool`'s fail-stale rule: flat or small declines only, never a
   rise.
3. **$U was rising all afternoon**, so every cycle computed a raise and refused
   it: `CompX unverified; would raise 690929→692557 — refusing (fail-stale)`.
4. The last successful U/ALGO post was **16:03:35**. U/tALGO crossed the
   vault's 30-minute window at **16:33**, U/ALGO at **16:38**.

### The two findings that matter more than the outage

**The alerting watches the symptom, not the cause — and may not be wired at
all.** `StalenessWatchdog` is correct code: `STALE_WARN_SECONDS = 900` warns at
15 minutes and goes `critical: true` at 30, debounced on state change so it
does not repeat per cycle. On 2026-11-10 that puts a warn around **16:18** and
a critical at **16:33**. But what it watches is the age of the *posted price*,
so even working perfectly the first alert lands **15 minutes before the vault
freezes**.

> **Check this before anything else:** `notify()` is a no-op unless
> `ALERT_WEBHOOK_URL` is set, it defaults to `""`, `start_oracles.cmd` sets
> only `TWAP_STATE_PATH`, and OVERVIEW.md records the webhook as unset with
> *"three feed incidents … ~27h, ~48h and ~96min before anyone noticed"*. The
> bot prints `Alert webhook: configured / not set` at startup. If it says not
> set, every item in §5 is worth nothing until that is fixed, and it is a
> one-line change.

The cause had been detectable for **58 hours** regardless. `compx_cross_check`
spotted it on the very first cycle and every cycle after, correctly:

```python
if age > cfg.compx_max_age:
    log.warning(f"[{pool.label}] CompX price stale ({age}s > {cfg.compx_max_age}s)")
    return "unverified"
```

`log.warning`, and the same for the other two `unverified` branches and for
every `refusing (fail-stale)` line. The bot alerts on the posted price ageing,
on prices resuming, on PEX divergence, even on a self-test — but never on its
only validator dying, which is the one condition that predicts all of it.

So the fix is not "add alerting". It is **move the alert from the symptom to
the cause**, trading a 15-minute warning for a 58-hour one. **A timestamp
nobody is alerted on is worth exactly as much as no timestamp.** This is the
cheapest change here by a wide margin and the only one that would have
prevented the outage we actually had, which is why §9 puts it first.

**CompX was the only thing that could block a post.** The PEX cross-check is
`ALERT-ONLY by design` — its own docstring says making it able to block would
let their oracle freeze ours. So this was not "both sources failed". It was
"the one source failed, and the telemetry that should have shouted was also
broken" (its pinned signer had been wrong since PEX rotated on 2026-10-23;
fixed in `14268ed`, and the running process picks it up on restart).

---

## 2. What the sources actually are

Measured 2026-11-10. The distinction that governs the whole design is
**liquidity independence** versus **computation independence**.

| Source | What it is | Independent of Tinyman liquidity? |
|---|---|---|
| Tinyman v2 pools | the price itself, from reserves via algod | — it *is* the input |
| Vestige | its own index of on-chain pool contracts | **No** — same pools, different aggregation |
| LiquiHog | same, and the same Pact managed-weighted blind spot | **No** |
| Haystack | a *router*; quotes by routing across the same pools | **No** — and adds an API dependency |
| CompX Flux | on-chain oracle box, timestamped | **No** |
| Pact pools | separate on-chain liquidity | **Yes** — but only $1,658 deep |
| Coinbase / Kraken / CoinGecko | real order books | **Yes** — but ALGO and USDC only |

**$U cannot be derived.** `TOKENOMICS.md` records no backing, redemption or
floor: $U is not a receipt or a claim, so unlike tALGO there is no issuer rate
to read. Its price is whatever pools say. There is no external market for it
anywhere, so **no source on earth prices $U independently of Algorand DEX
liquidity.** That is a risk to accept and document, not to engineer around.

What a second source *does* buy is a check on **our own computation** — the
route graph, the reference-pool config, the arithmetic. That is where this
system's incidents have actually come from:

- **2026-10-09** a hardcoded bound blocked a legitimate rise. Nine-hour outage.
- **2026-10-10** a bound sat *above* the band ceiling, so the bot would have
  accepted a price the contract rejected.
- **2026-10-27** the only validator went stale. 96 minutes, recovered
  unattended, noticed only because someone happened to be watching.
- **2026-11-10** the same thing again, for 58 hours.

---

## 3. The sources, in priority order

### 1 — Tinyman v2 (primary, unchanged)

Reserves read from algod, TWAP'd. Keep exactly as is. It is the only thing
that can price $U at all, and it is trustless: no vendor, no API key, no rate
limit.

### 2 — Vestige (secondary: the validator that replaces CompX's veto)

Agreed to **0.136%** today ($0.133661 against the bot's $0.133843) at the same
moment CompX's frozen value was **4.85%** out — close enough to the 5%
divergence limit that slightly more staleness would have flipped it from
`unverified` to a *hard* refuse.

It computes from a different pool set with different weighting, so it catches
our route graph being wrong. It cannot catch Tinyman being wrong.

> **It returns no timestamp.** Fields are `price`, `confidence`,
> `total_lockup`. So it may **vote** but may never **satisfy freshness** — see
> §4. Staleness is detected by observation instead: flag a Vestige price that
> has not moved across N cycles while the primary has.

### 3 — Coinbase + one fallback (independent truth for ALGO *and* USDC)

The only genuinely non-Algorand input available. Measured today:

| | ALGO/USD | vs median |
|---|---|---|
| Coinbase | 0.088450 | +0.193% |
| Kraken | 0.088280 | 0.000% |
| CoinGecko | 0.088189 | −0.103% |
| our derivation | 0.088528 | +0.281% |

Spread across the three: **0.296%**. Two venues, not three — the third buys
0.1% of accuracy against a 5% tolerance and costs a third rate limit, outage
mode and schema.

**This covers more than anything else here**, for a reason that is easy to
miss: in `config.lean.json` the `ALGO/USDC` pool carries **no
`compx_check_asset_id` at all**. The reference pool — the root every other
price is derived through — has never had a second source of any kind. It was
the only pool unaffected on both 2026-10-27 and 2026-11-10, and that is the
same fact seen from the other side: nothing can freeze it because nothing
checks it. The bot's own alert text makes the stakes plain: *"ALGO is the root
of every pool's price, so this affects all of them."*

Exchanges would be its first cross-check ever, and they are also the only layer
in this document that survives Tinyman being compromised rather than merely
unavailable.

**Price USDC too.** The derivation currently treats USDC as $1.00 axiomatically
(`derive_asset_price_usdc` returns 1.0 for it). A depeg would silently inflate
every $U price. One call turns an assumption into a measurement.

### 4 — Pact (low-authority sanity only)

Pact U/ALGO (`3734973475`) is the only non-Tinyman pool that can price $U
against a known asset — the other four Pact $U pools are paired with volatile
partners (ALPHA, COMPX, NIKO, FOLKS) and cannot price $U without first pricing
the partner.

Its depth is **$1,658** against **$2,423** of vault collateral — a ratio of
**0.68×**. The fallback is thinner than what it would price, so it may raise an
alert and must never set a price. That ratio worsens as the vault grows.

---

## 4. The rule

Replace *"CompX agrees, or fail-stale"* with:

> **At least two sources must be fresh and agree within tolerance.**

Any single source may die — including Vestige, including CompX, including one
exchange — without freezing the vault. That is precisely the property today's
design lacks, and the whole point of the change.

Freshness is satisfiable only by sources that can prove it:

| Source | Can prove freshness? |
|---|---|
| Tinyman | yes — chain round |
| Exchanges | yes — their timestamps |
| CompX | yes — `lastUpdated` |
| **Vestige** | **no** — confirming vote only |
| **Pact** | yes (chain), but authority-capped to alerting |

So a quorum can never consist of Vestige alone, and the primary must always be
one of the two.

---

## 5. Alerting — do this first

Much smaller than the feed work, and it is what actually cost us the outage.
The machinery already exists; it is pointed at the wrong event.

**First, confirm `ALERT_WEBHOOK_URL` is actually set**, per the box in §1.
Nothing below this line exists until it is.

1. **`notify()` on every source transition**, debounced by state change exactly
   as `StalenessWatchdog` and `check_algo_against_pex` already do — once on
   failure, once on recovery, never per cycle. That is the 58-hour warning.
2. **`notify()` on a refused post.** Every `refusing (fail-stale)` branch is a
   `log.warning` today, and a refusal is the last moment before the clock to
   the 30-minute window starts.
3. **`critical: true` when the quorum is lost**, because from there the vault
   freezes on a schedule.
4. **A "has not moved" detector** for any source without a timestamp.

Keep the posted-price watchdog exactly as it is. It is the backstop that
catches a failure mode nobody predicted, and the point of the above is to make
it the *second* thing to fire rather than the first.

---

## 6. Three traps, each measured

**The $U ticker collision.** Both Coinbase and Kraken return a confident 200
for a token called "U" — a completely different asset:

| | Price | Off by |
|---|---|---|
| Magnet $U | $0.133843 | — |
| Coinbase `U-USD` | $0.000068543 | **1,953×** |
| Kraken `UUSD` | $0.000089 | **1,504×** |

`read_compx_price` already has the right discipline — it verifies the box's
embedded `assetId` matches what was asked for. **Ticker symbols cannot provide
that.** No external source may price $U. Exchanges are for ALGO and USDC only,
and that restriction belongs in code, not in a comment.

**Vestige freezing into agreement.** A frozen feed that happens to agree votes
"yes" for ever and silently adds nothing. §5's detector is the mitigation.

**Pact being load-bearing.** At 0.68× coverage it cannot set a price. If it is
ever wired, the authority cap has to be enforced, not documented.

---

## 7. What this does not fix

**Tinyman going down.** No row in §2 survives it, because $U has no price
outside Algorand DEX liquidity. The correct behaviour is to fail closed, which
is what already happens.

Worth stating plainly because it is not a pricing problem: **freezing stops
liquidations.** Positions go underwater and nobody can close them, so bad debt
accrues for the duration. That is the real cost of a Tinyman outage and no feed
fixes it — it is a question about guardian powers and manual intervention.

The only genuine mitigation is **deeper non-Tinyman $U liquidity**, which is a
treasury deployment decision rather than an engineering one.

---

## 8. Why the bar is higher than it looks

The ±25% anchor band is **gone** — retired with `lp_oracle` (`3644230020`) on
2026-10-17. The live lean oracle (`3741272132`) caps nothing, and with no
anchor `effective_bounds_with_anchor` returns `(0,0,0)`, so the bot's own
bounds are inert (`ADMIN.md:192`).

So this is not defence in depth on top of a contract guard. **These sources,
the TWAP and the fail-stale rule are the entire defence**, and all of them are
off-chain and useless against a compromised bot key. `ORACLE_LEAN_SPEC.md`'s
envelope — reviewed safe below ~$100k collateral TVL, measured at $2,423 —
is what makes that acceptable today.

---

---

## 9. Sequencing

Ordered by cost-to-benefit against **the failure we have actually had twice**,
which is not the same as ordering by coverage — §3's exchange work protects
more and comes third here because it addresses a risk that has never yet fired.

1. **Alerting (§5).** Would have bought 58 hours of warning on 2026-11-10
   instead of 15 minutes, with no change to how prices are computed. Smallest
   change in the document.
2. **Vestige as the second validator**, and the two-of-three rule (§4). This is
   what ends the single-veto dependency.
3. **Exchanges for ALGO + USDC (§3).** Independently valuable and separable: it
   is the first cross-check the reference pool has ever had, and the only layer
   that survives Tinyman being wrong rather than absent.
4. **Pact as alert-only**, if at all.

---

## 10. Open

- Does Vestige expose freshness anywhere? Checked `/assets/{id}/price` (404)
  and `/assets/{id}/candles` (422); worth one pass over their docs before
  designing around its absence.
- Does CompX stay in the quorum once it recovers, or become a fourth opinion?
  It held a veto it could not be trusted with; it does not get that back by
  default.
- The route graph is a separate question this spec does not settle: $U's
  route 0 is quoted in **tALGO**, tALGO in ALGO, ALGO in USDC — three hops,
  every one a Tinyman v2 pool, and tALGO is itself issued by Tinyman. Route 0
  is U/tALGO because it is deepest (~$5.7K vs $1.9–2.0K). Promoting U/USDC
  would remove a whole dependency layer at the cost of depth.
