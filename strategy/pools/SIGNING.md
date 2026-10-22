# Strategy — deposits and withdrawals signed on our own UI

**Status:** **BUILT** for all three destinations, 2026-10-21/22. Written as a
spec 2026-10-21; §§1-10 are that original spec and §11 is what MainNet corrected
about it. Where the two disagree, **§11 is current** — and they disagree about
nine separate things, which is the main reason to read §11 first.
**Supersedes:** SPEC.md §7.1, which shipped a read-only page linking out
to Ultrade. That was the wrong product, not a smaller one. The link-out is
removed, URL included.
**Current status and real-signature state:** [`OVERVIEW.md`](./OVERVIEW.md).
**Code layout:** [`ARCHITECTURE.md`](./ARCHITECTURE.md).
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

Previously open across three revisions of SPEC.md. **Closed.**

`isSingleTokenMarket` (`@pdex/sdk` `v2Quotes.js:2576`) requires
`long_asset_id === short_asset_id`. Live `market_core`:

```
market 1 (ALGO/USD)   long=0 (ALGO)   short=31566704 (USDC)
market 2 (BTC/USD)    long=0 (ALGO)   short=31566704 (USDC)
```

Neither is a single-token market, so `deposit_liquidity_single` and
`withdraw_liquidity_single` are **not available on either pool**.

This removes a whole group shape from the build.

⚠️ **But it does NOT follow that every form must be two-asset** — see §9.5.
`deposit_liquidity` accepts a zero leg (`allowZero = true` in the builder;
`&&` not `||` in the quote), so a one-sided deposit is the same group shape with
one amount at zero. It also carries a price-impact consequence of up to ±1.1%
depending on which leg, which the preview must show.

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

## 4. Yield recall — NOT a backend dependency

> **Corrected after audit, 2026-10-21.** The first version of this section said
> market-pool withdrawals must run `prepareV2ActionRecall` "as the terminal's
> close path already does", and called the backend route it needs "the one hard
> dependency". Both halves were false, and §9.1 built a blocking question to
> Dan on top of them.

`grep -rn "prepareV2ActionRecall" src/` returns **zero hits.** The terminal
never calls it. What `closePositionInner` does instead:

- `readYieldRegistry(algod, marketId, …)` — built entirely from boxes
  (`perpsClient.ts:1673`)
- `yieldRecallMode: 1`, hardcoded (`:1753`)
- two candidate recall shapes, each asserted then simulated, first that passes
  wins (`:1707-1734`)

And `perpsReads.ts:925` records the decision deliberately: *"We do not take that
dependency… It turns out not to be necessary."*

`prepareV2ActionRecall` could not be fed chain data even if we wanted it:
`marketYield.js` requires `registry.registry_version === plan.registry_version
&& registry.registry_hash === plan.registry_hash`, and our chain-derived
`YieldRegistry` has neither field. It is a **verifier of a backend-issued plan**,
not a planner — every one of its ~40 assertions reads a field off
`v2MarketYieldActionRecallPlan()`'s response.

**So withdrawals reuse `readYieldRegistry` verbatim**, set `yieldRecallMode: 1`,
and keep the simulate-and-fallback loop. Roughly 40 lines, not a blocked
release.

Two things that still carry over:

- `yieldRecallMode: 0` is not an escape. `INTEGRATION_GUIDE.md:190` — *"Recall
  authorization is included even when idle cash currently covers the quote; the
  contract checks the actual shortfall at execution"* — and `perpsClient.ts:1595`
  records that mode 0 "builds fine and then fails at `inner tx 0` on a live
  position."
- The terminal derives its recall caps from a possibly-stale quote
  (`perpsClient.ts:1688`). **Re-quote here**; do not inherit that defect.

## 4b. Oracle payloads — required by every method, omitted from the first draft

Every method in §3 ends in two `byte[]` args: `oracle_message` and
`oracle_signature`. `OracleCallArgs` is **non-optional** on
`V2DepositLiquidityGroupInput`, `V2WithdrawLiquidityInput`, `V2CvaDepositInput`,
`V2CvaWithdrawInput` and `V2CvaWithdrawFromMarketInput`. The first draft elided
them as "…" in the signatures and omitted them from every input list and from
§5.2's anchor table.

AdminOps validates the payload itself — 133 bytes, 64-byte signature, `"PDX2"`
magic, version 3, genesis hash at offset 5, **target app id at offset 37** and
**market id at offset 45**. Offset 37 is exactly `ORACLE_TARGET_APP_OFFSET` in
`perpsGroup.ts:94`, so the terminal's assertion transfers verbatim.

The payloads exist today: the live bundle carries `app-3690309162/market-{1,2}`
and `app-3690309167/market-{1,2}`, so `getOraclePayload(PEX_APPS.adminOps,
marketId)` works with no new code.

Consequences the first draft never derived:

- **`ORACLE_MAX_AGE_SEC = 20`** applies to every group. The close path aborts
  before opening the wallet when `budgetLeft < MIN_SIGNING_BUDGET_SEC` (8s,
  `perpsClient.ts:1796`). Copy that gate — a display-drift guard does not
  address freshness.
- **Verify the signature before display**, as `perpsClient.ts:1667` does.
- **The C-Vault needs three payloads**, not one — see §4c.

## 4c. The C-Vault needs a mark preamble, and that makes it the HARDEST shape

`buildV2CvaDepositCall` begins with `buildV2CvaActiveMarkCalls(input)`, which
**throws** `missing active CVA mark oracle for market N` unless
`activeMarketOracles[N]` is supplied for every active market.

