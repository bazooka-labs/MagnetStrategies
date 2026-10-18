// MagnetFi v2 — borrower-facing WRITES (algokit-utils + wallet signer).
// Read-only queries live in magnetfiReads.ts (algosdk only) to keep light consumers lean.

import algosdk from "algosdk";
import { AlgorandClient, microAlgo } from "@algorandfoundation/algokit-utils";
import { ACTIVE, projectedAccruedInterest } from "./magnetfi";
import { hasActiveAdapter, getVaultPosition, type VaultPosition } from "./magnetfiReads";

export { makeAlgorand } from "./magnetfiOps";

const VAULT_MBR = 46_500;
const MAX_FEE = microAlgo(50_000);
// Higher fee + noop fillers when a borrow's issue_musd live-reads a whitelisted adapter (Folks).
const BORROW_PAD_FEE = microAlgo(300_000);
const PAD_FILLERS = 4;
const SEND = { coverAppCallInnerTransactionFees: true, populateAppCallResources: true };

const SPEC = {
  psm: "/contracts/PSM.arc56.json",
  vault: "/contracts/Vault.arc56.json",
  psmv3: "/contracts/PSMv3.arc56.json",
} as const;
const specCache: Record<string, string> = {};
async function loadSpec(which: keyof typeof SPEC): Promise<string> {
  if (!specCache[which]) {
    const r = await fetch(SPEC[which]);
    if (!r.ok) throw new Error(`spec load failed: ${which}`);
    specCache[which] = await r.text();
  }
  return specCache[which];
}

const toBase = (display: number) => BigInt(Math.round(display * 1_000_000));
const appAddr = (id: number) => algosdk.getApplicationAddress(id).toString();

// Which collateral pool a borrower write targets. Defaults to the primary (U/tALGO) pool so
// single-pool callers are unchanged; multi-pool callers (VaultsTab) pass each pool explicitly.
// poolId doubles as the vault's per-pool key; lpAsaId is the LP token deposited/returned.
export type PoolRef = { poolId: number; lpAsaId: number };
const DEFAULT_POOL: PoolRef = { poolId: ACTIVE.poolId, lpAsaId: ACTIVE.lpAsaId };

async function vault(al: AlgorandClient, sender: string) {
  return al.client.getAppClientById({ appSpec: await loadSpec("vault"), appId: BigInt(ACTIVE.vault), defaultSender: sender });
}
async function psm(al: AlgorandClient, sender: string) {
  return al.client.getAppClientById({ appSpec: await loadSpec("psm"), appId: BigInt(ACTIVE.psm), defaultSender: sender });
}

// How many PSMv3.noop fillers a borrow needs (0 = no active adapter / v2 PSM → no live-read).
async function borrowFillers(al: AlgorandClient): Promise<number> {
  return (await hasActiveAdapter(al.client.algod)) ? PAD_FILLERS : 0;
}

// Append `n` PSMv3.noop app calls to a group for reference-slot capacity (Folks live-read).
// The composer mutates in place, so no reassignment is needed.
type Grp = ReturnType<AlgorandClient["newGroup"]>;
async function addFillers(grp: Grp, al: AlgorandClient, sender: string, n: number): Promise<void> {
  if (n <= 0) return;
  const pc = await al.client.getAppClientById({
    appSpec: await loadSpec("psmv3"), appId: BigInt(ACTIVE.psm), defaultSender: sender });
  for (let i = 0; i < n; i++) {
    grp.addAppCallMethodCall(await pc.params.call({
      method: "noop", args: [], maxFee: BORROW_PAD_FEE,
      note: new TextEncoder().encode(`pad-${i}-${Date.now()}-${Math.random()}`),
    }));
  }
}

export const optIn = (al: AlgorandClient, sender: string, assetId: number) =>
  al.send.assetOptIn({ sender, assetId: BigInt(assetId) });

