# Magnet Strategies — Web App

The Next.js frontend for Magnet Strategies: the landing site, the **$U** token page, the
**MagnetFi "Bank"** (LP-collateral vaults + single-token markets), the **mUSD** page, and the
gated admin console. Protocol/contract design docs live in [`magnetfi/v2/`](../magnetfi/v2/OVERVIEW.md).

## Run & deploy
- From `web/`: `npm install`, then `npm run dev`.
- Network is fixed at startup by **`NEXT_PUBLIC_ALGO_NETWORK`** (`mainnet` default, or `testnet`).
- Pushing to `main` auto-deploys to **Vercel**. **Update live app IDs in `src/lib/magnetfi.ts`
  (`DEPLOYMENTS.mainnet`) before/with any contract redeploy.**

## Routes (site map)
| Route | What it is |
|---|---|
| `/` | Landing splash → "Attract Liquidity" + a link to `/about` |
| `/about` | The thesis + how the products fit together (a hub linking to each product page) |
| `/token` | $U token dashboard (price, holders, TVL, **TVL Rank** + Top 100 ASA modal, charts, swap) |
| `/magnetfi` | **The Bank** — tabbed app (below) |
| `/musd` | mUSD hub — live PSM metrics + the mint/redeem **Exchange** |
| `/pools` | $U liquidity pools (Tinyman & Pact) — live fee/farm APRs + add-liquidity deep-links |
| `/vote` | **UVote** — advisory founder-led governance; proposals, vote/reclaim, treasury tracker, gated admin |
| `/contact` | Contact |
| `/api/leaderboard` | Read API: top 100 ASAs by TVL (cached 300s) — powers the TVL Rank box |

## The Bank (`/magnetfi`) — `src/app/magnetfi/page.tsx`
- **Overview** (`OverviewTab`) — the landing: plain explanations of Single Token Markets and LP
  Collateral Vaults (each with a CTA into its tab), three live metric boxes (**Single-Token Lend
  Yield**, **Available to Borrow**, **LP Vault Utilization**), an mUSD pointer, and a **Learn more**
  modal (`LpVaultLearnMore`) holding the full LP-vault mechanics + liquidation ladder.
- **Single Token Markets** (`CompXMarkets`) — CompX-hosted $U/USDC lending pools (read-only SDK data
  + deep-link to transact; CompX custodies these, MagnetFi adds no contract surface).
- **LP Collateral Vaults** (`VaultsTab`) — **multi-pool**: renders one self-contained `VaultPanel` per
  wired collateral pool (U/tALGO + U/USDC live), each with its own oracle price, open form, live-projected
  accrued interest, liquidation-buffer bar, and pay/repay/borrow/add actions. Which pools are wired lives
  in `POOL_WIRING` (`magnetfi.ts`); reads/writes are parameterized by pool. Adding a pool = an admin-ops
  config pass + flipping its `POOL_WIRING` entry — **no contract redeploy** (12-pool schema headroom).
- **mUSD** — deep-links to `/musd` (the swap is no longer rendered inline).
- **Admin** (gated to `MAGNETFI_ADMIN_ADDRESS`) — see below.

## Admin console — `AdminTab` (gated)
- **Token setup** — `CreateMusd` (mainnet) / `CreateTestAssets` (testnet).
- **Active Loans** (`PositionsPanel`) — every open vault across all pools in one view:
  borrower (from the `vault_` box name), pool, collateral (LP + $), borrowed, live accrued
  interest, **health factor**, and an **interest-payment countdown** (past-due in red). Reads via
  `getAllPositions` (`magnetfiReads.ts`) + per-pool oracle. **Contextual liquidation buttons** wire
  the existing `magnetfiOps` calls: past-due state-0 → **Mark overdue** (→ state 1), state-1 →
  **Micro-liquidate** (needs a fresh oracle); health-factor tiers **T1 0.95–1.0 / T2 0.85–0.95 /
  full <0.85**. Guards: HF shown/actioned only when the oracle is **fresh** (no bogus HF→full-liq),
  a two-click arm→confirm (400 ms double-click guard) on the irreversible seizure, and settlement
  (`vault_state==2`) suppresses actions. Strictly additive + admin-gated — no borrower flow touched.