Live state forces it: `active_market_0 = 1`, `active_market_1 = 2`,
`max_nav_age_rounds = 5` (~14 s, enforced at `cva.teal:33, 515, 662, 875,
1043`), and `gm2:` marks are **~230 rounds stale** right now. A C-Vault deposit
built today must carry `mark_market(1)` and `mark_market(2)` plus their own Math
carriers.

Real shape — 8-10 transactions of Algorand's 16, and three oracle payloads:

```
[mark carriers] + mark_market(1) + mark_market(2)
+ transfer long (zero allowed) + transfer short (zero allowed)
+ pay storage (note "pdex-v2-cva-deposit-storage")
+ appl CvaVault.deposit + resource carriers
```

That note **fails** the terminal's `LINKED_NOTE_RE`
(`/^pdex-v2-linked-(escrow|storage)-\d+$/`, `perpsGroup.ts:117`), so a copied
note rule rejects every C-Vault deposit.

§3.2's input list also omits, from the type: `oracleMessage`,
`oracleSignature`, `longAssetId`, `shortAssetId`, `activeMarketIds`,
`activeMarketOracles`, `v2CvaVaultAppId`, `v2MarketsAppId`, `v2MathAppId`,
`v2AdminControlAppId`.

## 5. The assertion layer

`perpsGroup.ts` is ~2,200 lines of field-by-field decode-and-compare for the
terminal's four group shapes. Four new shapes need equivalent treatment, and a
liquidity deposit moves more of a user's money in one signature than a perps
open does.

**Shape count: five or six, not four.** C-Vault withdraw is two distinct shapes
(`withdraw`, 5 args, no recall fields; `withdraw_from_market`, 9 args with
`yield_recall_mode` and two receipt caps), plus `mark_market` as a preamble
shape that itself carries a signed payload and needs decode-and-compare. Sizing
against `perpsGroup.ts`'s 2,219 lines for four shapes under-counts by ~40%.

Build `strategy/group.ts` to the same contract:

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
- **Bound `boxes`** — and the model exists: `assertCancelGroup`
  (`perpsGroup.ts:2193`) already bounds them exhaustively (length 43, `o2:`
  prefix, owner pubkey, id in the displayed set). The open and close paths do
  not; the cancel path does. ⚠️ Do NOT copy its owner-equals-sender rule:
  `buildV2CvaWithdrawFromMarketCall` references `v2LpBoxKey(cvaAddress,
  marketId)` — keyed by the **vault's** address, not the user's — so that rule
  rejects every legitimate C-Vault market withdrawal. Deposits also reference
  `m2:`/`mp2:`/`mr2:`/`mo2:`/`mf2:`/`my2:` when no resource carrier is present.

### 5.2 Per value-moving leg — two anchors each

Every transfer must equal **both** what the screen displayed **and** a value
derived independently:

| Leg | Anchor A | Anchor B |
|---|---|---|
| ALGO long transfer | displayed long amount | quote's `longAmount` |
| USDC short transfer | displayed short amount | quote's `shortAmount` |
| storage `pay` | displayed storage figure | pinned SDK constant |
| receiver, every leg | — | the **correct** pinned app address, never a manifest value — see below |

⚠️ **The money does not go to the app being called.** `deposit_liquidity` calls
AdminOps `3690309162` but the transfers go to
`getApplicationAddress(v2MarketsAppId)` = `3690309159`. The C-Vault's go to its
own address. Asserting "receiver == the called app's address" rejects every
direct-LP deposit.

⚠️ **The storage payment has two legal values, not one.** `V2_LP_BOX_MBR = 26_500`
and `V2_CVA_USER_BOX_MBR = 32_900` on a first deposit, **0 on a top-up** when
the box already exists. Assert "0 or the pinned MBR", which is the shape
`checkStoragePayment` (`perpsGroup.ts:788`) already uses — and read `ml2:`/`gu2:`
before building to know which applies.

Also required, all present in the terminal and missing from the first draft:

- **Pinned method selectors.** `deposit_liquidity` = `115498d8`,
  `withdraw_liquidity` = `cc72508e` — both confirmed in AdminOps' live dispatch
  table. `perpsGroup.ts`'s header says why: checking the encoder's output
  against the same manifest proves only self-consistency.
- **A call budget**, not just `foreignApps ⊆ pinned`. The terminal's own comment
  records that the weaker rule let "an extra call to cvaVault, swapOps,
  adminOps or adminControl pass the assertion untouched."
- **Resource-carrier contents** — all four shapes emit them; assert each is a
  bare `Math.noop` naming nothing the asserted calls do not. `v2MathAppId` is
  required, not optional: the builder throws without it.
- **One validity window** across the group, so no leg can be replayed alone.
- **Simulate before signing.** For a withdrawal whose entire payout is inner
  transactions, simulation is the only pre-signature evidence that the recall
  caps and reference budget suffice.

### 5.3 Group-level

- **`sp.fee = sp.minFee; sp.flatFee = true` on suggestedParams**, with a stated
  numeric cap per shape. NOT "fee === minFee on every transaction" — that would
  fail every legitimate group here. The SDK sets per-method flat fees:
  `deposit_liquidity` and `withdraw_liquidity` 50,000 µALGO, `CvaVault.deposit`/
  `withdraw`/`mark_market` 23,000 each, Math carriers 1,000. Pinning
  suggestedParams stops the transfer legs and carriers inflating; the per-method
  fee stands where the method needs inner-transaction budget; the group total is
  capped (cf. `MAX_CLOSE_GROUP_FEE_MICRO_ALGO = 200_000`). Rough floors: direct
  deposit ≈ 55k, C-Vault deposit with marks ≈ 75–80k.
