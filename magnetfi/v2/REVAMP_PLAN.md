# MagnetFi Revamp — Sequenced Plan

_Written 2026-10-10. Supersedes the ordering in [TODO.md](./TODO.md) "Path forward
— agreed 2026-10-07", which put ALGO/USDC before the rebuild. The measurements
below are why that order changed._

Three goals, in the operator's words:

1. Reconfigure the over-the-top defences causing frequent protocol halts.
2. Add ALGO/USDC and U/ALGO collateral vaults.
3. Reconfigure the U/USDC and U/tALGO interest rates.

## Why these are one project and not three

**There is exactly one expensive move available, and everything should ride in
it.** v4 is a *vault* contract change, and the vault is the only piece with no
repointing path — the oracle swaps via `propose_lp_oracle`, the vault does not
(`LP_ORACLE.md` → Migration note). A new vault means:

- the PSM must be repointed: `propose_vault_contract` → **48h timelock** →
  `confirm_vault_contract` (`psm/contract.py:388-400`, `TIMELOCK_DELAY = 172_800`)
- every open position must be closed on the old vault and reopened on the new one
- every pool must be re-registered: 1 oracle call + 5 vault calls each

So registering ALGO/USDC and U/ALGO *before* the migration means registering them
**twice**, and — more importantly — inviting borrowers onto a vault they will have
to leave.

### Measurements taken 2026-10-10 that drive the ordering

| | value | consequence |
|---|---|---|
| PSM USDC reserve | **$151.40** | caps everything below |
| circulating mUSD | **$100.04** | |
| `vault_ceiling` = reserve − circulating | **$51.37** | total *additional* borrow capacity, all pools |
| open positions | **3**, across **2 borrower addresses** (neither is the admin key) | migration is a 2-person conversation today |
| vault collateral held | 2,000 U/tALGO LP + 400 U/USDC LP | |

**The $51 ceiling is the hinge.** Listing ALGO/USDC today opens it to fifty-one
dollars of borrowing, so it cannot produce the demand evidence TODO item 7 waits
on. The goal "prove ALGO/USDC interest" is gated by the *reserve*, not by the
collateral list — and funding the reserve while the halts persist and liquidation
is manual is the combination to avoid.

Note what is *not* a reason to wait: migration cost is bounded by construction,
since `circulating mUSD ≤ psm_usdc` caps total extraction regardless of how much
collateral is listed. The risk is not a runaway book. It is spending the one
cheap migration window on state that gets rebuilt.

---

## Phase 0 — Now. End the halt class without touching a contract

Every halt to date came from the bot's own absolute constants, not from the
chain. v4 deletes them, but v4 is weeks away and the halts are weekly.

- [ ] **0.1 — Derive `min_price`/`max_price` from the on-chain anchor at startup.**
      Read `lp_anchor_<pool_id>` from the oracle; set bounds to `anchor × 0.76`
      and `× 1.24`. This is TODO item 2, and it is the single highest-value
      change in Phase 0: it ends the failure class where bot bounds and the
      contract band disagree. Both the 2026-10-09 freeze (`max_price` 900,000
      blocking a legitimate rise while the band had 21% of room) and the
      ALGO/USDC bounds defect found 2026-10-10 (`max_price` 2,858 *above* the
      band ceiling) were this bug in opposite directions.
- [ ] **0.2 — Derive or drop `asset_price_bounds`.** Same failure with a longer
      fuse: ALGO carried a $0.50 ceiling against a $0.119 price. Either derive
      from the CompX reading or delete and lean on the CompX divergence check,
      which is the real protection.
- [ ] **0.3 — Fix the `notify()` crash path.** Found in the 2026-10-10 pre-push
      review and confirmed by running it: `Request(...)` is built outside the
      `try`, so a schemeless `ALERT_WEBHOOK_URL` raises `ValueError` instead of
      logging. The `notify()` call sites in `run_once` sit *outside* the
      `try/except` guarding `update_pool`, so the **first staleness alert would
      kill the loop** — exactly when the feed is already struggling. Unreachable
      while the URL is unset; arms the moment one is pasted. Two lines: move the
      `Request` inside the `try`, and bring `watch.check` /
      `check_algo_against_pex` / `heartbeat` under the existing handler.
