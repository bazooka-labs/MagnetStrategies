// @vitest-environment jsdom

/**
 * The card's face, and the modal behind it.
 *
 * Two things this file is built to catch, both of which are absences rather
 * than errors — the class of defect the dualSTAKE audit found every serious
 * example of:
 *
 *   1. A rate rendered when we did not read one, or rendered confidently
 *      while the node that earns it is offline. `grossAprPct` is a property
 *      of the NETWORK, so it reads perfectly well while this contract earns
 *      nothing at all, which is the one state where a green 4.5% is flatly
 *      false.
 *
 *   2. Disclosure that was moved into the modal and quietly lost on the way.
 *      Consolidating a card is only legitimate if everything still exists
 *      somewhere, so the moved claims are asserted INSIDE the opened modal
 *      rather than assumed to have arrived.
 */

import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DualStakeSnapshot } from "@/lib/strategy/dualstake/reads";
import type { ConsensusYield, Harvest } from "@/lib/strategy/dualstake/yield";
import type { HarvestScan } from "@/lib/strategy/dualstake/events";

const HOLDER = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";

let wallet: { address: string | null; isConnected: boolean } =
  { address: null, isConnected: false };
const ALGOD = {} as unknown;   // stable identity — see LiquidityView.test.tsx

vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    algodClient: ALGOD, address: wallet.address,
    isConnected: wallet.isConnected, signTransactions: null,
  }),
}));

let snapshot: DualStakeSnapshot | null = null;
let consensus: ConsensusYield | null = null;
let scan: HarvestScan | null = null;
let holding: bigint | null = null;

vi.mock("@/lib/strategy/dualstake/reads", async (orig) => ({
  // The REAL converters and `accruedReward` — the 6dp/5dp scaling is part of
  // what the card is being tested on, and stubbing it would certify nothing.
  ...(await orig<Record<string, unknown>>()),
  readSnapshot: () => Promise.resolve(snapshot),
  readHolding: () => Promise.resolve(holding),
  readRewardHolding: () => Promise.resolve({ balance: BigInt(0), optedIn: false }),
}));
vi.mock("@/lib/strategy/dualstake/yield", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),      // real netAprPct
  readConsensusYield: () => Promise.resolve(consensus),
}));
vi.mock("@/lib/strategy/dualstake/events", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),      // real harvestTotals
  readHarvests: () => Promise.resolve(scan),
}));

/** MainNet, 2026-11-07. */
const SNAP: DualStakeSnapshot = {
  rate: BigInt(311_948),
  stakedMicroAlgo: BigInt("49853603266"),
  rewardBalance: BigInt(1_555_178),
  headroomMicroAlgo: BigInt("64950146396734"),
  platformFeeBps: 250,
  noderunnerFeeBps: 400,
  upgrading: false,
  earning: true,
  round: BigInt(66_735_046),
};

/** The same day's network parameters: 4.827% gross, 4.513% net of 650bps. */
const YIELD: ConsensusYield = {
  round: BigInt(66_735_046),
  onlineStakeMicroAlgo: BigInt("1970550180769000"),
  payoutPerBlockMicroAlgo: BigInt(8_186_062),
  blockSeconds: 19 / 7,
  paidSamples: 8,
  grossAprPct: 4.8268,
};

/** A complete scan: the indexer reached the beginning of the record. */
const complete = (harvests: Harvest[]): HarvestScan =>
  ({ harvests, complete: true, scanned: 91 });

const HARVESTS: Harvest[] = [
  { round: 66_694_896, timestamp: 1_793_965_320, algoMicro: BigInt(7_659_112), rewardBase: BigInt(517_363) },
  { round: 66_666_169, timestamp: 1_793_886_180, algoMicro: BigInt(7_650_229), rewardBase: BigInt(516_308) },
  { round: 66_654_225, timestamp: 1_793_853_240, algoMicro: BigInt(7_555_326), rewardBase: BigInt(512_043) },
];

