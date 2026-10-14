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

type Which = "oracle" | "leanoracle" | "psm" | "vault" | "psmv3" | "folksadapter";
const SPEC_URL: Record<Which, string> = {
  oracle: "/contracts/LPOracle.arc56.json",
  // Shipped ALONGSIDE LPOracle.arc56.json, never over it: the admin panel
  // deploys from these files and the banded oracle's UI still needs its own
  // spec for the whole 48h window, and for a rollback after it
  // (ORACLE_LEAN_SPEC.md §6 step 7).
  leanoracle: "/contracts/LeanOracle.arc56.json",
  psm: "/contracts/PSM.arc56.json",
  vault: "/contracts/Vault.arc56.json",
  psmv3: "/contracts/PSMv3.arc56.json",
  folksadapter: "/contracts/FolksAdapter.arc56.json",
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

/**
 * Migration step 1 — deploy the lean oracle.
 *
 * Same constructor as LPOracle (guardian only). What differs is what the
 * contract will NOT do: no ±25% anchor band, no ±50%-vs-prior guard, and no
 * `set_price_anchor` method at all.
 *
 * The creator pays the app's global-state MBR at creation. The declared schema
 * is 57 uints / 7 byte-slices, so that is
 * 100_000 + 28_500×57 + 50_000×7 ≈ **2.07 ALGO** out of the admin wallet — more
 * than the banded oracle, because the schema is declared at the 19-pool ceiling
 * rather than grown per pool (ORACLE_LEAN_SPEC.md §2.3).
 */
export async function deployLeanOracle(
  algorand: AlgorandClient, sender: string, guardian: string,
): Promise<bigint> {
  const f = await factory(algorand, "leanoracle", sender);
  const { appClient: c } = await f.send.create({ method: "deploy", args: [guardian] });
  return c.appId;
}

/**
 * Migration steps 2-3 — authorize the bot, then register every pool.
 *
 * All pools in ONE atomic group with the updater call, so a partial
 * registration is not reachable: a pool missing from the new oracle goes dead
 * the instant the cutover confirms, and it presents as "oracle stale" rather
 * than "price not set" because freshness is checked before the price — so the
 * symptom points at a dead bot rather than at the pool nobody registered.
 * Pinned by test_a_pool_missing_from_the_new_oracle_dies_at_cutover.
 *
 * `prices` must be FRESH. The seed is what every existing position is valued
 * against the moment the vault switches over; a stale seed reprices the whole
 * book at cutover.
 */
export async function configLeanOracle(
  algorand: AlgorandClient, sender: string, oracleId: bigint,
  bot: string, pools: { poolId: bigint; price: bigint }[],
): Promise<void> {
  if (pools.length === 0) throw new Error("refusing to configure an oracle with no pools");
  const c = await appClient(algorand, "leanoracle", oracleId, sender);
  let g = algorand
    .newGroup()
    .addAppCallMethodCall(await c.params.call({ method: "set_authorized_updater", args: [bot], maxFee: MAX_FEE }));
  for (const p of pools) {
    g = g.addAppCallMethodCall(
      await c.params.call({ method: "add_pool", args: [p.poolId, p.price], maxFee: MAX_FEE }),
    );
  }
  await g.send(SEND_OPTS);
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

// ── v3: Folks yield adapter — deploy + initialize (fund + opt into USDC / fUSDC) ──

export async function deployFolksAdapter(
  algorand: AlgorandClient, sender: string,
  psmId: bigint, usdc: number, fusdc: number, pool: number, manager: number,
): Promise<bigint> {
  const f = await factory(algorand, "folksadapter", sender);
  const { appClient: c } = await f.send.create({
    method: "create",
    args: [psmId, BigInt(usdc), BigInt(fusdc), BigInt(pool), BigInt(manager), sender],
  });
  return c.appId;
}

/** Fund the adapter account + opt it into USDC and fUSDC (one atomic group). Admin only. */
export async function initFolksAdapter(
  algorand: AlgorandClient, sender: string, adapterId: bigint, usdc: number, fusdc: number,
): Promise<void> {
  const c = await appClient(algorand, "folksadapter", adapterId, sender);
  await algorand
    .newGroup()
    .addPayment({ sender, receiver: appAddr(adapterId), amount: algo(1) })
    .addAppCallMethodCall(await c.params.call({ method: "opt_in_asset", args: [BigInt(usdc)], maxFee: MAX_FEE }))
    .addAppCallMethodCall(await c.params.call({ method: "opt_in_asset", args: [BigInt(fusdc)], maxFee: MAX_FEE }))
    .send(SEND_OPTS);
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

// Fund a single (freshly redeployed) vault app for min-balance + opt-ins.
export async function fundVault(algorand: AlgorandClient, sender: string, vaultId: bigint): Promise<void> {
  await algorand.send.payment({ sender, receiver: appAddr(vaultId), amount: algo(1) });
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
