# Strategy — deposits and withdrawals signed on our own UI

**Status:** spec, not built. Written 2026-10-21.
**Supersedes:** STRATEGY_SPEC.md §7.1, which shipped a read-only page linking out
to Ultrade. That was the wrong product, not a smaller one, and the page is
hidden from the nav until this is built.
**Prerequisite reading:** `src/lib/perpsGroup.ts` header, and
`vendor/README.md` before touching the SDK pin.

---

## 1. What "signed on our own UI" has to mean

A user connects a wallet on `/strategy`, enters an amount, reviews what will
move, signs once, and sees the position. They never leave the site, and they can
get their capital out the same way. Anything short of that is the page we
already have.

Two consequences that are easy to under-scope:

1. **Withdrawals ship with deposits or neither ships.** A deposit path alone
   leaves a user who wants out with no route except Ultrade's app, having been
   told Magnet handles this. See §6 — the C-Vault's cooldown makes this worse,
   not better.
2. **The assertion layer is the work, not the construction.** The SDK builds
   these groups. What does not exist is the decode-and-compare that the terminal
   applies to every group it signs (§5).

---

## 2. Resolved: there is no single-asset deposit route

Previously open across three revisions of STRATEGY_SPEC.md. **Closed.**

`isSingleTokenMarket` (`@pdex/sdk` `v2Quotes.js:2576`) requires
`long_asset_id === short_asset_id`. Live `market_core`:

```
market 1 (ALGO/USD)   long=0 (ALGO)   short=31566704 (USDC)
market 2 (BTC/USD)    long=0 (ALGO)   short=31566704 (USDC)
```

Neither is a single-token market, so `deposit_liquidity_single` and
`withdraw_liquidity_single` are **not available on either pool**.

**Every form is two-asset: ALGO + USDC.** There is no USDC-only deposit, and the
UI must not imply one. This removes a whole group shape from the build and is
the single biggest scope reduction available.

---

## 3. Group shapes to build

### 3.1 Deposit — market pool (×2 markets)

`PDexV2AdminOps.deposit_liquidity(market_id, long_transfer, short_transfer, storage_payment, min_market_shares, …)`

- Builder: `buildV2DepositLiquidityTransactions`
- Quote: `quoteV2LpDeposit`
- Input: `{ marketId, longAmount, shortAmount, storagePaymentMicroAlgo, minMarketShares, marketYieldRegistry? }`
- Moves: ALGO (long leg) + USDC (short leg) + a storage `pay`

### 3.2 Deposit — C-Vault

`PDexV2CvaVault.deposit(txn, txn, pay, uint64, …)`

- Builder: `buildV2CvaDepositTransactions`
- Quote: `quoteV2CvaDeposit`
- Input: `{ longAmount, shortAmount, storagePaymentMicroAlgo?, minCvaShares? }`
- **No `marketId`** — the vault allocates across both markets itself.

### 3.3 Withdraw — market pool

`withdraw_liquidity(market_id, share_amount, min_long_amount, min_short_amount, …)`

- Builder: `buildV2WithdrawLiquidityTransactions`
- Quote: `quoteV2LpWithdraw`, bounded by `maximumV2LpWithdrawableShares`
- Input adds `yieldRecallMode`, `maxLongReceiptAmount`, `maxShortReceiptAmount`

`withdraw_liquidity_with_swap` exists and returns a single asset. **Out of scope
for v1** — it adds an output-mode matrix and swap-impact bounds, and a two-asset
exit is sufficient to not trap anyone.

### 3.4 Withdraw — C-Vault

`withdraw` (idle) and `withdraw_from_market` (unwinds an allocation).

- Builders: `buildV2CvaWithdrawTransactions`, `buildV2CvaWithdrawFromMarketTransactions`
- Planner: **`planV2CvaWithdraw` decides which** — do not choose in our code.
- Quotes: `quoteV2CvaIdleWithdraw`, `quoteV2CvaMarketWithdraw`, `quoteV2CvaWithdrawRoute`

---

## 4. The yield-recall preamble

Market-pool withdrawals must run `prepareV2ActionRecall` first, as the
terminal's close path already does: PEX holds idle market cash in external
venues, and a withdrawal may need it recalled in the same atomic group.

Reuses existing machinery. Two things carried over from the terminal:

- `prepareV2ActionRecall` **throws** when metadata is missing or inconsistent —
  "missing or inconsistent metadata is an error, never evidence that yield is
  off". Do not treat a throw as "no recall needed".
