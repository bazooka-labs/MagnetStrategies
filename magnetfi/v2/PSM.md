# MagnetFi v2 — Peg Stability Module (PSM)

## What Is the PSM?

The Peg Stability Module is a protocol-owned fixed-rate swap contract and the primary user-facing mUSD product. It allows anyone to mint mUSD by depositing USDC at 1:1 with no fee, and to redeem mUSD for USDC at 1:1 with a 1% fee. The PSM is not an AMM — there is no price curve, no slippage, no liquidity provider relationship.

The PSM is exposed as a first-class feature on the MagnetFi interface: users can mint mUSD directly without depositing any collateral or opening a vault. This serves holders who want mUSD for use in other Bazooka Labs products.

The PSM serves two purposes:
1. **Peg enforcement** — provides a guaranteed redemption venue that anchors mUSD to USDC
2. **Capital base** — its USDC balance defines the maximum mUSD that can exist in circulation

---

## Asymmetric Fee Model

| Direction | Fee | Rationale |
|---|---|---|
| USDC → mUSD (Mint) | 0% | Friction-free entry encourages mUSD adoption |
| mUSD → USDC (Redeem) | 1% → treasury | Protocol earns on exits; peg maintenance funded |

**Mint (USDC → mUSD):** user sends X USDC, receives X mUSD. Full 1:1 conversion. No fee.

**Redeem (mUSD → USDC):** user sends X mUSD, receives 0.99 × X USDC. 1% goes directly to treasury wallet via inner transaction.

The asymmetric fee creates a natural incentive to hold mUSD. Acquiring mUSD is free; exiting costs 1%. This supports the peg from below — sustained discount on a DEX triggers arbitrage (buy cheap mUSD, redeem via PSM at ~1:1), which pushes prices back up.

---

## Core Mechanics

### Mint: USDC → mUSD (0% fee)

```
musd_received = usdc_sent   [exact 1:1, no fee]
```

- User sends X USDC to PSM
- PSM sends X mUSD to user from its reserve
- PSM USDC balance: +X
- Circulating mUSD: +X
- Vault ceiling: unchanged (PSM USDC and circulating both increase by X)

**Invariant after mint:** `(circ + X) ≤ (usdc + X)` — if invariant held before, it holds after. Mint can never break the invariant.

### Redeem: mUSD → USDC (1% fee to treasury)

```
usdc_received  = floor(musd_sent × 9_900 / 10_000)
treasury_fee   = musd_sent − usdc_received   [sent to treasury wallet]
```

- User sends X mUSD to PSM
- PSM sends 0.99 × X USDC to user
- PSM sends 0.01 × X USDC to treasury wallet
- PSM USDC balance: −X (0.99X to user + 0.01X to treasury)
- Circulating mUSD: −X
- Vault ceiling: unchanged (PSM USDC and circulating both decrease by X)

**Invariant after redeem:** `(circ − X) ≤ (usdc − X)` — both sides decrease equally, invariant maintained.

---

## Vault Ceiling

The vault ceiling is the maximum mUSD that all vaults combined can mint:

```
vault_ceiling = psm.usdc_balance − circulating_musd
```

**What changes the vault ceiling:**

| Event | Vault Ceiling |
|---|---|
| Admin deposits USDC into PSM | +deposit amount |
| Vault borrows mUSD (minting) | −borrow amount |
| Vault repays mUSD (returned to PSM) | +repayment amount |
| PSM mint swap (USDC → mUSD) | unchanged (both sides +X) |
| PSM redeem swap (mUSD → USDC) | unchanged (both sides −X) |

PSM swaps are self-balancing — they never affect the vault ceiling. The ceiling is controlled exclusively by admin USDC deposits and vault borrow/repay activity.

**When vault ceiling = 0:** no new vault minting is possible. Existing vaults continue normally. Ceiling recovers as borrowers repay mUSD (returned to PSM reserve, circulating drops, ceiling grows). Admin can also grow ceiling by depositing more USDC.

---

## PSM Global State

