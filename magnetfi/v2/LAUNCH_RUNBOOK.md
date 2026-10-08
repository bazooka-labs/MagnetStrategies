# MagnetFi v3 — Mainnet Launch Runbook

Every privileged step is **Pera-signed by the connected admin/guardian wallet** through the
`/magnetfi` admin panel — no seed phrase, no script. Follow in order. Detailed method-level notes:
[ADMIN.md](./ADMIN.md#deployment-procedure-v2). Launch posture: **small ceiling, buffer ≥ 70%,
Folks-only, canary first.**

> Note: launching without the external audit / counsel is a deliberate owner decision (tracked
> separately). The internal reviews + testnet validation are in [AUDIT_HANDOFF.md](./AUDIT_HANDOFF.md);
> the accepted H-1 residual (recoverable_value must be a non-manipulable read) is satisfied by the
> Folks adapter. Keep the ceiling tiny until you're confident.

> **Historical:** this records the original launch. The step-wizards it references (Deploy &
> initialize, and later Vault redeploy) were **removed from the live admin panel post-launch** —
> retained in `web/src/components/magnetfi/v2/admin/` + git; re-add the import to `AdminTab.tsx` to
> run them again. Frontend map: [web/README.md](../../web/README.md).

## 0. Prerequisites
- [ ] **Site is live with the v3 UI** — the pushed frontend must be deployed (Vercel) or run locally
      (`npm run dev`). The PSMv3 wizard + Productive Reserves panel don't exist on an old build.
- [ ] Wallets ready: **admin** (connect via Pera), **guardian** (cold multisig — distinct key),
      **oracle bot** (funded ~5 ALGO), **treasury**.
- [ ] Known mainnet IDs: mUSD `3615600399`, USDC `31566704`, U/tALGO LP+pool `3163770927`.
      Folks: pool `971372237`, manager `971350278`, fUSDC `971384592` (prefilled in the adapter card).

## 1. Deploy wizard (admin tab → Deploy & initialize)
- [ ] Deploy **LP Oracle** (guardian).
- [ ] Deploy **PSM (v3 — Productive Reserves)** (mUSD, USDC, guardian).
- [ ] Deploy **Vault** (PSMv3, oracle, mUSD, USDC, guardian).
- [ ] **Fund apps** (min-balance).
- [ ] **Config oracle**: authorize bot + `add_pool` with the initial U/tALGO price (sets the ±25% anchor).
- [ ] **Config PSM**: opt into mUSD + USDC, set treasury.
- [ ] **Config vault**: **set liquidation threshold BEFORE LTV**, set rate, set LP ASA id.
- [ ] **Register vault on PSM**: `propose_vault_contract` → **48h timelock** → `confirm_vault_contract`.
- [ ] **Seed mUSD**: transfer the full 500M mUSD supply to the PSM.
- [ ] **Open the ceiling**: `deposit_usdc` a **small** starting reserve (e.g. ~$1,000).

## 2. Productive Reserves panel — add the Folks yield venue
- [ ] **Deploy & initialize Folks adapter** (one click — deploys, funds ~1 ALGO, opts into USDC+fUSDC).
      Copy the surfaced **adapter app ID**.
- [ ] **Propose adapter** (paste the adapter app ID) → **48h timelock** → **Confirm adapter**.
      *(Run this timelock in parallel with §1's vault-registration timelock — propose both, wait once.)*
- [ ] **Canary**: `strategy_deploy` a **tiny** amount → confirm the backing header + adapter
      `recoverable` update on-chain → `strategy_recall` it back. Only then scale up gradually.

## 3. Post-launch (outside the portal)
- [ ] Fill `web/src/lib/magnetfi.ts` `DEPLOYMENTS.mainnet` with the real Oracle / PSMv3 / Vault app IDs.
- [ ] Set the oracle bot `oracle_app_id` in its config; start the bot (freshness < 10 min).
- [ ] Redeploy the site so the borrower-facing tabs light up.
- [ ] Small live **borrow test** (open → borrow → repay) before opening publicly. Note: once the
      adapter is whitelisted, borrows auto-pad the group (`hasActiveAdapter`), so verify one borrow
      succeeds with the adapter live.

## Safety rails already enforced on-chain
- Redemptions always pay from the on-chain buffer (buffer-primary) — never blocked by deployed funds.
- `strategy_deploy` is capped by the buffer floor + per-venue cap; a bad adapter can only lose the
  funds deployed *to it*, never the buffer (balance-delta accounting).
- A realized loss freezes issuance + deploys + withdrawals until `restore`d (proven on testnet).
- Guardian can `pause` (halts mint + borrow issuance), veto any 48h change, and clear impairments.

---

# Adding ALGO/USDC collateral (prepared 2026-10-07, not yet executed)

The first non-$U collateral. Everything that can be done without the admin key
is done; what follows is the part that needs it, in an order that matters.

## Why this pool

The entire collateral book is currently U-denominated, so the protocol's
solvency rides on one thin token. ALGO/USDC also happens to be the only
collateral deep enough to **actually liquidate** — $1.72M of Tinyman TVL, where
unwinding a seizure does not move the price against the liquidator. U/tALGO
cannot say that at any size.

## Measured values (2026-10-07)

| | |
|---|---|
| LP ASA / `pool_id` | **1002590888** |
| pool address | `2PIFZW53RHCSFSYMCFUBW4XOCXOMB7XOYQSQ6KGT3KVGJTL4HM6COZRNMM` |
| `asset_1_id` | 31566704 (USDC, 6dp) |
| `asset_2_id` | 0 (ALGO, 6dp) |
| reserves | 858,138 USDC / 7,223,672 ALGO |
| TVL | $1,716,276 |
| LP supply | 1,476,355.6946 |
| **LP price** | **$1.162509** → scaled **1162509** |

Re-read the LP price immediately before `add_pool` — it moves, and the anchor is
set from it.

## Risk parameters, and why

**LTV 6500 / liq threshold 7800 / rate 500.**

An ALGO/USDC LP is roughly **half as volatile** as a volatile/volatile pair:
half the position is a stablecoin, so LP value tracks `sqrt(P_ALGO)`.

| ALGO | LP |
|---|---|
| −50% | −29.3% |
| −75% | −50% |

At 65/78 a max-LTV borrower becomes liquidatable on a 16.7% LP fall — **ALGO
−30.6%**. Compare U/USDC at 65/75, which liquidates on a 13.3% LP fall. So these
numbers are more conservative in real terms than the existing pools despite the
higher threshold.

Deliberately conservative while liquidation is still manual. Both are
admin-adjustable; raise toward 70/80 once the liquidation bot is proven.

## ⚠️ Order matters

**Register on chain FIRST.** `update_lp_price` asserts the pool is whitelisted,
so adding it to the bot config before `add_pool` means a reverted post and a
wasted fee every five minutes.

### 1. Admin calls (hardware wallet)

```
oracle 3644230020   add_pool(1002590888, <fresh LP price ×1e6>)
vault  3671287267   set_lp_asa_id(1002590888, 1002590888)
vault  3671287267   set_ltv(1002590888, 6500)
vault  3671287267   set_liq_threshold(1002590888, 7800)
vault  3671287267   set_rate(1002590888, 500)
```

`add_pool` sets the price **and** the anchor, so no separate re-anchor.

### 2. Oracle bot — add to `config.json` `pools`, then restart

```json
{
  "pool_id": 1002590888,
  "pool_address": "2PIFZW53RHCSFSYMCFUBW4XOCXOMB7XOYQSQ6KGT3KVGJTL4HM6COZRNMM",
  "asset_a_id": 31566704, "asset_a_decimals": 6,
  "asset_b_id": 0,        "asset_b_decimals": 6,
  "min_price": 880000, "max_price": 1440000,
  "compx_check_asset_id": 0,
  "label": "ALGO/USDC"
}
```

`asset_a` must be the pool's `asset_1_id` — the bot verifies this against chain
to catch a wrong `pool_address`. Bounds sit just inside the ±25% anchor band
(871,882 … 1,453,136). No new `asset_decimals`, `reference_pools` or
`asset_price_bounds` entries are needed — ALGO and USDC already have all three.

Expect ~15 minutes of `only 1/3 readings — holding prior on-chain price` before
the first post. That is the TWAP fail-stale gate, not a failure.

### 3. Frontend — add the wiring

`web/src/lib/magnetfi.ts` → `POOL_WIRING.mainnet`:

```ts
"algo-usdc": { poolId: 1002590888, lpAsaId: 1002590888 },
```

The `VAULT_TYPES` entry is already committed and renders as "coming soon" until
this line exists. **Add it last** — it is what switches the UI from a teaser to
live on-chain interaction.

## Two things to know going in

**No CompX cross-check on this pool.** CompX prices $U but **not ALGO** (nor
tALGO) — verified against the live oracle. `compx_check_asset_id: 0` disables
it, so this pool runs on TWAP alone. Mitigated by the pool being ~10× deeper
than the U pools and by LP tokens being inherently manipulation-resistant: a
swap moves both reserves in opposite directions, leaving the token's value
roughly intact.

**ALGO's reference pool is this pool.** `reference_pools[0]` points at the same
Tinyman ALGO/USDC pool being priced, so the derivation is circular — the LP price
reduces to `2 × USDC_reserve / LP_supply`. At equilibrium that is correct, and it
diverges only while the pool is away from market, which arbitrage closes quickly
at this depth. The error is also **conservative**: a manipulation that moves the
pool understates the LP value, causing over-liquidation rather than
under-collateralisation. Acceptable here; it would not be on a thin pool.