- The `capsByAsset` it returns bound the recall. The terminal's close path
  derives those caps from a possibly-stale quote
  (`perpsClient.ts:1688`); **re-quote here**, do not inherit that defect.

Recall needs a backend route (`v2MarketYieldActionRecallPlan`) which we do not
operate. **This is the one hard dependency — see §9.1.**

---

## 5. The assertion layer

`perpsGroup.ts` is ~2,200 lines of field-by-field decode-and-compare for the
terminal's four group shapes. Four new shapes need equivalent treatment, and a
liquidity deposit moves more of a user's money in one signature than a perps
open does.

Build `liquidityGroup.ts` to the same contract:

### 5.1 Per transaction

- `ALLOWED_TXN_TYPES` = `{axfer, appl, pay}`, failed **by count**, so an
  injected `acfg` / `keyreg` / `afrz` cannot ride along. (The terminal's audit
  called an injected `acfg` reassigning clawback the sharpest thing that could
  hide in a group.)
- `onComplete !== 0` fails — no app OptIn/CloseOut/Update/Delete.
- Bound `accounts`, `foreignApps`, `foreignAssets`, `note`, `lease`, `rekeyTo`,
  `closeRemainderTo`, `assetCloseTo`, `assetSender`, `genesisHash`.
- `foreignApps` ⊆ pinned PEX ids; `foreignAssets` ⊆ {0, USDC}; every sender is
  the connected wallet.
- `boxes` is the one field the terminal leaves unbounded. Bound it here:
  deposits touch `lp_state` / `cva_user_state` keys we can derive ourselves.

### 5.2 Per value-moving leg — two anchors each

Every transfer must equal **both** what the screen displayed **and** a value
derived independently:

| Leg | Anchor A | Anchor B |
|---|---|---|
| ALGO long transfer | displayed long amount | quote's `longAmount` |
| USDC short transfer | displayed short amount | quote's `shortAmount` |
| storage `pay` | displayed storage figure | pinned SDK constant |
| receiver, every leg | — | `getApplicationAddress(pinned id)`, never a manifest value |

`checkStoragePayment` (`perpsGroup.ts:790`) is the model.

### 5.3 Group-level

- `flatFee` at `sp.minFee` on every transaction, with a stated cap per shape.
  Without it a congested `suggestedParams` inflates the group — the terminal
  measured 8.4 ALGO at a 10,000 suggestion.
- Display-drift guard between quote and signature, as the open path has
  (`MAX_DISPLAY_DRIFT_BPS` etc.). **The close path lacks one and that is a known
  defect** — do not copy the close path here.
- `txId` computed from signed bytes **before** submission, and
  `SubmissionUnknownError` on a dropped response, so a lost socket is not a
  silent double deposit.
- One action in flight per tab.

### 5.4 What makes this bounded

`min_market_shares` / `min_cva_shares` are the slippage floors. They must be
**computed from the quote and asserted in the group**, never defaulted to 0 — a
zero floor means any share count is acceptable, which is the single worst
parameter on this surface.

---

## 6. Withdrawal constraints the UI must state before signing

Read live, not hardcoded. Current values on app `3690309167`:

| | Value | Consequence |
|---|---|---|
| `cva_mint_spread_bps` | 20 | 0.2% on the way in |
| `cva_burn_spread_bps` | 20 | 0.2% on the way out |
| `cva_withdraw_cooldown_rounds` | 1200 | ~55 min cool-down from deposit (see §6b for wording) |
| `min_cva_withdraw_usd` | 5000000 | $5 minimum withdrawal |

Direct pools have their own cooldown via
`quoteV2DirectLpWithdrawCooldown({ lastDepositTimestamp, currentTimestamp })`.

**Disclose the cool-down before the deposit signature, not at withdrawal.** A
user who learns of it when trying to leave has been misled, even if every number
was correct. Wording is specified in §6b — it is a "cool-down" with a duration,
never a "lock".

---

## 6b. Copy standard for the cool-down

The constraint in §6 is real and has to be stated. How it is stated is a
product decision, and the wording is specified here rather than left to whoever
writes the component.

### 6b.1 Use PEX's own word

**"Cool-down"** is not a softening — it is the protocol's vocabulary:
`cva_withdraw_cooldown_rounds`, `V2_DIRECT_LP_WITHDRAW_COOLDOWN_SECONDS`, and
the SDK returns `failure_reasons: ["withdraw_cooldown"]`. Using it keeps our
copy aligned with every other surface a user might read, including PEX's own.

