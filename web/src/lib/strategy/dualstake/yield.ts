// ── magnetALGO dualSTAKE — the yield figure, and where it comes from ───────
//
// ── Myth's SDK does not carry a rate. This is not an oversight of ours ─────
// The request that produced this module assumed the APR could be read from
// the SDK. It cannot, and the vendor says so in writing — their README, on
// `DSContractListing` and `DSContractState`: "Neither includes APR or farm
// info." `docs.myth.finance/dualSTAKE` publishes no figure either; it
// mentions "dualSTAKE farms offering higher APR (where available)" and gives
// no numbers. Checked 2026-11-07, both of them.
//
// So the number is derived here, from live chain reads, and the derivation is
// shown to the user in the Learn more modal rather than asserted at them.
//
// ── What the yield actually IS ────────────────────────────────────────────
// Algorand consensus rewards. The dualSTAKE account is online and incentive
// eligible, so each time it proposes a block it is paid the proposer payout;
// Myth take 650bps and the rest is swapped ALGO -> $U, which is what accrues
// to magnetALGO holders.
//
// A staker's expected annual reward is therefore
//
//     (stake / onlineStake) * blocksPerYear * payoutPerBlock
//
// and dividing by `stake` cancels it out entirely:
//
//     grossApr = blocksPerYear * payoutPerBlock / onlineStake
//
// which is the same for every eligible account regardless of size. All three
// inputs are read live. Nothing here is modelled.
//
// ── Why this and not a trailing realised figure ───────────────────────────
// Because block proposal is a Poisson process and this stake is small. At
// ~49.9K ALGO against ~1.97B online, the contract expects **0.8 proposals a
// day** — and it had made exactly three when this shipped. Annualising three
// samples carries a sampling error of about +/-58%, which is the same error
// as the "one observed redemption is not an annualised rate" rule that kept
// an APR off this card in the first place (SPEC.md §8).
//
// The expected figure has no such error: it is an expectation over the
// network's own parameters, not an extrapolation from our own short history.
// Measured 2026-11-07, the two agree inside the Poisson band — 4.83% gross
// expected against 6.00% gross realised over 3.00 days — and the realised
// harvest log goes in the modal so a reader can see that spread rather than
// take the headline on faith.

import { PLATFORM_FEE_BPS, NODERUNNER_FEE_BPS } from "./config";

/** Seconds in 365 days. The annualisation denominator, named so it is one. */
const YEAR_SECONDS = 31_536_000;

/**
 * Block headers to sample, and how far apart.
 *
 * Nine rounds at stride five spans 40 rounds — under two minutes — which is
 * short enough that every one is still in algod's block cache and long
 * enough to average the fee component of the payout.
 */
const SAMPLE_COUNT = 9;
const SAMPLE_STRIDE = 5;

/**
 * Below this many *paid* blocks in the sample we return null rather than a
 * figure.
 *
 * `pp` is zero for a block whose proposer was not incentive eligible, and
 * those are real — 2 of 16 in the first sample taken. They must be dropped
 * rather than averaged in, because including them would understate the payout
 * by the share of ineligible proposers on the network, which is not a thing
 * that happens to OUR staker. Dropping them leaves a median over fewer
 * samples, so there is a floor under how few that may be.
 */
const MIN_PAID_SAMPLES = 4;

/**
 * Block times outside this range mean we misread something.
 *
 * Algorand's is ~2.7s. A figure far outside this would come from a bad
 * timestamp or a round gap, and `blocksPerYear` is directly proportional to
 * it — a 10x error in block time is a 10x error in the APR, in the direction
 * of a far more attractive number. So it is bounded rather than trusted.
 */
const MIN_BLOCK_SECONDS = 1;
const MAX_BLOCK_SECONDS = 20;

export interface ConsensusYield {
  /** Round the figures were read at. */
  round: bigint;
  /** Total stake online across the network, microALGO. */
  onlineStakeMicroAlgo: bigint;
  /** Median non-zero proposer payout, microALGO per block. */
  payoutPerBlockMicroAlgo: bigint;
  /** Mean seconds per round across the sample. */
  blockSeconds: number;
  /** How many of the sampled blocks carried a payout. */
  paidSamples: number;
  /** Expected gross consensus APR, as a percentage. Before Myth's fees. */
  grossAprPct: number;
}

/** A single ARC-28 `swap` — one harvest of rewards into $U. */
export interface Harvest {
  round: number;
  /** Unix seconds. */
  timestamp: number;
  /** ALGO converted, microALGO. Already NET of Myth's fees — see below. */
  algoMicro: bigint;
  /** $U received, base units (5dp). */
  rewardBase: bigint;
}

/**
 * The APR a magnetALGO holder actually receives, after Myth's cut.
 *
 * Fees come from the live snapshot, never from `config`'s pins — Myth may
 * raise them by 250bps a week, so a hardcoded 650 would state a figure we had
 * not read. The pins exist for disclosure and for this function's tests.
 */
export function netAprPct(
  grossAprPct: number, platformFeeBps: number, noderunnerFeeBps: number,
): number {
  const bps = platformFeeBps + noderunnerFeeBps;
  return grossAprPct * (1 - bps / 10_000);
}

/** The same thing against the pinned fees, for a test to compare against. */
export const PINNED_FEE_BPS = PLATFORM_FEE_BPS + NODERUNNER_FEE_BPS;

/**
 * Expected block proposals per day for a given stake.
 *
 * In the modal, to say out loud why a short realised window is noisy: a
 * reader who sees "0.8 a day" understands why three harvests is not a series
 * without having to be told about Poisson processes.
 */
