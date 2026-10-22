/**
 * The oracle signer pin, and its drift detector.
 *
 * PEX rotated this key on 2026-10-22 with no notice. Our pin refused every
 * fresh payload — correct — but a client holding a cached pre-rotation bundle
 * passed the local check and was rejected on chain at
 * `AdminOps pc=6785, ed25519verify_bare; assert`, after the wallet prompt. A
 * real user hit that on a withdrawal.
 *
 * These pin the current key and the detector's behaviour, so the next rotation
 * is one legible sentence instead of a TEAL assert inside someone else's app.
 */
import { describe, expect, it } from "vitest";
import {
  PEX_ORACLE_SIGNER_PUBKEY_HEX, ORACLE_SIGNER_SOURCES, PEX_APPS,
} from "./perps";
import { verifyOracleSignerPin, signerDriftMessage } from "./perpsReads";

const NEW = "ac4b7131e62f4a715e4357f237b996d335b96b2127731cc44b6d34eb932ec9b6";
const OLD = "4cc6bcc8c281d1e1b5eec887adc373fee95f6e580125132e72303618d2e3dffb";

/** `oc` / `q` are the 32-byte key followed by a max-age and a zero. */
const ocBytes = (keyHex: string) => {
  const out = new Uint8Array(48);
  out.set(Uint8Array.from(Buffer.from(keyHex, "hex")), 0);
  new DataView(out.buffer).setBigUint64(32, BigInt(30));
  return out;
};

function fakeAlgod(keyByApp: Record<number, string | null>) {
  return {
    getApplicationByID: (app: number) => ({
      do: async () => {
        const k = keyByApp[app];
        if (k === null) throw new Error("unreadable");
        const key = ORACLE_SIGNER_SOURCES.find((s) => s.app === app)!.key;
        return {
          params: {
            globalState: [{ key: Buffer.from(key, "utf8"), value: { bytes: ocBytes(k!), type: 1 } }],
          },
        };
      },
    }),
  } as never;
}

const all = (k: string) =>
  Object.fromEntries(ORACLE_SIGNER_SOURCES.map((s) => [s.app, k]));

describe("the pinned signer", () => {
  it("is the key PEX rotated to on 2026-10-22", () => {
    expect(PEX_ORACLE_SIGNER_PUBKEY_HEX).toBe(NEW);
    expect(PEX_ORACLE_SIGNER_PUBKEY_HEX).not.toBe(OLD);
    expect(PEX_ORACLE_SIGNER_PUBKEY_HEX).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names every app that stores it, including the liquidity ones", () => {
    const apps = ORACLE_SIGNER_SOURCES.map((s) => s.app);
    // AdminOps and CvaVault are the liquidity paths' verifiers; neither was in
    // the original list, because the terminal never called them.
    expect(apps).toContain(PEX_APPS.adminOps);
    expect(apps).toContain(PEX_APPS.cvaVault);
    expect(apps).toContain(PEX_APPS.trading);
    expect(apps).toContain(PEX_APPS.orderOps);
    // Trading stores it under "q"; everything else under "oc".
    expect(ORACLE_SIGNER_SOURCES.find((s) => s.app === PEX_APPS.trading)!.key).toBe("q");
    expect(ORACLE_SIGNER_SOURCES.find((s) => s.app === PEX_APPS.adminOps)!.key).toBe("oc");
  });
});

describe("drift detection", () => {
  it("passes when every app holds the pinned key", async () => {
    const r = await verifyOracleSignerPin(fakeAlgod(all(NEW)));
    expect(r.ok).toBe(true);
    expect(r.drifted).toEqual([]);
    expect(r.onChain).toBe(NEW);
  });

  it("catches a full rotation — the 2026-10-22 event", async () => {
    const r = await verifyOracleSignerPin(fakeAlgod(all(OLD)));
    expect(r.ok).toBe(false);
    expect(r.drifted.length).toBe(ORACLE_SIGNER_SOURCES.length);
    expect(r.onChain).toBe(OLD);
    const msg = signerDriftMessage(r);
    expect(msg).toContain("rotated");
    expect(msg).toContain("Nothing was sent");
    // Must name both keys so the fix is obvious from the message alone.
    expect(msg).toContain(OLD.slice(0, 16));
    expect(msg).toContain(NEW.slice(0, 16));
  });

  it("catches a PARTIAL rotation, which is the dangerous shape", async () => {
    // Mid-rotation, some apps verify against the new key and some the old. A
    // check that stopped at the first app would call this fine.
    const mixed = { ...all(NEW), [PEX_APPS.adminOps]: OLD };
    const r = await verifyOracleSignerPin(fakeAlgod(mixed));
    expect(r.ok).toBe(false);
    expect(r.drifted).toEqual([{ app: PEX_APPS.adminOps, onChain: OLD }]);
    // No single key, so none is reported as "the" chain key.
    expect(r.onChain).toBeNull();
  });

  it("separates unreadable from drifted — unknown is not drift", async () => {
    const r = await verifyOracleSignerPin(
      fakeAlgod({ ...all(NEW), [PEX_APPS.cvaVault]: null }));
    expect(r.ok).toBe(true);
    expect(r.unreadable).toEqual([PEX_APPS.cvaVault]);
    expect(r.drifted).toEqual([]);
  });

  it("reads only the first 32 bytes, not the max-age tail", async () => {
    // `oc` is 48 bytes. Comparing the whole value would never match the pin.
    const r = await verifyOracleSignerPin(fakeAlgod(all(NEW)));
    expect(r.onChain).toHaveLength(64);
  });
});
