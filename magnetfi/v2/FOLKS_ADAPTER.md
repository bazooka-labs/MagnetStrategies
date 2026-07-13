# MagnetFi v3 — FolksAdapter spec (Phase 3)

The venue-specific integration for the **Folks Finance v2 USDC lending pool**, encapsulated as an
immutable adapter behind the PSM↔adapter interface (`pool_deposit` / `pool_withdraw` /
`recoverable_value`). This is the load-bearing venue-trust contract: **`recoverable_value()` must be
a non-manipulable on-chain read** (the #1 gate of this adapter's dedicated audit — see PSM.md H-1).

> **Status: interface fully reverse-engineered + verified against live mainnet state and the Folks
> `algorand-js-sdk` (commit ~2026-06). NOT integration-tested** — Folks is not on LocalNet, so a
> mainnet-fork / testnet deposit→read→harvest→recall cycle is required before this adapter is
> trusted or whitelisted (Phase 3.2 + dedicated audit).

## Verified constants (mainnet)
| Thing | Value | Source |
|---|---|---|
| USDC pool app | `971372237` | live + `mainnet-constants.ts` USDC.appId |
| Pool Manager app | `971350278` | `MainnetPoolManagerAppId` (arg to deposit/withdraw) |
| USDC asset (`asset`) | `31566704` (6dp) | USDC.assetId |
| fUSDC receipt (`f_asset`) | `971384592` (6dp) | USDC.fAssetId |

## recoverable_value (the read — verified against live state)
Folks packs the pool's interest data in global-state **byte key `"i"`** (0x69, a 56-byte blob =
7 × uint64, parsed by `parseUint64s` → `interest[0..6]`):

| idx | bytes | field |
|---|---|---|
| 0 | 0–7 | retentionRate |
| 1 | 8–15 | flashLoanFee |
| 2 | 16–23 | optimalUtilisationRatio |
| 3 | 24–31 | totalDeposits |
| 4 | 32–39 | depositInterestRate |
| **5** | **40–47** | **depositInterestIndex (`diit`, 14dp) ← the stored index** |
| 6 | 48–55 | latestUpdate (unix ts) |

- **`recoverable_underlying = fUSDC_balance × depositInterestIndex / 1e14`**
  (SDK `calcWithdrawReturn(amt, diit) = mulScale(amt, diit, ONE_14_DP)`; `ONE_14_DP = 1e14`).
- The adapter reads `interest[5]` = `extract_uint64(pool_global["i"], 40)`. This is the index **at
  last pool update**; the *live* index accrues forward (`calcDepositInterestIndex`), so the stored
  read is a **conservative lower bound** — monotonic, never over-counts → exactly what the PSM's
  `min(principal, recoverable)` wants. Live-verified on the pool: `interest[5] ≈ 1.226e14` (index
  ≈ 1.226), a sane cumulative deposit index.
- **Why this is non-manipulable:** it is the adapter's *own* fUSDC ASA balance × Folks' *own* pool
  index, both real on-chain reads the adapter cannot fake. Sending fUSDC/principal out drops the
  balance → recoverable drops → the PSM's harvest self-check fires. (This is the property PSM.md
  H-1 requires; it is why an off-chain/self-reported venue was rejected.)

## deposit (pool ABI)
`deposit(txn send_asset_txn, account receiver, asset asset, asset f_asset, application pool_manager) uint64`
- **Inner group** the adapter submits: `[ AssetTransfer(USDC → pool app addr, amount), AppCall pool.deposit(send_asset_txn, receiver=adapter, asset=USDC, f_asset=fUSDC, pool_manager) ]`.
- The `receiver` (adapter) is minted fUSDC; the call returns the fUSDC amount minted.
- Adapter must be opted into **both** USDC and fUSDC.

