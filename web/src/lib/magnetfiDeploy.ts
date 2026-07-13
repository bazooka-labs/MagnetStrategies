// MagnetFi v2 — browser deploy/initialize helpers.
// Mirrors the exact sequence proven by the LocalNet test harness (conftest._wire),
// but every step is built here and signed by the connected admin wallet via use-wallet.
// algokit-utils handles ABI encoding, resource population, and inner-fee coverage.
//
// Asset IDs (mUSD, USDC) are passed in by the caller so the same code works on
// mainnet (real IDs) and testnet (stand-in IDs created during a rehearsal).

import algosdk, { type TransactionSigner } from "algosdk";
import { AlgorandClient, algo, microAlgo } from "@algorandfoundation/algokit-utils";

export const USDC_ASA_ID_MAINNET = 31566704; // mainnet USDC (default for the wizard)
const SEED_MUSD_BASE = BigInt("500000000000000"); // 500M × 1e6 — full reserve
const MAX_FEE = microAlgo(50_000); // ceiling for inner-fee coverage

type Which = "oracle" | "psm" | "vault" | "psmv3";
const SPEC_URL: Record<Which, string> = {
  oracle: "/contracts/LPOracle.arc56.json",
  psm: "/contracts/PSM.arc56.json",
  vault: "/contracts/Vault.arc56.json",
  psmv3: "/contracts/PSMv3.arc56.json",
};

const specCache: Partial<Record<Which, string>> = {};
async function loadSpec(which: Which): Promise<string> {
  if (!specCache[which]) {
    const res = await fetch(SPEC_URL[which]);
    if (!res.ok) throw new Error(`Failed to load ${which} contract spec`);
    specCache[which] = await res.text();
  }
  return specCache[which]!;
}

export function makeAlgorand(algod: algosdk.Algodv2, signer: TransactionSigner): AlgorandClient {
  const algorand = AlgorandClient.fromClients({ algod });
  algorand.setDefaultSigner(signer);
  return algorand;
}

function appAddr(appId: bigint): string {
  return algosdk.getApplicationAddress(appId).toString();
}

async function factory(algorand: AlgorandClient, which: Which, sender: string) {
  return algorand.client.getAppFactory({ appSpec: await loadSpec(which), defaultSender: sender });
}

async function appClient(algorand: AlgorandClient, which: Which, appId: bigint, sender: string) {
  return algorand.client.getAppClientById({ appSpec: await loadSpec(which), appId, defaultSender: sender });
}

const SEND_OPTS = { coverAppCallInnerTransactionFees: true, populateAppCallResources: true };

// ── 1–3: deploy the three apps (each is its own creation; vault needs the prior ids) ──

export async function deployOracle(algorand: AlgorandClient, sender: string, guardian: string): Promise<bigint> {
  const f = await factory(algorand, "oracle", sender);
  const { appClient: c } = await f.send.create({ method: "deploy", args: [guardian] });
  return c.appId;
}

// Deploys the v3 (Productive Reserves) PSM — the launch PSM. Same deploy signature as v2
// (musd, usdc, guardian); buffer/cap default in-contract (70% / 100%).
export async function deployPsm(
  algorand: AlgorandClient, sender: string, guardian: string, musdAsaId: number, usdcAsaId: number,
): Promise<bigint> {
  const f = await factory(algorand, "psmv3", sender);
  const { appClient: c } = await f.send.create({
    method: "deploy",
    args: [BigInt(musdAsaId), BigInt(usdcAsaId), guardian],
  });
  return c.appId;
}

export async function deployVault(
  algorand: AlgorandClient, sender: string, guardian: string,
  psmId: bigint, oracleId: bigint, musdAsaId: number, usdcAsaId: number,
): Promise<bigint> {
  const f = await factory(algorand, "vault", sender);
  const { appClient: c } = await f.send.create({
    method: "deploy",
    args: [psmId, oracleId, BigInt(musdAsaId), BigInt(usdcAsaId), guardian],
  });
  return c.appId;
}

// ── 4: fund the app accounts for min-balance + opt-in costs ──

export async function fundApps(
  algorand: AlgorandClient, sender: string, ids: { oracle: bigint; psm: bigint; vault: bigint },
): Promise<void> {
  await algorand
    .newGroup()
    .addPayment({ sender, receiver: appAddr(ids.oracle), amount: algo(0.5) })
    .addPayment({ sender, receiver: appAddr(ids.psm), amount: algo(1) })
    .addPayment({ sender, receiver: appAddr(ids.vault), amount: algo(1) })
    .send();
}

// ── 5: oracle — authorize bot + register pool (sets price AND the ±25% anchor) ──

