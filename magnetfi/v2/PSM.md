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

All admin methods must include as their **first assertion**: `Assert Txn.sender == Global.creator_address`

**`deposit_usdc(amount)`** — atomic group: AppCall + AssetTransfer (USDC)
1. Assert `Txn.sender == Global.creator_address`
2. Assert AssetTransfer ASA ID = `usdc_asa_id`, receiver = PSM address, amount > 0
3. USDC lands in PSM; vault ceiling grows by `amount`; no further action required
4. `flat_fee=true, fee=1000`

**`withdraw_usdc(amount)`** — AppCall only
1. Assert `Txn.sender == Global.creator_address`
2. Assert `amount > 0`
3. Assert `psm_usdc_balance ≥ circulating_musd + amount` — rewritten to avoid uint64 underflow; equivalent to "cannot reduce below outstanding mUSD"
4. Inner transaction: transfer `amount` USDC to admin wallet
5. `flat_fee=true, fee=2000`

**`set_redeem_fee(fee_bps)`** — AppCall only
1. Assert `Txn.sender == Global.creator_address`
2. Assert `fee_bps ≤ 500` (max 5% on-chain cap)
3. Update `redeem_fee_bps`; takes effect on next redemption

**`set_treasury(address)`** — AppCall only
1. Assert `Txn.sender == Global.creator_address`
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

**PSM USDC is non-yielding:** USDC held in PSM earns nothing passively. Revenue comes only from redemption fees routed to treasury. Future versions could deploy idle PSM USDC into low-risk yield strategies — not v2 scope.

**Single vault contract:** `issue_musd()` and `receive_musd()` are gated to one registered vault app ID. If a second vault contract is deployed, `set_vault_contract()` would need to extend to a list.

**Redemption fee is admin-adjustable:** 1% is the starting fee. Admin can reduce to 0% during bootstrapping to minimize friction, or adjust upward. On-chain cap of 5% prevents the fee from becoming a peg-maintenance barrier.
