/**
 * The harvest log's arithmetic.
 *
 * Small surface, one trap: $U carries 5 decimals and ALGO 6, so the realised
 * conversion rate is the one figure in this module that can silently be 10x
 * wrong — the same trap `accruedReward` carries, in a different place. The
 * fixture below is the first three real harvests, so the expected rate is a
 * measured number rather than one derived from the code under test.
 */

import { describe, expect, it, vi } from "vitest";
import {
  assertHarvestsFromPinnedApp, harvestTotals, realisedRewardPerAlgo,
} from "./events";
import { DUALSTAKE_APP_ID } from "./config";
import type { Harvest } from "./yield";

/** Measured 2026-11-05 to 2026-11-06, rounds 66654225 / 66666169 / 66694896. */
const REAL: Harvest[] = [
  { round: 66_694_896, timestamp: 1_793_965_320, algoMicro: BigInt(7_659_112), rewardBase: BigInt(517_363) },
  { round: 66_666_169, timestamp: 1_793_886_180, algoMicro: BigInt(7_650_229), rewardBase: BigInt(516_308) },
  { round: 66_654_225, timestamp: 1_793_853_240, algoMicro: BigInt(7_555_326), rewardBase: BigInt(512_043) },
];

describe("harvestTotals", () => {
  it("sums the real log", () => {
    const t = harvestTotals(REAL)!;
    expect(t.count).toBe(3);
    expect(t.algoMicro).toBe(BigInt(22_864_667));   // 22.864667 ALGO
    expect(t.rewardBase).toBe(BigInt(1_545_714));   // 15.45714 $U
  });

  it("returns null for an empty log rather than a row of zeroes", () => {
    // "No harvests yet" and "0 ALGO harvested" read the same and are not.
    expect(harvestTotals([])).toBeNull();
  });

  it("gives no span for a single harvest", () => {
    // One point is not a window, and a zero-day window would divide by zero
    // in anything that tried to rate it.
    expect(harvestTotals([REAL[0]])!.days).toBeNull();
  });

  it("spans first to last regardless of the order it is given", () => {
    const forward = harvestTotals([...REAL].reverse())!;
    const backward = harvestTotals(REAL)!;
    expect(forward.days).toBeCloseTo(backward.days!, 9);
    expect(forward.days!).toBeGreaterThan(0);
  });

  it("ignores missing timestamps when computing the span", () => {
    const partial: Harvest[] = [
      { ...REAL[0], timestamp: 0 }, REAL[1], REAL[2],
    ];
    const t = harvestTotals(partial)!;
    // Still a real span from the two it could read, not a 1970 epoch span.
    expect(t.days).toBeCloseTo((1_793_886_180 - 1_793_853_240) / 86_400, 6);
  });
});

describe("realisedRewardPerAlgo — the 6dp/5dp trap", () => {
  it("matches the rate the contract actually achieved", () => {
    // 15.45714 $U for 22.864667 ALGO. Both scales applied, in the right
    // direction: a version that assumed matching decimals returns 0.0676.
    expect(realisedRewardPerAlgo(REAL)).toBeCloseTo(0.67603, 5);
  });

  it("is not out by a factor of ten", () => {
    // The specific failure this guards. 10x and 0.1x are both excluded, so
    // the assertion cannot be satisfied by the wrong scaling in either
    // direction.
    const r = realisedRewardPerAlgo(REAL)!;
    expect(r).toBeGreaterThan(0.1);
    expect(r).toBeLessThan(1);
  });

  it("agrees with each individual harvest, so the total is not hiding a drift", () => {
    for (const h of REAL) {
      expect(realisedRewardPerAlgo([h])!).toBeCloseTo(0.676, 2);
    }
  });

  it("returns null rather than dividing by zero ALGO", () => {
    expect(realisedRewardPerAlgo([])).toBeNull();
    expect(realisedRewardPerAlgo([{ ...REAL[0], algoMicro: BigInt(0) }])).toBeNull();
  });
});

