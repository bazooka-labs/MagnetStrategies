// ── MagnetFi v2 — frontend config ──────────────────────────────────────────────
// LP-collateral vaults + mUSD stablecoin + PSM. Separate from the v1 lending
// constants in constants.ts (still used by the DAO pages).

export const MAGNETFI_NETWORK: "mainnet" | "testnet" = "mainnet";

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

export const MUSD_ASA_ID = 3615600399;

// Bazooka admin wallet — gates the /magnetfi Admin panel in the UI (a UX guard so the
// live site doesn't expose admin tools; real authority is enforced on-chain by the
// contracts' admin checks). Must be the wallet you connect to deploy/operate v2.
export const MAGNETFI_ADMIN_ADDRESS =
  "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A";

// True once the core vault contract is deployed.
export const PROTOCOL_LIVE = MAGNETFI_APPS.vault !== 0;

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