| Key | Type | Description |
|---|---|---|
| `musd_asa_id` | uint64 | mUSD ASA ID (set at deployment) |
| `usdc_asa_id` | uint64 | USDC ASA ID (set at deployment) |
| `redeem_fee_bps` | uint64 | Fee on mUSD → USDC redemptions; default 100 (1%) |
| `treasury_address` | bytes | Destination for redemption fees |
| `vault_app_id` | uint64 | Registered vault contract authorized to call issue/receive |
| `admin` | account | Hot admin key (mutable via 2-step rotation); initialized to deployer |
| `guardian` | account | Cold guardian key (pause/veto/recovery) |
| `pending_admin` | account | Proposed admin awaiting `accept_admin()` (zero when none) |
| `pending_guardian` | account | Proposed guardian awaiting `accept_guardian()` (zero when none) |
| `paused` | uint64 | 1 = public `mint_musd` halted; 0 = active |
| `pending_vault_app_id` | uint64 | Queued vault app id awaiting timelock confirmation (0 when none) |
| `pending_vault_eta` | uint64 | Unix timestamp after which the queued vault-contract change may be confirmed |

The PSM's USDC and mUSD balances are read from the contract account's actual ASA balances — no separate counters. This prevents any drift between tracked and actual balances.

### Two-Role Admin Model

Admin-gated methods assert `Txn.sender == admin` (the stored hot key). The **guardian** (cold key) can `pause()` (either role) / `unpause()` (guardian only), `cancel_pending_vault_contract()` (admin or guardian), and `propose_admin()` (recovery). 2-step rotation via `propose_admin`/`accept_admin` and `propose_guardian`/`accept_guardian`. `deploy(musd_asa_id, usdc_asa_id, guardian)` sets admin = deployer and guardian = the passed address. Withdrawn USDC routes to the current `admin`.

---

## PSM Methods

### Caller Verification Note

For `issue_musd()` and `receive_musd()`, the "caller" is the **app address** of the vault contract — not a human wallet and not the app ID integer. In Algorand, when contract A calls contract B via inner transaction, `Txn.sender` at B's execution is `A`'s escrow address (a 32-byte public key derived from the app ID). The assertion must be:

```
Assert Txn.sender == AppParam.address(vault_app_id).value
```

Not `Txn.sender == vault_app_id` — that compares an address to a uint64, which is a type error and will never match.

---

### Public Methods (anyone)

**`mint_musd(amount)`** — atomic group: AppCall + AssetTransfer (USDC)
1. Assert AssetTransfer ASA ID = `usdc_asa_id`, receiver = PSM address, amount > 0
2. Assert `psm_musd_balance ≥ amount` — PSM must have mUSD reserve sufficient to issue
3. Inner transaction: transfer `amount` mUSD to caller
4. `flat_fee=true, fee=2000`

**Note on ceiling:** PSM mint is self-balancing — USDC and circulating mUSD increase by the same amount; the vault ceiling is unchanged. No ceiling check is needed here. The meaningful guard (step 2) is that PSM has mUSD reserve to give; the previous step 2 (`circulating + amount ≤ usdc + amount`) was a tautology that simplified to the pre-existing invariant.

**`redeem_musd(amount)`** — atomic group: AppCall + AssetTransfer (mUSD)
1. Assert AssetTransfer ASA ID = `musd_asa_id`, receiver = PSM address, amount > 0
2. Assert `treasury_address != ZeroAddress`
3. Compute `usdc_out = floor(amount × (10_000 − redeem_fee_bps) / 10_000)`
4. Compute `fee_out = amount − usdc_out`
5. Assert `usdc_out > 0` — dust guard (fails for amount < 2 at 1% fee)
6. Assert `psm_usdc_balance ≥ amount` — PSM must cover full USDC outflow (user + treasury)
7. Inner transaction 1: transfer `usdc_out` USDC to caller
8. **If `fee_out > 0`:** Inner transaction 2: transfer `fee_out` USDC to `treasury_address` — skipped when `redeem_fee_bps = 0` to avoid zero-amount ASA transfer rejection
9. `flat_fee=true, fee=3000` if fee_out > 0, else `fee=2000`