- Display-drift guard between quote and signature, as the open path has
  (`MAX_DISPLAY_DRIFT_BPS` etc.). **The close path lacks one and that is a known
  defect** — do not copy the close path here.
- `txId` computed from signed bytes **before** submission, and
  `SubmissionUnknownError` on a dropped response, so a lost socket is not a
  silent double deposit.
- One action in flight per tab.

### 5.4 What makes this bounded

`min_market_shares` / `min_cva_shares` are the deposit floors. They must be
**computed from the quote and asserted in the group**, never defaulted to 0 —
the SDK's `?? 0n` means a zero floor accepts any share count.

⚠️ **And the withdrawal floors matter more, because withdrawals have no legs to
anchor.** `buildV2WithdrawLiquidityTransactions` emits **no value-moving
transactions at all** — PEX returns assets by inner transaction. So §5.2's
two-anchor table has nothing to bind on any exit, and the only protection is
`min_long_amount` / `min_short_amount` in the app args, which the SDK also
defaults to `?? 0`. A zero there means "accept any payout" on the side where
the user is trying to get their capital back. Treat these as the worst
parameters on this surface, ahead of the deposit floors.

---

## 6. Withdrawal constraints the UI must state before signing

Read live, not hardcoded. Current values on app `3690309167`:

| | Value | Consequence |
|---|---|---|
| `cva_mint_spread_bps` | 20 | 0.2% on the way in |
| `cva_burn_spread_bps` | 20 | 0.2% on the way out |
| `cva_withdraw_cooldown_rounds` | 1200 | ~55 min cool-down from deposit (see §6b for wording) |
| `min_cva_withdraw_usd` | 5000000 | $5 minimum withdrawal |

Direct pools have their own, also consensus-enforced (§9.3), surfaced via
`quoteV2DirectLpWithdrawCooldown({ lastDepositTimestamp, currentTimestamp })`.

**The cooldown restarts on every top-up, on both destinations.**
`markets.teal:2632` rewrites `lp_state.updated_at` to now on each user deposit,
re-locking the *entire existing position* for a fresh hour; the C-Vault measures
from `last_deposit_round` the same way. A user with $10,000 in for a month who
adds $10 cannot withdraw anything for 55 minutes. "~1 hour after depositing"
reads as a one-time onboarding cost; it is not.

### 6a. Five more live gates, all on chain, none checked by any SDK quote

| gate | live | enforced |
|---|---|---|
| `deposit_paused` / `withdraw_paused` | 0 / 0 | `cva.teal:42, 45, 524, 527…` |
| `max_nav_age_rounds` | **5** (~14 s) | `cva.teal:33, 515, 662…` |
| allocation `status` | 1 (3 = WITHDRAW_ONLY) | contract |
| per-market `max_deposit_usd_per_call` / `…withdraw…` | **$10,000** each | contract |
| `max_pnl_factor_for_withdrawals_bps` | **7000** mkt 1 / **6000** mkt 2 | contract |

The pause flags, the NAV window and the cooldown are **not checked by
`quoteV2CvaIdleWithdraw` or `quoteV2CvaMarketWithdraw`** — those return
`ok: true` while the chain rejects. Reading them live is mandatory, not a
nicety.

Note `max_pnl_factor_for_withdrawals_bps` is *tighter* than the deposit
equivalent, so a pool with traders deep in profit blocks withdrawals before
deposits. `maximumV2LpWithdrawableShares` binary-searches against exactly these
— it is the right instrument, but needs the market record merged with `mo2:` OI
fields or it silently understates trader PnL.

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

**During the cool-down, the Withdraw action is UNAVAILABLE, not offered.**
Both cooldowns are `assert`ed on chain (§9.3), so a button that submits inside
the window fails at consensus — "offered, then refuses" is the precise failure
`perpsPreflight.ts` exists to prevent. Disable it and put the countdown in its
place, with the remaining time, which is always available
(`remaining_seconds`, or derived from `last_deposit_round`):

> Withdrawals open in 12 minutes

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
  reverse quote. Below $10 on the C-Vault, offer **full exit only** (§9.4).
- **Price impact per leg** must be in the preview: up to ±1.1% depending on
  which asset you send (§9.5). Omitting it hides a charge five times the size of
  the C-Vault's whole spread.

### 7a. Preflight, which the terminal already wrote

`openPosition` (`perpsClient.ts:341-371`) does all of this before building, and
none of it was in the first draft:

- **Spendable-ALGO check** — `amount - minBalance` must cover the ALGO leg plus
  ~50-80k µALGO of fees plus the 26.5k/32.9k storage payment. Without it, a user
  depositing near their whole balance gets a chain rejection.
- **USDC held and sufficient**, with named errors rather than a revert.
- **USDC opt-in for the EXIT.** Withdrawals arrive by inner transaction, so the
  receiver must be opted in. A C-Vault depositor whose allocation later pays out
  USDC may not be.
- **No LP-token opt-in needed** — `market_share_asset_id = 0` on both markets,
  so shares are box-tracked and never an ASA. Worth stating so nobody adds a
  spurious step.
- **Program pins.** `PEX_PROGRAM_SHA256` pins six apps; **AdminOps `3690309162`
  and CvaVault `3690309167` are not among them**, and `verifyProgramPins` does
  not read them. The two apps this entire feature runs on have no upgrade
  detection. Two more digests is a one-line change.

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
8. **On-chain gates refuse in the UI, not at consensus.** One test per gate:
   `withdraw_paused = 1`, inside either cooldown, allocation `status = 3`, a
   `max_nav_age_rounds` breach, and the per-call $10,000 cap. Each must disable
   the action rather than build a group — these are the failures that reach a
   user as "it just failed".