## withdraw (pool ABI)
`withdraw(axfer send_f_asset_txn, uint64 received_amount, account receiver, asset asset, asset f_asset, application pool_manager) uint64`
- **Inner group:** `[ AssetTransfer(fUSDC → pool app addr, fUSDC_amt), AppCall pool.withdraw(send_f_asset_txn, received_amount, receiver=adapter, asset=USDC, f_asset=fUSDC, pool_manager) ]`.
- You send `fUSDC_amt` fUSDC and request `received_amount` USDC to `receiver` (adapter).
- SDK sets the app-call **fee to 5000** (covers the pool's inner USDC transfer back). Fee budget is
  the #1 live-test item.
- **Adapter withdraw strategy (to validate on fork):** to service `pool_withdraw(amount)` — read the
  fresh index (optionally call `update_pool_interest_indexes(pool_manager)` first), compute
  `fUSDC_to_send = min(fUSDC_balance, ceil(amount × 1e14 / index))`, and request
  `received_amount = floor(fUSDC_to_send × index / 1e14)` so the request always corresponds to the
  fUSDC sent (avoids a mismatch revert / excess-refund ambiguity). Full-exit = send all fUSDC. The
  PSM re-measures the real USDC delta regardless (H-2/M-1), so a best-effort adapter return is safe.

## update_pool_interest_indexes
`update_pool_interest_indexes(application pool_manager) void` — refresh the pool's stored indexes to
"now". Optional before a read (stored is already conservative) but recommended before a withdraw so
`received_amount` matches the live index.

## Static cross-check vs. the SDK (done — no funds)
Traced the adapter's inner groups against the SDK builders `prepareDepositIntoPool` /
`prepareWithdrawFromPool`. **Encoding matches exactly** — arg order, types, references, and the
axfer receivers (USDC→pool on deposit, fUSDC→pool on withdraw) all line up. This rules out the most
likely untested-adapter bug class (a transposed/mis-typed arg). Residual risk is therefore purely
runtime (see below), which is what the testnet rehearsal validates.

**Testnet Folks ids** (for the dress rehearsal — same adapter, create-time params):
pool `147170678`, pool-manager `147157634`, USDC `67395862`, fUSDC `147171826`.

## ✅ Testnet integration — VALIDATED (Phase 3.2, live Folks testnet)
`tests/test_folks_adapter_testnet.py` ran the full cycle against the real Folks v2 testnet USDC
pool. Result:
- **deposit** 0.5 USDC → **418,636 fUSDC** at live index **1.194354** (`119435445945745`);
- **`recoverable_value()` = 499,999 µUSDC — matches `fUSDC × index / 1e14` from live pool state
  exactly** (the byte-40 index read is correct on-chain);
- entry rounding = **1 µUSDC** (500,000 → 499,999), well within ε;
- **withdraw** requested 500,000 → **499,999 returned to the PSM**; no rounding/refund revert.

All three prior unknowns cleared: fee budget OK, withdraw `received=floor(fUSDC×index/1e14)`
accepted, receiver routing to the PSM works.

**Key learning for the PSMv3 integration (Phase 4):** Folks ops are **resource-heavy** — a single
app call's 8 foreign-reference slots are not enough for the deposit/withdraw inner-call tree. The
test needed **filler app calls** in the group (`MockPsm.noop`) so `populate_app_call_resources`
could spread references. The frontend must likewise pad the group (extra app calls / explicit
references) whenever `strategy_deploy` / `strategy_recall` / `strategy_harvest` — or a vault borrow,
since `issue_musd` live-reads the adapter — touches the Folks adapter.

## Open items — remaining (before mainnet)
0. **Encoding: CLEARED** (static SDK cross-check). **Deposit/withdraw/read: VALIDATED** on testnet.
- **Dedicated audit** of the FolksAdapter (the venue-specific contract) before whitelisting.
- **Mainnet canary**: tiny deploy on mainnet Folks, then scale within the buffer/cap.
1. **Withdraw fUSDC↔received_amount + rounding + excess-refund** behavior (does the pool refund
   unused fUSDC, or must `received_amount` exactly equal `fUSDC_sent × index/1e14`?).
2. **Fee budget** across the deposit/withdraw inner groups (SDK uses fee=5000 on withdraw).
3. **Resource/foreign-array** needs when the PSM→adapter→pool call chain runs inside a vault borrow
   (`issue_musd` live-reads the adapter): pool app + pool-manager app + USDC + fUSDC references.
4. A full **deposit → recoverable read (matches SDK) → harvest → recall** cycle vs. real Folks.
