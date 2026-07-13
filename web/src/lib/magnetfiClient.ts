// MagnetFi v2 — borrower-facing WRITES (algokit-utils + wallet signer).
// Read-only queries live in magnetfiReads.ts (algosdk only) to keep light consumers lean.

import algosdk from "algosdk";
import { AlgorandClient, microAlgo } from "@algorandfoundation/algokit-utils";
import { ACTIVE } from "./magnetfi";
import { hasActiveAdapter } from "./magnetfiReads";

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
export async function openVault(al: AlgorandClient, sender: string, lpDisplay: number, borrowDisplay: number) {
  const vc = await vault(al, sender);
  const vAddr = appAddr(ACTIVE.vault);
  // A borrow (>0) issues mUSD, which live-reads any whitelisted adapter through Folks → pad.
  const pad = borrowDisplay > 0 ? await borrowFillers(al) : 0;
  const fee = pad > 0 ? BORROW_PAD_FEE : MAX_FEE;
  const grp = al.newGroup()
    .addPayment({ sender, receiver: vAddr, amount: microAlgo(VAULT_MBR) })
    .addAppCallMethodCall(await vc.params.call({ method: "open_vault", args: [BigInt(ACTIVE.poolId), toBase(borrowDisplay)], maxFee: fee }))
    .addAssetTransfer({ sender, receiver: vAddr, assetId: BigInt(ACTIVE.lpAsaId), amount: toBase(lpDisplay) });
  await addFillers(grp, al, sender, pad);
  await grp.send(SEND);
}

export async function borrowMore(al: AlgorandClient, sender: string, amountDisplay: number) {
  const vc = await vault(al, sender);
  const pad = await borrowFillers(al);
  if (pad === 0) {
    await vc.send.call({ method: "borrow_more", args: [BigInt(ACTIVE.poolId), toBase(amountDisplay)], maxFee: MAX_FEE, ...SEND });
    return;
  }
  const grp = al.newGroup()
    .addAppCallMethodCall(await vc.params.call({ method: "borrow_more", args: [BigInt(ACTIVE.poolId), toBase(amountDisplay)], maxFee: BORROW_PAD_FEE }));
  await addFillers(grp, al, sender, pad);
  await grp.send(SEND);
}

/** Pay interest: mUSD transfer (to vault) BEFORE the app call (P22-01). Overpay reduces principal. */
export async function payInterest(al: AlgorandClient, sender: string, amountDisplay: number) {
  const vc = await vault(al, sender);
  await al.newGroup()
    .addAssetTransfer({ sender, receiver: appAddr(ACTIVE.vault), assetId: BigInt(ACTIVE.musd), amount: toBase(amountDisplay) })
    .addAppCallMethodCall(await vc.params.call({ method: "pay_interest", args: [BigInt(ACTIVE.poolId)], maxFee: MAX_FEE }))
    .send(SEND);
}

/** Repay principal: app call + mUSD transfer to PSM. Clear accrued interest first. */
export async function repayPrincipal(al: AlgorandClient, sender: string, amountDisplay: number) {
  const vc = await vault(al, sender);
  await al.newGroup()
    .addAppCallMethodCall(await vc.params.call({ method: "repay_principal", args: [BigInt(ACTIVE.poolId)], maxFee: MAX_FEE }))
    .addAssetTransfer({ sender, receiver: appAddr(ACTIVE.psm), assetId: BigInt(ACTIVE.musd), amount: toBase(amountDisplay) })
    .send(SEND);
}

export async function addCollateral(al: AlgorandClient, sender: string, lpDisplay: number) {
  const vc = await vault(al, sender);
  await al.newGroup()
    .addAppCallMethodCall(await vc.params.call({ method: "add_collateral", args: [BigInt(ACTIVE.poolId)], maxFee: MAX_FEE }))
    .addAssetTransfer({ sender, receiver: appAddr(ACTIVE.vault), assetId: BigInt(ACTIVE.lpAsaId), amount: toBase(lpDisplay) })
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