/** Open a vault: MBR payment + open_vault + LP deposit (display units). */
export async function openVault(al: AlgorandClient, sender: string, lpDisplay: number, borrowDisplay: number, pool: PoolRef = DEFAULT_POOL) {
  /**
   * A vault must borrow something.
   *
   * The contract accepts `borrow_amount == 0` and that is the trap: the only
   * path returning LP is pay_interest's close branch, which needs
   * `principal_paid > 0` (vault/contract.py:473), so a zero-borrow vault has
   * no exit. rescueZeroDebtVault can undo one, but it needs a fresh oracle
   * and unpaused borrowing — the conditions least likely to hold when someone
   * urgently wants their collateral back.
   *
   * The button already blocks this. The guard is here too because the button
   * is one React condition in one component, and this is the single entry
   * point every caller goes through — the same reason repayPrincipal carries
   * one. Blocking creation is strictly better than rescuing afterwards.
   */
  if (!(borrowDisplay > 0)) {
    throw new Error(
      "A vault must borrow a non-zero amount. Collateral deposited against a zero " +
      "borrow cannot be withdrawn, because closing a vault requires repaying principal.");
  }
  const vc = await vault(al, sender);
  const vAddr = appAddr(ACTIVE.vault);
  // A borrow (>0) issues mUSD, which live-reads any whitelisted adapter through Folks → pad.
  const pad = borrowDisplay > 0 ? await borrowFillers(al) : 0;
  const fee = pad > 0 ? BORROW_PAD_FEE : MAX_FEE;
  const grp = al.newGroup()
    .addPayment({ sender, receiver: vAddr, amount: microAlgo(VAULT_MBR) })
    .addAppCallMethodCall(await vc.params.call({ method: "open_vault", args: [BigInt(pool.poolId), toBase(borrowDisplay)], maxFee: fee }))
    .addAssetTransfer({ sender, receiver: vAddr, assetId: BigInt(pool.lpAsaId), amount: toBase(lpDisplay) });
  await addFillers(grp, al, sender, pad);
  await grp.send(SEND);
}

/**
 * The smallest possible debt: 1 micro-mUSD. Constructed, not `toBase(0.000001)`,
 * so no float ever touches it. (`BigInt(1)` rather than `1n` — the tsconfig
 * target predates BigInt literals.)
 */
const RESCUE_BASE_MUSD = BigInt(1);

/**
 * Close a vault that has collateral but no debt.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────
 * The vault has no `withdraw_collateral` and no `close_vault`. The ONLY path
 * that returns LP is `pay_interest`'s close branch, and it fires only when
 * `principal_paid > 0` (vault/contract.py:473). Every liquidation trigger also
 * asserts `total_debt > 0`. So a vault opened with `borrow_amount = 0` has no
 * exit at all — the collateral is simply stuck.
 *
 * The UI no longer lets one be created, but `open_vault(pool, 0)` is a public
 * ABI method: anyone with an algod connection can still make one from a script
 * or an old build. This is the way back out.
 *
 * ── Why it cannot hurt the protocol ─────────────────────────────────────────
 * It borrows 1 micro-mUSD and immediately repays it in the same atomic group,
 * which drives principal from 0 → 1 → 0 and lets the close branch fire.
 *
 * The safety argument is structural, not a matter of how carefully this is
 * written: **no contract code changes, and every call here is an existing
 * public method the caller could already invoke.** `borrow_more` and
 * `pay_interest` are both keyed by `_vault_key(Txn.sender, pool_id)`, so a
 * caller can only ever touch their own box. Anything this group can do, anyone
 * could already do today by hand-building the same three transactions. A
 * frontend cannot grant on-chain capability that does not already exist, so
 * the protocol's attack surface is unchanged by adding this button.
 *
 * Economically it is also a round trip: `borrow_more` issues 1 micro-mUSD from
 * the PSM and `pay_interest` returns it via `receive_musd`. Net zero against
 * the issuance ceiling, and the group is atomic so there is no intermediate
 * state anyone can observe or interrupt.
 *
 * ── Why exactly 1 micro-unit, repaid exactly ────────────────────────────────
 * Interest is provably 0 across this group, for two independent reasons —
 * worth stating both, because the first version of this comment got the
 * mechanism wrong while reaching the right answer.
 *
 * (1) `_accrue_interest` scales by principal, and principal is 0 when
 *     `borrow_more` runs, so it accrues nothing no matter how much time has
 *     passed. (It sets `last_accrual + min(elapsed, SECONDS_PER_YEAR)`, NOT
 *     `Global.latest_timestamp` as previously claimed here.)
 * (2) `pay_interest` then accrues again in the same block, so elapsed is 0.
 *
 * Belt and braces: even at the 3000 bps rate cap, annual interest on a
 * principal of 1 micro-unit floors to 0. The
 * close branch therefore needs `principal_paid == principal`, and repaying
 * exactly what was borrowed achieves that. Overpaying would NOT be safer: if
 * interest were somehow non-zero, `principal_paid = change - interest` would
 * fall short of the principal and the vault would fail to close.
 *
 * ── The one case this cannot fix ────────────────────────────────────────────
 * `_lazy_overdue_check` flips any vault to state 1 after 90 days without a
 * payment, debt or no debt, and `borrow_more` asserts state 0. Resetting state
 * needs a `pay_interest`, which needs mUSD the owner of a never-borrowed vault
 * may not have. That case is reported precisely rather than attempted.
 */
/** vault/contract.py DAYS_90 — `_lazy_overdue_check`'s window. */
const OVERDUE_SECONDS = 90 * 86_400;