9. **Mark preamble present when stale.** A C-Vault deposit built while
   `last_mark_round` is older than `max_nav_age_rounds` must carry
   `mark_market` for every active market, or fail to build.
10. **Signing budget.** A payload older than `ORACLE_MAX_AGE_SEC - MIN_SIGNING_BUDGET_SEC`
    must abort before the wallet opens.
11. **Withdrawal floors non-zero.** `min_long_amount`/`min_short_amount` of 0
    must throw, same as the deposit floors (§5.4).

---

## 9. Decisions, after audit

> Four claims in the first draft were wrong and three of them changed a
> decision. Corrected here; the originals are named so the reasoning is
> traceable.

### 9.1 Release order — REVERSED

**Market pools first. C-Vault second.** The first draft led with the C-Vault
on the grounds that it was "the easiest deposit (no `marketId`, no recall on the
idle path)". It is the hardest of the three:

| | market pool | C-Vault |
|---|---|---|
| oracle payloads | 1 | **3** (deposit + 2 marks) |
| mark preamble | none | **required** — marks are ~230 rounds stale against a 5-round window (§4c) |
| group size | ~6 txns | **8–10 of 16** |
| freshness window | 20 s (payload) | **~14 s** (`max_nav_age_rounds = 5`) |
| exit routes | one | two + a route decision we must make ourselves (§3.4) |
| pause flags on chain | — | `deposit_paused`, `withdraw_paused`, allocation `status` |
| dust floor | none | **$5 trap** (§9.4) |

With the recall dependency gone (§4), `deposit_liquidity` is six transactions
with one payload, and `withdraw_liquidity` is one app call plus carriers reusing
`readYieldRegistry` verbatim. That is the cheaper half **and** the only
destination with a clean exit.

This also removes the reason the first draft accepted a C-Vault-only v1. Both
pools plus their withdrawals is now the smaller piece of work.

### 9.2 The idle-withdrawal premise was wrong, and self-refuting

The first draft said `idle_long_amount`/`idle_short_amount` "are both 0 today"
and concluded the C-Vault's idle path needs no recall — in a sentence whose own
parenthesis then said the opposite.

Live: `idle_long_amount = 385716` (0.386 ALGO), `idle_short_amount = 131264`
(0.131 USDC) — **≈ $0.18 total**. `quoteV2CvaIdleWithdraw` pushes
`insufficient_idle` when idle < withdrawal, and `min_cva_withdraw` below $5. So
with $0.18 of idle against a $5 floor, **the idle route cannot satisfy any legal
withdrawal.** Every C-Vault exit goes through `withdraw_from_market`.

Leading with the C-Vault would have *maximised* exposure to the dependency the
draft called blocking. It is the only destination with no recall-free exit.

### 9.3 Both cooldowns are consensus rules — CORRECTED

The first draft said the direct-pool cooldown was an "SDK constant only",
advisory, and that we "could ignore it… we should not". **It is enforced on
chain.** Markets app `3690309159`, two sites:

```
global LatestTimestamp ; extract_uint64 (lp_state.updated_at, offset 8)
pushint 3600 ; + ; >= ; assert
```

(`markets.teal:2824-2831`, guarded by a `CallerApplicationID` carve-out, and
`:3149-3156`, unconditional.)

