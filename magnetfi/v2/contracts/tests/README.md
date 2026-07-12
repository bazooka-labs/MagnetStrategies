# MagnetFi v2 — Integration Test Suite

LocalNet integration tests: the three real compiled contracts are deployed to a
dev-mode Algorand node and exercised with real atomic transaction groups, inner
transactions, cross-contract calls, and time travel. This is the truest available
simulation short of mainnet (which we can't use because LP pricing depends on live
Tinyman state).

## Prerequisites

1. Docker running.
2. LocalNet started:  `algokit localnet start`
3. Contracts compiled (ARC56 specs present):
   `.venv/bin/puyapy smart_contracts/lp_oracle/contract.py smart_contracts/psm/contract.py smart_contracts/vault/contract.py`
4. Test deps installed in a dedicated venv:
   ```
   python3 -m venv .venv-test
   .venv-test/bin/pip install pytest "algokit-utils>=3,<4"
   ```

## Run

```
.venv-test/bin/python -m pytest tests/ -q
```

Reset LocalNet between long sessions if round counts grow very large:
`algokit localnet reset`.

## What's covered

| File | Coverage |
|---|---|
| `test_smoke.py` | Deploy + wiring; open → borrow → repay round trip |
| `test_psm.py` | mint 1:1, redeem fee→treasury, withdraw invariant guard, pause (mint blocked, redeem open, guardian-only unpause) |
| `test_vault_lifecycle.py` | deferred-draw, LTV caps, interest payment, overpayment→principal, repay, add_collateral, borrow_more |
| `test_accrual.py` | one-year interest vs formula; **P21-01 multi-year catch-up**; rate lock at open |
| `test_liquidation.py` | micro-liq (90d), partial tier 1/2, full (surplus + shortfall/bad-debt), settlement end-states, stale-oracle block; PSM invariant after each |
| `test_roles_timelock.py` | 2-step admin/guardian rotation, guardian recovery, admin≠guardian guards, pause, 48h timelock + guardian veto (vault oracle & PSM vault-contract) |
| `test_oracle.py` | updater auth, ±50% prior guard, ±25% anchor band, re-anchor, freshness blocks borrow |
| `test_attacks_authz.py` | **cross-contract bypass** (direct `issue_musd`/`receive_musd` rejected — the unlimited-mint guard), full admin-only sweep across all 3 contracts, borrower can't self-liquidate, guardian/bot least-privilege |
| `test_attacks_logic.py` | group manipulation (MBR underpay/wrong-receiver, wrong/zero LP, standalone call, mint amount-mismatch/wrong-receiver, double-mint one deposit, repay/pay mis-routing), state-machine abuse (state-2 blocks borrower ops, overdue blocks borrow), liquidation correctness (no healthy liq, no tier over-seizure, no double liq, invalid tier, micro timing, settle over-counter / healthy), dust/zero guards, bounded opt-out griefing |
| `test_productive_reserves.py` | **v3 PSM (PSMv3)** vs a controllable MockAdapter + MockVault: deploy/recall round-trip, harvest yield→treasury, `min()` valuation + paper-loss ceiling, inflated-mark can't over-issue, **H-2** (harvest can't drain the buffer — reported return ignored, balance-delta), **M-1** (recall crystallizes a hidden loss despite a lying adapter), realized-loss deficit freeze + `restore`, **H-1** (impaired dead-adapter escape hatch removes + writes off), **L-1** (guardian-only un-impair), buffer floor + per-venue cap, withdraw frozen during deficit, adapter whitelist 48h timelock + guardian veto, remove-requires-empty, and mint/redeem unchanged under v3 |

**v3 compile prereq:** also compile the v3 contracts —
`.venv/bin/python3.12 -m puyapy smart_contracts/psm_v3/contract.py smart_contracts/mock_adapter/contract.py smart_contracts/mock_vault/contract.py`
(post-rename the venv wrappers have stale shebangs; invoke puyapy via `python3.12 -m`).

## Harness notes

- `conftest.py` deploys a fresh protocol per test (`proto` fixture) with distinct
  admin / guardian / bot / treasury keys and fresh mUSD / USDC / LP assets.
- Time travel uses dev-mode `set_timestamp_offset` (the 48h timelock and interest
  accrual depend on it).
- Inner-transaction fees and foreign references are covered automatically via
  `SendParams(cover_app_call_inner_transaction_fees=True, populate_app_call_resources=True)`.
- Suggested-params caching is disabled (dev mode advances a round per txn, which
  staled the default time-based cache).

## Bug found by this suite

`P22-01` (High) — `pay_interest` read the mUSD transfer at `group_index + 1`
(after the call), but the overpayment path forwards `change` to the PSM via an
inner transfer *during* the call. The funds hadn't arrived yet → underflow. Fixed
to read at `group_index − 1` (transfer first). See AUDIT.md Pass 22.
