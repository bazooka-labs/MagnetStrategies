# ASA TVL Aggregation — Spec v2

**Status:** IMPLEMENTED in shadow mode (`AGGREGATE_TVL_ENABLED = false`). Awaiting a 48h comparison before display is switched over.
**Scope:** analytics/display only. Adds LiquiHog + Pact-weighted enumeration to the TVL shown on `/token`.
**MagnetFi:** no protocol impact — see [MagnetFi Impact Review](#magnetfi-impact-review). One real coupling exists (**shared deployment**), mitigated in §6.

---

## Problem

`fetchTotalTvlUsd()` in `web/src/lib/pools.ts` sums live per-pool TVL over two hardcoded arrays — `POOLS` (7) and `DUST_POOLS` (8) — fetching Tinyman by pool **address** and Pact by pool **id**. The number is correct: verified 2026-09-06 at **$43,415** in-house vs **$43,317** from an independent pipeline (0.23% apart, price-quote timing).

Three maintenance defects:

1. **A venue is never queried.** `fetchPoolMetrics` dispatches on `"tinyman" | "pact"` only. $U holds **$180.64** in STAMM pool `3555593896` that nothing sees.
2. **Discovery is manual.** Pact's managed-weighted migration cost four commits (`c8a25c8`, `c5ce2a9`, `4e65156`, `5d4f735`). TVL was understated until they landed.
3. **The dust list can't be refreshed the way it was built** — from Vestige's pool index, now HTTP 530.

## Non-goals

- **Not a price change.** `fetchMagnetPriceUSDC()` keeps `api.vestigelabs.org`. Price is coverage-insensitive (arbitrage aligns venues; measured spread vs LiquiHog 0.07%); TVL is a sum and needs every pool.
- **Not an oracle.** Nothing here feeds MagnetFi, mUSD, vault LTVs, or liquidation.
- **Not the top-100 leaderboard.** Separate later work.

---

## Design

### 1. Canonical pool key — resolves the v1 double-count bug

v1 said "dedupe by pool id". **That was unimplementable and would have double-counted most of the $43.4k**: hardcoded Tinyman entries are keyed by pool *account address* (`pools.ts:12`), while LiquiHog returns `pool_id`.

Verified bridge: **for Tinyman v2, LiquiHog's `pool_id` is the pool's LP token asset id.**

| Entry | Tinyman `liquidity_asset.id` | LiquiHog `pool_id` |
|---|---|---|
| `u-talgo` | 3163770927 | 3163770927 ✓ |
| `u-usdc` | 3673941603 | 3673941603 ✓ |
| `u-mooj` | 3266422773 | 3266422773 ✓ |

Canonical key is therefore:
- **Tinyman** — the LP asset id, obtained from the same `/pools/{address}/` response already fetched for APRs (`liquidity_asset.id`). No extra request.
- **Pact** — the pool app id, already the `ref`.

LiquiHog also returns `lp_asset_id` per pool as a cross-check.

### 2. Source precedence, not `max()`

v1 said "prefer the larger of (hardcoded, unioned)". **Removed.** As review noted, that is either a no-op (if the union is a superset) or a monotone ratchet that structurally selects the most inflated source per pool — converting the §4 guards from a filter into a preference for whatever survives them and is highest.

Replaced with **one value per pool, chosen by precedence**:

```
for each pool in (hardcoded ∪ discovered), keyed canonically:
    value = our own direct Tinyman/Pact fetch, if it succeeded
          else LiquiHog's tvl_usd_micro/1e6, if it passes every §4 guard
          else  count as FAILED, contribute 0
total = Σ value
```

Rationale: we trust our own direct fetch over a third party, and use the third party only to **discover** pools we don't have — plus as a **backstop** when our own fetch fails. That last part strictly reduces the understatement described in M1 below: today a failed fetch silently drops the pool.

### 3. Union, never replace

`POOLS` and `DUST_POOLS` stay permanently as the floor. Discovery only *adds*. If enumeration replaced the list, a stale LiquiHog index would make TVL silently drop — which on a token page reads as liquidity fleeing. **Understating is worse than overstating.**

### 4. Guards on every third-party value

LiquiHog does **not** index Pact managed-weighted pools (same blind spot as Vestige): it reports 91,891 $U locked vs a true 162,748 U, blind to 70,857 U (44%). Those are reached by hardcoded Pact ids and, optionally, by enumerating the factory.

Both third-party paths — LiquiHog **and** the indexer — must apply all of these. Every guard **fails closed on a missing field**:

| Guard | Reason |
|---|---|
| `typeof pool_id === "number"` && integer && > 0 | Interpolated into URLs. |
| `algosdk.isValidAddress(addr)` on the Tinyman address branch | A numeric regex never fires on an address; v1's SSRF guard had a hole exactly where the code needs it. |
| `Number.isFinite(v) && v >= 0` | `NaN`/`Infinity` poisons `reduce`. Never `Number(x) \|\| 0` — that coerces garbage to a contributing 0. |
| `tvl_rate_encoded === false` (**present and false**) | Fail-open on absence was a v1 bug. This field's absence is what produced 1.7 trillion ALGO in testing. |
| `tvl_priced_sides === 2` | Single-sided pricing is circular; produced 355 billion ALGO. |
| `tvl_confidence_bps >= 8500` | Excludes manipulated/unpriceable pools. Costs $0.03 on $U — measured. |
| Per-pool cap: reject any single discovered pool > the **entire hardcoded floor** | No fabricated pool may dominate the headline. A 40%-of-floor cap was tried first and was **wrong**: measured, the largest legitimate $U pool (u-talgo `3163770927`) is ~48% of the floor alone, so 40% rejected a real pool. |
| Weighted-pool path: `bootstrapped === 1`, both reserves non-zero, **both sides independently priced**, and `next-token` pagination honoured | The Pact factory is **permissionless** — anyone can create a $U pool and choose weights/reserves to inflate a naive formula. Un-paginated `limit=1000` silently truncates, i.e. understates. |
| `AbortSignal.timeout(5000)` on every fetch | A hang stalls `/token` ISR regeneration to the function limit. |

### 5. Failure behaviour

- Any source down → degrade to the hardcoded floor. Never `null`, never a partial sum silently presented as complete.
- Return `{ usdTotal, poolsCounted, poolsFailed }`; `null` only when **every** pool failed everywhere.
- Callers render `—` on `null`, never `0`.

**M1, acknowledged and improved rather than preserved.** Today `pools.ts:76/:88` return `EMPTY_METRICS` on `!r.ok`, `tvlUsd` becomes `null`, and `pools.ts:124` filters it out — a partial sum presented as complete. v1 both forbade this and mandated "preserve exactly"; contradictory. Going 15 → ~40 pools per render would have multiplied 429/500 exposure and made silent understatement *more* likely. §2's precedence backstop is the fix: a pool only drops out if it fails in **both** sources, and `poolsFailed` surfaces it.

### 6. Deployment coupling — the one real MagnetFi risk

`/magnetfi`, `/musd` and the admin panel are routes of the **same Next app and deployment** as `/token`. This does not let bad data reach the protocol, but it affects the protocol's UI availability and release cadence:

- `/token` declares no `export const dynamic` (the only such export in the tree is `app/api/pools/route.ts:5`), so it is **prerendered at build**. An unhandled throw in new code fails `next build` → blocks shipping any MagnetFi fix. Prod stays up on the prior deployment, so this is release-blocking, not an outage.
- `fetchTotalTvlUsd` is called with **no try/catch** from `tokenStats.ts:61` and `app/token/page.tsx:15`'s `Promise.all`. It cannot throw today only because `fetchPoolMetrics` swallows everything (`pools.ts:99-103`). New top-level code sits outside that guard.

Mitigations, all mandatory:
1. **All new network code lives in a new server-only module**, `web/src/lib/tvlAggregate.ts`, imported only by `tokenStats.ts`. It must **not** be imported by `pools.ts`, because `app/pools/page.tsx:1` is `"use client"` and imports the runtime value `DEX_LABEL` — **`pools.ts` is in the client graph** (v1 wrongly called that import "types only"). Adding fetch code there risks shipping it to browsers or breaking that page's build.
2. Every new code path wrapped in try/catch **inside** the module, so its exported contract is strictly `Promise<Result | null>` and it can never throw.
3. Rollout flag is a **module constant** — a reviewable code change — not an env var, so flipping it cannot redeploy the borrower-facing repay/withdraw/liquidate UI.
4. `AbortSignal.timeout` on every fetch, so third-party flakiness cannot fail `next build`.

---

## MagnetFi Impact Review

**Conclusion: cannot affect the protocol.** Independently re-verified; v1's proof was partly wrong, so here is the corrected one.

### The actual proof

**No USD or TVL figure exists anywhere on the MagnetFi or admin surface.** `ADMIN.md:156` does instruct an operator to hand-type a number — *"Operations → Re-anchor price → Pool ID + current price (mUSD/LP)"* — and that number is read from `PositionsPanel.tsx:127` (`oracle?.price`) ← `getOracle` (`magnetfiReads.ts:35-41`), which reads `lp_price_<poolId>` from oracle global state **via algod**. A `tvl` grep across all components hits only `/token`, `/pools`, `LiveStats`, and `CompXMarkets.tsx:93` (CompX's own SDK). So a poisoned display TVL has **no copy-paste path** into `set_price_anchor` or `add_pool`. That, not the import graph, is the load-bearing argument.

### Supporting verification

- **Module graph.** Exactly five references to `lib/pools`/`lib/tokenStats` exist, all display surfaces. The transitive import closure of every `magnetfi*.ts` and `components/magnetfi/**` file is `algosdk`, `algokit-utils`, `@compx/sdk`, `useWallet`, and sibling magnetfi modules. No path reaches pools/tokenStats.
- **Oracle bot.** `magnetfi/v2/oracle_bot/oracle_bot.py` — sole network dependency is `algod.AlgodClient` (`:224-226`); `requirements.txt` is `py-algorand-sdk` only, no `requests`/`httpx`. Prices come from `account_application_info` local state (`:252`, `:305`, `:430`); the CompX second source is an on-chain **box read**, not an API. **No HTTP price API.**
- **No shared cache/env/route/constant.** pools.ts and tokenStats.ts read no env var. The only protocol-path env var is `NEXT_PUBLIC_ALGO_NETWORK` (`magnetfi.ts:36-37`). Next's data cache is URL-keyed and no MagnetFi path uses it. Poisoned data is cached ≤60s and reaches `/token` visitors only.
- **Live protocol healthy**, 2026-09-06 17:05 UTC: u-talgo 0.763238 mUSD/LP (+3.14% vs anchor), u-usdc 2.317459 (+2.61%), both posted <1 min prior, both inside the ±25% band.

### Footgun — do not unify, and namespace generated ids

Stronger than v1 stated: it is a shared **id namespace**, not just coincidental pool ids. `POOLS[].id` uses literally `"u-talgo"` / `"u-usdc"` (`pools.ts:26,36`) — the exact keys of `POOL_WIRING` (`magnetfi.ts:59-62`) and `VAULT_TYPES[].id` (`magnetfi.ts:103,116`). A future `POOLS.find(p => p.id === typeId)` join would look correct and would couple display config to live collateral wiring.

**Do not refactor them into a common constant.** If enumeration ever generates ids, namespace them `auto:<poolId>` so they cannot collide.

### Pre-existing, not touched here

`contracts/lending/oracle_bot.py` (v1 lending, superseded by CompX) has both HTTP sources dead — `api.vestige.fi` 530, `api.haystackrouter.com` connection failure. It only runs when `BOT_MNEMONIC` (`:203`) and `ORACLE_APP_ID` (`:205`) are set; `constants.ts` has `ORACLE_APP_ID = 0`. Dormant. **Correction to v1:** it does *not* throw on an empty source list (`:191` early-returns). The real latent hazard is `:194` — `DIVERGENCE_LIMIT` is only checked when `len(prices) > 1`, so a single surviving HTTP source posts **unchecked**. Strengthens the case for deleting the file.

---

## Test plan — fixtures, not live dollars

v1's tests asserted live mainnet dollar amounts against third-party APIs. Those are non-deterministic, fail on genuine market moves and third-party downtime, and would be skipped within weeks. All value assertions are fixture-based.

| # | Test | Asserts |
|---|---|---|
| 1 | **Dedupe** — same pool in `POOLS` (by address) and LiquiHog (by `pool_id`) | Counted **once**. This is the highest-probability bug (v1's H1) and v1's plan omitted it. |
| 2 | Unit conversion — `tvl_usd_micro: 43_415_000_000` | Contributes `43_415`, not `43_415_000_000`. The likeliest real-world defect. |
| 3 | Precedence | Direct fetch wins over LiquiHog for the same pool; LiquiHog used only when direct fetch failed. |
| 4 | Discovery | A LiquiHog-only pool (STAMM `3555593896`) is added. |
| 5 | Floor | Every hardcoded pool present in the result even when LiquiHog omits all of them. |
| 6 | Poison — `NaN`, `Infinity`, negative, `tvl_rate_encoded` missing, `tvl_rate_encoded: true`, `priced_sides: 1`, `confidence: 100`, non-numeric `pool_id`, a pool claiming 10× the floor | Each dropped; total unchanged. |
| 7 | Outage — LiquiHog 500 / timeout / malformed JSON | Total equals hardcoded floor; no throw. |
| 8 | Total failure — all sources down | Returns `null`; UI renders `—`, not `0`. |
| 9 | Never throws — every source rejects | `fetchAggregateTvlUsd()` resolves, does not reject. Protects `next build`. |
| 10 | **Import isolation guard** (transitive, directional) | No module under `lib/magnetfi*` or `components/magnetfi/**` transitively imports `lib/pools`, `lib/tokenStats`, or `lib/tvlAggregate`. |
| 11 | Client-graph guard | `lib/tvlAggregate` is not reachable from any `"use client"` entry point. |

## Rollout

1. Implement behind a module constant defaulting **off**; log aggregate vs current total.
2. Compare over ~48h. Enable when they track within tolerance and no guard has fired.
3. Remove the flag. `POOLS`/`DUST_POOLS` stay permanently as the floor.

## Corrections to v1

- `app/pools/page.tsx:5` imports `DEX_LABEL`, a **runtime value**, and the file is `"use client"` — `pools.ts` is in the **client** graph. v1 called it "types only".
- `components/LiveStats.tsx` is **rendered nowhere** — dead code. Its `"$U pools on Tinyman & Pact"` sublabel needs no update; consider deleting the file.
- `magnetfiClient.ts:9` also re-exports from `./magnetfiOps`; v1's import list was incomplete. Conclusion unchanged.
- v1's claim that the v1 oracle bot throws on an empty source list is **false** (see above).

---

## Implementation

| File | Change |
|---|---|
| `web/src/lib/tvlAggregate.ts` | **New.** Server-only. Discovery, guards, union, precedence. Exported contract `Promise<AggregateResult \| null>`; never throws. |
| `web/src/lib/tokenStats.ts` | `fetchTVL()` computes the aggregate alongside the floor and logs both. Displays the floor while the flag is off; `Math.max(aggregate, floor)` when on, so the number can never fall below the floor. |
| `web/src/lib/pools.ts` | One-word change: `DUST_POOLS` exported so the server module can reuse the floor. No logic touched. |
| `web/src/lib/tvlAggregate.test.ts` | **New.** 46 tests. |
| `web/vitest.config.ts`, `package.json` | **New.** vitest as a devDependency — the app had no test runner. Dev-only; absent from `next build` and the production bundle. |

### Verified

- `npx tsc --noEmit` clean; `npm test` 46/46; `npx next build` succeeds (the property that protects MagnetFi's release cadence).
- `/pools` First Load JS is 97.6 kB and the client-graph test confirms `tvlAggregate` is unreachable from any `"use client"` entry point.
- Live shadow output at build time:

```
[tvl] floor=$43694.38 aggregate=$43877.09 (+0.42%) pools=38 discovered=23 unresolved=0
      guards=[confidence:3370479355, confidence:3370482507, confidence:3163758794,
              confidence:3481371099, confidence:3596839399]
```

The +$182.71 delta is the STAMM pool the old code could not see, plus quote drift. The five dropped pools total **$0.03**. `unresolved=0` means every hardcoded pool was valued by our own fetch, so nothing relied on the backstop.

### Two bugs the tests caught before shipping

1. **Counter over-precision.** The original `poolsFailed` decrement assumed a failed Tinyman fetch could be matched to a discovered pool. It cannot: the failed response is what carries `liquidity_asset.id`, so the canonical key is unknowable. Replaced with honest `floorUnresolved` / `fromDiscovery` counters that may overlap.
2. **Cap too tight** — see the guard table. Found by the live smoke test, not by a unit test.

### Remaining work before the flag flips

- Watch shadow logs ~48h; confirm the delta stays near +0.4% and no guard beyond the five known dust pools fires.
- Consider deleting `components/LiveStats.tsx` (dead code) and `contracts/lending/oracle_bot.py` (dormant, both HTTP sources dead, unchecked single-source post at `:194`).
