# MagnetFi v2 — mUSD

## What Is mUSD?

mUSD is an Algorand-native stablecoin issued by the MagnetFi v2 protocol. It is pegged to USDC at 1:1. Borrowers receive mUSD when they draw against their LP vault collateral. mUSD can be redeemed for USDC at any time via the Peg Stability Module at a fixed rate.

mUSD is not an algorithmic stablecoin. Every mUSD in circulation is backed by at least 1 USDC held in PSM reserves. The peg is enforced by contract — the vault cannot mint more mUSD than the PSM holds in USDC.

---

## Core Invariant

> **Circulating mUSD ≤ PSM USDC reserves at all times.**

"Circulating mUSD" = total mUSD supply minus the mUSD held by the PSM contract (unissued reserve).

This invariant is enforced at the contract level:
- The vault delegates the ceiling check to `PSM.issue_musd` (the vault itself only checks LTV) — so the invariant has a single on-chain enforcement point
- The PSM checks this guard before issuing mUSD to vault users
- The admin cannot withdraw PSM USDC below circulating mUSD

The peg is mathematically guaranteed as long as the PSM holds sufficient USDC. There is no algorithmic mechanism that can fail — it is a bookkeeping constraint.

**Under Productive Reserves (v3):** the reserve exists in two forms and the invariant counts both —
> **Circulating mUSD ≤ on-chain USDC + Σ recoverable value of deployed strategy positions.**

mUSD remains **USDC-backed** (idle USDC + a recoverable Folks/etc. position, e.g. `fUSDC`) and fully redeemable; the deployed portion still backs the dollar. LP collateral is *not* mUSD's backing — it secures the loans. See [PSM.md → Productive Reserves (v3)](./PSM.md#productive-reserves-v3).

---

## ASA Parameters

| Field | Value | Notes |
|---|---|---|
| Name | Magnet USD | |
| Unit name | mUSD | |
| ASA ID | TBD (created at deployment) | |
| Decimals | 6 | Matches USDC; simplifies all swap math |
| Total supply | 500,000,000 mUSD | Effective cap is PSM reserves, not total supply |
| URL | magnetstrategies.io | |
| Manager | Admin wallet (initially) | Can be transferred to a contract later |
| Reserve | PSM contract address | Semantic: PSM holds all non-circulating mUSD |
| Freeze | Zero address | No freeze capability |
| Clawback | Zero address | No clawback capability — no rug vector |

**Decimals note:** 6 decimals means 1 mUSD = 1,000,000 base units. This matches USDC's 6-decimal representation. All protocol math for mUSD values uses base units. Display divides by 1,000,000.

**Clawback note:** setting clawback to zero is a deliberate security decision. A clawback address can pull tokens from any holder without consent — this would be an unacceptable protocol trust risk. mUSD is recycled by the holder returning it to the PSM reserve (reducing circulating supply) rather than by a contract confiscating it.

**Total supply note:** the on-chain total supply is a ceiling, not a target. The practical ceiling is always PSM USDC reserves. 500M mUSD is minted at creation and held entirely in the PSM reserve — providing ample headroom well beyond any realistic near-term circulation.

---

## Mint Authority

mUSD is minted by the **PSM contract only**, via inner ASA transfer from the PSM's own mUSD balance to the recipient.

Mint path:
1. Vault contract validates borrower's LP collateral and approved borrow amount
2. Vault calls PSM's `issue_musd(recipient, amount)` via cross-app inner transaction
3. PSM checks: `circulating_musd + amount ≤ usdc_balance`
4. PSM transfers `amount` mUSD to recipient from its own balance
5. Circulating mUSD increases

No other contract or wallet can mint mUSD. Admin wallet cannot mint directly — all minting is gated through the vault + PSM.

---

## Returning mUSD to Reserve (Recycling)

mUSD is never destroyed at the ASA level. It is recycled — returned to the PSM reserve — which increases the PSM's mUSD balance and decreases circulating supply. The total ASA supply stays at 500M permanently; only circulating supply changes.

Return paths:

**Via vault principal repayment:**
1. Borrower sends mUSD **directly to the PSM contract address** in the outer atomic group
2. Vault contract verifies the outer group contains an AssetTransfer to PSM of the declared amount
3. Vault reduces `musd_borrowed` in borrower's vault state
4. Vault calls PSM `receive_musd(amount)` via inner transaction
5. PSM's mUSD balance increases → circulating supply decreases → vault ceiling grows

