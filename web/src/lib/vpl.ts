// VPL — Volatility Prediction Ladder. Shared constants and read helpers.
//
// Product docs: hedge/VPL.md · spec: hedge/VPL_SPEC.md · ops: hedge/OPERATIONS.md

export const MUSD_ASA_ID_MAINNET = 3615600399;

// Same wallet as MagnetFi's admin today. Note it is also mUSD's manager and reserve,
// so one compromise reaches both protocols plus the un-minted supply. VPL supports
// two-step propose_admin/accept_admin, so this can be split off later without a
// redeploy — worth doing before pot sizes get meaningful.
export const VPL_ADMIN_ADDRESS =
  "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";

// Set after deploying. 0 means "not deployed" — the page renders a deploy prompt.
export const VPL_APP_ID = Number(process.env.NEXT_PUBLIC_VPL_APP_ID ?? 0);

export const PRICE_FEED_ID = 1; // BTC/USD

// ±0.5 / 1.25 / 2.25 / 3.5% of the reference, as unsigned bps multipliers of it.
// Band i covers (boundary[i-1], boundary[i]]; the outer two are open-ended.
export const DEFAULT_BAND_BOUNDS = [9650, 9775, 9875, 9950, 10050, 10125, 10225, 10350];
export const BAND_COUNT = 9;
export const BPS = 10_000;

export const DEFAULT_RAKE_BPS = 400;
export const DEFAULT_MIN_STAKE = 5_000_000; // 5 mUSD
export const BOX_MBR = 41_700;
export const PAYOUT_FEE = 8_000;

export const STATUS = ["OPEN", "LOCKED", "RESOLVED", "VOID"] as const;
export const VOID_REASON = ["thin", "empty band", "no lock", "no resolve", "admin"] as const;

export const CHECKPOINT_LOCK = 0;
export const CHECKPOINT_RESOLVE = 1;

/** Human label for a band, given the reference price set at lock (0 before lock). */
export function bandLabel(i: number, bounds: number[] = DEFAULT_BAND_BOUNDS): string {
  const pct = (bps: number) => {
    const v = (bps - BPS) / 100;
    return `${v > 0 ? "+" : ""}${v.toFixed(2).replace(/\.?0+$/, "")}%`;
  };
  if (i === 0) return `below ${pct(bounds[0])}`;
  if (i === BAND_COUNT - 1) return `above ${pct(bounds[bounds.length - 1])}`;
  return `${pct(bounds[i - 1])} to ${pct(bounds[i])}`;
}

/** Band boundary prices for a given reference. Mirrors the contract's muldiv. */
export function bandBoundaries(reference: bigint, bounds: number[] = DEFAULT_BAND_BOUNDS) {
  return bounds.map((b) => (reference * BigInt(b)) / BigInt(BPS));
}

export const fmtUsd = (micro: bigint | number, dp = 2) =>
  (Number(micro) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });

/** Live multiple for a band, in bps, matching get_ladder. 0 means an empty band. */
export function bandMultipleBps(totalStake: bigint, rakeBps: number, bandStake: bigint) {
  if (bandStake === BigInt(0)) return BigInt(0);
  const payable = (totalStake * BigInt(BPS - rakeBps)) / BigInt(BPS);
  return (payable * BigInt(BPS)) / bandStake;
}
