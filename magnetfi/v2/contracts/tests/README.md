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

### Which oracle

`MAGNETFI_ORACLE` swaps the oracle underneath and runs the WHOLE suite against
it. The vault reads `lp_price_`/`lp_ts_` by global-state key and never calls the
oracle, so each spec claims its oracle is a drop-in; this is what demonstrates
it rather than arguing it.

| value | contract | writer | band | last run (2026-10-14) |
|---|---|---|---|---|
| unset / `posted` | `LPOracle` — live on mainnet | authorized | ±25% anchor, ±50% prior | 119 passed, 9 skipped |
| `lean` | `LeanOracle` | authorized | **none** | 108 passed, 20 skipped |
| `relay` | `RelayOracle` (v5) | **none** — signed payloads | **none** | 109 passed, 19 skipped |

```
MAGNETFI_ORACLE=lean .venv-test/bin/python -m pytest tests/ -q
```

Writer-ness and band-ness are separate flags (`RELAY`, `BANDED`) because the
lean oracle keeps the first and drops the second. Skip a test on the property it
actually needs, never on the oracle's name — keyed off one flag, the suite
skipped the band tests and the writer test together, which left the lean
oracle's authorization gate untested exactly where it is the only gate left.

### Reset LocalNet before each full run

```
algokit localnet reset
```

LocalNet's genesis accounts hold participation keys that **expire around round
30000**, and dev mode mints a block per transaction. Measured 2026-10-14: a full
suite run costs about **3,400 rounds**, so one reset is good for roughly eight
runs — three consecutive runs reached round 10,322 with all three accounts still
`Online`.

(An earlier revision of this file said 20,000 rounds per run and "about one and
a half runs per reset". That was wrong by ~6x. The dispenser failure that
prompted it came from a LocalNet left running for two days, already past round
30000, not from a single run's cost.)

Once past the expiry the accounts go `Offline`,
`algorand.account.localnet_dispenser()` can no longer find a dispenser, and
every test errors out in fixture setup with:

```
Error retrieving LocalNet dispenser account; couldn't find the default account
```

That is an exhausted chain, **not** a failing test — the giveaway is that the
errors arrive in fixture setup and the first run of a session passed. Resetting
before a comparison run is still worth it: it costs ~20s and removes the
question entirely.

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
