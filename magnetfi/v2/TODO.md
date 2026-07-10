# MagnetFi v2 — Open Items / Pre-Mainnet TODO

Compiled from all audit passes (1–24). This tracks what remains **open**; every audit
finding that required a *code* change is already resolved and recorded in [AUDIT.md](./AUDIT.md).
The three contracts compile clean, have been through three independent fresh-context
reviews + adversarial testing, and pass 67 integration/adversarial + 30 oracle-bot tests.

_Last updated: 2026-06-27. First vault target: **U/tALGO** on mainnet._

## Deployment status
- ✅ **mUSD ASA on mainnet:** `3615600399`.
- ✅ **Full UI built** — `/magnetfi` app (Overview / CompX Markets / LP Vaults / mUSD) + gated Admin panel (Create mUSD, testnet asset factory, deploy wizard, operations console). Borrower tabs wired to live on-chain data + transactions.
- ✅ **Testnet rehearsal complete** — deploy wizard ran end to end (incl. the 48h timelock). Testnet apps: Oracle `765096480`, PSM `765096481`, Vault `765096491`; test assets mUSD `765095889`, USDC `765095890`, LP `765095900`.
- ⏸️ **Mainnet deploy PAUSED (deliberate).** Building **v3 productive reserves** (yield-bearing PSM) *before* launch — the immutable + locked-reserve design + no forced loan repayment make retrofitting yield impossible once loans exist. Launch params otherwise gathered: guardian `TM6N…`, bot `AGAI…`, treasury `VM2J…`, U/tALGO pool/LP `3163770927`, $1,000 ceiling.
- 🔨 **v3 productive reserves** — adapter-based yield-bearing PSM (Folks Finance first; ≤5 vetted, timelocked adapters). Design: [PSM.md → Productive Reserves (v3)](./PSM.md#productive-reserves-v3). **Gates mainnet; requires a dedicated fresh audit + legal counsel.**

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

- [x] **MagnetFi v2 app** at `/magnetfi`: Overview / Markets (CompX) / LP Vaults / mUSD tabs + gated Admin panel.
- [x] **Network-aware config** (`lib/magnetfi` `ACTIVE` / `DEPLOYMENTS`) replaces hand-edited constants; resolves app + asset IDs per network via `NEXT_PUBLIC_ALGO_NETWORK`.
- [x] **Admin panel** (gated to the admin wallet): Create mUSD, testnet asset factory, the resumable **deploy & initialize wizard** (48h-timelock aware), and the **operations console** (rates, liquidations, pause/unpause, reserves & fees, oracle re-anchor, governance/rotation + timelocked repoints).
- [x] **Borrower tabs wired to live data + transactions** with correct atomic-group ordering (incl. the pay-interest transfer-before-call fix, P22-01), live health factors, and oracle-freshness gating on borrows.
- [x] **CompX single-token markets** integrated (live read + deep-link).
- [ ] After mainnet deploy: fill `DEPLOYMENTS.mainnet` in `web/src/lib/magnetfi.ts` with the real Oracle/PSM/Vault app IDs + U/tALGO LP/pool IDs, fill the oracle bot config, and redeploy the site.
- [ ] (Polish) Frontend should display the current rate and alert borrowers on rate changes (rate locks at vault open).

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