describe("assertHarvestsFromPinnedApp", () => {
  it("accepts transactions against the app we pinned", () => {
    expect(assertHarvestsFromPinnedApp([
      { applicationTransaction: { applicationId: BigInt(DUALSTAKE_APP_ID) } },
      { applicationTransaction: { applicationId: DUALSTAKE_APP_ID } },
    ])).toBe(true);
  });

  it("rejects a log borrowed from a DIFFERENT dualSTAKE contract", () => {
    // Myth run several. Another one's harvests are a plausible-looking set of
    // numbers describing someone else's product, which is worse than none.
    expect(assertHarvestsFromPinnedApp([
      { applicationTransaction: { applicationId: BigInt(DUALSTAKE_APP_ID) } },
      { applicationTransaction: { applicationId: BigInt(2_933_534_328) } },
    ])).toBe(false);
  });

  it("tolerates a non-app transaction, which carries no app id to check", () => {
    expect(assertHarvestsFromPinnedApp([{}])).toBe(true);
  });
});

/**
 * The pagination loop itself.
 *
 * ── Why this file has to fake an indexer ──
 * Mutation run, 2026-11-07: breaking the loop after its first page SURVIVED
 * both suites. The hermetic tests mock `readHarvests` whole, and the live
 * test cannot reach it either — the contract has well under one page of
 * transactions today, so a single-page scan and an exhaustive one return the
 * same thing on MainNet and will keep doing so until the day the loop is
 * actually needed. That is precisely the day a silent truncation would start
 * mattering, which is the defect this loop was written to fix.
 *
 * So the indexer is faked, and the loop is driven over page boundaries it
 * will not see in production for months.
 */
