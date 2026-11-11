# MagnetFi — Oracle Price Sources

**Status: SPEC, nothing built. Written 2026-11-10, after the outage that day.**
Bot-side only — no contract change. The contract side is
[ORACLE_LEAN_SPEC.md](./ORACLE_LEAN_SPEC.md); this is what feeds it.

**Decision 2026-11-10: CompX is ruled out, not demoted.** It has now frozen the
book twice, and its future is uncertain enough that we do not want a dependency
on it at any authority level. §4a is how to remove it without silently removing
the guard with it — the obvious way does exactly that.

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

**CompX was the only thing that could block a post — and the only thing that
could freeze one.** Every other check is advisory by construction: the PEX
cross-check is `ALERT-ONLY by design`, because its docstring notes that letting
it block would hand PEX's oracle the power to freeze ours, and the route
cross-check `logs only, never gates`. So this was not "both sources failed".
One vendor held a unilateral veto, used it correctly, and nobody was told
(the PEX pin had also been wrong since PEX rotated on 2026-10-23 — fixed in
`14268ed`, picked up on restart).

**That veto is the thing being removed.** Not the guard: §4a.

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
| ~~CompX Flux~~ | on-chain oracle box, timestamped | **Ruled out** — see header |
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

### What CompX was supposedly providing, we already have

This is the fact that reorders everything below, and I had it wrong in the
first draft of this spec. `derive_asset_price_usdc` **already** runs a
multi-route cross-check, and its own comment says what it is for:

> *"This is what replaces the CompX dependency for assets with several routes:
> independent arithmetic over independent pools, catching the derivation bugs
> an absolute bound cannot."*

In `config.lean.json`, `$U` (`3081853135`) carries **three** configured routes,
not one:

| Route | Quoted via | Role |
|---|---|---|
| 0 | tALGO (`2537013734`) | the pricing route — deepest, ~$5.7K |
| 1 | USDC (`31566704`) | advisory cross-check |
| 2 | ALGO (`0`) | advisory cross-check |

Routes 1 and 2 are priced every cycle and compared against route 0 at
`ROUTE_DIVERGENCE_ALERT = 0.05`, transition-gated so a standing divergence is
one log line rather than one per cycle. **So $U already has two independent
second opinions on our own arithmetic** — the exact job CompX was nominally
doing, done by pools instead of a vendor.

**ALGO and tALGO have exactly one route each.** In the same config they are
plain objects, not lists, so the cross-check loop never executes for them. The
root of every price in the system has no second opinion of any kind — not
CompX (never configured for ALGO/USDC), not a second route, nothing.

That is the real gap, and it is why §3's ordering is not what I first proposed.

### Measured: the routes would have held the feed up

Priced live from reserves on 2026-11-11 01:1xZ, replicating
`_price_via_route` exactly:

| | $U | vs route 0 | quote-side depth |
|---|---|---|---|
| route 0 (via tALGO) | $0.135728 | — | ~$2,881 |
| route 1 (via USDC) | $0.135642 | **0.06%** | ~$942 |
| route 2 (via ALGO) | $0.135601 | **0.09%** | ~$1,032 |
| CompX (frozen 66.7h) | $0.140338 | 3.29% | — |

**The routes agree to within 0.09% while CompX is 3.29% out and climbing.**
That is tighter than Vestige's 0.136% and it needs no vendor, no API key and no
new dependency. Promoting this check from advisory to the verifier is the
smallest change that both removes CompX and leaves $U better verified than it
is today — and the agreement has evidently held throughout the outage, since
these are the same pools the bot has been reading all along.

> **Two caveats, and they shape the rule.** First, the routes are thin: route 1
> holds about $942 on the quote side, so moving it 5% takes roughly $23 of swap
> (constant product: √1.05 − 1 ≈ 2.47% of reserves) and costs only the round
> trip. If a *unanimous* route agreement were required to post, that is a
> freeze-the-vault attack for a few dollars. So the rule must be **majority
> agreement, never unanimity** — §4. Second, the routes share Tinyman, so they
> catch our arithmetic and our config, never Tinyman itself (§7).

### A trap to avoid while CompX is still wired

Do **not** "fix" the freeze by raising `compx_max_age_seconds`. Staleness is
checked before divergence, so today CompX short-circuits to `unverified` and
the fail-stale rule still permits flat and small declines. Widen the age limit
and the frozen $0.140338 becomes *eligible*, and the divergence check runs
against it: currently 3.29%, measured at 4.85% the day before, against a 5%
`compx_divergence_limit` that returns `"diverged"` — a **hard refuse with no
flat-or-decline escape**. That turns a partial freeze into a total one, and it
gets likelier as $U moves away from CompX's stuck value.

---

## 3. The sources, in priority order

### 1 — Tinyman v2 (primary, unchanged)

Reserves read from algod, TWAP'd. Keep exactly as is. It is the only thing
that can price $U at all, and it is trustless: no vendor, no API key, no rate
limit.

### 2 — Coinbase + one fallback (independent truth for ALGO *and* USDC)

