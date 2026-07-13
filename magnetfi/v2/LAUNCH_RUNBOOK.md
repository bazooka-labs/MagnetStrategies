# MagnetFi v3 — Mainnet Launch Runbook

Every privileged step is **Pera-signed by the connected admin/guardian wallet** through the
`/magnetfi` admin panel — no seed phrase, no script. Follow in order. Detailed method-level notes:
[ADMIN.md](./ADMIN.md#deployment-procedure-v2). Launch posture: **small ceiling, buffer ≥ 70%,
Folks-only, canary first.**

> Note: launching without the external audit / counsel is a deliberate owner decision (tracked
> separately). The internal reviews + testnet validation are in [AUDIT_HANDOFF.md](./AUDIT_HANDOFF.md);
> the accepted H-1 residual (recoverable_value must be a non-manipulable read) is satisfied by the
> Folks adapter. Keep the ceiling tiny until you're confident.

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
