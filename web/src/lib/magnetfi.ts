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
  mainnet: { oracle: 0, psm: 0, vault: 0, musd: 3615600399, usdc: 31566704, lpAsaId: 3163770927, poolId: 3163770927 },
  testnet: {
    oracle: 765096480, psm: 765096481, vault: 765096491,
    musd: 765095889, usdc: 765095890, lpAsaId: 765095900, poolId: 765095900,
  },
};

export const ACTIVE: Deployment = DEPLOYMENTS[_NET];

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
    rateBps: 800,
    status: "launching",
    blurb: "Double yield-bearing collateral with the deepest liquidity — the first vault at launch.",
  },
  {
    id: "u-usdc",
    pair: "U / USDC",
    tokens: ["$U", "USDC"],
    ltvBps: 6500,
    liqThresholdBps: 7500,
    rateBps: 500,
    status: "soon",
    blurb: "USDC stabilizes half the position, so it earns the highest LTV and lowest rate.",
  },
  {
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