export async function configOracle(
  algorand: AlgorandClient, sender: string, oracleId: bigint,
  bot: string, poolId: bigint, initialPrice: bigint,
): Promise<void> {
  const c = await appClient(algorand, "oracle", oracleId, sender);
  await algorand
    .newGroup()
    .addAppCallMethodCall(await c.params.call({ method: "set_authorized_updater", args: [bot], maxFee: MAX_FEE }))
    .addAppCallMethodCall(await c.params.call({ method: "add_pool", args: [poolId, initialPrice], maxFee: MAX_FEE }))
    .send(SEND_OPTS);
}

// ── 6: PSM — opt into mUSD + USDC, set treasury ──

export async function configPsm(
  algorand: AlgorandClient, sender: string, psmId: bigint, treasury: string,
  musdAsaId: number, usdcAsaId: number,
): Promise<void> {
  const c = await appClient(algorand, "psmv3", psmId, sender);
  await algorand
    .newGroup()
    .addAppCallMethodCall(await c.params.call({ method: "opt_in_asset", args: [BigInt(musdAsaId)], maxFee: MAX_FEE }))
    .addAppCallMethodCall(await c.params.call({ method: "opt_in_asset", args: [BigInt(usdcAsaId)], maxFee: MAX_FEE }))
    .addAppCallMethodCall(await c.params.call({ method: "set_treasury", args: [treasury], maxFee: MAX_FEE }))
    .send(SEND_OPTS);
}

// ── 7: Vault — opt into mUSD + LP, set risk params (liq threshold BEFORE ltv) ──

export async function configVault(
  algorand: AlgorandClient, sender: string, vaultId: bigint,
  lpAsaId: bigint, poolId: bigint, rateBps: bigint, liqThresholdBps: bigint, ltvBps: bigint,
  musdAsaId: number,
): Promise<void> {
  const c = await appClient(algorand, "vault", vaultId, sender);
  await algorand
    .newGroup()
    .addAppCallMethodCall(await c.params.call({ method: "opt_in_asset", args: [BigInt(musdAsaId)], maxFee: MAX_FEE }))
    .addAppCallMethodCall(await c.params.call({ method: "opt_in_asset", args: [lpAsaId], maxFee: MAX_FEE }))
    .addAppCallMethodCall(await c.params.call({ method: "set_rate", args: [poolId, rateBps], maxFee: MAX_FEE }))
    .addAppCallMethodCall(await c.params.call({ method: "set_liq_threshold", args: [poolId, liqThresholdBps], maxFee: MAX_FEE }))
    .addAppCallMethodCall(await c.params.call({ method: "set_ltv", args: [poolId, ltvBps], maxFee: MAX_FEE }))
    .addAppCallMethodCall(await c.params.call({ method: "set_lp_asa_id", args: [poolId, lpAsaId], maxFee: MAX_FEE }))
    .send(SEND_OPTS);
}

// ── 8: PSM — propose vault registration (starts the 48h timelock) ──

export async function proposeVaultRegistration(
  algorand: AlgorandClient, sender: string, psmId: bigint, vaultId: bigint,
): Promise<void> {
  const c = await appClient(algorand, "psm", psmId, sender);
  await c.send.call({ method: "propose_vault_contract", args: [vaultId], maxFee: MAX_FEE });
}

/** Unix timestamp (seconds) after which the queued vault registration can be confirmed; 0 if none. */
export async function readVaultEta(algorand: AlgorandClient, psmId: bigint, sender: string): Promise<number> {
  const c = await appClient(algorand, "psm", psmId, sender);
  const gs = await c.getGlobalState();
  const v = gs.pending_vault_eta?.value;
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

// ── 9: PSM — confirm vault registration (after the timelock elapses) ──

export async function confirmVaultRegistration(
  algorand: AlgorandClient, sender: string, psmId: bigint,
): Promise<void> {
  const c = await appClient(algorand, "psm", psmId, sender);
  await c.send.call({ method: "confirm_vault_contract", args: [], maxFee: MAX_FEE });
}

// ── 10: seed the PSM with the full mUSD reserve ──

export async function seedReserve(
  algorand: AlgorandClient, sender: string, psmId: bigint, musdAsaId: number,
): Promise<void> {
  await algorand.send.assetTransfer({
    sender, receiver: appAddr(psmId), assetId: BigInt(musdAsaId), amount: SEED_MUSD_BASE,
  });
}

// ── 11: open the vault ceiling with an initial USDC deposit ──

export async function openCeiling(
  algorand: AlgorandClient, sender: string, psmId: bigint, usdcBase: bigint, usdcAsaId: number,
): Promise<void> {
  const c = await appClient(algorand, "psm", psmId, sender);
  await algorand
    .newGroup()
    .addAssetTransfer({ sender, receiver: appAddr(psmId), assetId: BigInt(usdcAsaId), amount: usdcBase })
    .addAppCallMethodCall(await c.params.call({ method: "deposit_usdc", args: [usdcBase], maxFee: MAX_FEE }))
    .send(SEND_OPTS);
}