| Use | Avoid |
|---|---|
| cool-down | lock, locked, lockout, frozen |
| after a 1-hour cool-down you can withdraw | you cannot withdraw for 1 hour |
| withdrawals open in 43 minutes | withdrawal blocked / denied / rejected |
| your deposit settles for 1 hour | your funds are trapped / stuck |

"Lockout" implies something punitive and open-ended; this is 55 minutes and
automatic. "Cannot withdraw" leads with a prohibition where the useful
information is *when they can*.

### 6b.2 The rule that keeps it honest

**Softer noun, same precision.** The house voice already does this — the
terminal describes a genuinely awkward fact as *"PEX holds it as a reusable
escrow. Closing a position releases it back into that escrow rather than to
your wallet"* (`PerpsInfoModal`). Calm, and you still know exactly where your
money went.

So the copy must always carry: **that withdrawals are unavailable, for how
long, and that it starts at deposit.** Dropping any of those three to sound
friendlier is the failure mode. "A short cool-down applies" is friendly and
useless; a user who reads it and expects to withdraw in ten minutes has been
misled by tone rather than by a number.

On the C-Vault this is a consensus rule — the transaction fails on chain — so
vagueness here produces a failed signature, not a disappointment.

### 6b.3 The three surfaces

**Before signing a deposit** — set the expectation, do not bury it:

> Withdrawals open 1 hour after you deposit. PEX applies a cool-down to new
> liquidity; it starts when this transaction confirms.

**On the position card, during the cool-down** — lead with the time, and make
it a countdown, not a state:

> Withdrawals open in 43 minutes

**If a withdrawal is attempted during it** — concrete remaining time, never a
bare refusal. `quoteV2DirectLpWithdrawCooldown` returns `remaining_seconds`
and the C-Vault's is derived from `last_deposit_round`, so the number is always
available:

> This deposit is still in its cool-down — withdrawals open in 12 minutes.

**In the costs list**, beside the spread and the minimum, in the modal's voice:

> PEX applies a 1-hour cool-down to new liquidity before it can be withdrawn.

### 6b.4 Never

- A warning triangle, amber, or red on the cool-down. It is a normal term of
  the product, not a fault — the amber treatment is reserved for things that
  are wrong (a stale feed, an unverified asset leg, a pool at its cap).
- The word "cool-down" without a duration.
- Any phrasing that implies we chose it. It is PEX's, and §9.2.3 records that
  we cannot remove it; saying so plainly is also more honest than letting a
  user infer it is ours.

## 7. UI shape

Per card: amount inputs for both legs, a quote preview (shares out, your
resulting share of the pool, the floor being enforced), the costs from §6, and
one sign. After depositing, the same card shows the position with a Withdraw
action.

- **No "Max" button on deposits.** The terminal deliberately has none; a typed
  stake is harder to fat-finger.
- **Amount parsing goes through `perpsInput.ts`**, which is a whitelist and
  already refuses `"12,50"` → 1250, `"1e5"`, `"-5"` and non-ASCII digits. Three
  audits found three instances of that defect; do not write a second parser.
- **Withdraw takes shares or a percentage**, clamped by
  `maximumV2LpWithdrawableShares` — not a USD amount, which would need a
  reverse quote.

---

## 8. Test plan

1. **Group-shape fixtures.** Capture each built group and assert its decoded
   shape, as `__fixtures__/perpsGroups.json` does for the terminal.
2. **Mutation per assertion.** For each check in §5, mutate the group and prove
   the assertion fires. An assertion without a failing mutation is decoration.
3. **Zero-floor refusal.** `minMarketShares: 0` / `minCvaShares: 0` must throw
   before signing.
4. **Two-asset only.** A deposit path that constructs a single-asset group for
   either live market must fail (§2).
5. **Cool-down disclosure.** The deposit preview must surface a non-zero
   cool-down read from live state; a hardcoded 0 must fail. A second test asserts
   the §6b vocabulary: the strings shown must contain a duration, and must not
   contain "lock", "locked", "lockout" or "frozen" — the copy standard is
   testable, so it is tested rather than trusted to review.
6. **Recall throw is not "off".** A `prepareV2ActionRecall` throw must abort,
   not proceed with no recall.
7. **Unknown-submission.** A dropped response must surface the txId, not retry.

---

## 9. What I need answered

### 9.1 From Dan — blocking the market-pool withdrawal path

`prepareV2ActionRecall` needs `v2MarketYieldActionRecallPlan` and
`v2MarketYieldResourceRegistry`, which are **backend routes we do not operate**,
and `BACKEND_INTEGRATION.md` says not to proxy a PEX-operated API.

