// Perps — PEX oracle payload fetch, decode and verification.
//
// Perps runs no feed of its own; it consumes PEX's signed payloads. See
// strategy/ORACLE.md. This module's whole job is to make sure that the numbers we
// SHOW a user are the numbers we SEND to the chain.
//
// ── Why decoding is not optional ─────────────────────────────────────────────
// The published bundle carries each payload twice: as convenient JSON fields
// (index_price_min, index_price_max, ...) and as `message_hex`, the bytes the
// signature actually covers. Only the second is authenticated. Reading the JSON
// fields for display while submitting the bytes means the price on screen and
// the price on chain have no enforced relationship.
//
// So: every number this module returns is decoded from the signed bytes. The
// JSON fields are used for routing and nothing else.
//
// ── What client-side verification is and is not for ──────────────────────────
// The contract verifies the signature itself, so a forged payload costs a failed
// transaction rather than funds. Verifying here is a DISPLAY-honesty control: it
// stops us quoting a price that could never have executed. That is why a
// verification failure blocks opens but is not treated as a fund-safety event.

import {
  ALGORAND_MAINNET_GENESIS_HASH_HEX,
  ORACLE_MAX_AGE_SEC,
  PEX_ORACLE_BUNDLE_URL,
  PEX_ORACLE_SIGNER_PUBKEY_HEX,
} from "./perps";

// ── Signed message layout (133 bytes, pinned) ─────────────────────────────────
// magic "PDX2" | version:u8 | genesisHash:32 | then twelve big-endian uint64s.
const MSG_LEN = 133;
const MAGIC = "PDX2";
const MSG_VERSION = 3;
const HEADER_LEN = 4 + 1 + 32;

const MSG_WORDS = [
  "targetAppId", "marketId", "indexAssetId", "longAssetId", "shortAssetId",
  "indexMinPrice", "indexMaxPrice", "longMinPrice", "longMaxPrice",
  "shortMinPrice", "shortMaxPrice", "publishedAt",
] as const;

export type OracleMessage = Record<(typeof MSG_WORDS)[number], bigint> & {
  genesisHashHex: string;
};

export type OraclePayload = {
  /** The exact bytes the signature covers — pass these to the builder unchanged. */
  message: Uint8Array;
  signature: Uint8Array;
  /** Decoded from `message`, never from the bundle's JSON fields. */
  decoded: OracleMessage;
  /** Mid price, Price12. Derived from the signed min/max. */
  indexPrice12: bigint;
  ageSeconds: number;
  signatureVerified: boolean;
};

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("perps oracle: odd-length hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

/** Decode the signed bytes against the pinned layout. Throws on any mismatch. */
export function decodeOracleMessage(message: Uint8Array): OracleMessage {
  if (message.length !== MSG_LEN) {
    throw new Error(`perps oracle: message is ${message.length} bytes, expected ${MSG_LEN}`);
  }
  const magic = String.fromCharCode(...Array.from(message.slice(0, 4)));
  if (magic !== MAGIC) throw new Error(`perps oracle: bad magic ${JSON.stringify(magic)}`);
  if (message[4] !== MSG_VERSION) {
    throw new Error(`perps oracle: message version ${message[4]}, expected ${MSG_VERSION}`);
  }

  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const out = { genesisHashHex: bytesToHex(message.slice(5, 37)) } as OracleMessage;
  MSG_WORDS.forEach((name, i) => {
    out[name] = view.getBigUint64(HEADER_LEN + i * 8, false);
  });
  return out;
}

/**
 * Ed25519 verification via WebCrypto.
 *
 * Returns false rather than throwing when the runtime has no Ed25519: callers
 * gate opens on the flag, so an unsupported browser degrades to "cannot open"
 * instead of "opens without checking".
 */
async function verifyEd25519(message: Uint8Array, signature: Uint8Array, pubkey: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(pubkey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      Uint8Array.from(signature) as unknown as BufferSource,
      Uint8Array.from(message) as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

type BundleEntry = {
  app_id: number;
  market_id: number;
  message_hex: string;
  signature_hex: string;
  pubkey_hex: string;
};

/** Fetch the published bundle. No auth, no backend of ours in the path. */
export async function fetchOracleBundle(
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, BundleEntry>> {
  const res = await fetchImpl(PEX_ORACLE_BUNDLE_URL, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`perps oracle: bundle fetch failed ${res.status}`);
  const body = (await res.json()) as { payloads?: Record<string, BundleEntry> };
  if (!body?.payloads) throw new Error("perps oracle: bundle has no payloads");
  return body.payloads;
}

/**
 * Resolve one target-bound payload and check everything about it.
 *
 * Every assertion here answers a specific substitution: the wrong app, the wrong
 * market, the wrong network, the wrong signer, or a price old enough to have
 * moved. A payload that fails any of them is refused rather than downgraded.
 */
export async function getOraclePayload(
  appId: number,
  marketId: number,
  opts: { fetchImpl?: typeof fetch; nowSec?: number; maxAgeSec?: number; bundle?: Record<string, BundleEntry> } = {},
): Promise<OraclePayload> {
  const payloads = opts.bundle ?? (await fetchOracleBundle(opts.fetchImpl ?? fetch));
  const key = `app-${appId}/market-${marketId}`;
  const entry = payloads[key];
  if (!entry) throw new Error(`perps oracle: no payload for ${key}`);

  // The bundle names the signer; we do not take its word for it.
  if (entry.pubkey_hex?.toLowerCase() !== PEX_ORACLE_SIGNER_PUBKEY_HEX) {
    throw new Error("perps oracle: payload signer is not the pinned PEX signer");
  }

  const message = hexToBytes(entry.message_hex);
  const signature = hexToBytes(entry.signature_hex);
  const decoded = decodeOracleMessage(message);

  // Target binding, read from the SIGNED bytes rather than the JSON envelope.
  if (decoded.targetAppId !== BigInt(appId)) {
    throw new Error(`perps oracle: payload is bound to app ${decoded.targetAppId}, not ${appId}`);
  }
  if (decoded.marketId !== BigInt(marketId)) {
    throw new Error(`perps oracle: payload is bound to market ${decoded.marketId}, not ${marketId}`);
  }
  if (decoded.genesisHashHex !== ALGORAND_MAINNET_GENESIS_HASH_HEX) {
    throw new Error("perps oracle: payload is not for Algorand MainNet");
  }

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const ageSeconds = nowSec - Number(decoded.publishedAt);
  const maxAge = opts.maxAgeSec ?? ORACLE_MAX_AGE_SEC;
  if (ageSeconds > maxAge) {
    throw new Error(`perps oracle: payload is ${ageSeconds}s old, limit ${maxAge}s`);
  }
  // A payload from the future is a clock problem on one side or a fabrication on
  // the other. Neither is a thing to quote against.
  if (ageSeconds < -5) {
    throw new Error(`perps oracle: payload is ${-ageSeconds}s in the future`);
  }

  if (decoded.indexMinPrice > decoded.indexMaxPrice || decoded.indexMinPrice === BigInt(0)) {
    throw new Error("perps oracle: index price band is malformed");
  }

  const signatureVerified = await verifyEd25519(message, signature, hexToBytes(PEX_ORACLE_SIGNER_PUBKEY_HEX));

  return {
    message,
    signature,
    decoded,
    indexPrice12: (decoded.indexMinPrice + decoded.indexMaxPrice) / BigInt(2),
    ageSeconds,
    signatureVerified,
  };
}

/** Price12 -> dollars, for display only. */
export const price12ToUsd = (p: bigint): number => Number(p) / 1e12;