export function proposalsPerDay(
  stakeMicroAlgo: bigint, onlineStakeMicroAlgo: bigint, blockSeconds: number,
): number | null {
  if (onlineStakeMicroAlgo <= BigInt(0) || blockSeconds <= 0) return null;
  const blocksPerDay = 86_400 / blockSeconds;
  return blocksPerDay * (Number(stakeMicroAlgo) / Number(onlineStakeMicroAlgo));
}

/** The sample a yield is computed from. Exported so a test can drive it. */
export interface BlockSample {
  round: number;
  /** Proposer payout, microALGO. Zero when the proposer was not eligible. */
  payoutMicroAlgo: number;
  /** Unix seconds. */
  timestamp: number;
}

/**
 * The arithmetic, separated from the reads so it can be tested without a
 * network and mutated without one either.
 *
 * Returns null — never a zero, never a partial figure — whenever the inputs
 * cannot support a number. A zero APR and an unknown APR render differently
 * and mean different things.
 *
 * ── The guards below are a chain, and four of them are REDUNDANT ──────────
 * Said plainly because the mutation run says so. Every guard here was
 * disabled in turn: the sample-count, zero-payout, median and block-time
 * bounds each turned their test red on their own, but the zero-stake,
 * zero-span, non-finite-block-time and non-positive-APR checks each
 * SURVIVED, because a later guard catches the same input. Remove the
 * zero-stake check and a zero denominator yields Infinity, which the
 * non-finite check at the bottom rejects anyway.
 *
 * That is defence in depth and it stays. What it means for the tests is
 * worth being precise about: the behaviour is pinned — removing a redundant
 * guard AND its partner does turn the test red, which was run and confirmed
 * — but no single one of those four is the only thing between a bad read and
 * a rendered number. Anyone deleting one as dead code should delete it
 * knowing the test suite will not stop them, and that the next edit to its
 * partner then has nothing behind it.
 */
export function computeConsensusYield(
  samples: BlockSample[], onlineStakeMicroAlgo: bigint, round: bigint,
): ConsensusYield | null {
  if (onlineStakeMicroAlgo <= BigInt(0)) return null;

  const sorted = [...samples].sort((a, b) => a.round - b.round);
  if (sorted.length < 2) return null;

  const paid = sorted
    .map((s) => s.payoutMicroAlgo)
    .filter((p) => p > 0)
    .sort((a, b) => a - b);
  if (paid.length < MIN_PAID_SAMPLES) return null;
  /* Median, not mean: the payout is a protocol bonus plus the block's own
     fees, so a single unusually busy block would pull a mean upward. The
     spread across a real sample is 8.179-8.206 ALGO, so the two barely
     differ — which is the point. The median cannot be moved by one outlier
     at all, and costs nothing when there is none. */
  const payout = paid[Math.floor(paid.length / 2)];

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const rounds = last.round - first.round;
  if (rounds <= 0) return null;
  const blockSeconds = (last.timestamp - first.timestamp) / rounds;
  if (!Number.isFinite(blockSeconds)) return null;
  if (blockSeconds < MIN_BLOCK_SECONDS || blockSeconds > MAX_BLOCK_SECONDS) return null;

  const blocksPerYear = YEAR_SECONDS / blockSeconds;
  const grossAprPct =
    (blocksPerYear * payout * 100) / Number(onlineStakeMicroAlgo);
  if (!Number.isFinite(grossAprPct) || grossAprPct <= 0) return null;

  return {
    round,
    onlineStakeMicroAlgo,
    payoutPerBlockMicroAlgo: BigInt(payout),
    blockSeconds,
    paidSamples: paid.length,
    grossAprPct,
  };
}

/**
 * Read the network parameters the APR is built from.
 *
 * ── Why raw fetch rather than algosdk ──
 * `algod.block()` returns the whole block, transactions included: 5.7KB for a
 * quiet round and far more for a busy one, times nine. algod supports
 * `?header-only=true`, which returns 1.1KB and is all this needs, and algosdk
 * has no binding for it. `readSnapshot` already takes a server string rather
 * than a client for its own reasons, so this matches the module it lives in.
 *
 * Returns null on any failure. The card renders a dash.
 */
export async function readConsensusYield(
  algodServer: string,
): Promise<ConsensusYield | null> {
  try {
    const base = algodServer.replace(/\/+$/, "");
    const statusRes = await fetch(`${base}/v2/status`);
    if (!statusRes.ok) return null;
    const status = await statusRes.json();
    const lastRound = Number(status["last-round"]);
    if (!Number.isFinite(lastRound) || lastRound <= 0) return null;

    /* One round back from the tip: the very latest is occasionally not yet
       servable as a block even though status reports it. */
    const rounds = Array.from(
      { length: SAMPLE_COUNT }, (_, i) => lastRound - 1 - i * SAMPLE_STRIDE,
    ).filter((r) => r > 0);

    const [supplyRes, ...blockRes] = await Promise.all([
      fetch(`${base}/v2/ledger/supply`),
      ...rounds.map((r) =>
        fetch(`${base}/v2/blocks/${r}?header-only=true&format=json`)),
    ]);

    if (!supplyRes.ok) return null;
    const supply = await supplyRes.json();
    const online = BigInt(supply["online-money"] ?? 0);

    const samples: BlockSample[] = [];
    for (const res of blockRes) {
      if (!res.ok) continue;                  // a pruned round is not an error
      const body = await res.json();
      const h = body.block ?? body;
      const round = Number(h.rnd);
      const timestamp = Number(h.ts);
      if (!Number.isFinite(round) || !Number.isFinite(timestamp)) continue;
      samples.push({ round, timestamp, payoutMicroAlgo: Number(h.pp ?? 0) });
    }

    return computeConsensusYield(samples, online, BigInt(lastRound));
  } catch {
    return null;
  }
}
