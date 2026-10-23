// Regenerates src/lib/strategy/__fixtures__/cvaGroups.json from live MainNet.
//
//   CAPTURE=1 npx vitest run src/lib/strategy/__fixtures__/captureCva.test.ts
//
// Skipped on a normal `npm test` run: it needs the network, and the fixture it
// writes is committed precisely so the mutation tests do NOT.
//
// The C-Vault is the pool going in front of users first, and it had no
// real-bytes coverage while the market pools had 55 mutation tests. Same
// reasoning as capture.test.ts: a test that builds its groups as object
// literals is testing a belief about the SDK, not the SDK — and six separate
// shape errors in this path were invisible to a hand-built group.
//
// Regenerate when the SDK version changes, when the builders in cvaGroup.ts
// change, or when the vault's active markets change.

import { it } from "vitest";
import fs from "node:fs";
import algosdk from "algosdk";
import {
  buildV2CvaDepositTransactions,
  buildV2CvaWithdrawFromMarketTransactions,
} from "@pdex/sdk/transactions";
import { readCvaSnapshot } from "../cvaSnapshot";
import { chooseWithdrawRoute, markMarketsFor, CVA_USER_BOX_MBR_MICRO_ALGO } from "../cvaGroup";
import { PEX_APPS, PEX_ASSETS } from "../../perps";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const CAPTURE = !!process.env.CAPTURE;

/** A real C-Vault depositor: 646.8 shares. */
const HOLDER = "ALUYA2D55QDUUIY3JORBOB2B7WRTVV477R6URF4P6NY4ZZWB3LUK3DU6WE";
/** A real funded trader with NO `gu2:` box — the first-time shape. */
const FIRST_TIMER = "6UE6PHOA6234L5HTVRMJGN7TKLGCTVLLFTI5DMWUUHJ6OZFGPXFE7QQENU";

it.skipIf(!CAPTURE)("captures real SDK C-Vault groups", async () => {
  const algod = new algosdk.Algodv2("", "https://mainnet-api.algonode.cloud", "");
  const snap = await readCvaSnapshot(algod);
  const sp = await algod.getTransactionParams().do();
  // Mirror cvaGroup's fee pinning: a fixture that builds differently from
  // production is not a capture.
  sp.fee = sp.minFee;
  sp.flatFee = true;

  const refs = {
    v2CvaVaultAppId: PEX_APPS.cvaVault,
    v2MarketsAppId: PEX_APPS.markets,
    v2MathAppId: PEX_APPS.math,
    v2AdminControlAppId: PEX_APPS.adminControl,
    longAssetId: PEX_ASSETS.algo,
    shortAssetId: PEX_ASSETS.usdc,
    indexAssetId: PEX_ASSETS.algo,
    activeMarketIds: snap.state.activeMarkets,
    activeMarketOracles: snap.activeMarketOracles,
    oracleMessage: snap.oracle.message,
    oracleSignature: snap.oracle.signature,
  };

  const enc = (g: unknown[]) => g
    .map((t) => ((t as { txn?: algosdk.Transaction }).txn ?? t) as algosdk.Transaction)
    .map((t) => b64(algosdk.encodeUnsignedTransaction(t)));

  // Two deposit shapes, because the first-time one is its own shape and the
  // pools shipped a bug that lived exactly in that difference.
  const usdcMicro = BigInt(6_000_000);
  const minShares = BigInt(4_900_000);
  const deposits: Record<string, unknown> = {};
  for (const [name, sender, storage] of [
    ["returning", HOLDER, BigInt(0)],
    ["firstTime", FIRST_TIMER, CVA_USER_BOX_MBR_MICRO_ALGO],
  ] as const) {
    const g = buildV2CvaDepositTransactions({
      sender, longAmount: BigInt(0), shortAmount: usdcMicro,
      storagePaymentMicroAlgo: storage, minCvaShares: minShares, ...refs,
    } as never, sp) as unknown[];
    const t = g.map((x) => ((x as { txn?: algosdk.Transaction }).txn ?? x) as algosdk.Transaction);
    console.log(`deposit ${name}: ${t.length} txns [${t.map((x) => x.type).join(",")}] `
      + `fee=${t.reduce((a, x) => a + Number(x.fee), 0)} storage=${storage}`);
    deposits[name] = {
      sender, algoMicro: "0", usdcMicro: String(usdcMicro),
      minShares: String(minShares), storagePaymentMicro: String(storage),
      txns: enc(g),
    };
  }

  const shareAmount = BigInt(Math.ceil(10 / snap.navPerShare * 1e6));
  const caps = { long: BigInt(500_000_000), short: BigInt(500_000_000) };
  const { route } = chooseWithdrawRoute(snap, HOLDER, shareAmount, caps);
  const minAlgo = BigInt(20_000_000);
  const minUsdc = BigInt(7_000_000);
  const wg = buildV2CvaWithdrawFromMarketTransactions({
    sender: HOLDER, marketId: route.marketId, shareAmount,
    minLongAmount: minAlgo, minShortAmount: minUsdc,
    yieldRecallMode: 1,
    maxLongReceiptAmount: caps.long, maxShortReceiptAmount: caps.short,
    marketYieldRegistry: snap.registries[route.marketId],
    ...refs,
  } as never, sp) as unknown[];
  const wt = wg.map((x) => ((x as { txn?: algosdk.Transaction }).txn ?? x) as algosdk.Transaction);
  console.log(`withdraw: ${wt.length} txns fee=${wt.reduce((a, x) => a + Number(x.fee), 0)} `
    + `route=market ${route.marketId} marks=[${markMarketsFor(snap).join(",")}]`);

  const recall = (snap.registries[route.marketId].recall ?? {}) as Record<string, unknown>;
  fs.writeFileSync("src/lib/strategy/__fixtures__/cvaGroups.json",
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      note: "Real @pdex/sdk 0.6.6 C-Vault output against MainNet. Regenerate with CAPTURE=1.",
      activeMarkets: snap.state.activeMarkets,
      markMarkets: markMarketsFor(snap),
      navPerShare: snap.navPerShare,
      oracleMessageB64: b64(snap.oracle.message),
      oracleSignatureB64: b64(snap.oracle.signature),
      deposits,
      withdraw: {
        sender: HOLDER, route,
        shareAmount: String(shareAmount),
        minAlgoMicro: String(minAlgo), minUsdcMicro: String(minUsdc),
        yieldRecallMode: "1",
        maxLongReceipt: String(caps.long), maxShortReceipt: String(caps.short),
        recall, txns: enc(wg),
      },
    }, null, 1) + "\n");
});