**Via vault interest payment:**
1. Borrower sends mUSD **to the vault contract** in the outer atomic group (interest stays in vault, not PSM)
2. Vault zeroes `accrued_interest`; mUSD added to `accumulated_fees` counter
3. Circulating supply is **unchanged** — mUSD moved from borrower wallet to vault, both are non-PSM
4. When admin calls `collect_fees()`, mUSD moves to admin wallet — still circulating
5. Admin optionally sends swept mUSD directly to PSM address via plain AssetTransfer to reduce circulating supply and grow vault ceiling

**Via PSM redemption (mUSD → USDC swap):**
1. User sends mUSD to PSM
2. PSM's mUSD balance increases directly
3. PSM sends USDC to user (1% fee goes to treasury separately)
4. Circulating supply decreases

---

## Circulating Supply Tracking

Circulating mUSD is computed as:

```
circulating_musd = total_musd_asa_supply − psm_musd_asa_balance
```

This value is computed dynamically — no counter needs to be maintained separately. The invariant check is:

```
assert circulating_musd + mint_amount ≤ psm.usdc_balance
```

---

## Cross-Contract Interaction

mUSD interacts with two contracts:

| Contract | Interaction |
|---|---|
| PSM | Holds all non-circulating mUSD; issues mUSD on vault mint calls; receives mUSD on principal repayments and swaps |
| Vault | Tracks per-borrower mUSD balances; holds interest revenue in `accumulated_fees` until admin sweeps; routes principal repayments directly to PSM |

**Two distinct mUSD flows at the vault:**
- **Principal mUSD** (borrowed mUSD being repaid) — routed directly to PSM, reducing circulating supply
- **Interest mUSD** (payments on outstanding borrows) — held in the vault as `accumulated_fees`; does not reduce circulating supply until admin sends it to PSM

This split keeps interest revenue under admin control (can be held, deployed as DEX liquidity, or returned to PSM) while ensuring principal repayments always restore the vault ceiling immediately.

---

## PSM as Reserve Holder

The PSM contract holds two assets simultaneously:
1. USDC — the backing reserve
2. mUSD — the non-circulating reserve

The PSM's USDC balance represents the maximum mUSD that can be in circulation. The PSM's mUSD balance represents the remaining issuance headroom. At any moment:

```
psm_usdc_balance ≥ circulating_musd      [the core invariant]
vault_ceiling    = psm_usdc_balance − circulating_musd
```

The PSM USDC balance grows through admin deposits and PSM mint swaps (users send USDC → receive mUSD). It shrinks through PSM redemption swaps (users send mUSD → receive USDC) and redemption fees routed to treasury. Admin withdrawals also reduce it (subject to the invariant guard). Redemption fees (1% on mUSD → USDC) route directly to the treasury wallet in the same transaction and do not accumulate in PSM reserves. This keeps the PSM's role clear: it is a liquidity facility, not a yield-accumulating reserve.

---

## Peg Stability

mUSD maintains its peg through a direct redemption guarantee: any holder can swap 1 mUSD for 0.99 USDC at any time (1% fee), and any USDC holder can acquire mUSD at exactly 1:1 with no fee. This eliminates the possibility of a sustained de-peg below ~$0.99 as long as PSM has USDC reserves.

**One-way peg pressure:** if mUSD trades at a discount on a DEX (say $0.97), arbitrageurs buy mUSD from the DEX and redeem via PSM at $0.99, capturing the spread. This buying pressure pushes the DEX price back up.

**No algorithmic risk:** the peg does not depend on any token burn/mint mechanic, incentive structure, or market-making bot. It is enforced by the existence of the PSM as a guaranteed redemption venue.

---

## Known Assumptions

**USDC stability:** mUSD is pegged to USDC, not USD directly. If USDC de-pegs from USD, mUSD de-pegs proportionally. This assumption is shared by the majority of DeFi protocols and is acceptable at current TVL.

**PSM solvency:** the peg guarantee holds only as long as PSM has USDC reserves. If the admin withdraws all USDC from the PSM (bypassing the circulating-supply guard would be required, which is contract-blocked), the peg fails. The contract prevents this; operational integrity is required for everything else.

**Total supply headroom:** Algorand ASA total supply is immutable post-creation — the manager role cannot increase it. If total mUSD outstanding ever approaches 500M, the protocol would need to deploy a new mUSD ASA and migrate. At 500M total supply this is a far-future concern — the real constraint will always be PSM USDC reserves, not the ASA ceiling. Plan accordingly if protocol scale ever reaches the hundreds-of-millions range.
