// ── MagnetFi v2 — frontend config ──────────────────────────────────────────────
// LP-collateral vaults + mUSD stablecoin + PSM. Separate from the v1 lending
// constants in constants.ts (still used by the DAO pages).

export const MUSD = {
  name: "Magnet USD",
  ticker: "mUSD",
  decimals: 6,
} as const;

export const U_TOKEN = {
  name: "Magnet",
  ticker: "$U",
  asaId: 3081853135,
  decimals: 5,
} as const;

// On-chain app / asset IDs — 0 until the v2 contracts are deployed to mainnet.
export const MAGNETFI_APPS = {
  oracle: 0,
  psm: 0,
  vault: 0,
} as const;

export const MUSD_ASA_ID: number = 3615600399;

// Bazooka admin wallet — gates the /magnetfi Admin panel in the UI (a UX guard so the
// live site doesn't expose admin tools; real authority is enforced on-chain by the
// contracts' admin checks). Must be the wallet you connect to deploy/operate v2.
export const MAGNETFI_ADMIN_ADDRESS =
  "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";

// Active deployment, resolved by network (NEXT_PUBLIC_ALGO_NETWORK). Borrower-facing
// tabs read from ACTIVE so they light up on testnet without code changes; admin tools
// keep their own mainnet defaults + manual overrides.
const _NET: "mainnet" | "testnet" =
  process.env.NEXT_PUBLIC_ALGO_NETWORK === "testnet" ? "testnet" : "mainnet";

export type Deployment = {
  oracle: number; psm: number; vault: number;
  musd: number; usdc: number; lpAsaId: number; poolId: number;
};

const DEPLOYMENTS: Record<"mainnet" | "testnet", Deployment> = {
  mainnet: { oracle: 3741272132, psm: 3644230181, vault: 3671287267, musd: 3615600399, usdc: 31566704, lpAsaId: 3163770927, poolId: 3163770927 },
  testnet: {
    oracle: 765096480, psm: 765096481, vault: 765096491,
    musd: 765095889, usdc: 765095890, lpAsaId: 765095900, poolId: 765095900,
  },
};

export const ACTIVE: Deployment = DEPLOYMENTS[_NET];

// Per-network on-chain IDs per collateral pool, keyed by VaultType.id. A VaultType present here is
// WIRED for live on-chain interaction; one absent renders as "coming soon". lpAsaId doubles as the
// pool_id in the vault contract. (Migrating off the single ACTIVE.poolId/lpAsaId toward multi-pool.)
export type PoolWiring = { poolId: number; lpAsaId: number };
const POOL_WIRING: Record<"mainnet" | "testnet", Record<string, PoolWiring>> = {
  mainnet: {
    "u-talgo": { poolId: 3163770927, lpAsaId: 3163770927 },
    "u-usdc": { poolId: 3673941603, lpAsaId: 3673941603 },  // live 2026-08-19 (oracle posting, vault configured)
    // Wired 2026-10-17, after the lean-oracle cutover. Both pools had been
    // priced by the oracle since 2026-10-09 and were deliberately left
    // unwired until the migration landed, so each was registered once rather
    // than twice. Vault-side params verified on chain against VAULT.md:
    // U/ALGO 6000/7500/800, ALGO/USDC 6500/7500/800, both LP ASAs opted in.
    "u-algo": { poolId: 3617313492, lpAsaId: 3617313492 },
    "algo-usdc": { poolId: 1002590888, lpAsaId: 1002590888 },
  },
  testnet: {
    "u-talgo": { poolId: 765095900, lpAsaId: 765095900 },
  },
};
export const ACTIVE_POOL_WIRING = POOL_WIRING[_NET];

/**
 * Pools registered on the ORACLE, which is not the same set as POOL_WIRING.
 *
 * POOL_WIRING answers "can someone borrow against this" — it is the vault side.
 * The oracle prices more than the vault lends against: ALGO/USDC and U/ALGO
 * were registered and are being posted to, but their vault-side registration is
 * deliberately deferred to the lean-oracle migration so each pool is registered
 * once rather than twice (STATUS.md §6).
 *
 * Keeping them out of POOL_WIRING is correct — adding them there would offer a
 * vault nobody can open. But it also meant the admin's Oracle Health panel,
 * which iterates POOL_WIRING, showed two of four live feeds: the two pools the
 * bot had never posted to were invisible in the one place that exists to notice
 * a feed that is not posting.
 *
 * `vaultWired` carries the distinction into the panel so an unborrowable pool
 * reads as monitored-but-not-collateral rather than as an oversight.
 */