async function mount() {
  const { DualStakeCard } = await import("./DualStakeCard");
  render(<DualStakeCard />);
  // The card reads on mount; wait for the loading dash to resolve.
  await waitFor(() => expect(screen.queryByText("…")).toBeNull());
}

/** Opens the explainer and returns its dialog. */
/**
 * Opens the explainer and waits for its harvest read to settle.
 *
 * The log is fetched when the modal first opens rather than on card mount —
 * it pages the indexer, so its cost grows with the product and nothing on
 * the card's face shows it. That makes the panel's content arrive a tick
 * after the dialog, so every assertion here waits for the read, not just for
 * the dialog element.
 */
async function openModal() {
  fireEvent.click(screen.getByRole("button", { name: "Learn more about magnetALGO" }));
  const dialog = await waitFor(() =>
    screen.getByRole("dialog", { name: "About magnetALGO dualSTAKE" }));
  await waitFor(() => expect(screen.queryByText("Reading the log…")).toBeNull());
  return dialog;
}

beforeEach(() => {
  wallet = { address: null, isConnected: false };
  snapshot = SNAP; consensus = YIELD; scan = complete(HARVESTS); holding = null;
});
afterEach(cleanup);

describe("the rate on the face", () => {
  it("shows the APR net of the fees the contract charges", async () => {
    await mount();
    // 4.8268% gross less 650bps = 4.513%. The arithmetic is the real
    // netAprPct, so this asserts the wiring AND the figure.
    const figure = await waitFor(() => screen.getByText("4.51%"));
    expect(figure.className).toContain("text-green-400");
    expect(figure.className).toContain("font-mono");
    // Labelled as an expectation, not as history.
    expect(screen.getByText(/Expected · net of Myth's fee/)).toBeTruthy();
  });

  it("uses the LIVE fees, so a raise moves the number", async () => {
    // Myth may raise fees 250bps a week. A card that netted the pinned 650
    // would keep printing 4.51% after that happened.
    snapshot = { ...SNAP, platformFeeBps: 250, noderunnerFeeBps: 650 };
    await mount();
    await waitFor(() => expect(screen.getByText("4.39%")).toBeTruthy());
    expect(screen.queryByText("4.51%")).toBeNull();
  });

  it("renders a dash, never a zero, when the network could not be read", async () => {
    // The failure that matters: a 0.00% APR is a claim, and we did not
    // measure it.
    consensus = null;
    await mount();
    /* Scoped to the rate box: a disconnected wallet dashes the two position
       stats as well, so a bare getByText("—") matches three elements and
       proves nothing about which one it found. */
    const box = screen.getByText(/Network parameters unavailable/)
      .closest("div.glow-accent")!;
    expect(box).toBeTruthy();
    expect(box.textContent).toContain("—");
    expect(box.textContent).not.toMatch(/\d%/);
  });

  it("strikes the rate through when Myth's node is not earning", async () => {
    /*
      The case the whole three-state treatment exists for. `readConsensusYield`
      succeeds — it describes the network, not this contract — so without this
      the card would print a confident green rate while nothing accrued at it.
    */
    snapshot = { ...SNAP, earning: false };
    await mount();
    const figure = await waitFor(() => screen.getByText("4.51%"));
    expect(figure.className).toContain("line-through");
    expect(figure.className).not.toContain("text-green-400");
    expect(screen.getByText(/not online and incentive-eligible/)).toBeTruthy();
  });

  it("does NOT strike it through merely because the snapshot is unread", async () => {
    // `null` is unknown and must not be treated as offline — that would
    // assert a node outage we never observed.
    snapshot = null;
    await mount();
    expect(screen.queryByText(/not online and incentive-eligible/)).toBeNull();
  });
});

describe("what stayed on the face", () => {
  it("still says whose contract it is, where the button is", async () => {
    // Moved disclosure is fine; moved *this* is not. It is the thing a
    // depositor has to know before pressing Deposit, so it stays beside it.
    await mount();
    expect(screen.getByText(/This is Myth Finance's contract, not ours\./)).toBeTruthy();
  });

  it("still names both halves of the return, never the ratio alone", async () => {
    // Rule 1. "1:1" is true of the ALGO and false of the holding.
    await mount();
    expect(screen.getByText(/comes back 1:1/)).toBeTruthy();
    expect(screen.getByText(/accrues on top of it/)).toBeTruthy();
  });

  it("labels the $U figure as gross, and does not tint it", async () => {
    // Rule 3: part of that figure is the user's own entry cost.
    wallet = { address: HOLDER, isConnected: true };
    holding = BigInt(100_000_000);          // 100 magnetALGO
    await mount();
    expect(screen.getByText("$U on redemption")).toBeTruthy();
    const value = await waitFor(() => screen.getByText("0.03119 $U"));
    expect(value.className).not.toContain("text-green-400");
  });
});

describe("what moved into Learn more", () => {
  it("opens and closes", async () => {
    await mount();
    const dialog = await openModal();
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "About magnetALGO dualSTAKE" })).toBeNull());
  });

  it("closes on Escape", async () => {
    await mount();
    await openModal();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "About magnetALGO dualSTAKE" })).toBeNull());
  });

  it("carries every claim that left the card", async () => {
    await mount();
    await openModal();
    // The mechanism panel.
    expect(screen.getByText(/swaps them out of ALGO and into/)).toBeTruthy();
    // The $U mint cost, which a wallet holding none meets as a refusal.
    expect(screen.getByText(/and a little \$U/)).toBeTruthy();
    // The exit claim the audits flagged and the founder corrected.
    expect(screen.getByText(/no pool to exit through/)).toBeTruthy();
    // The upgrade path and the fee, with its ceiling on changes.
    expect(screen.getByText(/one-week timelock with the new code/)).toBeTruthy();
    expect(screen.getByText(/6\.5% of rewards today and may rise by up to/)).toBeTruthy();
    // The Tinyman depth point, which was in SPEC.md and on no screen at all.
    expect(screen.getByText(/roughly \$9\.5K when this shipped/)).toBeTruthy();
  });

  it("shows the derivation of the card's own number", async () => {
    // An APR with no stated basis is the thing this modal exists to prevent.
    await mount();
    await openModal();
    expect(screen.getByText(/How the rate on the card is worked out/)).toBeTruthy();
    // Every input, printed so a reader can redo the multiplication.
    // Twice over, deliberately: once in the input table and once inside the
    // multiplication, so `getAllByText` is the correct query here.
    expect(screen.getAllByText(/8\.1861/).length).toBe(2);    // ALGO per block
    expect(screen.getByText("2.71")).toBeTruthy();            // block seconds
    // And the result, matching the face exactly rather than nearly.
    expect(screen.getAllByText(/4\.51%/).length).toBeGreaterThan(0);
  });

  it("states that Myth publish no rate, which is why one is derived", async () => {
    await mount();
    await openModal();
    expect(screen.getByText(/Myth publish no APR/)).toBeTruthy();
  });

  it("lists the realised harvests and refuses to annualise them", async () => {
    await mount();
    await openModal();
    // 22.864667 ALGO -> 15.45714 $U across three harvests.
    expect(screen.getByText(/22\.8647 ALGO/)).toBeTruthy();
    expect(screen.getByText(/15\.45714 \$U/)).toBeTruthy();
    expect(screen.getByText(/0\.67603 \$U per ALGO/)).toBeTruthy();
    // The reason, which is a measured figure and not a hedge.
    expect(screen.getByText(/not annualised on purpose/)).toBeTruthy();
    expect(screen.getByText(/about 0\.8 blocks a day/)).toBeTruthy();
  });

  it("distinguishes an unread harvest log from an empty one", async () => {
    // `null` and `[]` mean different things; "no harvests yet" is a claim.
    scan = null;
    await mount();
    await openModal();
    expect(screen.getByText(/Couldn't read the harvest log/)).toBeTruthy();
    cleanup();

    scan = complete([]);
    await mount();
    await openModal();
    expect(screen.getByText(/No harvests recorded yet/)).toBeTruthy();
  });

  /*
    ── The heading is a claim, and it expires ──
    "Every harvest so far" was true of a 300-transaction scan on the day it
    shipped and was going to stop being true silently: deposits fill the
    window, so a busier product pushes the oldest harvests off the end while
    the title goes on claiming completeness. Same shape as the two bounds
    that expired here on 2026-11-07.

    These are the tests that make the claim falsifiable.
  */
  it("only claims completeness when the scan actually reached the end", async () => {
    await mount();
    await openModal();
    expect(screen.getByText("Every harvest so far")).toBeTruthy();
    expect(screen.queryByText("Recent harvests")).toBeNull();
    expect(screen.queryByText(/not its whole history/)).toBeNull();
  });

  it("retitles and says so when the scan was truncated", async () => {
    scan = { harvests: HARVESTS, complete: false, scanned: 12_000 };
    await mount();
    await openModal();
    expect(screen.getByText("Recent harvests")).toBeTruthy();
    expect(screen.queryByText("Every harvest so far")).toBeNull();
    // Names its own window rather than leaving the reader to guess it.
    expect(screen.getByText(/last 12,000 transactions on the contract/)).toBeTruthy();
    expect(screen.getByText(/older harvests than the ones above/)).toBeTruthy();
  });

  it("does not call a truncated count a total", async () => {
    // "3 total" beside a truncated list is the same overclaim as the
    // heading, in a place that is easier to miss.
    scan = { harvests: HARVESTS, complete: false, scanned: 12_000 };
    await mount();
    await openModal();
    expect(screen.queryByText(/3 total/)).toBeNull();
    cleanup();

    scan = complete(HARVESTS);
    await mount();
    await openModal();
    expect(screen.getByText(/3 total/)).toBeTruthy();
  });

  it("says how many rows it is showing when the list is cut to 12", async () => {
    const many: Harvest[] = Array.from({ length: 20 }, (_, i) => ({
      round: 66_700_000 - i * 1000,
      timestamp: 1_793_965_320 - i * 3600,
      algoMicro: BigInt(7_600_000),
      rewardBase: BigInt(513_000),
    }));
    scan = complete(many);
    await mount();
    await openModal();
    expect(screen.getByText(/Showing the 12 most recent of 20/)).toBeTruthy();
    // The totals still cover all twenty, which is why the line is needed.
    expect(screen.getByText(/152\.0000 ALGO/)).toBeTruthy();
  });

  it("does not read the harvest log until the modal is opened", async () => {
    /*
      The reason the fetch moved off card mount: it pages the indexer to
      exhaustion, so its cost grows with the product, and nothing on the
      card's face shows it.
    */
    const events = await import("@/lib/strategy/dualstake/events");
    const spy = vi.spyOn(events, "readHarvests");
    spy.mockClear();
    await mount();
    expect(spy).not.toHaveBeenCalled();
    await openModal();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does not refetch the log every time the modal is reopened", async () => {
    const events = await import("@/lib/strategy/dualstake/events");
    const spy = vi.spyOn(events, "readHarvests");
    spy.mockClear();
    await mount();
    await openModal();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(
      screen.queryByRole("dialog", { name: "About magnetALGO dualSTAKE" })).toBeNull());
    await openModal();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does not state a fee it failed to read", async () => {
    // The rule every other figure on this card follows.
    snapshot = null;
    await mount();
    await openModal();
    expect(screen.getByText(/couldn't read the current fee/i)).toBeTruthy();
    expect(screen.queryByText(/6\.5% of rewards today/)).toBeNull();
  });
});