- **Can the recall plan be derived entirely from chain state?** The terminal's
  close path calls `readYieldRegistry` from boxes, so possibly yes — if so, this
  is a reimplementation like `pexPerformance.ts` and nothing is blocked.
- **If not, is a public recall-plan route or R2 artifact possible?** Same shape
  as the performance bundle he just shipped.
- **Does a withdrawal that needs no recall work without it?** `idle_long_amount`
  / `idle_short_amount` on the vault are both 0 today, and market 2 has no OI —
  so the common case may need nothing.

Deposits do **not** need recall, so a deposit-only v1 is possible if this
answer is slow. That trades against §1's rule about not shipping deposits alone.

### 9.2 Product decisions — ANSWERED 2026-10-21

1. **Deposits and withdrawals ship together.** Confirmed. No deposit-only
   release. If §9.1 blocks market-pool withdrawals, the answer is to ship
   C-Vault alone (decision 2), not to ship deposits without an exit.

2. **C-Vault leads, and a C-Vault-only v1 is acceptable.** The market pools
   follow if feasible in the same release. This happens to resolve §9.1's risk:
   the C-Vault's idle withdrawal path needs no market recall
   (`idle_long_amount`/`idle_short_amount` are both 0 today, so
   `planV2CvaWithdraw` would route through `withdraw_from_market`, which does
   need recall — see §9.1, still open).

3. **The withdrawal lock cannot be removed — it is PEX's, not ours.**

   The instinct was that a lock is unnecessary, and it would be if it were our
   design. It is not:

   | | Value | Enforced where |
   |---|---|---|
   | C-Vault | `cva_withdraw_cooldown_rounds` = 1200 ≈ **55 min** at 2.77 s/block | **PEX's deployed bytecode** — the strings `cva_withdraw_cooldown_rounds` and `cooldown` are both present in app `3690309167`'s approval program |
   | Direct pools | `V2_DIRECT_LP_WITHDRAW_COOLDOWN_SECONDS` = 3600 = **1 hour** | **SDK constant only** — `cooldown` appears in neither AdminOps `3690309162` nor Markets `3690309159` bytecode |

   So:
   - On the **C-Vault** the cooldown is a consensus rule. A withdrawal inside it
     fails on chain. Nothing we build can change that, and the pool we are
     leading with is the one that has it.
   - On the **direct pools** it is advisory. We *could* ignore it. **We should
     not.** PEX put it there — most plausibly to stop a deposit/withdraw
     sandwich around fee accrual or a price move — and shipping a path their own
     SDK says should not exist makes us the reason their pool gets gamed.

   **There is therefore no lock-free option on PEX**, and both are ~1 hour. The
   decision available is not whether to have one, but whether to disclose it
   well. This spec discloses it **before the deposit signature** (§6), which is
   the only honest handling.

4. **Minimum deposit: $5**, matching the terminal — and the match is exact
   rather than approximate. `min_collateral_usd` and `min_position_size_usd` are
   both `5000000` (= $5.00) on both markets, so this is PEX's own floor, not a
   number we invented. It also lines up with `min_cva_withdraw_usd` ($5), so a
   user cannot deposit an amount they are then unable to withdraw.

   Deposit ceilings are not a concern: `max_pool_usd_for_deposit_long/short`
   are $1 trillion on both markets.

5. **No link-out to Ultrade, in any form.** Removed as an option, including as a
   fallback if this slips. The three cards' current call-to-action goes away
   when this ships; until then the page stays hidden. STRATEGY_SPEC.md §7.1 is
   fully superseded and the `PEX_APP_URL` constant should be deleted, not
   repointed.

### 9.3 Still open, and worth telling users

Market 1 has ~$4 of OI headroom against a PEX-set cap of $2,200. Capital
deposited there earns fees on size that cannot currently be traded against.
Not a blocker and not ours to fix, but the deposit preview should say so rather
than let someone discover it — the same reasoning as the cooldown.

## 10. Explicitly out of scope for v1

- Any link-out to Ultrade's app. Removed as an option entirely (§9.2.5).
- `withdraw_liquidity_with_swap` (single-asset exit)
- `deposit_liquidity_single` / `withdraw_liquidity_single` — unavailable (§2)
- Compounding, auto-rebalance, position history
- "Smart Stake" / Magnet-managed fund — shelved separately
- Bumping the vendored SDK. `vendor/README.md`: "Do not bump this in
  isolation" — `PEX_SDK_VERSION`, the pinned program hashes and the solver
  verification all move with it. 0.6.6 has every builder and quote this spec
  needs.
