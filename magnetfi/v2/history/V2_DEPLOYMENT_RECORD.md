# MagnetFi v2 — deployment record

> **History. Nothing here is current.**
> Lifted from the former `magnetfi/v2/TODO.md` when that file was merged into
> `OVERVIEW.md`. This is the record of how v2 reached mainnet: what was
> deployed, when, and what each canary reconciled to. For current state read
> [OVERVIEW.md](../OVERVIEW.md); for the audit record, [AUDIT.md](../AUDIT.md).
>
> ⚠️ Figures, rates and app IDs below are as they were at the time of writing.
> Two are known to have changed since: the interest rates moved on 2026-10-14
> (U/tALGO and U/USDC are **not** 8% and 5% any more — read them from the
> vault's `rate_<pool_id>` globals), and the banded oracle `3644230020` named
> here was retired on 2026-10-17 in favour of the lean oracle.

## Deployment status
- ✅ **mUSD ASA on mainnet:** `3615600399`.
- ✅ **Full UI live** — `/magnetfi` Bank (Overview / Single Token Markets / LP Collateral Vaults / mUSD) + gated admin (ops console + Productive Reserves); standalone `/musd` and `/about` pages. Borrower tabs wired to live on-chain data + transactions. Frontend reference: [web/README.md](../../../web/README.md).
- ✅ **Testnet rehearsal complete** — deploy wizard ran end to end (incl. the 48h timelock). Testnet apps: Oracle `765096480`, PSM `765096481`, Vault `765096491`; test assets mUSD `765095889`, USDC `765095890`, LP `765095900`.
- ✅ **Live on mainnet.** Core protocol (Oracle / PSMv3 / Vault) deployed and operating on **U/tALGO +
  U/USDC** collateral; v3 productive-reserves PSM live. Folks yield adapter not yet whitelisted. (Live app
  IDs are in `web/src/lib/magnetfi.ts` `DEPLOYMENTS.mainnet` + `POOL_WIRING`, and the oracle bot config.)
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
  retired/paused. Spec + audit record: [LIQUIDATION.md](../LIQUIDATION.md) "SHIPPED" block.
- ✅ **Mainnet canary — VALIDATED end-to-end (2026-08-17) on vault `3671287267`.** Full loop reconciled
  on-chain to the µUSD: open + borrow 30 mUSD → PSM mUSD↔USDC swap → ~3 days interest accrual
  (**0.019481 mUSD = exactly 30 × 8% APR × 2.96 days**, confirming the rate lock + per-second accrual)
  → close via `pay_interest` (interest charged, 30 principal returned to PSM, overpay buffer refunded,
  box deleted + MBR returned). PSM invariant held throughout (circulating ≤ USDC reserve). The new
  penalty/liquidation paths are covered by the test suite + two audits (a normal close never liquidates).
- ✅ **Second collateral vault — U/USDC — ADDED WITH NO REDEPLOY + VALIDATED (2026-08-19).** First use of
  the 12-pool schema headroom: registered entirely via admin ops on the live stack — oracle
  `add_pool(3673941603)` + anchor; vault `set_liq_threshold 7500 → set_ltv 6500 → set_rate 500 →
  set_lp_asa_id → opt_in_asset`; oracle bot config gained the pool (dry-run + live: derived $U
  cross-checks CompX <0.1% and the U/USDC-direct $U matches the reference graph to ~0.06% — a stronger
  $U anchor). Frontend made **multi-pool** (per-pool wiring map; `VaultPanel` reads/writes parameterized
  by pool; fresh review CLEAN). Canary reconciled on-chain: 75 U/USDC LP collateral → borrow 5 mUSD at
  the **5% rate** (vs U/tALGO 8%, confirming per-pool params) → close (principal→PSM, LP + MBR returned,
  box deleted); PSM invariant held. **U/USDC LP token/pool_id = `3673941603`**; Tinyman v2 pool acct
  `ONUEZGER6ZTBW7IT2FNWQVSTXJJEMG4BK2YK25FTDKEBTDE72BKV7SJUSI`; params 65% LTV / 75% liq / 5% APR.
  Note: the MBR (`46,500 µALGO`) is a refundable box deposit — paid on open, returned on close, both pools.
- ✅ **v3 productive reserves BUILT + testnet-validated** (PSMv3 + FolksAdapter). Design:
  [PSM.md → Productive Reserves (v3)](../PSM.md#productive-reserves-v3); roadmap:
  [V3_IMPLEMENTATION_PLAN.md](../V3_IMPLEMENTATION_PLAN.md); audit package: [AUDIT_HANDOFF.md](../AUDIT_HANDOFF.md).
  Folks adapter not yet whitelisted on mainnet.

---

---

## ✅ Resolved (reference only)

All code-level audit findings through Pass 24 are fixed and recorded in [AUDIT.md](../AUDIT.md), including:
the two-role guardian model (admin rotation, pause, 48h timelock on oracle/vault repointing),
the oracle ±25% drift anchor (P19-03), the oracle-bot pool-state read correction (P19-01),
the settlement-branch LP-trap fix (F-01), the accrual lost-time fix (P21-01), role-distinctness
guards (P21-02/03/04), and the `pay_interest` group-ordering fix found by the test suite (P22-01).
P19-04 (liquidation interest realized as PSM overcollateralization) and P23-01 (bounded LP-opt-out
liquidation-delay griefing) were reviewed and documented as non-issues / accepted.
