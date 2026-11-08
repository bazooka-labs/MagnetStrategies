/**
 * $U is on the ASA TVL board, and the confidence floor still admits it.
 *
 * ── Why this needs watching rather than trusting ─────────────────────────
 * The eligibility floor is a number we picked against a model we do not
 * control. On 2026-11-07 Vestige's confidence for $U fell under the then-gate
 * of 8000 bps and the rank cell went blank — no error, no failing test, just
 * "…" where a number had been. It was noticed by a person looking at the
 * page, which is the slowest possible detector.
 *
 * The cause was not a fault: the U/uALGO pool opened three days earlier and
 * is now the largest single $U pool at 22.6% of its liquidity, against a
 * counterparty Vestige rates 7384 bps. Normal protocol growth moved the
 * number. It will move again.
 *
 * The floor is now 7500 against a measured 7599, which is ~99 bps of
 * headroom and thin on purpose — "just enough", by decision. This test is
 * the other half of that decision: it fails in CI when the margin goes,
 * instead of the UI going quiet.
 */

import { describe, expect, it } from "vitest";
import { MAGNET_ASA_ID, fetchBoard } from "@/lib/leaderboard";

describe("the ASA TVL board, live", () => {
  it("includes $U at all — the thing that silently stopped being true", async () => {
    const board = await fetchBoard();
    expect(board, "the board could not be built").not.toBeNull();
    expect(
      board!.magnet,
      "$U is absent from the board. Its Vestige confidence has fallen below "
      + "MIN_ASSET_CONFIDENCE_BPS again — read the note on that constant, check "
      + "the live figure, and decide whether to move the floor or let it stand.",
    ).not.toBeNull();
  }, 90_000);

  it("reports how much headroom is left over the floor", async () => {
    /*
      Not a threshold assertion — a reading, printed so a thin margin is
      visible in the run rather than inferred after it breaks. The hard
      failure is the test above; this is the early warning in front of it.
    */
    const board = await fetchBoard();
    const m = board?.magnet;
    expect(m).toBeTruthy();
    const margin = (m!.confidenceBps ?? 0) - 7500;
    // eslint-disable-next-line no-console
    console.log(
      `$U confidence ${m!.confidenceBps} bps, floor 7500, margin ${margin} bps`
      + `  (rank ${m!.rank}, ${m!.pools} pools)`,
    );
    expect(m!.confidenceBps).toBeGreaterThanOrEqual(7500);
  }, 90_000);

  it("ranks $U somewhere sane, not at the very bottom of the board", async () => {
    // A rank of 600-something would mean the TVL arithmetic broke rather than
    // the gate — a different failure wearing the same blank cell.
    const board = await fetchBoard();
    expect(board!.magnet!.rank).toBeGreaterThan(0);
    expect(board!.magnet!.rank).toBeLessThan(200);
    expect(board!.magnet!.assetId).toBe(MAGNET_ASA_ID);
    expect(board!.magnet!.tvlUsd).toBeGreaterThan(1_000);
  }, 90_000);
});
