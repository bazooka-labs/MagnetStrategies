/**
 * Cost basis — what the shares you hold right now actually cost.
 *
 * The risk here is one-directional: an overstated basis understates a gain
 * (annoying), an understated basis OVERSTATES it (not acceptable on a money
 * surface). So every case that does not reconcile exactly must return null
 * rather than approximate, and that is what these pin.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { readCostBasis } from "./costBasis";

/** A deposit receipt: 11 uint64s after the 6-byte ABI prefix. */
const receipt = (paidMicro: number, sharesMicro: number) => {
  const b = Buffer.alloc(6 + 11 * 8);
  b.writeUInt32BE(0x151f7c75, 0);
  b.writeUInt16BE(11 * 8, 4);
  b.writeBigUInt64BE(BigInt(paidMicro), 6 + 4 * 8);    // field 4 — paid
  b.writeBigUInt64BE(BigInt(sharesMicro), 6 + 5 * 8);  // field 5 — shares
  return new Uint8Array(b);
};
const sel = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

const tx = (selector: string, round: number, log?: Uint8Array) => ({
  confirmedRound: round,
  applicationTransaction: { applicationArgs: [sel(selector)] },
  ...(log ? { logs: [log] } : {}),
});

const indexerWith = (transactions: unknown[]) => ({
  searchForTransactions: () => ({
    address: () => ({
      applicationID: () => ({
        limit: () => ({ do: () => Promise.resolve({ transactions }) }),
      }),
    }),
  }),
}) as never;

afterEach(() => vi.restoreAllMocks());

describe("it answers what the CURRENT shares cost", () => {
  it("uses the amount that left the wallet, not the credited value", async () => {
    // $25.00 deposited; the 0.2% spread credits ~$24.95 of shares. The basis
    // must be 25.00 — hiding the spread inside the basis is the whole failure
    // this guards against.
    const r = await readCostBasis(
      indexerWith([tx("b2eea014", 100, receipt(25_000_000, 20_831_065))]),
      "ADDR", 20.831065,
    );
    expect(r?.paidUsd).toBe(25);
    expect(r?.deposits).toBe(1);
  });

  it("ignores a position that was fully exited and re-entered", async () => {
    /**
     * The real history on 2026-10-28: $7.00 deposited, fully withdrawn, then
     * $25.00 deposited. The holder's 20.831065 shares came from the second
     * deposit alone, so the basis is $25.00 — not $32.00.
     */
    const r = await readCostBasis(
      indexerWith([
        tx("b2eea014", 66268323, receipt(7_000_000, 5_874_225)),
        tx("e8e9f32d", 66273320),
        tx("b2eea014", 66331559, receipt(25_000_000, 20_831_065)),
      ]),
      "ADDR", 20.831065,
    );
    expect(r?.paidUsd).toBe(25);
    expect(r?.deposits).toBe(1);
  });

  it("sums several deposits when all of them are still held", async () => {
    const r = await readCostBasis(
      indexerWith([
        tx("b2eea014", 100, receipt(10_000_000, 8_000_000)),
        tx("b2eea014", 200, receipt(15_000_000, 12_000_000)),
      ]),
      "ADDR", 20,
    );
    expect(r?.paidUsd).toBe(25);
    expect(r?.deposits).toBe(2);
  });

  it("reads deposits newest-first regardless of indexer order", async () => {
    const r = await readCostBasis(
      indexerWith([
        tx("b2eea014", 999, receipt(25_000_000, 20_831_065)),
        tx("b2eea014", 1, receipt(7_000_000, 5_874_225)),
      ]),
      "ADDR", 20.831065,
    );
    expect(r?.paidUsd).toBe(25);
  });
});

describe("it refuses rather than approximating", () => {
  it("returns null on a partial exit that matches no suffix", async () => {
    // 20.831065 minted, 15 held. No combination of whole deposits explains
    // that, so the basis is unknown and must not be guessed.
    const r = await readCostBasis(
      indexerWith([tx("b2eea014", 100, receipt(25_000_000, 20_831_065))]),
      "ADDR", 15,
    );
    expect(r).toBeNull();
  });

  it("returns null when the deposits cannot cover the shares held", async () => {
    const r = await readCostBasis(
      indexerWith([tx("b2eea014", 100, receipt(7_000_000, 5_874_225))]),
      "ADDR", 20.831065,
    );
    expect(r).toBeNull();
  });

  it("returns null with no deposits, and with no shares", async () => {
    expect(await readCostBasis(indexerWith([]), "ADDR", 5)).toBeNull();
    expect(await readCostBasis(indexerWith([tx("b2eea014", 1, receipt(1, 1))]), "ADDR", 0)).toBeNull();
  });

  it("returns null rather than throwing when the indexer fails", async () => {
    const broken = {
      searchForTransactions: () => ({
        address: () => ({
          applicationID: () => ({
            limit: () => ({ do: () => Promise.reject(new Error("indexer down")) }),
          }),
        }),
      }),
    } as never;
    await expect(readCostBasis(broken, "ADDR", 5)).resolves.toBeNull();
  });

  it("skips a deposit whose receipt is missing", async () => {
    // No log means no basis for that deposit; the suffix cannot reconcile.
    const r = await readCostBasis(
      indexerWith([tx("b2eea014", 100)]), "ADDR", 20.831065,
    );
    expect(r).toBeNull();
  });
});
