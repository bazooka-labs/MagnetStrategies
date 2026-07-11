# MagnetFi v3 — Implementation Plan (Productive Reserves)

Build roadmap for v3 = the v2 core + a **yield-bearing PSM**. The design is frozen in **[PSM.md → Productive Reserves (v3)](./PSM.md#productive-reserves-v3)** (design-reviewed; H-1–H-4/M-2 resolved, fresh-agent findings F-1–F-9 folded in). This document is the *how-to-build*, not the design.

**Scope:** PSM-only. Vault / LP Oracle / Liquidation are **untouched** and keep their v2 audit passes. **Gated on** a dedicated fresh code audit + legal counsel before mainnet.

**Guiding principles**
- Build strictly to the frozen spec; no design changes without re-review.
- **Mock-adapter-first testing** — the whole valuation/deficit/buffer machinery is exercised against a *controllable* mock adapter (deterministic yield, loss, partial recovery, zero, withdrawal-freeze) before touching real Folks. This is the only way to test the F-1–F-6 loss paths reliably.
- Reuse existing patterns: the 48h-timelock + guardian veto, `opt_in_asset`, `WideRatio`, the ops panel, the reads/deploy-wizard, and the LocalNet test harness.

---

## Phase 0 — Groundwork (before contract code)

- **0.1 Verify Folks Finance's on-chain layout (blocks the adapter).** Confirm on mainnet: the USDC lending pool app id(s), the deposit + withdraw ABI methods, the `fUSDC` ASA id, the exact **deposit-index** state key + its scaling/decimals, and how to read **available withdrawal liquidity**. Capture in a short `FolksAdapter` integration note. *(Can be done now via algod reads.)*
- **0.2 Decide parameters** (see table below) — buffer / max-deployment fraction, per-venue cap, total-deployed cap, dust `ε`, max-staleness (multi-adapter only), and whether to timelock `set_treasury` (F-7).
- **0.3 Engage legal counsel (parallel track, start now):** entity, US-person access / geofencing, and review of the yield-to-treasury mechanism (GENIUS Act — no yield to holders).

## Phase 1 — v3 PSM contract (venue-agnostic)

Extend the v2 PSM (`contracts/smart_contracts/psm/contract.py`) into a fresh v3 PSM. Immutable (no `UpdateApplication`), as v2.

- **1.1 New state:** `deployed_principal[adapter]` (receipt), adapter whitelist (≤5) + pending-adapter + eta, `reserve_deficit`, per-adapter impairment mark, buffer + cap params.
- **1.2 Adapter interface:** the minimal `deposit(amount)` / `withdraw(amount)` / `recoverable_value()` the PSM calls; adapters are separate immutable contracts.
- **1.3 Modify `issue_musd`:** check redefined backing `on-chain USDC + Σ min(deployed_principalᵢ, recoverableᵢ)`; **freeze while `reserve_deficit > 0`**. (Launch: single-adapter live read.)
- **1.4 Modify `withdraw_usdc`:** buffer-aware `amount ≤ min(on-chain − buffer, total_backing − circulating)` in **underflow-safe additive** form (F-5); **freeze while `reserve_deficit > 0`** (F-5).
- **1.5 New `deploy` / `recall` / `harvest`:**
  - `deploy(adapter, amount)` — PSM→adapter→venue; `deployed_principal += amount`; assert buffer/cap/invariant after.
  - `recall(adapter, amount)` — venue→PSM buffer; `retired = min(deployed_principal, amount)`; `deployed_principal −= retired`; `reserve_deficit += max(0, retired − recovered)` only if `> ε` (F-3/F-4).
  - `harvest(adapter)` — route only *realized* yield to treasury; **assert `recoverable_after ≥ deployed_principal` post-sweep** (F-1); never reduce backing below principal.
- **1.6 New `propose/confirm/cancel_adapter`:** 48h timelock + guardian veto (reuse the oracle/vault-repoint pattern); **removal requires the adapter's `recoverable_value == 0`** (no orphaned funds).
- **1.7 Deficit + impairment:** `reserve_deficit` is a **freeze/restore gate, not a second subtraction from backing** (F-4); `restore` = admin USDC deposit paying it down; manual **impairment mark** applies to a *value loss OR a withdrawal-halt* (F-6).
- **1.8 Guardrails:** buffer floor at deploy-time, per-venue cap, `on-chain after deploy ≥ buffer` total cap (F-8).
- **Unchanged (assert in tests):** `mint_musd`, `redeem_musd`, `receive_musd`.

## Phase 2 — Mock adapter + full test suite (deterministic)

- **2.1 `MockAdapter`** with knobs: set value, set liquidity (to freeze withdrawals), force partial recovery, force zero. Lets us drive every loss path on demand.
- **2.2 LocalNet tests:** deploy/recall/harvest happy paths; `min()` valuation; issuance freeze on paper / realized / partial-lossy loss / venue-to-zero; deficit crystallization + `restore`; `withdraw_usdc` frozen during deficit; **harvest rejects inflated yield** (F-1); dust tolerance (no spurious deficit on entry rounding, F-3); buffer/cap enforcement; adapter whitelist timelock + guardian cancel + removal-requires-empty; `mint`/`redeem`/`receive` unchanged.
- **2.3 Adversarial regression tests = the F-1–F-8 scenarios**, each as a named test.

## Phase 3 — Folks adapter + integration

- **3.1 `FolksAdapter`** to the verified 0.1 layout; immutable; opts into `fUSDC`.
- **3.2 Integration test** against real Folks (testnet if it exists there, else a mainnet-fork / careful dry-run): deposit → `fUSDC` → read `recoverable` (matches Folks) → harvest → recall; verify withdrawal-liquidity handling.
- **3.3** Whitelist the Folks adapter via the timelock in the deploy sequence.

## Phase 4 — Frontend

- **4.1 Ops panel:** `deploy` / `recall` / `harvest`; adapter add/remove (propose/confirm/cancel); `reserve_deficit` + `restore`; per-adapter position + **backing ratio** (calm framing).
- **4.2 Reads:** strategy positions, backing ratio, deficit; surface backing ratio on the overview (transparent, not alarmist).
- **4.3 Deploy wizard:** extend to deploy the v3 PSM.

## Phase 5 — Pre-mainnet gates

- **5.1 Dedicated fresh code audit** of the v3 PSM + Folks adapter (a *new* pass, not a re-run of v2).
- **5.2 Legal counsel sign-off.**
- **5.3 Testnet rehearsal:** full deploy + a deploy→harvest→recall cycle + a *simulated loss → deficit → restore* drill (via a mock adapter on testnet).
- **5.4 Mainnet deploy:** small ceiling, **conservative deployment fraction**, Folks-only.

---

## Parameters — starting recommendations (finalize in 0.2)

| Parameter | Starting value | Notes |
|---|---|---|
| Max adapters | **5** | decided |
| Adapter whitelist timelock | **48h + guardian veto** | reuse existing pattern |
| Max deployment fraction (launch) | **≤ 30%** (buffer ≥ 70%) | deliberately conservative to start; tunable |
| Per-venue cap | single venue at launch → total cap governs | when multi: ≤ 50% of deployed per venue |
| Dust tolerance `ε` | a few cents of USDC (e.g. `10_000` µUSDC) | absorbs `fUSDC` entry rounding (F-3) |
| Multi-adapter max-staleness | n/a at launch (single-adapter live read) | needed only when caching (F-2) |
| `set_treasury` | recommend **timelock it** | harvest routes yield through treasury (F-7) |

## Open questions to close during the build
- Folks read specifics (0.1) — the concrete app id / index key / scaling.
- Final buffer / cap / `ε` values (0.2).
- Whether to timelock `set_treasury` (F-7) — recommend yes.

## Carries over from v1/v2 (not rebuilt)
mUSD ASA (`3615600399`); Vault / LP Oracle / Liquidation contracts + their 27 passes; the oracle bot (Pass 25, on-chain + CompX); the ops panel + reads (~90% reusable); the deploy wizard; the LocalNet test harness.