The draft's grep for the string `cooldown` could never have found `pushint
3600`. **This is the fourth time in this repo a behavioural fact has been
asserted from a string search** — see `feedback_assert_behaviour_not_source_text`.

So there is no choice to make on either destination, and §9.3's policy
paragraph about honouring an advisory is void. The consequence for the UI is
bigger than wording: **the Withdraw action must be unavailable inside the
window, not offered and refused.** Offering a button that fails at `assert` is
the exact failure `perpsPreflight.ts` exists to prevent.

| | duration | enforced |
|---|---|---|
| direct pools | 3600 s = 1 h | Markets bytecode, `assert` |
| C-Vault | 1200 rounds ≈ **55 min** (measured 2.75 s/block) | CvaVault bytecode |

### 9.4 Minimum deposit — ~~$5 is a trap; use $5.25~~ SUPERSEDED by §11.11

The first draft set $5 and claimed it "lines up with `min_cva_withdraw_usd`
($5), so a user cannot deposit an amount they are then unable to withdraw."
Exactly backwards. At the live 20/20 bps spreads:

```
deposit $5.000000  ->  withdrawable $4.980040   BELOW the $5 exit floor
deposit $5.020000  ->  withdrawable $4.999960   BELOW
deposit $5.021000  ->  withdrawable $5.000956   OK
```

A $5.00 C-Vault deposit cannot be fully withdrawn *immediately*. Minimum
fully-exitable is ≈ **$5.02004** before any NAV decline.

> **"Permanently" was wrong — see §11.11.** This treated NAV as static. The
> shortfall is 0.40% of vault growth, which a vault earning anything covers in
> days. The minimum is now **$5.00**.

Worse, the floor applies to the withdrawal *value*, not the residual: a user
with $7 can withdraw $5–$7 but not $2, so **any partial exit leaves ≤ $5 of
permanent dust.**

**Decision: $5.25 minimum on the C-Vault** — ~~which clears the floor with ~4.5%
of headroom for NAV movement~~, and the withdraw UI offers **full exit only**
below $10 so nobody strands a residual. Market pools keep no minimum — they
have no exit floor.

> **REVERSED — the minimum is $5.00. See §11.11.** This treated NAV as static;
> the shortfall is 0.40% of growth, i.e. days, not forever. $5.25 also bought
> 4.38% of headroom where 0.01% was required. Market pools did get a $5.00
> minimum after all, for an unrelated reason (§11.8).

The draft also mis-sourced the number: `min_collateral_usd` and
`min_position_size_usd` ($5 each) are **perps** parameters. `quoteV2LpDeposit`
reads neither; its only size gates are `empty_deposit` and
`deposit_value_too_small`. "PEX's own floor" was true of a different product.

### 9.5 One-sided deposits ARE possible — §2's conclusion was too strong

§2's chain facts are right: `deposit_liquidity_single` is genuinely unavailable
on both markets. But the conclusion "**every form is two-asset**" does not
follow, and the SDK is built the other way:

- `quoteV2LpDeposit`: `if (longAmount <= 0n && shortAmount <= 0n)
  reasons.push("empty_deposit")` — **`&&`, not `||`**. One leg at zero quotes ok.
- `buildV2DepositLiquidityTransactions` passes `allowZero = true` to both
  transfer builders, and `makeTokenTransferTxn` throws on zero *unless* that
  flag — so it exists specifically to permit a zero leg.

**This is economically significant, not just a form option.** `depositImpact`
prices deposits against pool balance. Live market 1 is **$650 of ALGO against
$1,952 of USDC**, so an ALGO-only deposit *reduces* the imbalance and earns
positive impact, while a USDC-only deposit widens it and pays up to
`max_swap_impact_bps = 110` — **1.1%, five times the C-Vault's entire round
trip.** The bonus is capped by a ~$1.45 impact pool; the penalty is not.

So the preview must show price impact per leg, and test-plan item 4 ("a
single-asset group must fail") would have locked in a false invariant.

**Open, settleable by one simulate:** whether the contract accepts a zero leg.
The SDK's quote and builder both say yes. Worth confirming before building the
form.

### 9.6 The OI headroom claim was one-sided

Market 1: long OI **$2,195.60** against a $2,200 cap — $4.40 free, as stated.
But short OI is **$162.26** against the same $2,200 cap — **$2,037.74 free**. A
deposit backs both sides, so "the market has ~$4 of headroom" overstates it by
~460× on the short side. The honest line: *long-side OI is at its cap; the short
side has ~$2,038 free.*

### 9.7 Questions for Dan — narrowed

§9.1's three blocking questions are answered in our own repo (§4). What is
actually worth asking:

1. Is the direct-LP cooldown's `CallerApplicationID` carve-out stable? It is why
   the C-Vault's own `ml2:` rows carry `updated_at = 0` while third-party rows
   carry real timestamps.
2. Do `withdraw_liquidity`'s two TEAL cooldown sites differ deliberately — one
   guarded, one not?
3. Does `lp_state.updated_at` move on **withdrawal** as well as deposit? The
   field name suggests yes, which would restart the cooldown on a remainder
   after a partial exit.
4. Would he lower `cva_withdraw_cooldown_rounds`? Worth asking once, given the
   product view that ~1 h is unnecessary — but it is his contract.

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

---

## 11. What the build found — corrections to this spec

Written after implementing §§4–7 against MainNet, 2026-10-21. Everything below
contradicts something stated earlier in this document, and the implementation
follows this section, not the earlier text.

### 11.1 The SDK's LP quotes are too inaccurate to set a floor from

§7 assumed the slippage floors would come from `quoteV2LpDeposit` /
`quoteV2LpWithdraw`. Measured against MainNet, on market 1:

```
deposit  0.5 ALGO + 0.5 USDC   quote 492,740 shares   chain 484,711   quote 1.656% HIGH
withdraw 0.092902 shares       quote 230,829 µALGO    chain 234,657   quote 1.742% LOW
```

Consistent, and in mirror directions: the quotes value the pool below what the
chain does, almost certainly by the quantity lent into the yield vaults. The
error is insensitive to the price input — every variant of the index, long and
short band edges, and every `pnlContext`, returns the identical figure — and
passing the market's eight open positions changes nothing either.

**This was a shipping bug, not a rounding note.** A 1% floor derived from the
deposit quote is *unsatisfiable*: MainNet rejected exactly that group at
`AdminOps pc=1541` (`dig 18; >=; assert`), the on-chain minimum-shares check. A
Deposit button that always fails.

**Resolution: the chain is the source of truth.** Both apps return an ABI
receipt whose field names the vendored manifest supplies, and `decodeReceipt`
reads them:

```
v2_lp_deposited   market_id long_amount short_amount shares_minted
                  long_pool_amount_after short_pool_amount_after
                  market_share_supply_after
v2_lp_withdrawn   market_id shares_burned long_out short_out
                  long_pool_amount_after short_pool_amount_after
                  market_share_supply_after storage_refund_microalgo