- **Operations** (`OperationsPanel`) — pauses, liquidations, risk params, reserves & fees, oracle,
  and governance/timelocked repoints. Each action is an `ActionForm` signed via Pera; button tones:
  default (purple) / warn (yellow) / danger (red).
- **Productive Reserves** (`StrategyPanel`) — v3 PSM: backing metrics, deploy/recall/harvest, Folks
  adapter deploy + whitelist, deficit/impairment, guardrails, timelocked treasury.
- **Deploy wizards were removed from the live panel post-launch.** `DeployWizard` (full-stack launch)
  and `VaultRedeployPanel` (vault-only redeploy against the live PSM/oracle, 48h timelock) still exist
  in `src/components/magnetfi/v2/admin/` and in git — re-add their import + section to `AdminTab.tsx`
  to use them again.

## Frontend architecture — `src/lib/`
- **`pools.ts`** — `POOLS` (the Tinyman + Pact pools shown as cards on `/pools`) and `DUST_POOLS`
  (real but sub-$150 $U pools found on both DEXes, folded into Total TVL but not worth a card).
  `fetchPoolMetrics(pool)` hits Tinyman's/Pact's own pool API per pool (TVL, fee APR, farm APR);
  `fetchTotalTvlUsd()` sums `tvlUsd` across `POOLS` + `DUST_POOLS` — the shared source for both
  `/api/pools` and the site-wide Total TVL stat, so a pool migrating to a new pool id (e.g. Pact's
  2026 platform move) only needs updating here to flow everywhere. Both arrays are now also the
  **permanent floor** under `tvlAggregate.ts` — discovery only ever adds to them, never replaces.
- **`tvlAggregate.ts`** (server-only) — `fetchAggregateTvlUsd()`: $U TVL across *every* venue, not
  just the hardcoded pools. Discovers pools via **LiquiHog** (`hogswap-v1.liquihog.dev`) plus the
  **Pact managed-weighted factory** (enumerated from its application address; reserves live in pool
  global state, not the pool account — which is why Vestige and LiquiHog both read them as empty).
  Adds the **STAMM** venue nothing else queried. Uses **source precedence, not `max()`**: our own
  Tinyman/Pact fetch wins, and a third party is used only to discover a pool we lack or to backstop
  one whose fetch failed. Guards fail closed (rate-encoded pools hold an exchange rate, not a
  balance; single-sided pricing is circular). **Never throws** — `/token` is prerendered at build
  with no try/catch, so a throw here would fail `next build`. Gated by `AGGREGATE_TVL_ENABLED`;
  while false it shadow-logs `[tvl] floor=… aggregate=…` and the displayed number is unchanged.