export function rescueBlockedReason(
  pos: VaultPosition | null, nowSec: number = Math.floor(Date.now() / 1000),
): string | null {
  if (!pos) return "No vault position for this pool.";
  // Checked before state, because "you have debt, use the normal button" is
  // more useful than "your vault is overdue" to someone who has both.
  if (pos.musdBorrowed > 0) return "This vault has debt — use Repay & Close instead.";
  if (pos.vaultState === 2) {
    return "This vault is in liquidation and must be settled by the admin.";
  }
  // The STORED flag is not enough. `_lazy_overdue_check` (contract.py:250)
  // recomputes overdue at execution time from `last_payment_timestamp`, and
  // borrow_more asserts state 0 AFTER that check — so a box still recording 0
  // is flipped and reverts. That is the normal case here, not an edge one: a
  // trapped vault is by definition one nobody has touched, so it drifts past
  // 90 days by sitting there. Matching on the stored flag alone would hand
  // the user a hex revert in precisely the state this message was written for.
  if (pos.vaultState === 1 || nowSec >= pos.lastPaymentTs + OVERDUE_SECONDS) {
    return "Vault is overdue, so it cannot borrow until that clears. Send any small amount "
      + "of mUSD to this wallet, run Pay Interest once (refunded in full), then retry.";
  }
  if (pos.lpAmount <= 0) return "This vault holds no collateral to return.";
  return null;
}

export async function rescueZeroDebtVault(
  al: AlgorandClient, sender: string, pool: PoolRef = DEFAULT_POOL,
) {
  const pos = await getVaultPosition(al.client.algod, sender, pool.poolId);
  // Re-read and re-check at send time, because the panel's copy can be a
  // refresh out of date.
  //
  // This covers the conditions readable from the vault BOX. It is not every
  // precondition: vault `paused`, the PSM's `paused`/`reserve_deficit`/
  // adapter-impaired flags, and PSM ceiling headroom are all enforced on
  // chain and not checked here, so they still surface as an opaque revert.
  // Oracle freshness is gated by the button only, from the same
  // possibly-stale panel read — a vault within ~60s of the 1800s edge can
  // show enabled and revert. None risks funds; each costs a confusing error
  // instead of a sentence. Worth closing with a read of both apps' globals if
  // this path ever gets real use.
  const blocked = rescueBlockedReason(pos);
  if (blocked) throw new Error(blocked);

  const vc = await vault(al, sender);
  const vAddr = appAddr(ACTIVE.vault);
  // Issuing mUSD live-reads any whitelisted adapter through Folks, exactly as a
  // normal borrow does — so the rescue carries the same reference padding.
  const pad = await borrowFillers(al);
  const fee = pad > 0 ? BORROW_PAD_FEE : MAX_FEE;

  // Order is load-bearing: pay_interest reads the mUSD transfer at
  // `group_index - 1`, so the transfer must sit immediately before it. Fillers
  // append after, which shifts nothing.
  // ⚠️ The borrow amount and the transfer amount MUST be the same value, which
  // is why both read RESCUE_BASE_MUSD rather than a literal. Borrow more than
  // is repaid and `principal_paid < principal`, so the close branch never
  // fires: the group succeeds, a fee is paid, and the vault stays locked with
  // a new dust debt. Repay more than is borrowed and the excess is refunded
  // harmlessly — but the user has no excess to send, since the mUSD being
  // repaid is the mUSD just borrowed. No unit test can catch a divergence
  // here (it needs chain execution), so the single constant is the guard.
  const grp = al.newGroup()
    .addAppCallMethodCall(await vc.params.call({
      method: "borrow_more", args: [BigInt(pool.poolId), RESCUE_BASE_MUSD], maxFee: fee }))
    .addAssetTransfer({
      sender, receiver: vAddr, assetId: BigInt(ACTIVE.musd), amount: RESCUE_BASE_MUSD })
    .addAppCallMethodCall(await vc.params.call({
      method: "pay_interest", args: [BigInt(pool.poolId)], maxFee: fee }));
  await addFillers(grp, al, sender, pad);
  await grp.send(SEND);
}

export async function borrowMore(al: AlgorandClient, sender: string, amountDisplay: number, pool: PoolRef = DEFAULT_POOL) {
  const vc = await vault(al, sender);
  const pad = await borrowFillers(al);
  if (pad === 0) {
    await vc.send.call({ method: "borrow_more", args: [BigInt(pool.poolId), toBase(amountDisplay)], maxFee: MAX_FEE, ...SEND });
    return;
  }
  const grp = al.newGroup()
    .addAppCallMethodCall(await vc.params.call({ method: "borrow_more", args: [BigInt(pool.poolId), toBase(amountDisplay)], maxFee: BORROW_PAD_FEE }));
  await addFillers(grp, al, sender, pad);
  await grp.send(SEND);
}

