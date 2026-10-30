#!/usr/bin/env node
/**
 * Is MagnetFi still inside the envelope the lean oracle's design assumes?
 *
 * The oracle accepts any non-zero price from the bot key with no on-chain
 * bound on how far it moves (lean_oracle/contract.py, ORACLE_LEAN_SPEC.md).
 * That trade is valid only below the reviewed ceiling — AUDIT.md:1077 puts it
 * at < ~$100k collateral-pool TVL — and NOTHING ON CHAIN ENFORCES IT. So it
 * has to be looked at, and a runbook step that cannot be run is not a step.
 *
 * Reads only. No key, no signing, no writes.
 *
 *     node magnetfi/v2/scripts/envelope.mjs
 *
 * Exit 0 inside the envelope, 1 past it, 2 if the chain could not be read —
 * so it can be wired to an alert later without rewriting.
 */

const ALGOD = process.env.ALGOD_URL ?? "https://mainnet-api.algonode.cloud";

/** Live on mainnet. Mirrors web/src/lib/magnetfi.ts — update both together. */
const ORACLE = 3741272132;
const VAULT = 3671287267;
const PSM = 3644230181;
const MUSD = 3615600399;
const USDC = 31566704;

/** AUDIT.md:1077 — "the audit quantified the safe envelope (< ~$100k ...)". */
const ENVELOPE_USD = 100_000;

const get = async (path) => {
  const r = await fetch(`${ALGOD}${path}`);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};

/** Algorand's application address, without pulling in the SDK for one call. */
async function appAddress(id) {
  const { createHash } = await import("node:crypto");
  const buf = Buffer.concat([
    Buffer.from("appID"),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(id)); return b; })(),
  ]);
  const digest = createHash("sha512-256").update(buf).digest();
  // base32 (RFC 4648, no padding) + 4-byte checksum, as Algorand encodes it.
  const checksum = createHash("sha512-256").update(digest).digest().subarray(28);
  const full = Buffer.concat([digest, checksum]);
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const byte of full) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Global state as [keyBuffer, value] pairs.
 *
 * Deliberately NOT an object: the oracle's price keys are `lp_price_` plus a
 * raw 8-byte pool id, and routing those bytes through an object key
 * stringifies them as UTF-8 and corrupts the id. The first version of this
 * script did exactly that and reported $0.00 of collateral — a silent zero,
 * which is the worst possible failure for a script whose whole job is to say
 * whether a ceiling has been crossed.
 */
const globals = (app) => (app.params["global-state"] ?? []).map((kv) => [
  Buffer.from(kv.key, "base64"),
  kv.value.type === 2 ? kv.value.uint : Buffer.from(kv.value.bytes, "base64"),
]);

async function main() {
  // ── posted LP prices, keyed `lp_price_` + 8-byte pool id ──
  const prices = new Map();
  for (const [raw, v] of globals(await get(`/v2/applications/${ORACLE}`))) {
    if (raw.length === 17 && raw.subarray(0, 9).toString() === "lp_price_") {
      prices.set(Number(raw.readBigUInt64BE(9)), v);
    }
  }
  if (prices.size === 0) {
    console.error("no lp_price_ globals found on the oracle — refusing to report $0");
    process.exit(2);
  }

  // ── collateral actually held by the vault, valued at those prices ──
  const vault = await get(`/v2/accounts/${await appAddress(VAULT)}`);
  let collateralUsd = 0;
  const rows = [];
  for (const a of vault.assets ?? []) {
    const price = prices.get(a["asset-id"]);
    if (!price || a.amount === 0) continue;
    const { params } = await get(`/v2/assets/${a["asset-id"]}`);
    const units = a.amount / 10 ** (params.decimals ?? 6);
    const usd = units * (price / 1e6);
    collateralUsd += usd;
    rows.push([a["asset-id"], units, price / 1e6, usd]);
  }

  // ── PSM backing, and the mUSD it permits to exist ──
  const psmAcct = await get(`/v2/accounts/${await appAddress(PSM)}`);
  const usdc = (psmAcct.assets ?? []).find((x) => x["asset-id"] === USDC)?.amount ?? 0;
  const psmMusd = (psmAcct.assets ?? []).find((x) => x["asset-id"] === MUSD)?.amount ?? 0;
  const supply = Number((await get(`/v2/assets/${MUSD}`)).params.total);
  const circulating = supply - psmMusd;
  // issue_musd: circulating + amount <= on-chain USDC + deployed backing.
  // deployed is zero while no adapter is wired; adapter_ids all-zero confirms.
  const headroom = Math.max(0, usdc - circulating);

  const m = (n) => `$${(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  console.log("MagnetFi — collateral against the reviewed envelope\n");
  for (const [asa, units, px, usd] of rows) {
    console.log(`  asa ${asa}  ${units.toFixed(3).padStart(14)} LP  x ${m(px)}  = ${m(usd).padStart(14)}`);
  }
  console.log(`  ${"collateral-pool TVL".padEnd(30)} ${m(collateralUsd).padStart(14)}`);
  console.log(`  ${"reviewed envelope".padEnd(30)} ${m(ENVELOPE_USD).padStart(14)}  (AUDIT.md:1077)`);
  const headroomX = collateralUsd > 0 ? `${(ENVELOPE_USD / collateralUsd).toFixed(1)}x` : "n/a";
  console.log(`  ${"headroom".padEnd(30)} ${headroomX.padStart(14)}\n`);
  console.log(`  ${"PSM USDC".padEnd(30)} ${m(usdc / 1e6).padStart(14)}`);
  console.log(`  ${"mUSD circulating".padEnd(30)} ${m(circulating / 1e6).padStart(14)}`);
  console.log(`  ${"mintable headroom".padEnd(30)} ${m(headroom / 1e6).padStart(14)}`);

  if (collateralUsd >= ENVELOPE_USD) {
    console.log(`\n  PAST THE ENVELOPE. Due before growing further, per AUDIT.md and`);
    console.log(`  ORACLE_LEAN_SPEC.md: restore a wide on-chain bound on update_lp_price,`);
    console.log(`  and commission the external audit.`);
    process.exit(1);
  }
  console.log(`\n  Inside the envelope.`);
}

main().catch((e) => { console.error("could not read chain:", e.message); process.exit(2); });
