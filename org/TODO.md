# Magnet Strategies — TODO

Last updated: 2026-06-18

---

## Mainnet Launch ✅

- [x] Deploy `voting.py` to mainnet — App ID 3554779766
- [x] Update `VOTING_APP_ID` and `VOTING_NETWORK` in `constants.ts`
- [x] Call `optin_asa` on mainnet voting contract
- [x] 2-step founder transfer — throwaway deployer → real founder via `accept_founder` (2026-05-15)
- [x] Proposal created (founder wallet, 2026-05-15)
- [x] Vote cast (second wallet, 2026-05-15)
- [x] **claim_tokens** — vote window closed 2026-05-22; tokens retrieved successfully, full end-to-end cycle verified

---

## Landing Page (magnetstrategies.io)

- [x] Full-bleed background, Times New Roman title, white divider, subtitle
- [x] Live stat cards — price, holders, TVL
- [x] **TVL Rank card + Top 100 ASA leaderboard modal** (`/token`, 2026-09-07) — see [ASA_TVL_SPEC.md](../ASA_TVL_SPEC.md)
- [x] Action cards — Vestige (chart), TinyMan (swap), MagnetDAO (DAO)
- [x] Social icons — X and Discord
- [x] About Magnet Strategies modal with full copy
- [x] Browser favicon set (Magnet ASA image)
- [x] Custom domain pointed (magnetstrategies.io → Vercel)
- [x] SEO — per-page `<title>` and Open Graph metadata (`og:image`, `og:description`)
- [x] Mobile responsive audit on landing page

---

## DAO App (magnetstrategies.io/dao)

- [x] All routes migrated to `/dao/*`
- [x] Navbar — "Magnet Strategies" brand, gradient magnet icon, links to `/`
- [x] Footer — "Magnet Strategies" / Bazooka Labs, X and Discord links
- [x] DAO home merged with governance page (hero + token info cards + quarterly cycle)
- [x] Token info cards — Magnet Token ($U), Community (holders), Liquidity Deployed (TVL)
- [x] Treasury chart — anchored balance reconstruction fix, 30D/90D/6M/All range selector
- [x] Add toast notifications for transaction success/failure
- [x] Mobile responsive audit across all DAO pages
- [x] Add AlgoExplorer/Lora links on: voting contract, governance vote results, application transactions
- [x] SEO — Open Graph metadata for `/dao/*` routes
- [ ] "Share result" link on completed vote epoch cards (treasury page)
- [ ] "No wallet" state message on vote modal
- [ ] "Copy ASA ID" button on ApplicationCards

---

## Smart Contracts

- [ ] Decide fate of legacy `governance.py` and `treasury.py` — archive or delete
- [ ] Consider migrating `voting.py` from PyTeal 0.27 to PuyaPy for long-term maintainability
- [ ] Add `cancel_proposal` function (founder-only emergency removal)
- [ ] Evaluate future-dated `start_time` support in `create_proposal`

### v2 Contract — Security Fixes (priority order)

> Full audit completed 2026-05-22. Current exposure is low — community is small and known,
> wallet UIs surface transaction details, and no fix requires immediate redeployment.
> Address before significant token volume flows through voting.

- [ ] **[Medium — token theft]** Add `Assert(Gtxn[1].sender() == Txn.sender())` in `cast_vote`
      — without this, a co-signer can be tricked into funding a vote that credits a different wallet,
      which can then claim the co-signer's locked tokens after the window closes
- [ ] **[Medium — tally integrity]** Validate that the chosen option is non-empty in `cast_vote`
      — `choice <= 3` is currently accepted even for 2-choice proposals; votes for empty choice slots
      corrupt the tally (tokens can still be claimed, no theft)
- [ ] **[Low — griefing]** Consider capping concurrent active proposals (e.g. one at a time)
      — founder can stack overlapping 7-day windows, locking voter token circulation for extended periods
- [ ] **[Low — operational]** Monitor contract ALGO balance relative to vote box MBR (~0.027 ALGO/voter)
      — if depleted during an active window, new `cast_vote` calls fail until balance is topped up
