# MagnetFi v3 — Audit Handoff (Productive Reserves)

Package for the **dedicated pre-mainnet audit** of the v3 PSM + Folks adapter. v3 = the audited v2
core + a yield-bearing PSM. This document is the map: scope, architecture, the trust model, what our
internal review already found and fixed, the one **accepted residual** the auditor must own, and how
to build/test. Design authority: **[PSM.md → Productive Reserves (v3)](./PSM.md#productive-reserves-v3)**.

## 1. Scope

**In scope (new / changed — audit these):**
- `contracts/smart_contracts/psm_v3/contract.py` — **PSMv3**, the reserve contract. *This holds the
  funds.* Immutable (no `UpdateApplication`). The redefined backing invariant is the highest-risk
  change (it changes what backs the dollar).
- `contracts/smart_contracts/folks_adapter/contract.py` — **FolksAdapter**, the venue integration.
  Its `recoverable_value()` is load-bearing (see §5).

**Out of scope (unchanged from the v2 passes, keep their audit history):**
- `vault/`, `lp_oracle/` contracts — untouched in v3.
- The v2 `psm/contract.py` — superseded by `psm_v3`; not deployed at launch.
- `mock_adapter/`, `mock_vault/`, `mock_psm/` — TEST-ONLY contracts (with deliberate knobs like
  `set_withdraw_lie`); never deployed to mainnet. Do not audit as production, but they drive the
  loss-path tests.

## 2. What the PSM does

Holds USDC reserves + the unissued mUSD supply. mUSD is 1:1 USDC-backed and redeemable via the PSM.
**Core invariant, redefined for v3:**

```
circulating mUSD  ≤  on-chain USDC  +  Σ min(deployed_principalᵢ, recoverableᵢ)   (i = 1..N, N ≤ 5)
```

Idle reserve USDC may be deployed to a whitelist of ≤5 immutable **adapters** (yield venues; Folks
first) via one fixed interface — `pool_deposit(uint64)`, `pool_withdraw(uint64)->uint64`,
`recoverable_value()->uint64`. `min()` means a venue can never over-report backing; an impaired
venue counts 0. Two roles: hot **admin** (routine ops), cold **guardian** (pause/veto/unpause,
lockdown-lifts). Adapters are added via a **48h timelock + guardian veto**.

**Non-negotiables** (any finding that breaks one is critical): (1) instant 1:1 redeemability —
redemptions pay from the on-chain buffer and never evaluate the venue sum; (2) the invariant never
breaks; (3) a bad adapter can only ever lose the funds deployed *to it* — never the buffer or other
venues, and reserve principal never leaks to treasury.

## 3. Trust boundary — where to focus

The exploitable surface is the **PSM → adapter** boundary (cross-app `abi_call`). A whitelisted
adapter is semi-trusted (48h + veto to add) but could later turn hostile or be buggy. The invariant
math, arc4-array state handling, freezes, access control, and reentrancy-safety (AVM forbids the PSM
twice on the call stack) were checked and held in internal review — re-verify, but spend the most
effort on the adapter boundary and the redefined invariant.

## 4. Prior internal review — findings fixed (two fresh-agent passes)

All fixed in-code and covered by named regression tests (§6). Summarized so the auditor can confirm
the fixes rather than re-derive:

| ID | Issue | Fix |
|---|---|---|
| **H-2** | `strategy_harvest` paid treasury the adapter's *reported* return → a malicious adapter drains the whole buffer to treasury | Pay only the on-chain USDC **balance delta**, capped at computed yield; never trust the return value |
| **M-1** | `strategy_recall` trusted the returned `recovered` → a lying adapter hides a realized loss (no deficit) | Same balance-delta measurement; shortfall crystallizes correctly |
| **H-1 (liveness)** | A reverting/dead adapter permanently bricked issuance (mark-impaired froze issuance; `remove_adapter` called the dead `recoverable_value` → catch-22) | Impaired adapters removable **without** calling them; residual principal written off to `reserve_deficit` |
| **L-1** | Hot key could *clear* an impairment (lift a lockdown) | Clearing impairment is guardian-only (mirrors `unpause`) |
| **M-2** | Per-recall dust ε gameable | ε lowered to entry-rounding only; recall accounting is exact (balance-delta) |
| **INFO-1/2, L-3** | `pause` didn't halt issuance; harvest not frozen on *any* impairment; 0-id slot sentinel | `pause` halts `issue_musd`; harvest frozen while any adapter impaired; explicit non-zero id guards |

## 5. ⚠ Accepted residual — the #1 thing the auditor must own (H-1, harvest)

`strategy_harvest`'s sweep bound (`recoverable_before`) and its post-sweep `recoverable ≥ principal`
self-check **both read the adapter's own `recoverable_value()`**. A whitelisted adapter that lies
self-consistently could route **its own deployed principal** (bounded — never the buffer or other
venues) to treasury and leave phantom backing, revealed as a deficit on the next `recall`. This is
**not closable venue-agnostically** (the PSM has no independent measure of a venue's value, and the
AVM has no try/catch). The mitigation is architectural:

> **Harvest safety REQUIRES `recoverable_value()` to be a non-manipulable on-chain read.** This is the
> single most important property to verify in the FolksAdapter. The Folks adapter reads
> `fUSDC_balance × depositInterestIndex / 1e14` — the adapter's own ASA balance × Folks' own pool
> index, neither of which it can fake; sending principal out drops the balance → the self-check
> fires. **Confirm no path lets `recoverable_value()` return a value not backed by a real, current
> on-chain read.** See PSM.md H-1 and `FOLKS_ADAPTER.md`.

## 6. Test coverage

- **LocalNet (deterministic, 16 tests):** `contracts/tests/test_productive_reserves.py` — real
  compiled PSMv3 + a controllable MockAdapter. Covers deploy/recall/harvest, `min()` valuation +
  paper loss, **H-2** (harvest can't drain the buffer), **M-1** (recall crystallizes a hidden loss),
  deficit→restore, **H-1** escape hatch, **L-1**, buffer/cap, adapter timelock+veto, mint/redeem
  unchanged. Full suite: 83 passed (67 v2 + 16 v3).
- **Live Folks testnet:** `test_folks_adapter_testnet.py` (adapter ↔ real Folks: deposit → read
  matches `fUSDC×index/1e14` exactly → withdraw) and `test_psm_folks_testnet.py` (full stack:
  real PSMv3 → real FolksAdapter → live Folks strategy_deploy/recall/remove). `test_psm_deficit_testnet.py`
  = loss→deficit→freeze→restore drill on testnet.
- The testnet tests use a **short-timelock PSMv3 built from the real source** (only `TIMELOCK_DELAY`
  patched — no logic drift) so the 48h timelock can be exercised in real time.

## 7. Operational requirements the auditor should note (not bugs)

- **Resource padding:** Folks operations exceed a single app call's 8 foreign-reference limit, so
  strategy calls **and vault borrows** (which live-read the adapter via `issue_musd`) must pad the
  group with `PSMv3.noop` app calls. The frontend does this (`hasActiveAdapter` gate). `noop` is a
  state-free, unprivileged padding primitive.
- **Launch posture:** small ceiling, conservative deployment fraction (buffer ≥ 70%), Folks-only,
  single adapter. Multi-adapter (≤5) is built but only Folks is whitelisted at launch.
- **Regulatory (separate track):** yield routes to treasury, never to holders (GENIUS Act). Legal
  counsel sign-off is a launch gate.

## 8. Build & test

```
cd contracts
# compile (note: venv wrappers have stale shebangs post-rename → invoke puyapy via python3.12)
.venv/bin/python3.12 -m puyapy smart_contracts/psm_v3/contract.py smart_contracts/folks_adapter/contract.py
# LocalNet tests (needs `algokit localnet start`)
.venv-test/bin/python -m pytest tests/test_productive_reserves.py -q
# live testnet tests (needs a funded throwaway wallet; never commit the mnemonic — public repo)
export FOLKS_TEST_MNEMONIC="..."
.venv-test/bin/python -m pytest tests/test_psm_folks_testnet.py tests/test_psm_deficit_testnet.py -s -q
```

PSMv3: 34 ABI methods, global schema 13 uints / 9 bytes. Compiled with puyapy 5.8.1.