export type OraclePool = { id: string; poolId: number; lpAsaId: number; vaultWired: boolean };
const ORACLE_POOLS: Record<"mainnet" | "testnet", OraclePool[]> = {
  mainnet: [
    // Order is display order, and it groups by collateral family: the three $U
    // pools first, then the one that is not. That is the same split the card
    // glow encodes, and interleaving them would undercut it.
    { id: "u-talgo", poolId: 3163770927, lpAsaId: 3163770927, vaultWired: true },
    { id: "u-usdc", poolId: 3673941603, lpAsaId: 3673941603, vaultWired: true },
    // Oracle-only. Queued 2026-10-13; the bot prices them, the vault cannot lend
    // against them until the migration registers them vault-side.
    { id: "u-algo", poolId: 3617313492, lpAsaId: 3617313492, vaultWired: true },
    { id: "algo-usdc", poolId: 1002590888, lpAsaId: 1002590888, vaultWired: true },
  ],
  testnet: [
    { id: "u-talgo", poolId: 765095900, lpAsaId: 765095900, vaultWired: true },
  ],
};
export const ACTIVE_ORACLE_POOLS = ORACLE_POOLS[_NET];
/** On-chain IDs for a collateral pool by VaultType id; undefined if not yet wired ("coming soon"). */
export function poolWiring(typeId: string): PoolWiring | undefined {
  return ACTIVE_POOL_WIRING[typeId];
}

// Folks Finance v2 USDC lending pool — the launch yield venue. Ids verified against live
// state + the algorand-js-sdk (see FOLKS_ADAPTER.md). Used to deploy the FolksAdapter.
export type FolksVenue = { pool: number; manager: number; usdc: number; fusdc: number };
const FOLKS: Record<"mainnet" | "testnet", FolksVenue> = {
  mainnet: { pool: 971372237, manager: 971350278, usdc: 31566704, fusdc: 971384592 },
  testnet: { pool: 147170678, manager: 147157634, usdc: 67395862, fusdc: 147171826 },
};
export const ACTIVE_FOLKS: FolksVenue = FOLKS[_NET];

// True once the core vault contract is deployed for the active network.
export const PROTOCOL_LIVE = ACTIVE.vault !== 0;

// PSM redemption fee (mUSD → USDC). Mint (USDC → mUSD) is always 0%.
export const PSM_REDEEM_FEE_BPS = 100; // 1%

export type VaultStatus = "launching" | "soon";

export type VaultType = {
  id: string;
  pair: string;
  tokens: [string, string];
  ltvBps: number;
  liqThresholdBps: number;
  rateBps: number;
  status: VaultStatus;
  blurb: string;
};