- [ ] **[Future]** Add founder emergency token rescue function
      — for recovering tokens from wallets that voted but lost ASA opt-in or wallet access;
      note: introduces trust risk (founder could sweep active votes) — design carefully

---

## MagnetFi — Lending Protocol (`magnetstrategies.io/magnetfi`)

> MagnetFi has two versions: v1 (standard two-pool lending, code complete) and v2 (LP vault + mUSD,
> primary focus, design phase). Docs at `magnetfi/v1/` and `magnetfi/v2/`.

### MagnetFi v1 — Contracts (complete)
- [x] `oracle.py` — $U/USDC price oracle, 50% deviation guard, two-wallet separation
- [x] `pool.py` — full lending pool, 21 methods, kink interest model, manual liquidation
- [x] Both compiled clean — artifacts in `contracts/lending/out/`
- [x] `deploy.py` — fallback deploy script using `getpass` (no seed phrase in shell/env)
- [x] `oracle_bot.py` — Vestige → Haystack → TinyMan fallback, 5-min loop, 15% divergence guard
  - ⚠️ **Stale as of 2026-09-06:** this is the **v1** bot (`contracts/lending/oracle_bot.py`), superseded by
    CompX for Layer 1 and dormant (`main()` exits without `ORACLE_APP_ID`/`BOT_MNEMONIC`). **Both HTTP price
    sources are dead** — `api.vestige.fi` returns 530, `api.haystackrouter.com` fails to connect — leaving only
    the on-chain TinyMan path, and that is gated on `U_ALGO_POOL_ID`/`ALGO_USDC_POOL_ID` being set. Separately,
    `DIVERGENCE_LIMIT` is only checked when `len(prices) > 1`, so a single surviving source posts **unchecked**.
    Candidate for deletion. The **live v2 LP oracle bot** (`magnetfi/v2/oracle_bot/`) is unaffected — it reads
    only on-chain state via algod and makes no HTTP price calls.

### MagnetFi v1 — Frontend (first pass complete)
- [x] Route scaffolded at `web/src/app/magnetfi/`
- [x] "MagnetFi" added to site navbar
- [x] Overview tab — pool cards, protocol stats, "not deployed" banner
- [x] Lend tab — deposit/withdraw UI shell (wiring pending)
- [x] Borrow tab — 4-action grid, health factor display shell (wiring pending)
- [x] Admin tab (admin wallet only) — Deploy, Oracle, Rates, Positions, Treasury panels
- [x] Deploy wizard — 5-step wallet-signed flow, no seed phrase required
- [x] ARC-56 artifacts copied to `web/src/lib/lending/` for browser import

### MagnetFi v1 — Testnet deployment (blocked until v2 direction confirmed)
- [ ] Create dedicated admin wallet (Pera, not main founder wallet)
- [ ] Create oracle bot wallet (separate hot key)
- [ ] Fund admin wallet — 10+ ALGO testnet + opt into USDC (10458941) and $U (757131983)
- [ ] Set `LENDING_ADMIN_ADDRESS` in `web/src/lib/constants.ts`
- [ ] Run deploy wizard from `/magnetfi` admin panel (5 signing sessions)
- [ ] Verify deployment on Lora/AlgoExplorer — dead shares minted, oracle set on both pools
- [ ] Update `ORACLE_APP_ID`, `USDC_POOL_APP_ID`, `U_POOL_APP_ID` in `constants.ts` → redeploy site
- [ ] Fund oracle bot wallet + start `oracle_bot.py` with env vars `BOT_MNEMONIC` + `ORACLE_APP_ID`
- [ ] Fund both pools with initial liquidity (founder deposit via Lend tab)

### MagnetFi v1 — UI wire-up (after deployment)
- [ ] Overview tab — fetch pool global state (total deposits, borrowed, utilization, APY/APR)
- [ ] Overview tab — fetch oracle price + staleness from chain
- [ ] Lend tab — read lender position from box, wire deposit/withdraw transactions
- [ ] Borrow tab — read borrower box, compute live health factor, wire all 4 actions
- [ ] Admin → Oracle panel — live price, last updated, bot wallet address from chain
- [ ] Admin → Rates panel — wire `set_rates()` transaction signing
- [ ] Admin → Positions panel — indexer scan for all borrower boxes + health factor computation; liquidate button wired for eligible positions + settlement flow
- [ ] Admin → Treasury panel — wire `collect_fees()` and `collect_algo()` transactions