describe("readHarvests — paging to the end of the record", () => {
  const PAGE = 1000;

  /**
   * `pages` is a list of transaction-count + harvest-count per page.
   *
   * ── The fake SERVES the token, it does not ignore it ──
   * The first version advanced on an internal counter and accepted
   * `nextToken()` as a no-op, so deleting the call that sends the token
   * survived the mutation run: the fake paged correctly whether the code
   * asked for page two or asked for page one again. A real indexer would
   * have returned page one forever and the scan would have looped on the
   * same thousand transactions.
   *
   * Now the page served is decided by the token presented, and a request
   * that should carry one and does not is recorded as a fault.
   *
   * `endsWithToken` models the other thing a real indexer may do: hand back
   * a short page that still carries a continuation token.
   */
  function fakeIndexer(
    pages: { count: number; harvests: number }[],
    { endsWithToken = false } = {},
  ) {
    let calls = 0;
    let pending: string | undefined;     // token the NEXT request must carry
    let presented: string | undefined;   // token this request carried
    const faults: string[] = [];

    const query = {
      applicationID: () => query,
      limit: () => query,
      nextToken: (t: string) => { presented = t; return query; },
      do: async () => {
        if (pending !== presented) {
          faults.push(`page ${calls}: expected token ${pending}, got ${presented}`);
        }
        // The page served follows the token, exactly as an indexer's does.
        const index = pending ? Number(pending.replace("tok", "")) : 0;
        const p = pages[index] ?? { count: 0, harvests: 0 };
        const transactions = Array.from({ length: p.count }, (_, i) => ({
          _page: index, _harvest: i < p.harvests, _i: i,
        }));
        const last = index === pages.length - 1;
        pending = last && !endsWithToken ? undefined : `tok${index + 1}`;
        presented = undefined;
        calls += 1;
        return { transactions, nextToken: pending };
      },
    };
    return {
      query, searchForTransactions: () => query,
      calls: () => calls, faults: () => faults,
    };
  }

  /** A client that turns the marked fixtures into swap events. */
  const fakeClient = {
    getParsedArc28EventsFromTransaction: (t: {
      _page: number; _harvest: boolean; _i: number;
    }) => t._harvest ? [{
      spec: { name: "swap" },
      argsByName: { algo_amount: BigInt(7_600_000), asa_amount: BigInt(513_000) },
      outerTransaction: {
        confirmedRound: 66_000_000 + t._page * 10_000 + t._i,
        roundTime: 1_793_000_000 + t._page * 1000 + t._i,
      },
    }] : [],
  };

  async function scan(
    pages: { count: number; harvests: number }[],
    opts: { endsWithToken?: boolean } = {},
  ) {
    const idx = fakeIndexer(pages, opts);
    vi.doMock("algosdk", async (orig) => {
      const real = await orig<Record<string, unknown>>();
      return { ...real, default: { ...(real.default as object), Indexer: function () { return idx; } } };
    });
    vi.doMock("./reads", () => ({ readClient: () => fakeClient }));
    vi.resetModules();
    const { readHarvests } = await import("./events");
    const out = await readHarvests("https://algod.test", "https://idx.test");
    vi.doUnmock("algosdk");
    vi.doUnmock("./reads");
    vi.resetModules();
    return { out, pagesFetched: idx.calls(), faults: idx.faults() };
  }

  it("stops at a short page, and calls it complete", async () => {
    // The ordinary case today: 91 transactions, one call, done.
    const { out, pagesFetched } = await scan([{ count: 91, harvests: 3 }]);
    expect(pagesFetched).toBe(1);
    expect(out!.complete).toBe(true);
    expect(out!.scanned).toBe(91);
    expect(out!.harvests.length).toBe(3);
  });

  it("follows the continuation token across a FULL page", async () => {
    // The mutation that survived both suites: break after page one. A full
    // page means the indexer has more, and the harvests on page two are the
    // OLDEST ones — exactly the rows a truncated scan loses.
    const { out, pagesFetched, faults } = await scan([
      { count: PAGE, harvests: 2 },
      { count: PAGE, harvests: 3 },
      { count: 120, harvests: 1 },
    ]);
    expect(pagesFetched).toBe(3);
    expect(out!.complete).toBe(true);
    expect(out!.scanned).toBe(PAGE * 2 + 120);
    expect(out!.harvests.length).toBe(6);
    // Every page after the first asked for itself by token.
    expect(faults).toEqual([]);
  });

  it("stops on a SHORT page even when the indexer still offers a token", async () => {
    /*
      A short page means the indexer had nothing more to fill it with, token
      or not. Without this the scan would keep asking — and on an indexer
      that always returns a token, it would run to the page cap and then
      report a complete history as truncated.
    */
    const { out, pagesFetched } = await scan(
      [{ count: PAGE, harvests: 1 }, { count: 40, harvests: 2 }],
      { endsWithToken: true });
    expect(pagesFetched).toBe(2);
    expect(out!.complete).toBe(true);
    expect(out!.harvests.length).toBe(3);
  });

  it("returns newest first across page boundaries", async () => {
    // Pages arrive newest-first from the indexer, but the sort has to hold
    // across them or the modal's first row is not the latest harvest.
    const { out } = await scan([
      { count: PAGE, harvests: 2 },
      { count: 50, harvests: 2 },
    ]);
    const rounds = out!.harvests.map((h) => h.round);
    expect(rounds).toEqual([...rounds].sort((a, b) => b - a));
  });

  it("reports INCOMPLETE rather than silently truncating at the page cap", async () => {
    // Twelve full pages with a token still outstanding. The modal retitles
    // itself on this flag; without it the list quietly loses its oldest rows
    // while the heading still says "Every harvest so far".
    const { out, pagesFetched } = await scan(
      Array.from({ length: 20 }, () => ({ count: PAGE, harvests: 1 })));
    expect(pagesFetched).toBe(12);
    expect(out!.complete).toBe(false);
    expect(out!.scanned).toBe(PAGE * 12);
    expect(out!.harvests.length).toBe(12);
  });

  it("is complete when the last page fills exactly and the token runs out", async () => {
    // A page that is full but final: `nextToken` absent is the authority,
    // and treating a full page alone as "more to come" would report a
    // complete scan as truncated.
    const { out } = await scan([{ count: PAGE, harvests: 1 }]);
    expect(out!.complete).toBe(true);
  });
});