```

So both builders run **two passes**: simulate with a floor of zero, read the
receipt, apply the tolerance to the chain's own figure, rebuild, assert,
simulate again. The floor then protects against what it should — state moving
between now and the signature — and the figure shown to the user is the
contract's, not an estimate. The SDK quotes remain only as a live estimate
while someone is typing, labelled as such.

`strategy/quote.ts` deliberately exports no `floorOf`; an earlier revision did
and it was a trap.

### 11.2 A withdrawal needs the yield registry and BOTH receipt caps

§4 said recall was "NOT a dependency". For a withdrawal that is wrong — and the
SDK's types accept all three mistakes without complaint:

| shape | outcome |
|---|---|
| `yieldRecallMode: 0` | builds, then fails at `inner tx 0` |
| mode 1, no `marketYieldRegistry` | SDK throws `marketYieldRegistry is required` |
| mode 1, caps `0/0` | builds; MainNet rejects at Markets `pc=12259` (`frame_dig -1; <=; assert`) |
| mode 1, long cap only | same rejection |
| mode 1, both caps | **accepted** — 10 txns, 117,000 µALGO |

The close path's "index leg only, then both legs" fallback is therefore *wrong
here* and is not used: a withdrawal pays out both assets, so the tighter shape
cannot satisfy the contract rather than merely being unlikely to fit.

### 11.3 Measured group shapes and the fee cap

```
deposit    6 txns   pay(ALGO) axfer(USDC) pay(storage) + AdminOps + 2 Math    55,000 µALGO
withdraw  10 txns   AdminOps + 9 Math carriers (both recall legs)            117,000 µALGO
```

The first fee cap written here was 120,000, from shapes measured *without* the
registry. A correct withdrawal sits at 117,000 — on the lip of it. Raised to
**200,000** on that evidence, which keeps ~1.7x headroom; the carriers are
individually asserted to be bare noops, so the headroom cannot hide an
operation, only fee.

### 11.4 The withdrawal assertion needs the recall's own allow-set

A real withdrawal's recall names the Folks pool and its manager, the xALGO
consensus app, the proposer set, and the fUSDC and xALGO assets — **fifteen
findings** on the first live group, every one of them a legitimate resource.

The fix is not to relax `checkEveryTransaction`. `readYieldRegistry` already
derives a closed `recall: { accounts, assets, apps }` set from chain, and that
set is passed in, so anything outside it still fails. This leaves the check
*tighter* than a blanket "PEX apps are fine" rule. `readRecallContext` returns
the registry and the recall set together so a caller cannot take one without
the other.

### 11.5 Trading's call budget was NOT widened

A liquidity group calls AdminOps, which the trading `CALL_BUDGET` excludes
deliberately — audit 8 found that including it let an extra call ride along
inside a trade. `strategy/group.ts` has its **own** budget and its own shapes.
`PIN_SETS` likewise splits the program pins per path, so a trade does not pay
for the vault hashes it never calls.

Program pins added for the two apps this path signs against, previously
unpinned:

```
adminOps  ac8d667ce2396d783c02ae968dbb041400bd600d590ba606d71362140f2a212f
cvaVault  b2fd9b6f0e6e7f9bf47ad6edfe2e367a3e1485cd40eb62d489a8053bcd50b9b1
```

### 11.6 Confirmed on chain, not inferred

- `ml2:` lp_state is **16 bytes**: `share_amount` at 0, `updated_at` at 8.
  Confirmed in the Markets bytecode (`intc_2 // 8; extract_uint64`) and against
  two live boxes.
- The direct cool-down is `>=`, so the boundary second itself is allowed, and
  `updated_at == 0` is not gated. `quoteV2DirectLpWithdrawCooldown` matches the
  bytecode exactly, including the zero case, so it owns the arithmetic and the
  3600 constant — §9.3's correction stands and now has a shared implementation.
- The C-Vault cool-down reads `cva_user_state[8..16]` (`last_deposit_round`),
  confirmed at `cva.teal label58`, and is skipped entirely when the global is 0.
  Corroborated by a live user who deposited at round 65,154,825 and withdrew
  1,433 rounds later — just past the 1,200 cool-down.
- Every C-Vault global the gates read exists under the name assumed:
  `cva_withdraw_cooldown_rounds` 1200, `min_cva_withdraw_usd` 5000000, both
  spreads 20 bps, `max_nav_age_rounds` 5, both per-call caps 0 (unlimited),
  both pause flags 0, `active_market_{0,1}` = 1, 2.
- The oracle payload goes to **AdminOps** on both paths, matching the signed
  bundle's own key `app-3690309162/market-N`.
- `$5.00` into the C-Vault leaves `$4.98003992` withdrawable, not `$4.980038`
  as §9.4 printed. The conclusion is unchanged.

### 11.7 Two freshness regimes in the C-Vault, and why it shipped second

The vault enforces NAV freshness two different ways:

```
lenient   Round <= mark_round + max_nav_age_rounds   (5 rounds, ~14s)   cva.teal label143
strict    gm2:[40..48] == global Round, exact, AND a verified mark_market
          (selector 0x7eda6c29) for that market in the same group          cva.teal:5160-5205
```

Under the strict path waiting cannot help: the mark must land in the same round
as the action, which is only possible inside the group. So a stale NAV is never
something to tell a user to retry — it is a leg to add, one per active
allocation holding shares.

The live NAV was **36 to 257 rounds stale** across this session's runs, against
a 5-round limit. That is the condition that makes an unprepared C-Vault deposit
fail, and it is why the two direct pools shipped first.

> **Shipped 2026-10-22.** The preamble turned out to be the SDK's job, not ours
> — see §11.12. The vault's card offers both actions.

### 11.8 Product minimum on the direct pools is $5, not $5.25

The $5.25 in §9.4 exists only to clear the C-Vault's $5 withdrawal floor after
two 20 bps spreads. Neither applies to the direct pools: the Markets app
enforces no minimum deposit and has no exit floor. $5 is kept anyway, because a
round trip costs ~0.17 ALGO in fees (~$0.02) and on a $1 deposit that is a
share no APR on the page would recover. Using one number for both would misstate
why either exists.

