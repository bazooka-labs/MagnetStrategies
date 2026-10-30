#!/usr/bin/env node
/**
 * Does the deployed bytecode match the committed artifact?
 *
 * The question every review rests on, and the one easiest to assume. Run
 * 2026-10-30 it found that PSM v3 did NOT match — 3,038 bytes on chain
 * against 3,008 from source — which meant that contract could only be
 * reviewed by equivalence argument rather than by hash. The oracle and vault
 * matched exactly.
 *
 * Reads only. No key, no signing, no writes.
 *
 *     node magnetfi/v2/scripts/verify-bytecode.mjs
 *
 * Exit 0 if every contract matches, 1 if any differs, 2 if a source artifact
 * or the chain could not be read.
 *
 * A MISMATCH IS NOT AUTOMATICALLY A LOGIC CHANGE. A different compiler
 * version reorders stack-shuffling opcodes and shifts byte counts while
 * computing exactly the same thing. When this reports a difference, compare
 * the CONSTANTS and the semantic opcode sequence before concluding anything —
 * see OVERVIEW.md, "The committed PSM v3 artifact does not reproduce the
 * deployed bytecode", for how that was established the first time.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ALGOD = process.env.ALGOD_URL ?? "https://mainnet-api.algonode.cloud";
const SC = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts", "smart_contracts");

/** Mirrors web/src/lib/magnetfi.ts DEPLOYMENTS.mainnet — update both together. */
const TARGETS = [
  ["lean_oracle", 3741272132, join(SC, "lean_oracle", "LeanOracle.approval.teal")],
  ["vault", 3671287267, join(SC, "artifacts", "vault", "Vault.approval.teal")],
  ["psm_v3", 3644230181, join(SC, "artifacts", "psm_v3", "PSMv3.approval.teal")],
];

const short = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

let worst = 0;
for (const [name, appId, tealPath] of TARGETS) {
  let onchain, local;
  try {
    const app = await (await fetch(`${ALGOD}/v2/applications/${appId}`)).json();
    onchain = Buffer.from(app.params["approval-program"], "base64");
  } catch (e) {
    console.log(`${name.padEnd(12)} could not read app ${appId}: ${e.message}`);
    worst = Math.max(worst, 2);
    continue;
  }
  try {
    const res = await fetch(`${ALGOD}/v2/teal/compile`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: readFileSync(tealPath, "utf8"),
    });
    if (!res.ok) throw new Error(`compile ${res.status}: ${await res.text()}`);
    local = Buffer.from((await res.json()).result, "base64");
  } catch (e) {
    console.log(`${name.padEnd(12)} could not build ${tealPath}: ${e.message}`);
    worst = Math.max(worst, 2);
    continue;
  }

  const match = onchain.equals(local);
  if (!match) worst = Math.max(worst, 1);
  console.log(
    `${name.padEnd(12)} app ${String(appId).padEnd(11)} ` +
    `chain ${short(onchain)} (${String(onchain.length).padStart(5)}B)  ` +
    `source ${short(local)} (${String(local.length).padStart(5)}B)  ` +
    (match ? "MATCH" : "*** DIFFERS ***"),
  );
}

if (worst === 1) {
  console.log(`\n  A contract differs from its artifact. Before concluding the LOGIC`);
  console.log(`  changed, compare constants and the semantic opcode sequence — a`);
  console.log(`  compiler version bump alone shifts byte counts. See OVERVIEW.md.`);
}
process.exit(worst);