- **`leaderboard.ts`** (server-only) — `fetchBoard()`: ranks every ASA by **two-sided TVL** (the full
  value of each pool containing it, matching the Total TVL box). Eligibility: **80% price confidence**
  (matched to Vestige's model so rankings stay familiar) and **≥2 pools**. Excludes LP tokens
  (via `lp_asset_id` collected from the pool set itself), **non-LP venues** (`dualstake mint`,
  `xALGO`/`tALGO mint/burn`, `Folks Lend` — staked supply, not swappable liquidity), and **Folks
  lending receipts** (fAssets pair only against other fAssets and double-count the underlying; the
  **FOLKS governance token is exempt by asset id**, so a rename could never delist it).
- **`tokenStats.ts`** — `/token` + homepage `LiveStats` metrics: `fetchHolderCount` (Indexer),
  `fetchMagnetPriceUSDC` ($U/ALGO from Vestige × ALGO/USD from CoinGecko), `fetchTVL` (converts
  `fetchTotalTvlUsd()`'s USD sum to ALGO via the same CoinGecko rate). Vestige is used only for the
  $U/ALGO price quote — Total TVL is **not** sourced from Vestige's asset-level aggregate, since it
  lagged behind pool migrations. `fetchTVL` also runs `fetchAggregateTvlUsd()` alongside the floor and
  logs both; it displays the aggregate only when `AGGREGATE_TVL_ENABLED` is true, and never below the
  floor (understating TVL reads as liquidity leaving).

  > **Price-source caveat:** Vestige is online but no longer updating its pool index. It reports
  > `total_lockup` of ~91k $U against ~163k actually pooled — it sees ~56% of the liquidity, blind to
  > the same Pact weighted pools, while reporting *higher* confidence than LiquiHog. It also returns
  > no round or timestamp, so staleness is undetectable from the payload. Accepted deliberately:
  > price is coverage-insensitive (arbitrage keeps venues aligned; measured spread vs LiquiHog 0.07%)
  > whereas TVL is a sum and needs every pool. Revisit if arbitrage visibly breaks down.
- **`magnetfi.ts`** — config + pure helpers. `DEPLOYMENTS` (per-network app/asset IDs), `ACTIVE`,
  `ACTIVE_FOLKS`, `MAGNETFI_ADMIN_ADDRESS`, `VAULT_TYPES`, **`POOL_WIRING` / `poolWiring(id)`** (per-pool
  on-chain ids — which collateral vaults are live), and `healthFactor` / `maxBorrow` /
  `liquidationBuffer` / `projectedAccruedInterest` / `pct` / `formatUsd`. **Update live IDs + wiring here.**
- **`magnetfiReads.ts`** — read-only chain queries (algosdk): `getProtocolStats`, `getStrategyStats`,
  `getVaultPosition`, `getTotalVaultDebt`, `getBalances`, oracle reads. Pool-specific reads take an
  optional poolId/lpAsaId (defaults to the primary pool).
- **`magnetfiClient.ts`** — borrower writes (algokit-utils + Pera): `openVault`, `borrowMore`,
  `payInterest`, `repayPrincipal` (routes through `pay_interest`), `addCollateral`, `mintMusd`,
  `redeemMusd`. Vault writes take an optional `pool: PoolRef` (defaults to the primary pool) so each
  `VaultPanel` targets its own pool.
- **`magnetfiOps.ts`** — admin ops. **`magnetfiDeploy.ts`** — deploy/config helpers (used by the
  retained wizards).

## Design system
- Palette: **magnet purple** (`#a855f7`) on near-black surface (`#08000f`); accent greens use
  `green-400` app-wide. Fonts: **Sora** (display) / **Inter** (body) / **JetBrains Mono** (numbers).
- Primitives in `src/components/magnetfi/v2/shared.tsx`: `Panel`, `Stat`, `PrimaryButton`, `PairGlyph`,
  badges.

## Notable UI behaviors (and where they live)
- **Total TVL** (`/token`, homepage `LiveStats`) = live sum of every tracked Tinyman + Pact pool's
  own reported TVL (`fetchTotalTvlUsd`, `lib/pools.ts`), including `DUST_POOLS`, converted to ALGO
  via CoinGecko's ALGO/USD rate. Not a third-party asset-level aggregate — summing our own known
  pools is what keeps it correct the moment a pool migrates to a new pool id.
- **TVL Rank + Top 100 modal** (`components/TvlRankStat.tsx`, client) — fetches `/api/leaderboard`
  so `/token` stays static. The **whole card** is the hit target, not just the "See Top 100" corner
  label (a 10px corner link fails on touch). The modal **pins $U's row and scrolls to it** rather
  than landing at rank 1 — which is also what makes it work on the day $U falls outside the top 100
  (its row is then appended below a separator with its true rank). No rank delta yet: that needs an
  hourly snapshot table and there is no datastore in this project.
- **Live-projected accrued interest** — the on-chain `accrued_interest` is lazy (only written on a
  vault interaction), so the UI projects it client-side (`projectedAccruedInterest`, `VaultsTab`, 60s
  tick). The estimate is always ≥ the on-chain value, so health factor is never overstated.
- **Liquidation-buffer bars** — color-coded by health factor in the position card + open-vault preview.
- **mUSD Exchange** — one swap card with a clickable directional arrow (flip mint ⇄ redeem) + Max
  buttons (`MusdTab`, shared by `/musd` and, via deep-link, the Bank's mUSD tab).
- **LP Vault Utilization** = **total vault debt ÷ USDC reserve** (`getTotalVaultDebt`), *not*
  circulating mUSD (which also counts minted mUSD + fees) — so zero loans correctly reads 0%.
- **Repayment** routes entirely through `pay_interest` (the vault has no `repay_principal`); the client
  sends interest + principal and the contract refunds any overpay.
- **PSM metrics live only on `/musd`** (single source); the Bank's mUSD tab deep-links there.