### 11.9 The PEX URL is gone

Not replaced — removed. `PEX_APP_URL` and `GoToPex` are deleted, per "don't use
the URL, forget that as an option". The C-Vault card shows a disabled control
with a reason instead of a link.

### 11.10 A first-time depositor could never deposit

Shipped and then fixed the same day, and the most instructive defect in this
product.

`AdminOps.deposit_liquidity` asserts the storage payment equals the `ml2:` box
MBR **exactly**:

```
assert failed pc=1203   opcodes=intc 17 // 26500 ; == ; assert
```

The deposit path hardcoded zero, which is correct only for a wallet that already
holds the box. So every existing LP could deposit and **no new depositor could**
— including the first real user of the page.

**Why every test missed it.** They all used `A4YW55…`, a real market-1 LP with
an existing box, and zero is the right answer for that wallet. A suite that only
ever exercises the returning case cannot see the first-time case. This is the
same gap the perps path carried across eight audits as `SHAPE_OPEN_STORAGE`.

Fixed by `storagePaymentFor(hasPosition)` — exactly the MBR on a first deposit,
exactly zero afterwards, since the contract asserts equality in both directions
and neither value is a safe default for the other. The constant is the SDK's
`V2_LP_BOX_MBR_MICRO_ALGO`, not a literal, so a PEX box-layout change moves with
the vendored version. The MBR is counted toward the balance gate and the MAX
button's reserve, both of which would otherwise build a group the gate refuses.

The live test keeps the **failing** case as well as the passing one, so this
cannot regress to zero unnoticed. The C-Vault has the same trap at a different
value — `gu2:` is 32,900 — and that one was tested before shipping rather than
discovered (§11.12).

### 11.11 Minimum C-Vault deposit is $5.00, not $5.25 — §9.4 overstated the trap

§9.4 called a $5.00 deposit "permanently below the exit floor" and set the
minimum at $5.25 on that basis. The word *permanently* was wrong, and it was the
word the decision rested on.

Prompted by a real-world check: **Mallow run the same C-Vault and accept $5.00
even.** That is a direct contradiction of a spec claim, so the mechanism was
re-read in the deployed bytecode rather than argued about.

**The mechanism is as described.** Mint marks the share price UP by
`cva_mint_spread_bps` (`cva.teal:1251-1266`); `label59` subtracts
`cva_burn_spread_bps` from the gross on exit and `min_cva_withdraw_usd` is
asserted against the **net** (`cva.teal:5924-5931`). At the live 20/20 bps
against a $5 floor:

```
deposit $5.0000  ->  position $4.990020  ->  net on exit $4.980040   under the floor
deposit $5.0200  ->  position $5.009980  ->  net on exit $4.999960   still under, barely
deposit $5.0201  ->  position $5.010080  ->  net on exit $5.000060   clears
```

**What was wrong is the conclusion.** NAV appreciates. The shortfall on a $5.00
deposit is **0.4008% of vault growth**:

| vault APR | wait before a full exit is possible |
|---|---|
| 5% | ~30 days |
| 8% | ~19 days |
| 11.22% | ~14 days |
| 15% | ~10 days |

A short wait, not a trap. And $5.25 was not even a tidy fix — it bought 4.38% of
headroom where 0.01% was the requirement, which is the signature of a number
picked to feel safe rather than derived.

**Decision: $5.00 minimum**, matching Mallow, with the mechanic surfaced rather
than hidden. Deposits below the immediate-exit threshold carry a **notice, not a
gate** — `Notice` is a separate type from `Gate` precisely so it cannot disable
a button:

> This vault has a $5.00 withdrawal minimum, and after its 0.20% entry and
> 0.20% exit costs a $5.00 deposit sits just under it. Your full exit opens once
> the vault earns about 0.40% — roughly 14 days at its current rate, longer if
> its value falls. Deposit $5.03 or more to be able to withdraw in full right
> away.

Three things that copy has to get right, each pinned by a test:

- the **downside** is stated ("longer if its value falls"), not only the happy case
- the day estimate is **omitted** when no APR is available, never invented
- the threshold is rounded **up** to the cent. The true value is $5.02004, so
  "$5.02" would name an amount that still needs a hair of growth.

`cvaImmediateExitMinUsd` and `cvaGrowthNeededForExit` derive from the live
globals. All three inputs — both spreads and the floor — are admin-mutable, and
a test sweeps them rather than pinning $5.02.

**The general lesson, which is the third time this has bitten this document:**
§11.1 found an SDK quote trusted without measurement, §11.2 found a dependency
declared absent without testing it, and this found a static model of a quantity
that grows. Each survived because it was reasoned about rather than checked.

### 11.12 The C-Vault build — what it actually cost, and six more shape errors

Built 2026-10-22. Both paths build, assert and simulate on MainNet:

```
deposit   $6 USDC        ->   8 txns,  74,000 µALGO  ->  5,103,278 shares
withdraw  $10 of shares  ->  15 txns, 178,000 µALGO  ->  22.11 ALGO + 7.54 USDC
```

**§9.1's main cost estimate was wrong.** It deferred the vault partly because
the mark preamble looked like ours to assemble. It is not: `planV2CvaWithdraw`
picks the route, and both CVA builders emit the `mark_market` legs when given
`activeMarketIds` and `activeMarketOracles` (`V2CvaDepositInput` extends
`V2CvaActiveMarkOracleRefs`, so this holds on deposits too, which have no
planner because they have no route). Deferring was still right — the vault is
the harder shape — but for narrower reasons than stated.