**Promoted above Vestige.** This is the only item here that covers the gap
§2 identifies: ALGO is single-routed, it is the root every other price derives
through, and nothing has ever cross-checked it. Measured today:

| | ALGO/USD | vs median |
|---|---|---|
| Coinbase | 0.088450 | +0.193% |
| Kraken | 0.088280 | 0.000% |
| CoinGecko | 0.088189 | −0.103% |
| our derivation | 0.088528 | +0.281% |

Spread across the three: **0.296%**. Two venues, not three — the third buys
0.1% of accuracy against a 5% tolerance and costs a third rate limit, outage
mode and schema.

In `config.lean.json` the `ALGO/USDC` pool also carries **no
`compx_check_asset_id` at all**, so it was the one pool unaffected on both
2026-10-27 and 2026-11-10 — the same fact from the other side: nothing can
freeze it because nothing checks it. The bot's own alert text makes the stakes
plain: *"ALGO is the root of every pool's price, so this affects all of them."*

Exchanges are also the only layer in this document that survives Tinyman being
**wrong** rather than merely absent, since every other row reads the same pools.

**Price USDC too.** The derivation treats USDC as $1.00 axiomatically
(`derive_asset_price_usdc` returns 1.0 for it). A depeg would silently inflate
every $U price. One call turns an assumption into a measurement.

### 3 — Vestige (cross-DEX sanity on $U)