### Infrastructure / ops
- [ ] Set up oracle bot server (cron or always-on process)
- [ ] Alerting on oracle bot staleness (>10 min = protocol frozen for new borrows)
- [ ] Decision: admin wallet hardware (Ledger) or `getpass` script for liquidations

---

## MagnetFi v2 — LP Vault + mUSD (`magnetfi/v2/`)

> Primary focus. LP-collateral borrowing protocol with mUSD stablecoin. Admin-managed.
> Architecture decisions locked; detailed design docs and contracts not yet written.

### Architecture docs (NEXT)
- [ ] `magnetfi/v2/VAULT.md` — vault mechanics, repayment model, grace period, interest accrual
- [ ] `magnetfi/v2/PSM.md` — reserve model, fee compounding, admin controls, invariant proofs
- [ ] `magnetfi/v2/LP_ORACLE.md` — LP valuation formula, data sources, TWAP, circuit breakers
- [ ] `magnetfi/v2/LIQUIDATION.md` — micro-liquidation path, health-factor path, priority rules

### Contracts (after docs)
- [ ] Create `contracts/lending_v2/` directory
- [ ] `musd_asa.py` — mUSD ASA creation (or admin creates via Pera)
- [ ] `psm.py` — PSM contract (USDC reserves, mUSD mint/burn, 1% fee, admin-only deposit/withdraw)
- [ ] `vault.py` — LP vault (collateral deposit, mUSD mint, interest accrual, liquidation triggers)
- [ ] `lp_oracle.py` — LP price oracle (TVL-based valuation, TWAP, circuit breakers)
- [ ] Compile all contracts, copy ARC-56 artifacts to `web/src/lib/lending_v2/`

### Frontend (after contracts)
- [ ] Extend `/magnetfi` with v2 UI (separate tab or route)
- [ ] Admin panel: PSM management, vault oversight, liquidation triggers
- [ ] Borrower UI: LP deposit, mUSD mint, interest payments, collateral withdrawal

---

## Infrastructure

- [x] Vercel deployment configured (deploys from `/Users/kc/MagnetDAO` root, `web/` resolved correctly)
- [x] Custom domain magnetstrategies.io live on Vercel
- [ ] Set up GitHub repo and push codebase
- [ ] Enable Vercel GitHub integration for auto-deploy on `git push main`
- [ ] Add environment variable support for sensitive constants

---

## ASA TVL Tracker

- [x] Diagnose why Vestige under-reports $U (Pact managed-weighted pools: reserves in pool global state, not the pool account — invisible to escrow-balance indexers)
- [x] `tvlAggregate.ts` — $U TVL across every venue; LiquiHog + Pact weighted factory discovery, STAMM venue added, hardcoded pools kept as a permanent floor
- [x] `leaderboard.ts` + `/api/leaderboard` — top 100 ASAs by two-sided TVL, cached 300s
- [x] `TvlRankStat.tsx` — TVL Rank metric box + Top 100 modal on `/token`, $U's row pinned
- [x] Eligibility rules: 80% price confidence, ≥2 pools, LP tokens / non-LP venues / Folks receipts excluded
- [x] 74 tests (vitest added — the web app had no test runner)
- [ ] Flip `AGGREGATE_TVL_ENABLED` after a 48h shadow comparison (Total TVL box still shows the hardcoded floor)
- [ ] Rank delta (▲/▼) — needs an hourly snapshot table; no datastore in the project yet
- [ ] Staleness filter for dormant pools — board-wide issue, not fAsset-specific (45% of fGOLD$'s TVL had not traded since 2024-04)
- [ ] Extract the duplicated `PACT_WEIGHTED_FACTORY_ADDR` constant (typo'd once; silently returned zero weighted pools)
- [ ] Commit `web/package.json` + lockfile (carries an unrelated `@compx/sdk` bump, so held back)
