# MagnetFi v2 — Open Items / Pre-Mainnet TODO

Compiled from all audit passes (1–24). This tracks what remains **open**; every audit
finding that required a *code* change is already resolved and recorded in [AUDIT.md](./AUDIT.md).
The three contracts compile clean, have been through three independent fresh-context
reviews + adversarial testing, and pass 67 integration/adversarial + 30 oracle-bot tests.

_Last updated: 2026-08-03. Live on mainnet with U/tALGO; first borrows validated._

## Deployment status
- ✅ **mUSD ASA on mainnet:** `3615600399`.
- ✅ **Full UI live** — `/magnetfi` Bank (Overview / Single Token Markets / LP Collateral Vaults / mUSD) + gated admin (ops console + Productive Reserves); standalone `/musd` and `/about` pages. Borrower tabs wired to live on-chain data + transactions. Frontend reference: [web/README.md](../../web/README.md).
- ✅ **Testnet rehearsal complete** — deploy wizard ran end to end (incl. the 48h timelock). Testnet apps: Oracle `765096480`, PSM `765096481`, Vault `765096491`; test assets mUSD `765095889`, USDC `765095890`, LP `765095900`.
- ✅ **Live on mainnet.** Core protocol (Oracle / PSMv3 / Vault) deployed and operating on U/tALGO
  collateral; v3 productive-reserves PSM live. Folks yield adapter not yet whitelisted. (Live app
  IDs are in `web/src/lib/magnetfi.ts` `DEPLOYMENTS.mainnet` and the oracle bot config.)
- ✅ **Repayment model consolidated + vault redeployed.** `pay_interest()` is now the single
  repayment path (always charges interest before touching principal) with clamp-and-refund on
  overpay; the standalone `repay_principal()` method was removed. The vault was redeployed with
  this change and the PSM re-pointed to it via the 48h timelock. End-to-end validated on mainnet
  (open → borrow → PSM swaps → interest-accruing close, all reconciled on-chain).
- ✅ **Liquidation-penalty vault upgrade — SHIPPED (2026-08-14), vault `3671287267`.** Adverse-execution
  penalties on health liquidations (Tier 1 5% / Tier 2 7% with seizure recalibrated to 77%; full liq →
  seize-all, borrower gets $0 above MBR, no snapshot-priced surplus refund). Adjustable-but-capped
  `set_liq_penalty` (on-chain lever). Global schema maxed to 12-pool capacity. Deployed bytecode
  byte-for-byte matches the puyapy-5.9.0 reproducible build; two fresh reviews (change + adversarial)
  returned CLEAN (only medium M1 — liq_threshold must stay ≤ 75%, doc-guarded; on-chain cap to 7500 in
  next redeploy). **P23-01 resolved** (seize-all removes the surplus force-push). Old vault `3657553596`
  retired/paused. Spec + audit record: [LIQUIDATION.md](./LIQUIDATION.md) "SHIPPED" block.