**Six shape errors, each failing with a misleading message.** All were found by
running it against MainNet, none by reading the types:

| what was wrong | how it surfaced |
|---|---|
| `oraclePayload` missing the decoded price band | `Cannot convert undefined to a BigInt`, thrown inside `oraclePrices` |
| flat `resources` instead of nested `resources.app_ids` | `v2MathAppId is required for CVA mark_market resource carrier` — an error about the carrier, caused by the resource map |
| hand-mapped `gm2:` words instead of `parseV2CvaMarketAllocationState` | every withdrawal refused `withdraw_cap` |
| partial market record instead of `marketRecord()` | silently reads as zeros |
| no `yieldRecallMode: 1` + registry | `Yield recall preparation is required` |
| a registry for the wrong market | **throws** `xALGO strategy is required for action recall` |

The third is the sharpest: the market-route check at `v2Quotes.js:578` reads
`max_withdraw_usd_per_call` with **no `> 0n` unlimited guard**, unlike the
vault-level check twenty lines above it. A missing key defaults to zero, and
zero means "refuse everything" rather than "no limit". `cvaSnapshot.ts` exists
so this assembly happens once, in one audited place.

The last one is why `registries` is keyed by market: the route and the registry
must be chosen together, and a mismatch is not a graceful no.

### 11.13 Two assertion gaps, found by real groups, affecting the trading path

Both were legitimate SDK behaviour that "every path measured so far" had hidden,
and the fix to the second touches a check the live terminal uses.

- The SDK marks a CVA deposit's storage leg with the note
  `pdex-v2-cva-deposit-storage`. `checkEveryTransaction` permitted only the
  perps linked-order note pattern, so a **correct deposit was refused**. Allowed
  as an exact string on a `pay` leg, never as a pattern.
- A CVA withdrawal moves no assets itself — both sides arrive by inner transfer
  — so there is no `axfer` leg to put USDC into `checkMathCarriers`'s allowed
  set, and a real carrier naming USDC was refused. `collateralAssetId` is now
  passed in. `checkEveryTransaction` already permitted USDC on every call, so
  withholding it from the carriers was an inconsistency rather than a control.

Regression-checked: 705 hermetic tests and all live pool tests pass, including
the real-bytes perps open and close assertions.

### 11.14 Withdrawals are denominated in dollars, not share percentages

A product decision, taken 2026-10-22, and deliberately different from the pools.

The pools use a share-percentage slider because nothing about them is
denominated in dollars. **Every** constraint on the C-Vault is: a $5 withdrawal
floor, 0.2% entry and exit spreads, per-call caps in USD. A percentage slider
would make the floor a surprise exactly at the low end where it bites.

So: dollars primary, `MAX` for a full exit, and the share count shown
underneath — because shares are what actually gets signed and the dollar figure
is approximate, since NAV moves between the quote and the signature. The receipt
afterwards is the chain's own number.

### 11.15 There is no withdrawal cap, and no penalty

Both claims in earlier revisions were wrong.

**No cap.** §11 previously recorded `split_cva_withdrawal_required` as a live
constraint and a product decision was raised about capping withdrawals. That
failure only ever appeared while the snapshot was incomplete — with both routes
ineligible, "split required" is the planner saying no single route works. With
the snapshot correct, a sweep plans a holder's **entire $757 position** in one
group against a $1,640 vault:

```
$   6   m1 OK   m2 OK          $ 250   m1 OK   m2 OK
$  25   m1 OK   m2 OK          $ 500   m1 OK   m2 not eligible
$ 100   m1 OK   m2 OK          $ 757   m1 OK   m2 not eligible
```

A single market allocation does have a ceiling, so a large exit needs a market
big enough for it — the planner picks one, which is why this needs no product
decision either.

**No penalty.** All 27 vault globals enumerated: there is no early-withdrawal
penalty, lockup tier, or fee that varies with holding period. The three costs
are the 0.2% burn spread (flat, whether held an hour or a year), the ~56 minute
cool-down after a *deposit*, and the $5 minimum. The cool-down is the only thing
that stops a withdrawal being instant, and only in the hour after funds go in.

### 11.16 First real signature

`/strategy`'s first real money, 2026-10-22 03:32:39 UTC: **$5.00 into ALGO/USD**
by a first-time depositor. Confirmed on chain — a new `ml2:` box (the tenth),
4.278512 shares, and the 26,500 µALGO MBR paid, which is the §11.10 fix
validated in production rather than in simulation.

Five of the six paths still have no real signature. That, and not any remaining
capability gap, is why `/strategy` is out of the nav.

### 11.17 Still open

- **Real signatures.** One of six paths has one (§11.16). That is the gap that
  keeps `/strategy` out of the nav, not any missing capability.
- **Fixtures and mutation tests for the C-Vault.** The pools have real-bytes
  mutation tests; the vault has live tests and mounted component tests but no
  captured fixture yet.
- **A first-time C-Vault depositor**, live. The constant is pinned and the
  branch is tested, but no wallet without a `gu2:` box has been simulated
  through it — which is precisely the shape §11.10 says to check.
- `signAndSubmit` lives in `submit.ts` and is used by the liquidity paths only;
  `perpsClient.ts` still has its own copy. Rewiring the live trading submit path
  for a hidden feature was the riskier choice, so the trading path should adopt
  it next time it is touched. The duplication is real.
- **Not a gap, recorded so it is not re-litigated:** no `Pool` interface is
  extracted. Two implementations share their gates and their discipline, not
  their shape — see ARCHITECTURE.md, "What the C-Vault proved about the seam".
