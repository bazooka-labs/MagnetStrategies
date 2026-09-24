// Perps — protocol manifest loading.
//
// The PEX SDK cannot encode a single app-call argument without a protocol
// manifest. Its own loader fetches one from a builder backend over plain HTTP
// with no signature, no pinning and no version assertion.
//
// That manifest supplies the ABI method signatures used to ENCODE what the user
// signs and the box formats used to DECODE what the user is shown. Whoever
// controls it controls both. An attacker serving a poisoned manifest gets a
// group whose bytes mean something else to the real contract, and a full-group
// assertion that round-trips through the same poisoned spec and passes.
//
// So we ship it. The manifest is vendored into the repo, its SHA-256 is checked
// against the pin in perps.ts before it is handed to the SDK, and no network
// fetch is involved at any point.
//
// See strategy/perps/SPEC.md, "CRITICAL: The Backend Supplies Fund Destinations".

import { setProtocolManifest } from "@pdex/sdk";
import manifestJson from "./pexProtocolManifest.json";
import { PEX_PROTOCOL_MANIFEST_CANONICAL_SHA256, PEX_PROTOCOL_MANIFEST_SHA256 } from "./perps";

/**
 * Canonical bytes of the vendored manifest.
 *
 * NB: this re-serialises the parsed JSON rather than reading the file, because a
 * bundler hands us an object, not the original text. `JSON.stringify` of a
 * round-tripped object is NOT byte-identical to the source file, so the runtime
 * check is against the canonical pin, not the raw-file pin.
 */
const canonicalBytes = (): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(manifestJson));

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes) as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

let installed = false;
let installedHash: string | null = null;

export type ManifestStatus = {
  installed: boolean;
  /** Canonical-form hash actually computed at runtime. */
  hash: string | null;
  /** True when the raw vendored file matched the pin at build time. */
  pinnedRawSha256: string;
};

/**
 * Install the vendored manifest into the SDK, once.
 *
 * Throws if the manifest does not match its pin. That is deliberate and it
 * blocks every build path: a group encoded against an unverified ABI is exactly
 * the failure this module exists to prevent, and degrading to "encode anyway"
 * would defeat it entirely.
 */
export async function installProtocolManifest(): Promise<ManifestStatus> {
  if (installed) {
    return { installed: true, hash: installedHash, pinnedRawSha256: PEX_PROTOCOL_MANIFEST_SHA256 };
  }
  const hash = await sha256Hex(canonicalBytes());
  if (hash !== PEX_PROTOCOL_MANIFEST_CANONICAL_SHA256) {
    throw new Error(
      `perps: protocol manifest failed its pin (got ${hash.slice(0, 16)}…, expected ` +
      `${PEX_PROTOCOL_MANIFEST_CANONICAL_SHA256.slice(0, 16)}…). Refusing to encode against an unverified ABI.`,
    );
  }
  // The SDK keys manifests by version; 2 is the V2 protocol.
  setProtocolManifest(manifestJson as Record<string, unknown>, 2);
  installed = true;
  installedHash = hash;
  return { installed: true, hash, pinnedRawSha256: PEX_PROTOCOL_MANIFEST_SHA256 };
}

/** Test seam: forget the installed manifest so a test can re-install. */
export function resetProtocolManifestForTests(): void {
  installed = false;
  installedHash = null;
}