- ✅ **v3 productive reserves BUILT + testnet-validated** (PSMv3 + FolksAdapter). Design:
  [PSM.md → Productive Reserves (v3)](./PSM.md#productive-reserves-v3); roadmap:
  [V3_IMPLEMENTATION_PLAN.md](./V3_IMPLEMENTATION_PLAN.md); audit package: [AUDIT_HANDOFF.md](./AUDIT_HANDOFF.md).
  Folks adapter not yet whitelisted on mainnet.

---

## 🔴 Blocking — must be done before mainnet launch

### Keys & assets
- [ ] Create the **guardian cold multisig** (recommend 2-of-3 hardware), distinct from the admin and oracle-bot keys. Its address is a required parameter to all three `deploy()` calls. The contract rejects `guardian == admin`.
- [ ] Create the **oracle bot wallet** (separate hot key); fund with ~5 ALGO for fees.
- [x] Create **mUSD ASA** on mainnet — ✅ **ASA `3615600399`** (Magnet USD / mUSD, 6 dp, 500M, default-frozen off, freeze + clawback renounced, manager/creator = `KNML…NYU6A`). Created via the admin-panel Pera handshake; verified on-chain. Wired into `web/src/lib/magnetfi.ts` (`MUSD_ASA_ID`).
- [x] Gather first-vault (U/tALGO) mainnet IDs — ✅ all confirmed on-chain:
  - [x] tALGO ASA ID = `2537013734` (6 dp); $U = `3081853135` (5 dp)
  - [x] U/tALGO Tinyman v2 pool ACCOUNT = `AIR4CSC54U33WCX4JTMJA4X6PHBVG7OGX7XVV2MCACYSSDULZNJ2KNGRZI`
  - [x] U/tALGO LP token ASA = `3163770927` (used as `lp_asa_id` and `pool_id`)
  - [x] AMM validator app id = `1002541853` (mainnet) confirmed

### Oracle bot config — ✅ rebuilt on-chain (Pass 25); `config.json` filled for U/tALGO
- [x] Pricing is now **fully on-chain** (no external price API): reference-pool graph over Tinyman v2 reserves (`ALGO←ALGO/USDC`, `tALGO←tALGO/ALGO`, `U←U/tALGO`), rooted at USDC. Resolves P19-02.
- [x] **CompX Flux oracle** (mainnet `3307588794`) wired as the second-source divergence guard; verified live (derived vs CompX Δ0.86%). Sanity bounds set for U/tALGO.
- [x] Verified against mainnet via `--dry-run` (LP price `675635` ≈ $0.6756); test suite 30→42, all green.
- [ ] Set `oracle_app_id` (the MagnetFi LP Oracle) in `config.json` after the mainnet deploy.
- [ ] **(If/when a wBTC pool is added)** verify wBTC ASA decimals + add its reference pool — AUD-006. Not required for the U/tALGO launch.

### Deployment sequencing
- [ ] Follow the [ADMIN.md deployment procedure](./ADMIN.md#deployment-procedure-v2) exactly (order matters).
- [ ] **Plan the genesis 48h timelock window:** registering the vault on the PSM is now `propose_vault_contract` → wait 48h → `confirm_vault_contract`. Schedule this gap before public launch (e.g., run it during the rest of setup).
- [ ] Confirm initial oracle prices for each pool — passed to `add_pool(pool_id, initial_price)`, which sets both the live price and the ±25% drift anchor.
- [ ] Prepare risk params per pool: `rate_bps`, `liq_threshold_bps` (set **before** `set_ltv`), `ltv_bps`, `lp_asa_id`.

---

## 🟠 Strongly recommended before mainnet (not code-blocking)

- [x] **Automated test suite.** ✅ Done — LocalNet integration + adversarial suite at `contracts/tests/` (67 tests) deploying the real compiled contracts across every privileged path, attack class, and the P21-01 regression (caught a real bug on first run, P22-01, fixed); plus 30 oracle-bot unit tests at `oracle_bot/tests/`. Re-run: `.venv-test/bin/python -m pytest tests/` (see `tests/README.md`).
- [ ] **Professional third-party audit** before significant TVL. Internal review is strong (24 passes + executable, adversarial & oracle-bot tests), but real-fund custody warrants an external firm.
- [ ] **Test borrow on mainnet** with a small amount (single vault, full open→borrow→repay) before opening to the public.

---

## 🟡 Deferred design items / future enhancements (non-blocking)

- [ ] **Multi-source oracle pricing (P19-02).** LP_ORACLE.md describes a 3-tier source hierarchy (Vestige direct LP price → computed from asset prices + reserves → full on-chain) with a cross-source median/divergence check. Only the computed (reserves × Vestige asset prices) path is implemented. Add a second independent source + median before scaling TVL, so a single bad feed can't propagate.
- [ ] **Bot redundancy & alerting (AUD-004).** Run redundant bot instances and uptime/staleness alerting so the oracle doesn't go stale on a single-host failure. (Oracle staleness fails safe — blocks borrows/liquidations — but is still an availability hit.)
- [ ] **Surplus-LP custody on liquidation (P23-01).** `trigger_full_liquidation` force-pushes surplus LP to the borrower; a borrower who opted out of the LP ASA can thereby delay (not prevent) a surplus liquidation. Bounded/non-economic (see AUDIT.md Pass 23). Optional future hardening: custody surplus for separate claim instead of force-pushing.
- [ ] **Multi-vault support.** PSM authorizes a single vault app id. If a second vault contract is ever deployed, extend the registration to a list.
- [ ] **PSM productive reserves — PROMOTED to the v3 launch build** (no longer deferred; now *gates* mainnet). Yield-bearing PSM via the **adapter pattern** (≤5 vetted, timelocked adapters; **Folks Finance first**; redefined invariant + liquidity buffer + per-venue exposure caps; yield → treasury/$U, **never holders** per GENIUS Act). Full design + rationale (and why off-chain/custodial is rejected) in **[PSM.md → Productive Reserves (v3)](./PSM.md#productive-reserves-v3)**. Needs a dedicated fresh audit + legal counsel before mainnet.

---

## 🔵 Frontend / integration — ✅ built (testnet-validated)

- [x] **MagnetFi app** at `/magnetfi`: Overview / Single Token Markets / LP Collateral Vaults / mUSD (deep-links to the standalone `/musd` page) + gated Admin panel. Plus standalone `/musd` and `/about` pages. Full site map: [web/README.md](../../web/README.md).
- [x] **Network-aware config** (`lib/magnetfi` `ACTIVE` / `DEPLOYMENTS`) replaces hand-edited constants; resolves app + asset IDs per network via `NEXT_PUBLIC_ALGO_NETWORK`.
- [x] **Admin panel** (gated to the admin wallet): Create mUSD / testnet asset factory, the **operations console** (rates, liquidations, pause/unpause, reserves & fees, oracle re-anchor, governance/rotation + timelocked repoints), and the **Productive Reserves** panel. The step-wizards (full-stack deploy + vault redeploy) were removed from the live panel post-launch — retained in `admin/` + git; re-add to `AdminTab.tsx` if needed.
- [x] **Borrower tabs wired to live data + transactions** with correct atomic-group ordering (incl. the pay-interest transfer-before-call fix, P22-01), live health factors, and oracle-freshness gating on borrows.
- [x] **CompX single-token markets** integrated (live read + deep-link).
- [x] After mainnet deploy: filled `DEPLOYMENTS.mainnet` in `web/src/lib/magnetfi.ts` (Oracle/PSMv3/Vault + U/tALGO LP/pool IDs), oracle bot config, and redeployed the site.
- [x] Frontend shows the current rate (open-vault preview + the "How LP Collateral Vaults work" Learn More). No rate-change alert needed for existing positions — the rate is **locked at open** and never changes for a vault.

---

## 🟢 Post-launch monitoring (operational — see [ADMIN.md](./ADMIN.md#monitoring-checklist))

- [ ] Oracle bot freshness (>10 min stale → alert)
- [ ] Per-vault health factor (<1.2 watch, <1.0 act) on every oracle update
- [ ] Payment-overdue tracking (>75 days flag, >90 days micro-liq eligible)
- [ ] PSM overcollateralization ratio (<1.05 alert) and vault ceiling headroom
- [ ] Vaults stuck in `vault_state == 2` for >1 hour (settlement incomplete)
- [ ] Admin USDC float (<$200 replenish) and contract ALGO balances (<1 ALGO top up)

---

## ✅ Resolved (reference only)

All code-level audit findings through Pass 24 are fixed and recorded in [AUDIT.md](./AUDIT.md), including:
the two-role guardian model (admin rotation, pause, 48h timelock on oracle/vault repointing),
the oracle ±25% drift anchor (P19-03), the oracle-bot pool-state read correction (P19-01),
the settlement-branch LP-trap fix (F-01), the accrual lost-time fix (P21-01), role-distinctness
guards (P21-02/03/04), and the `pay_interest` group-ordering fix found by the test suite (P22-01).
P19-04 (liquidation interest realized as PSM overcollateralization) and P23-01 (bounded LP-opt-out
liquidation-delay griefing) were reviewed and documented as non-issues / accepted.