**`issue_musd(recipient, amount)`** — vault contract only (cross-app inner transaction)
1. Assert `amount > 0`
2. Assert `Txn.sender == AppParam.address(vault_app_id).value` — vault app address only
3. Assert `circulating_musd + amount ≤ psm_usdc_balance` — ceiling invariant check
4. Inner transaction: transfer `amount` mUSD to recipient
5. `flat_fee=true, fee=2000`

**`receive_musd(amount)`** — vault contract only; called when mUSD is returned to reserve
1. Assert `amount > 0`
2. Assert `Txn.sender == AppParam.address(vault_app_id).value` — vault app address only; security comes from this check: only the registered, audited vault contract can declare mUSD returned to PSM
3. PSM mUSD balance increases by `amount`; circulating mUSD decreases by `amount`; vault ceiling grows by `amount`
4. No output — state update only; `flat_fee=true, fee=1000`

**Why no AssetTransfer assertion:** mUSD physically reaches PSM through two different paths depending on which vault method calls receive_musd. In `repay_principal()` and `settle_health_liquidation()`, mUSD arrives via an outer group AssetTransfer (user/admin → PSM) that the vault verifies at its level. In `pay_interest()` overpayment, mUSD arrives via a vault-issued inner AssetTransfer (vault → PSM) submitted as a sibling to the receive_musd call. Algorand's Gtxn always refers to the OUTER transaction group, so a Gtxn assertion in receive_musd would catch case 1 but always fail in case 2. Security relies on the vault app address check (only the vault can call this) and the physical token flow (mUSD must arrive at PSM for PSM's ASA balance to increase, which is what any caller reading circulating supply observes).

### Admin Methods (admin wallet only)

All admin methods must include as their **first assertion**: `Assert Txn.sender == admin`

**`deposit_usdc(amount)`** — atomic group: AppCall + AssetTransfer (USDC)
1. Assert `Txn.sender == admin`
2. Assert AssetTransfer ASA ID = `usdc_asa_id`, receiver = PSM address, amount > 0
3. USDC lands in PSM; vault ceiling grows by `amount`; no further action required
4. `flat_fee=true, fee=1000`

**`withdraw_usdc(amount)`** — AppCall only
1. Assert `Txn.sender == admin`
2. Assert `amount > 0`
3. Assert `psm_usdc_balance ≥ circulating_musd + amount` — rewritten to avoid uint64 underflow; equivalent to "cannot reduce below outstanding mUSD"
4. Inner transaction: transfer `amount` USDC to admin wallet
5. `flat_fee=true, fee=2000`

**`set_redeem_fee(fee_bps)`** — AppCall only
1. Assert `Txn.sender == admin`
2. Assert `fee_bps ≤ 500` (max 5% on-chain cap)
3. Update `redeem_fee_bps`; takes effect on next redemption

**`set_treasury(address)`** — AppCall only
1. Assert `Txn.sender == admin`
2. Assert `address != ZeroAddress`
3. Update `treasury_address`

**Vault-contract registration (timelocked — replaces the old instant `set_vault_contract`)**

Registering the wrong vault would authorize an attacker contract to mint mUSD, so this is a **48h timelock with guardian veto** (P19-03 / P19-10):
- **`propose_vault_contract(vault_app_id)`** — admin only; asserts `!= 0`; stores `pending_vault_app_id` + `pending_vault_eta = now + 48h`.
- **`confirm_vault_contract()`** — admin only; asserts pending exists and `now >= eta`; applies and clears.
- **`cancel_pending_vault_contract()`** — admin **or guardian** (the veto).

At genesis this 48h window is unavoidable — plan it into the launch timeline (see ADMIN.md deployment procedure).

**`pause()` / `unpause()`**
- `pause()` (admin or guardian) sets `paused = 1`, halting public `mint_musd`. Redeem, issue, and receive stay open — users and the vault can always exit.
- `unpause()` (guardian only) clears it — a compromised hot key cannot lift a guardian lockdown.

---

## Revenue Model

PSM revenue is simple and direct: every mUSD redemption sends 1% of the USDC paid out to the treasury wallet in the same transaction. No manual sweep required.