/** Pay interest: mUSD transfer (to vault) BEFORE the app call (P22-01). Overpay reduces principal. */
export async function payInterest(al: AlgorandClient, sender: string, amountDisplay: number, pool: PoolRef = DEFAULT_POOL) {
  const vc = await vault(al, sender);
  await al.newGroup()
    .addAssetTransfer({ sender, receiver: appAddr(ACTIVE.vault), assetId: BigInt(ACTIVE.musd), amount: toBase(amountDisplay) })
    .addAppCallMethodCall(await vc.params.call({ method: "pay_interest", args: [BigInt(pool.poolId)], maxFee: MAX_FEE }))
    .send(SEND);
}

/**
 * Repay principal — routed through pay_interest, the sole repayment path. Sends the live
 * accrued interest (+ a small drift buffer) plus the requested principal to the vault; the
 * contract charges interest first, applies the rest to principal, and refunds any excess
 * (so overpaying to close is safe). Pass the full outstanding principal to close the vault.
 */
export async function repayPrincipal(al: AlgorandClient, sender: string, principalDisplay: number, pool: PoolRef = DEFAULT_POOL) {
  const vc = await vault(al, sender);
  const pos = await getVaultPosition(al.client.algod, sender, pool.poolId);
  if (!pos) throw new Error("no vault position");
  /**
   * Refuse rather than succeed-and-do-nothing.
   *
   * pay_interest only closes a vault when `principal_paid > 0`
   * (vault/contract.py:473). With zero principal outstanding the payment below
   * is refunded in full, the box is rewritten unchanged, and the transaction
   * CONFIRMS — so the caller showed a success toast while the collateral
   * stayed locked. A user watching their LP not come back had no way to tell
   * that from a UI bug.
   *
   * The UI no longer lets a zero-debt vault be created and no such vault
   * exists on chain (audited 2026-10-17), so this is a backstop. It must throw
   * rather than silently send: a confirmed no-op is the worst of both.
   */
  if (pos.musdBorrowed <= 0) {
    throw new Error(
      "This vault has no outstanding principal, so repaying cannot close it. " +
      "Closing requires paying principal down to zero from a non-zero balance.");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const liveInterest = projectedAccruedInterest(
    pos.accruedInterest, pos.musdBorrowed, pos.rateBps, pos.lastAccrualTs, nowSec);
  // Small cover for accrual drift between this estimate and on-chain execution; the contract
  // refunds any excess, so a slight overpay is safe and guarantees interest is fully covered.
  const interestCover = liveInterest * 1.01 + 0.001;
  const payDisplay = interestCover + principalDisplay;
  await al.newGroup()
    .addAssetTransfer({ sender, receiver: appAddr(ACTIVE.vault), assetId: BigInt(ACTIVE.musd), amount: toBase(payDisplay) })
    .addAppCallMethodCall(await vc.params.call({ method: "pay_interest", args: [BigInt(pool.poolId)], maxFee: MAX_FEE }))
    .send(SEND);
}

export async function addCollateral(al: AlgorandClient, sender: string, lpDisplay: number, pool: PoolRef = DEFAULT_POOL) {
  const vc = await vault(al, sender);
  await al.newGroup()
    .addAppCallMethodCall(await vc.params.call({ method: "add_collateral", args: [BigInt(pool.poolId)], maxFee: MAX_FEE }))
    .addAssetTransfer({ sender, receiver: appAddr(ACTIVE.vault), assetId: BigInt(pool.lpAsaId), amount: toBase(lpDisplay) })
    .send(SEND);
}

/** Mint mUSD: USDC transfer to PSM (before) + mint_musd. */
export async function mintMusd(al: AlgorandClient, sender: string, amountDisplay: number) {
  const pc = await psm(al, sender);
  await al.newGroup()
    .addAssetTransfer({ sender, receiver: appAddr(ACTIVE.psm), assetId: BigInt(ACTIVE.usdc), amount: toBase(amountDisplay) })
    .addAppCallMethodCall(await pc.params.call({ method: "mint_musd", args: [toBase(amountDisplay)], maxFee: MAX_FEE }))
    .send(SEND);
}

/** Redeem mUSD: mUSD transfer to PSM (before) + redeem_musd. */
export async function redeemMusd(al: AlgorandClient, sender: string, amountDisplay: number) {
  const pc = await psm(al, sender);
  await al.newGroup()
    .addAssetTransfer({ sender, receiver: appAddr(ACTIVE.psm), assetId: BigInt(ACTIVE.musd), amount: toBase(amountDisplay) })
    .addAppCallMethodCall(await pc.params.call({ method: "redeem_musd", args: [toBase(amountDisplay)], maxFee: MAX_FEE }))
    .send(SEND);
}
