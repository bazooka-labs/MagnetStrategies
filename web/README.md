# Magnet Strategies — Web App

The Next.js frontend for Magnet Strategies: the landing site, the **$U** token page, the
**MagnetFi "Bank"** (LP-collateral vaults + single-token markets), the **mUSD** page, and the
gated admin console. Protocol/contract design docs live in [`magnetfi/v2/`](../magnetfi/v2/OVERVIEW.md).

## Run & deploy
- From `web/`: `npm install`, then `npm run dev`.
- Network is fixed at startup by **`NEXT_PUBLIC_ALGO_NETWORK`** (`mainnet` default, or `testnet`).
- Pushing to `main` auto-deploys to **Vercel**. **Update live app IDs in `src/lib/magnetfi.ts`
  (`DEPLOYMENTS.mainnet`) before/with any contract redeploy.**

## Routes (site map)
| Route | What it is |
|---|---|
| `/` | Landing splash → "Attract Liquidity" + a link to `/about` |
| `/about` | The thesis + how the products fit together (a hub linking to each product page) |
| `/token` | $U token dashboard (price, holders, TVL, charts, swap) |
| `/magnetfi` | **The Bank** — tabbed app (below) |
| `/musd` | mUSD hub — live PSM metrics + the mint/redeem **Exchange** |
| `/contact` | Contact |
| `/dao`, `/dao/*` | DAO pages |

## The Bank (`/magnetfi`) — `src/app/magnetfi/page.tsx`
- **Overview** (`OverviewTab`) — the landing: plain explanations of Single Token Markets and LP
  Collateral Vaults (each with a CTA into its tab), three live metric boxes (**Single-Token Lend
  Yield**, **Available to Borrow**, **LP Vault Utilization**), an mUSD pointer, and a **Learn more**
  modal (`LpVaultLearnMore`) holding the full LP-vault mechanics + liquidation ladder.
- **Single Token Markets** (`CompXMarkets`) — CompX-hosted $U/USDC lending pools (read-only SDK data
  + deep-link to transact; CompX custodies these, MagnetFi adds no contract surface).
- **LP Collateral Vaults** (`VaultsTab`) — the borrow flow: open/manage a vault, live-projected
  accrued interest, liquidation-buffer bar, and pay/repay/borrow/add actions with Max buttons.
- **mUSD** — deep-links to `/musd` (the swap is no longer rendered inline).
- **Admin** (gated to `MAGNETFI_ADMIN_ADDRESS`) — see below.

## Admin console — `AdminTab` (gated)
- **Token setup** — `CreateMusd` (mainnet) / `CreateTestAssets` (testnet).
- **Operations** (`OperationsPanel`) — pauses, liquidations, risk params, reserves & fees, oracle,
  and governance/timelocked repoints. Each action is an `ActionForm` signed via Pera; button tones:
  default (purple) / warn (yellow) / danger (red).
- **Productive Reserves** (`StrategyPanel`) — v3 PSM: backing metrics, deploy/recall/harvest, Folks
  adapter deploy + whitelist, deficit/impairment, guardrails, timelocked treasury.
- **Deploy wizards were removed from the live panel post-launch.** `DeployWizard` (full-stack launch)
  and `VaultRedeployPanel` (vault-only redeploy against the live PSM/oracle, 48h timelock) still exist
  in `src/components/magnetfi/v2/admin/` and in git — re-add their import + section to `AdminTab.tsx`
  to use them again.

## Frontend architecture — `src/lib/`
- **`magnetfi.ts`** — config + pure helpers. `DEPLOYMENTS` (per-network app/asset IDs), `ACTIVE`,
  `ACTIVE_FOLKS`, `MAGNETFI_ADMIN_ADDRESS`, `VAULT_TYPES`, and `healthFactor` / `maxBorrow` /
  `liquidationBuffer` / `projectedAccruedInterest` / `pct` / `formatUsd`. **Update live IDs here.**
- **`magnetfiReads.ts`** — read-only chain queries (algosdk): `getProtocolStats`, `getStrategyStats`,
  `getVaultPosition`, `getTotalVaultDebt`, `getBalances`, oracle reads.
- **`magnetfiClient.ts`** — borrower writes (algokit-utils + Pera): `openVault`, `borrowMore`,
  `payInterest`, `repayPrincipal` (routes through `pay_interest`), `addCollateral`, `mintMusd`,
  `redeemMusd`.
- **`magnetfiOps.ts`** — admin ops. **`magnetfiDeploy.ts`** — deploy/config helpers (used by the
  retained wizards).

## Design system
- Palette: **magnet purple** (`#a855f7`) on near-black surface (`#08000f`); accent greens use
  `green-400` app-wide. Fonts: **Sora** (display) / **Inter** (body) / **JetBrains Mono** (numbers).
- Primitives in `src/components/magnetfi/v2/shared.tsx`: `Panel`, `Stat`, `PrimaryButton`, `PairGlyph`,
  badges.

## Notable UI behaviors (and where they live)
- **Live-projected accrued interest** — the on-chain `accrued_interest` is lazy (only written on a
  vault interaction), so the UI projects it client-side (`projectedAccruedInterest`, `VaultsTab`, 60s
  tick). The estimate is always ≥ the on-chain value, so health factor is never overstated.
- **Liquidation-buffer bars** — color-coded by health factor in the position card + open-vault preview.
- **mUSD Exchange** — one swap card with a clickable directional arrow (flip mint ⇄ redeem) + Max
  buttons (`MusdTab`, shared by `/musd` and, via deep-link, the Bank's mUSD tab).
- **LP Vault Utilization** = **total vault debt ÷ USDC reserve** (`getTotalVaultDebt`), *not*
  circulating mUSD (which also counts minted mUSD + fees) — so zero loans correctly reads 0%.
- **Repayment** routes entirely through `pay_interest` (the vault has no `repay_principal`); the client
  sends interest + principal and the contract refunds any overpay.
- **PSM metrics live only on `/musd`** (single source); the Bank's mUSD tab deep-links there.