// Risk parameters mirror VAULT.md. U/tALGO is the first vault at launch.
export const VAULT_TYPES: VaultType[] = [
  {
    id: "u-talgo",
    pair: "U / tALGO",
    tokens: ["$U", "tALGO"],
    ltvBps: 6000,
    liqThresholdBps: 7500,
    rateBps: 1000,
    status: "launching",
    blurb: "Double yield-bearing collateral with the deepest liquidity — the first vault at launch.",
  },
  {
    id: "u-usdc",
    pair: "U / USDC",
    tokens: ["$U", "USDC"],
    ltvBps: 6500,
    liqThresholdBps: 7500,
    rateBps: 600,
    status: "soon",
    blurb: "USDC stabilizes half the position, so it earns the highest LTV and lowest rate.",
  },
  {
    // Seeded 2026-10-09. LP ASA 3617313492; pool
    // 35I7TSPBSYCEP276DHLZDTOP3W77GY76VOLBCAKWICVFJUOTQAMRR6QZA4.
    id: "u-algo",
    pair: "U / ALGO",
    tokens: ["$U", "ALGO"],
    ltvBps: 6000,
    liqThresholdBps: 7500,
    rateBps: 800,
    status: "soon",
    blurb: "The blue-chip Algorand pair.",
  },
  {
    // The first NON-U collateral. Every vault above is U-denominated, so the
    // whole book rides on one thin token; this is a risk fix before it is a
    // growth one. It is also the only collateral deep enough to actually
    // liquidate — $1.72M of Tinyman TVL against U/tALGO's, where unwinding a
    // large seizure would move the price against the liquidator.
    //
    // 65/75. The LTV is the generous half and it is earned: an ALGO/USDC LP is
    // roughly HALF as volatile as a volatile/volatile pair, because half the
    // position is a stablecoin and LP value tracks sqrt(P_ALGO), so ALGO -50%
    // moves the LP only -29%.
    //
    // The THRESHOLD is not a risk judgement and must not be tuned like one.
    // 7500 is a firm protocol-wide cap: TIER1_SEIZE_BPS/TIER2_SEIZE_BPS are
    // hardcoded at 35%/77% and restore HF >= 1.06 only at 7500 (audit M1,
    // LIQUIDATION.md:483). `set_liq_threshold` still accepts up to 9000, so a
    // higher value lands on chain and silently breaks partial-liquidation
    // health restoration — nothing reverts, the maths just stops working.
    //
    // This read 7800 until 2026-10-17 and was caught before the pool was
    // wired. Raising it needs recalibrated seize percentages and a vault
    // redeploy, not an admin call.
    id: "algo-usdc",
    pair: "ALGO / USDC",
    tokens: ["ALGO", "USDC"],
    ltvBps: 6500,
    liqThresholdBps: 7500,
    rateBps: 800,
    status: "soon",
    blurb: "The deepest pool on Algorand, half of it a stablecoin — the safest collateral here, and the first that is not $U.",
  },
  {
    id: "u-wbtc",
    pair: "U / wBTC",
    tokens: ["$U", "wBTC"],
    ltvBps: 6000,
    liqThresholdBps: 7500,
    rateBps: 800,
    status: "soon",
    blurb: "Bitcoin exposure, working as collateral.",
  },
];

// ── helpers ────────────────────────────────────────────────────────────────────

export const pct = (bps: number): number => bps / 100; // 6000 → 60

export function formatUsd(n: number, dp = 2): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/**
 * Health factor = collateral value × liquidation threshold / debt.
 * < 1.0 means the position is eligible for liquidation. Returns Infinity at zero debt.
 */
export function healthFactor(collateralUsd: number, debtMusd: number, liqThresholdBps: number): number {
  if (debtMusd <= 0) return Infinity;
  return (collateralUsd * (liqThresholdBps / 10_000)) / debtMusd;
}

/** Max mUSD borrowable against a collateral value at a given LTV. */
export function maxBorrow(collateralUsd: number, ltvBps: number): number {
  return collateralUsd * (ltvBps / 10_000);
}

export const SECONDS_PER_YEAR = 31_536_000; // mirrors the vault contract accrual denominator

/**
 * Live-projected accrued interest (mUSD): the stored on-chain accrued_interest plus the
 * interest accumulated since last_accrual_timestamp that has not yet been written to chain.
 * Accrual is lazy on-chain (only written on a vault interaction), so this lets a borrower
 * watch interest build with no on-chain write. Mirrors the vault's per-second accrual,
 * including its 1-year elapsed cap. DISPLAY ESTIMATE ONLY — the exact amount due is
 * recomputed on-chain at pay time (integer floor math), so at equal timestamps this is a
 * hair high, never low (health factor is never optimistically overstated).
 */
export function projectedAccruedInterest(
  storedAccruedMusd: number,
  principalMusd: number,
  rateBps: number,
  lastAccrualSec: number,
  nowSec: number,
): number {
  if (principalMusd <= 0 || rateBps <= 0 || lastAccrualSec <= 0) return storedAccruedMusd;
  let elapsed = Math.max(0, nowSec - lastAccrualSec);
  if (elapsed > SECONDS_PER_YEAR) elapsed = SECONDS_PER_YEAR;
  const annual = principalMusd * (rateBps / 10_000);
  return storedAccruedMusd + (annual * elapsed) / SECONDS_PER_YEAR;
}

/**
 * The % drop in collateral value that would push the position to HF = 1.0
 * (the liquidation point). Returns 0 if already underwater.
 */
export function liquidationBuffer(collateralUsd: number, debtMusd: number, liqThresholdBps: number): number {
  if (debtMusd <= 0) return 1;
  const liqValue = debtMusd / (liqThresholdBps / 10_000); // collateral value at HF = 1
  const buffer = 1 - liqValue / collateralUsd;
  return Math.max(0, buffer);
}