| Revenue source | Amount | Destination |
|---|---|---|
| mUSD → USDC redemption fee | 1% of USDC paid | Treasury wallet (automatic) |

The 1% fee leaves the PSM immediately — it does not accumulate in PSM reserves. PSM USDC only grows through admin deposits. This keeps the PSM's role clear: it is a liquidity facility, not a yield-generating contract.

---

## Self-Balancing Property

PSM swaps never change the vault ceiling. This is an important operational property:

- Users freely mint and redeem mUSD through the PSM without affecting vault borrowing capacity
- Vault ceiling is determined solely by admin decisions (deposit size) and borrower activity (repayments)
- The admin does not need to monitor or react to PSM swap volume to maintain peg or ceiling integrity

The only scenario requiring admin attention is growing the vault ceiling intentionally — a deliberate business decision, not reactive maintenance.

---

## What the PSM Is Not

- **Not an AMM** — no price curve, no slippage, no impermanent loss
- **Not open to external liquidity providers** — all reserves are protocol-owned
- **Not a fee-compounding reserve** — fees go to treasury; PSM grows only through admin deposits
- **Not a CDP** — PSM does not mint mUSD against deposits; vault contract handles collateralized minting separately

---

## Known Assumptions

**USDC stability:** mUSD is pegged to USDC. A severe USDC de-peg propagates to mUSD proportionally. Accepted assumption shared by the majority of DeFi protocols.