Agreed to **0.136%** today ($0.133661 against the bot's $0.133843) at the same
moment CompX's frozen value was **4.85%** out — close enough to the 5%
divergence limit that slightly more staleness would have flipped it from
`unverified` to a *hard* refuse, freezing the book outright instead of merely
declining to raise.

**Lower value than the first draft of this spec claimed.** Its job was to
replace CompX's veto, but §2 shows the three configured routes already do that
for $U. What Vestige still adds is the one thing routes cannot: it aggregates
across DEXes, so it sees $U liquidity we have not configured — Pact, and
anything new — and would catch our route set becoming unrepresentative rather
than merely inconsistent. Useful, genuinely independent of our config, and not
urgent.

It cannot catch Tinyman being wrong, because it reads the same pools.

> **It returns no timestamp.** Fields are `price`, `confidence`,
> `total_lockup`. So it may **vote** but may never **satisfy freshness** — see
> §4. Staleness is detected by observation instead: flag a Vestige price that
> has not moved across N cycles while the primary has.

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

Any single source may die — a route, Vestige, one exchange — without freezing
the vault. That is precisely the property today's design lacks, and the whole
point of the change. No source gets a unilateral veto again; that property is
what made one vendor's outage our outage, twice.

Freshness is satisfiable only by sources that can prove it:

| Source | Can prove freshness? |
|---|---|
| Tinyman | yes — chain round |
| Tinyman routes 1–2 | yes — chain round, already running |
| Exchanges | yes — their timestamps |
| **Vestige** | **no** — confirming vote only |
| **Pact** | yes (chain), but authority-capped to alerting |

So a quorum can never consist of Vestige alone, and the primary must always be
one of the two.

---

## 4a. Removing CompX without removing the guard

> **The gate being removed is also a latch.** Pass 29 C1: while `compx_verified`
> is false the rule refuses **in whole** — it never clamps and never re-posts to
> refresh `lp_ts_` — so `onchain` never moves and the same comparison recurs
> every cycle. The posted price becomes a running minimum and the feed freezes
> permanently the first time the real price rises above it. Worse, a drop
> *greater* than `UNVERIFIED_MAX_DROP` is refused entirely rather than clamped
> to the 10% step, so **a >10% crash while the second source is down freezes the
> oracle at the pre-crash price indefinitely**, blocking every liquidation path
> exactly when it is needed. So this section is not only cleanup: the removal
> must also replace refuse-in-whole with a step limiter and put a time bound on
> the unverified state. One reviewed change, not two.

**The obvious way to rule CompX out is wrong, and fails silently.** Deleting
`compx_check_asset_id` from the pools — or clearing `compx_oracle_app_id` —
does not disable a check. It makes the check *pass*:

```python
if pool.compx_check_asset_id is None or not cfg.compx_oracle_app_id:
    return "ok"
```

`"ok"` sets `compx_verified = True`, and the fail-stale gate in `update_pool`
is guarded by `if not compx_verified:`. So a config-only removal asserts
"verified" with nothing verifying, and the gate that refused to raise an
unconfirmed price never engages again on any pool.

The code is honest about this — `get_lp_price` logs `compx_state = "skipped"`
separately from the flag, with the comment *"compx_verified=True covers two
different situations — confirmed, and no check configured — and only the first
is verification."* It is a known sharp edge, not a bug, and ruling CompX out is
exactly the operation that runs onto it.

**So removal is a code change, not a config change.** `compx_verified` should
become a verdict with three states that the gate reads explicitly — verified,
unverified, and *no verifier configured* — so that the third is a deliberate
decision recorded in one place rather than an accident of a falsy config key.
Then delete `compx_cross_check`, `read_compx_price`, the three `compx_*` config
keys and the per-pool `compx_check_asset_id`, and point the gate at the §4
quorum.

### What is still standing in the meantime

Worth stating precisely, because "CompX was the only thing that could block a
post" is true of the *veto* and not of the guards. With CompX gone and nothing
built yet, a posted price still has to pass:

| Guard | Setting | Live on the lean oracle? |
|---|---|---|
| TWAP window / `MAX_TWAP_AGE` | 1800s | **yes** |
| `MIN_TWAP_READINGS` | 3 | **yes** — holds after a restart |
| `DIVERGENCE_LIMIT` spot-vs-TWAP | 15%, upward only | **yes** — skips the post |
| `asset_price_bounds` | $U `$0.02–$1.00`, ALGO `$0.02–$0.50` | **yes** — raises |
| route cross-check ($U only) | 5% | logs only, never gates |
| per-pool `min_price`/`max_price` | e.g. U/tALGO `660000–1079000` | **inert — but armed by one algod error** |

So the real remaining guard is **TWAP plus a 15% upward spot deviation cap**,
with absolute bounds catching absurdity. That is thinner than it looks in the
config but not nothing: a single-cycle spike is smoothed and a >15% upward
spot jump is skipped outright. What it does not stop is a manipulation held
across the TWAP window, and §3's thin-pool economics are why that matters.

> **The per-pool bounds are inert in normal operation and armed by a single
> algod error** — which is worse than either being live or being dead. On the
> happy path `read_onchain_anchor` returns 0 (app 3741272132 has 17 global
> keys and no `lp_anchor_`), so `effective_bounds` returns `(0, 0)` and both
> checks skip themselves. But when that read *fails* it returns `None`, and the
> `None` branch at `oracle_bot.py:1057-1064` falls back to the config bounds —
> at which point live U/ALGO sits only **~5.6% above its floor** of 661141. So
> one degraded reply during a 6% decline refuses that pool's post, in the
> direction where liquidation needs the price. That is the 2026-10-09 bug still
> wired in, behind a comment asserting it is dead. Either gate on the posted
> value directly or delete them; do not leave the choice to a network blip.
>
> Two earlier drafts of this spec got this wrong in both directions — first
> calling the bounds the narrowest live constraint, then calling them dead
> config. The audited answer is in [AUDIT.md](./AUDIT.md) Pass 29 H3.

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

`read_compx_price` had the right discipline and is worth copying before it is
deleted: it verified the box's embedded `assetId` matched what was asked for,
rather than trusting the key it looked up under. **Ticker symbols cannot
provide that** — there is no asset id in `U-USD`. So: no external source may
price $U, exchanges are restricted to ALGO and USDC, and that restriction
belongs in code rather than in a comment.

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

Reordered after the §2 finding. Vestige was second in the first draft; the
three existing $U routes already do most of its job, so it drops below the
exchange work, which covers an asset nothing checks at all.

1. **Alerting (§5).** Would have bought 58 hours of warning on 2026-11-10
   instead of 15 minutes, with no change to how prices are computed. Smallest
   change here, and worthless until `ALERT_WEBHOOK_URL` is set.
2. **Remove CompX properly (§4a)**, as a code change with a three-state verdict.
   This is what unfreezes the book and ends the vendor veto. Doing it by config
   instead would unfreeze the book *and* permanently disable the fail-stale
   gate, which is the trap worth not walking into.
3. **Exchanges for ALGO + USDC (§3).** The first cross-check the reference pool
   has ever had, on the one asset with no second route, and the only layer that
   survives Tinyman being wrong rather than absent.
4. **A second ALGO route** in `reference_pools`, turning ALGO from a bare object
   into a list. Cheapest possible redundancy for the root asset — it reuses
   machinery that already runs for $U — though it stays inside Tinyman, so it
   complements the exchanges rather than substituting for them.
5. **Delete or flag the dead per-pool bounds** (§4a). No behaviour change —
   it stops the config claiming a guard that does not exist.
6. **Vestige**, for cross-DEX coverage of liquidity our routes do not see.
7. **Pact as alert-only**, if at all.

---

## 10. Open

- Does Vestige expose freshness anywhere? Checked `/assets/{id}/price` (404)
  and `/assets/{id}/candles` (422); worth one pass over their docs before
  designing around its absence.
- ~~Does CompX stay in the quorum once it recovers?~~ **Answered 2026-11-10:
  ruled out entirely.** Twice-demonstrated unreliability plus an uncertain
  future is not something to carry at any authority level. §4a is the removal.
- The route graph is a separate question this spec does not settle: $U's
  route 0 is quoted in **tALGO**, tALGO in ALGO, ALGO in USDC — three hops,
  every one a Tinyman v2 pool, and tALGO is itself issued by Tinyman. Route 0
  is U/tALGO because it is deepest (~$5.7K vs $1.9–2.0K). Promoting U/USDC
  would remove a whole dependency layer at the cost of depth.