- [ ] **0.4 — Add ALGO/USDC to the bot config.** Already registered in the
      oracle (anchor `1149714`, set 2026-10-10). Costs ~$0.03/day and proves
      sustained operation on the largest pool ($1.72M TVL) — the plumbing v4
      must keep working. **No vault-side calls**, so no borrowing is possible.
      Band translation worth knowing: ALGO/USDC LP tracks `sqrt(P_ALGO)`, so
      ±25% ≈ ALGO between **$0.065 and $0.181** (today $0.1158).
- [ ] **0.5 — Rates, optional now.** Two calls, and rates are **locked at open**
      so only new vaults are affected. Free either way; do it if a vault might
      be opened before the migration.

**Gate out of Phase 0:** two full weeks with no halt that the bot caused.

---

## Phase 1 — Decide the lender-side shape. No code.

This blocks Phase 2 because it is *also* a vault change, and both must ride the
same migration (TODO item 6). Four questions, all of which change the contract:

- [ ] **1.1** Subordination of depositors to mUSD holders — explicit, or implied
      by the PSM invariant?
- [ ] **1.2** Share accounting — rebasing balance, or share price?
- [ ] **1.3** How an impaired adapter socialises losses across depositors.
- [ ] **1.4** Does liquidation become permissionless? (A tripwire already
      requires this be decided deliberately rather than by default.)

**Borrower growth is migration-cheap; lender shares are the weld.** A borrower
repays and reopens. A lender owed accrued interest cannot be casually moved. If
lender-side is genuinely far off, the fallback is to ship v4 alone and accept a
second migration later — but decide that explicitly, here, not by drift.

---

## Phase 2 — Build v4