**PSM USDC yield:** the v2 *core* PSM holds USDC idle (revenue only from redemption fees). The **launch build (v3)** adds **productive reserves** — deploying idle reserves into low-risk on-chain yield via vetted adapters (Folks first) while keeping mUSD fully redeemable — see **[Productive Reserves (v3)](#productive-reserves-v3)** below.

**Single vault contract:** `issue_musd()` and `receive_musd()` are gated to one registered vault app ID (set via the timelocked `propose_vault_contract`/`confirm_vault_contract` flow). If a second vault contract is deployed, the registration would need to extend to a list.

**Redemption fee is admin-adjustable:** 1% is the starting fee. Admin can reduce to 0% during bootstrapping to minimize friction, or adjust upward. On-chain cap of 5% prevents the fee from becoming a peg-maintenance barrier.

---

## Productive Reserves (v3)

> **Status: DESIGN — building before mainnet, not yet implemented.** This is the launch architecture (v3 = the v2 core + a yield-bearing PSM). It is documented here as the authoritative spec to build and audit against. Nothing in this section is live.

The PSM's USDC reserve is idle capital. Putting the portion that isn't actively being redeemed to work — earning low-risk on-chain yield — is what makes issuing our own stablecoin *economically* worthwhile (otherwise mUSD ≈ direct USDC lending + a ~1% swap fee, which doesn't justify the added contracts + regulatory surface). This is deliberately built **before** launch, not retrofitted, for a hard structural reason (below).

### Why this is built into v3, not added later
The v2 contracts are **immutable** (no `UpdateApplication` path — correct for a reserve contract) and the reserve backing circulating mUSD is **locked** (`withdraw_usdc` is capped at the excess above circulating). Combined with **interest-only, no-maturity loans** (no forced repayment — a healthy borrower can hold a position open indefinitely), there is **no clean way to migrate the reserve to new contracts after launch**: you'd be at the mercy of borrowers repaying, an open-ended wind-down. Therefore the yield capability must exist from the first mainnet deploy. (This is the whole reason the mainnet rollout was paused.)

### The non-negotiable principle
Any yield strategy must preserve both, or it doesn't ship:
1. **Instant 1:1 redeemability** — a redemption can never fail for lack of liquidity.
2. **The core invariant** — `circulating mUSD ≤ recoverable reserve value` at all times.

Reserve mismanagement is the most common way stablecoins die. The yield is a *bonus on top*, never load-bearing for the peg.

### What backs mUSD (unchanged in substance)
mUSD stays **USDC-backed** — the reserve just exists in two forms, both counted: idle **USDC** + the **recoverable value of deployed positions** (e.g. Folks `fUSDC`). LP collateral is *not* mUSD's backing — it secures the loans (borrower repayment) and is returned to borrowers; it protects the reserve, it doesn't back the dollar. Public wording: *"backed by USDC reserves, a portion of which may be deployed into low-risk on-chain lending while remaining fully redeemable."* Keep it **USDC-backed**, not "collateral-backed."

### Economic rationale — capital does double duty
Because a vault borrow issues mUSD **without removing USDC** from the PSM, the reserve backing borrowed mUSD sits idle in the PSM and can be deployed for yield **while it backs the circulating mUSD**. So the same seeded capital earns **loan interest (~8%) + reserve yield (~5–10%) simultaneously** — even with zero public adoption. This is the bank/Circle model (earn on reserves while they back redeemable liabilities), done on-chain and provably. Stacked returns come with stacked risk (venue + borrower default on the same base), which is why deployment stays fractional and diversified.

---

### Architecture — adapter pattern (PSM ↔ vetted adapters)

The PSM **never makes arbitrary external calls.** Venue-specific logic lives in small, immutable, separately-audited **adapter contracts**; the PSM talks to them through one fixed, minimal interface.

- **PSM core (immutable, venue-agnostic):** knows only `deposit(amount)`, `withdraw(amount)`, `recoverable_value()`. Holds a **whitelist of ≤ 5 adapters**, enforces the buffer / caps / invariant, and lets the admin deploy/recall to whitelisted adapters. Never calls a non-whitelisted app.
- **Adapter (immutable, one per venue):** hardcodes exactly one venue's integration (deposit/withdraw + read exchange rate), holds that venue's receipt token (e.g. `fUSDC`), and reports its recoverable USDC value. A bad adapter can only affect funds deployed *to it*.
- **Adapter management (add / remove):** via the **existing 48h-timelock + guardian-veto** pattern (propose → wait 48h → confirm; guardian can cancel). Adding a venue = deploy a new adapter + timelock-whitelist it. Removing = recall fully, then de-whitelist. **No PSM change, no migration, ever.** This is the "manage which adapters are in the strategy portfolio" capability.
- **Hardcap: 5 adapters** — a compile-time constant. Bounds state, the invariant loop, and audit surface. Diversifying across venues (e.g. 5k Folks / 3k T-bills / 2k CompX) limits single-venue concentration; each adapter carries an on-chain exposure cap.

**Build scope: ship with ONE adapter — Folks Finance — only.** The multi-adapter framework (up to 5) is built in, but only the Folks adapter is deployed/whitelisted at launch. Others (tokenized T-bills, CompX once it has real usage/maturity) plug in later with zero core change.

### Position accounting — principal vs. yield (resolves design-review H-1)
The contract records **`deployed_principal[adapter]`** — a *receipt* of exactly how much USDC was sent to each venue (up on `deploy`, down on `recall`). This separates two things that must never be confused:
- **Principal** = reserve. It backs mUSD. On recall it returns to the PSM buffer, never distributed.
- **Yield** = `recoverable_value − deployed_principal` (when positive) = revenue. Only *this* is harvestable to treasury; it is **never counted as backing.**

**Conservative valuation** — each venue is counted in the invariant at:
```
backing_from_venueᵢ = min(deployed_principalᵢ, recoverable_valueᵢ)
```
You never count *above* what you deposited (so a venue that misreports an inflated value can't fool the peg), and you drop *below* principal the instant a venue loses value (so a loss can't be masked). Yield is a bonus you harvest, not backing you rely on.

### Reading `recoverable_value` (how a venue position is quantified)
For Folks, `recoverable_value = fUSDC_balance × Folks_deposit_index` — the adapter reads its own fUSDC balance (its ASA balance) and the pool's on-chain deposit index (USDC-per-fUSDC), referencing the Folks app. That index is a **monotonic lending rate, not an AMM spot price**, so it is **not flash-manipulable** (a stale read is slightly *low* = conservative). Concretely, because backing counts `min(deployed_principal, recoverable_value)`:
- **Normal case** (steady state): the term is `deployed_principal` — a **known constant from the receipt** — so the peg's backing does not depend on trusting a live venue mark. (Entry rounding caveat, F-3: an `fUSDC` mint rounds down, so immediately after a deposit `recoverable = principal − dust` until yield accrues past it; `min()` conservatively under-counts by that dust, which is harmless — and see the dust tolerance `ε` in *Reserve deficit* so this never crystallizes a spurious deficit.)
- The index read only serves to **detect a loss** (`recoverable < principal`) and write the backing down. Thanks to `min()`, an index read that's too *high* (bug/misreport) **cannot over-count backing** (it's capped at principal); only a too-*low* read has effect, which is safe.
- **Ground truth is confirmed on `recall`** — what actually lands back in the PSM is the real value; any shortfall crystallizes into `reserve_deficit`.
- **Caveat:** the index is Folks' *accounting* value; it could overstate withdrawable value if Folks itself is impaired (bad debt) — the residual venue risk handled by `min()` + fractional deployment + the deficit mechanism. The exact Folks app id / index state key / scaling must be **verified against Folks' live contracts** when the adapter is built — that venue-specific knowledge is *why* the adapter is its own small, separately-audited contract.

### Redefined invariant
```
circulating mUSD  ≤  on-chain USDC  +  Σ min(deployed_principalᵢ, recoverable_valueᵢ)   (i = 1..N, N ≤ 5)
```
- Checked on **new issuance** (vault borrow / PSM mint) and on **`deploy`** — the actions that could break it. The `min()` bounds how far the invariant trusts a venue's reported value.
- **Redemptions do not evaluate the sum:** a redemption pays from the on-chain buffer and lowers both `circulating` and `on-chain USDC` equally, *preserving* the inequality automatically. The bounded loop only runs on the less-frequent paths.

### Guardrails
1. **Liquidity buffer** — a minimum fraction of reserves stays as on-chain USDC, sized to expected redemption flow **and** to the venue's withdrawal liquidity (recall is *not* guaranteed instant). Start conservative: deploy only ~20–40%, keep the majority liquid.
2. **Per-venue exposure cap** — no single adapter may hold more than X% of deployed reserves (on `deployed_principal`). Diversification is a contract guarantee, not admin discipline.
3. **Total-deployed cap** — enforced as **`on-chain USDC after deploy ≥ buffer`** (i.e. `reserve` here means *on-chain USDC*, the strict reading — F-8). The buffer is a **deploy-time throttle, not a maintained floor**: `redeem_musd` doesn't check it, so the buffer bounds how much you *deploy*, it doesn't *guarantee* liquidity (consistent with the H-2 tail risk).

### Admin flows (admin-triggered; funds move escrow-to-escrow, never through the admin wallet)
- **`deploy(adapter, amount)`** — routes `amount` USDC PSM → adapter → venue; `deployed_principal[adapter] += amount`; asserts buffer/cap/invariant hold after.
- **`recall(adapter, amount)`** — withdraws USDC from the venue back into the PSM buffer (**principal → reserve**); reduces `deployed_principal`. **Admin-directed and per-venue** — the admin chooses which venue and how much; there is **no automatic multi-venue "walk-and-skip" loop** (resolves H-3: on Algorand a failed inner txn reverts the whole transaction, so "attempt-and-skip" isn't atomically possible — recall targets one chosen venue).
- **`harvest(adapter)`** — sweeps only the **yield** (`recoverable_value − deployed_principal`, if positive) to **treasury**. Separate from `recall`, so topping up the buffer never forces a yield sweep. **Self-verifying (F-1) — the one place `min()` does NOT protect us:** harvest *actually withdraws* real USDC, so a too-high venue mark would otherwise pull principal out to treasury. Therefore harvest routes only what is **actually realized** on withdrawal, and **asserts `recoverable_after ≥ deployed_principal` after the sweep** (revert otherwise). Harvest may never reduce counted backing below principal.
- **`set_treasury` hardening (F-7):** because `harvest` routes yield to `treasury_address` and `set_treasury` is not timelocked in v2, a compromised hot key could `set_treasury(attacker); harvest` (bounded to accrued yield). Consider timelocking `set_treasury`, and have the incident pause also halt `harvest`.

### Redemption liquidity (resolves H-2)
Redemptions are **buffer-primary**: `redeem_musd` pays from on-chain USDC only, and the **redeem path stays unchanged from v2** — no new inner-transaction logic on the most safety-critical method. The design relies on **conservative deployment** so the buffer realistically always covers redemption flow; the admin **operationally recalls** from a venue to top it back up when it runs low.

**Solvency vs. liquidity — the accepted tail risk:** the protocol can be fully *solvent* (backing ≥ circulating) yet temporarily *illiquid* (not enough on-chain USDC right now) if most reserves are deployed and a redemption wave drains the buffer. Then a redemption **reverts** ("insufficient liquid reserve — retry shortly") until the admin recalls — a **delay, not a loss.** This is irreducible for *any* yield-deployed reserve (even atomic recall fails if the venue itself is illiquid), so it is *bounded* — by deploying only a fraction and keeping a large buffer — not engineered away.

### Reserve deficit & venue loss (resolves M-2)
If a venue *loses* value, the design fails safe and stays transparent:
- **Paper (unrealized) loss** — the `min(principal, recoverable)` valuation immediately lowers counted backing, which **automatically blocks new issuance and new deploys** (the invariant), before any recall.
- **Realized loss — precise accounting (F-4):** on a recall of `amount`, `retired_principal = min(deployed_principal, amount)`; `deployed_principal −= retired_principal`; and `reserve_deficit += max(0, retired_principal − recovered)` — recorded **only** when the shortfall exceeds a dust tolerance `ε` (F-3), so entry rounding never crystallizes a spurious deficit. Nothing routes to treasury on a loss (never underflow). This is the "outstanding amount" the protocol owes itself to be whole.
- **`reserve_deficit` is a freeze / restoration gate — NOT a second subtraction from backing (F-4).** Backing already reflects a loss (via `min()` before recall, via reduced on-chain USDC after recall); subtracting `reserve_deficit` from the backing sum *again* would double-count the loss, understate backing, and block restoration. It only (a) freezes issuance + new deploys and (b) is the target the admin restores.
- **Impairment covers a *liquidity freeze*, not just value loss (F-6):** if a venue halts withdrawals while its index still reads healthy, `min(principal, recoverable) = principal` and nothing auto-freezes — issuance could stay open against an unrecallable position. The admin's manual **impairment mark** must therefore apply to a *withdrawal-halted* venue too (forcing the write-down + issuance freeze even when the index looks fine). "Venue withdrawals halted" is a monitoring/impairment trigger.
- **While `reserve_deficit > 0`:** issuance and new deploys stay frozen; the ops panel shows *"Reserve deficit: $X — restore to re-enable."* The counter is on-chain (public), so the app can surface a **backing ratio** ("100%" / "99.4% — restoration in progress") — transparent by default, but framed calmly (a loud "under-backed" banner can itself trigger a run).
- **Restore** — the admin deposits USDC to pay down `reserve_deficit`; at zero, full 1:1 backing is restored and issuance re-enables.
- **Redemptions stay 1:1** throughout — **no socialized haircuts** (complex, they signal weakness, and are unnecessary when deployment is conservative). Honest note: 1:1 redemptions during a deficit are first-come-first-served, which is exactly why deployment is fractional and the deficit is covered fast.
- **Honest limitation:** the contract can *track* the deficit and *freeze* issuance until it clears, but it **cannot force** the admin to deposit (no contract can conjure USDC from a wallet). "Making the PSM whole" is an **operational/reputational commitment** enforced indirectly by the issuance freeze + reputation — standard for every reserve-backed stablecoin. What keeps it safe: fractional deployment into a vetted venue makes any loss small enough to always be treasury-coverable.

### Custody note
The receipt token (`fUSDC`) is held by the **adapter contract account**, not any wallet. The PSM already has an admin-gated `opt_in_asset` (Pass 16), so ASA custody is mechanically supported; adapters opt into their own receipt ASA. Funds only ever flow PSM ↔ adapter ↔ venue — all smart-contract escrows.

### On-chain only — not custodial/off-chain
A centralized venue (e.g. a Coinbase rewards balance) is explicitly rejected: the contract can't verify off-chain balances (the invariant degrades to "trust the custodian"), it reintroduces the counterparty risk mUSD avoids (USDC itself briefly de-pegged in 2023 when reserves were stuck at a bank), and withdrawals aren't atomic. On-chain venues let the contract read the position's recoverable value and keep the invariant honest.

### Venues
- **Folks Finance USDC market — venue #1 (launch).** Most battle-tested Algorand money market; deposit USDC → `fUSDC`. Conservative, audited.
- **Tokenized T-bills / RWA** — lowest fundamental risk (Circle/Tether model) *if* a liquid, contract-custody-compatible Algorand product exists (often KYC/permissioned — verify). Aspirational venue #2.
- **CompX USDC market** (`3491050310`) — in-ecosystem, on-chain, but ~0 usage today; add only once it has real depth/maturity.
- **Deliberately excluded:** ALGO governance/consensus staking, liquid staking (tALGO), DEX LPing — all carry price/IL risk, inappropriate for a USD-denominated reserve.

### Yield routing
Yield routes to **treasury** (→ $U buybacks) or compounds into reserves. **Do NOT route yield to mUSD holders** — the GENIUS Act prohibits payment-stablecoin issuers from paying yield to holders (see the regulatory note below). Treasury/$U routing is the defensible path.

### Regulatory
A yield-earning reserve raises the regulatory stakes, not lowers them. Yield to **treasury**, never holders. This needs **legal counsel before mainnet** (entity, US-person access / geofencing, review of the yield mechanism). The v3 build window is the time to close this out in parallel.

### Method map — v3 is PSM-only (resolves design-review H-4)
v3 modifies the **PSM only**; the **Vault / LP Oracle / Liquidation contracts are untouched** (they keep their v2 audit passes). The vault points at the new v3 PSM at deploy. Fresh-audit scope = the v3 PSM + the Folks adapter.

| Method | v3 status |
|---|---|
| `redeem_musd` | **Unchanged** — its `psm_usdc_balance ≥ amount` guard *is* buffer-primary (reverts if the buffer can't cover — the accepted H-2 tail-risk) |
| `mint_musd` | **Unchanged** — self-balancing; the redefined invariant holds automatically |
| `issue_musd` | **Modified** — checks the redefined backing `on-chain USDC + Σ min(principal, recoverable)`; frozen while `reserve_deficit > 0` |
| `withdraw_usdc` | **Modified** — buffer-aware (`amount ≤ min(on-chain USDC − buffer, total_backing − circulating)`, written **underflow-safe/additive** since `on-chain − buffer` legitimately underflows once redemptions have drawn the buffer down); **also frozen while `reserve_deficit > 0`** (F-5) so reserves can't leave while under-reserved |
| `deploy` / `recall` / `harvest` | **New** — see Admin flows (principal ↔ reserve, yield ↔ treasury) |
| `propose/confirm/cancel_adapter` | **New** — ≤5-adapter whitelist via the existing 48h timelock + guardian veto |
| `restore` (+ `reserve_deficit`, `deployed_principal`) | **New** — deficit accounting + position receipts |

**Compute nuance:** at launch (Folks-only, one adapter) `issue_musd` reads the one venue live — trivial. At 5 adapters the hot path may cache PSM-internal state, but the cache **must never present a stale-*high* mark (F-2)** — otherwise a paper loss between updates would be counted at full principal, re-opening the over-issuance hole `min()` closes. Safe forms: cache only the constant `deployed_principal` and still read each venue's `recoverable` live for the `min()` (the index read is the cheap part), *or* require `issue_musd` to revert if any adapter's mark is older than a max-staleness (with a permissionless `revalue`). Scale-time item, not a launch blocker.

### Build + audit sequencing
v3 (Folks adapter + the redefined invariant + buffer/caps + recall path + adapter-whitelist timelock) is **meaningful new attack surface on the contract that holds the reserve** and requires its own **dedicated fresh audit** — not a re-run of the v2 passes. The redefined invariant is the highest-risk change (it changes what backs the dollar), so it gets the most scrutiny. Launch posture is otherwise unchanged: small ceiling, conservative deployment fraction, Folks-only.