Design is settled in
[LP_ORACLE.md → v4](./LP_ORACLE.md#v4--signed-payloads-decided-2026-10-07-not-yet-built).
Build order puts the signer first so the vault has something real to verify.

- [ ] **2.1 — Signer service.** TWAP smoothing and the CompX cross-check **stay**
      — they catch bugs, which key custody does not, and signing a *spot* price
      on a pool as thin as U/tALGO is the one genuinely catastrophic thing that
      could be dropped. Signs `{pool_id, price, expiry}`, pushes to object
      storage, no inbound connections. Signer key separate from the cold admin
      key, holding only fee ALGO. Model: PEX's own R2 bucket, whose verification
      path this org already reads in `oracle_bot.py:read_pex_algo_price`.
- [ ] **2.2 — Vault contract.** Add: verify signature; payload expiry (~20s);
      `price > 0` (a zero permanently bricks a pool, AUD-042); pool whitelist.
      Remove: posted-price read, `lp_ts_` freshness, anchor band, ±50%-vs-prior,
      `set_price_anchor`. **Expiry is replay protection and is not about our key**
      — a signed payload is public the moment it is used, so anyone can keep one
      from a spike and replay it.
- [ ] **2.3 — Frontend.** Fetch the payload and attach it to the user's
      transaction group. Every borrow, repay and liquidation path.
- [ ] **2.4 — Tests.** Extend `contracts/tests/` (67) and `oracle_bot/tests/`
      (80). New adversarial cases: expired payload, payload for the wrong pool,
      wrong signer, `price = 0`, replay of a spike payload.
- [ ] **2.5 — Review gate.** Spec → fresh adversarial review agent (breakage +
      attack vectors) → only then deploy. Standing rule for this protocol.
- [ ] **2.6 — Reproducible build.** Match deployed bytecode byte-for-byte to the
      puyapy build, as was done for vault `3671287267`.

---

## Phase 3 — The one migration

**Goals 2 and 3 land here, at no extra cost.** Registering four pools on a fresh
vault is the same work as registering two, and the rate changes are just the
`set_rate` values chosen during registration.

- [ ] **3.1** Deploy the new vault (reproducible build verified).
- [ ] **3.2** `propose_vault_contract(<new vault>)` on the PSM. **Start the 48h
      clock early** and do the rest of the work inside the window.
- [ ] **3.3** Wind down the 3 open positions. Two borrower addresses —
      `DINKXOOJ…` (2 positions) and `WTG2WWFY…` (1) — neither is the admin key,
      so this needs contacting them. Each repays via `pay_interest` and closes;
      LP and the refundable `46,500 µALGO` MBR return to them.
- [ ] **3.4** `confirm_vault_contract()` after the timelock.
- [ ] **3.5** Register all four pools. **Threshold before LTV** — `set_ltv`
      asserts `liq != 0` (`vault/contract.py:936`). Threshold is capped at
      **7500**, firmly: the on-chain assert permits 9000 for backward
      compatibility, but seize percentages are calibrated only for 75% and above
      it partial-liquidation health restoration breaks *silently* (M1).

      | pool | pool_id | LTV | liq | rate | note |
      |---|---|---|---|---|---|
      | U/tALGO | 3163770927 | 6000 | 7500 | **1000** | 8% → 10% |
      | U/USDC | 3673941603 | 6500 | 7500 | **600** | 5% → 6% |
      | ALGO/USDC | 1002590888 | 6500 | 7500 | **800** | new |
      | U/ALGO | 3617313492 | 6000 | 7500 | **800** | new; LP ASA is `3617313492`, **not** `3073502995` — a different token also ticking "U" |

      Per pool, in order: `add_pool` (oracle) → `set_lp_asa_id` →
      `set_liq_threshold` → `set_ltv` → `set_rate` → `opt_in_asset`.
      `add_pool` price is entered in **human units** in the Admin UI, which
      multiplies by 1e6 itself (`OperationsPanel.tsx:142`). Read each price fresh
      immediately before the call.
- [ ] **3.6** Pause and retire the old vault `3671287267`.
- [ ] **3.7** Frontend: `POOL_WIRING.mainnet` gains `algo-usdc` and `u-algo`;
      `DEPLOYMENTS.mainnet` gains the new vault id.
- [ ] **3.8** Canary each new pool: open → borrow → close, reconciled on-chain,
      as was done for U/USDC on 2026-08-19.

---

## Phase 4 — Liquidation bot

After Phase 3, **not before** (TODO item 5). Built against today's band it would
be frozen out in most of the cases it exists for: the band locks at −25% while
live borrowers only become liquidatable at −53%, so the freeze is *guaranteed* to
precede the need. v4 removes the band, which is what makes a liquidation bot able
to act at all.

- [ ] **4.1** Health monitor across all open boxes, every payload refresh.
- [ ] **4.2** Execution against the three `trigger_*_liquidation` paths.
- [ ] **4.3** Prove it on a deliberately underwater canary position.

---

## Phase 5 — Reserve, then the demand test

Only now does goal 2 become measurable.

- [ ] **5.1** Fund the PSM reserve from own capital. This raises `vault_ceiling`
      and is *not* gated by the public-deposit tripwire.
- [ ] **5.2** Measure ALGO/USDC borrow demand — the evidence TODO item 7 waits
      on. The pool is $1.72M; 10% captured is ~$172k collateral and ~$103k of
      borrow demand.
- [ ] **5.3** Public PSM deposits remain **pinned** behind the tripwires in
      TODO.md. Before a single third-party deposit, re-answer the key-compromise
      question: v4 accepts that risk because loss is capped at the PSM reserve
      *and the reserve is the founder's own money*. Outside deposits end both
      halves, and the **upward rate limit** in LP_ORACLE.md → Designs considered
      and rejected is the design to reach for first.

---

## What this plan deliberately does not do

- **Does not list ALGO/USDC or U/ALGO for borrowing before Phase 3.** The test it
  would enable is capped at $51, and it spends the cheap migration window.
- **Does not build the liquidation bot before v4.** It would be frozen out in
  the cases it exists for.
- **Does not drop TWAP or the CompX cross-check.** Those catch bugs. Only a
  stolen key bypasses our code, and that is the accepted risk.
- **Does not fund the reserve before liquidation works.** Supply without the
  ability to liquidate is the combination the whole plan is sequenced to avoid.

## The one honest alternative

If waiting weeks for ALGO/USDC is unacceptable, the coherent version is: fund the
reserve, register ALGO/USDC on the *current* vault, accept that those borrowers
must close at Phase 3, and accept running it on a protocol that still halts.
That costs ~12 extra hardware-wallet calls and one borrower migration
conversation per position opened. It is defensible at today's scale and gets
worse every week — which is precisely what "the window closes as positions
accumulate" means. Choose it deliberately if at all.
