// ── Perps — frontend config and pinned constants ──────────────────────────────
// Leveraged positions on PEX, a third-party perpetuals protocol by Ultrade.
// Magnet Strategies writes no contract here: every economic action is a PEX call
// signed by the user's wallet. See perps/SPEC.md.
//
// EVERYTHING IN THIS FILE IS A BUILD-TIME CONSTANT BY DESIGN.
// The SDK resolves app and asset IDs from a backend-supplied deployment manifest,
// and the collateral transfer's destination is derived from one of them. A poisoned
// manifest therefore redirects user funds while every asset-movement check still
// passes, because it checks against the same poisoned source. Pin, then assert.

/** SDK version this file is pinned against. Never float this. */
export const PEX_SDK_VERSION = "0.6.2" as const;

// ── PEX MainNet deployment ────────────────────────────────────────────────────
// Recovered from GET /v2/networks/mainnet/deployments. Fetch the manifest at
// runtime if you like, but assert every ID equals the value below and hard-fail
// on mismatch — a PEX redeploy must require a release, never a JSON edit.
export const PEX_APPS = {
  math: 3690309158,
  markets: 3690309159,
  trading: 3690309160,
  tradingRiskOps: 3690309161,
  adminOps: 3690309162,
  swapOps: 3690309163,
  singleTokenOps: 3690309164,
  singleTokenTrading: 3690309165,
  orderOps: 3690309166,
  cvaVault: 3690309167,
  marketYieldVault: 3690309168,
  marketXAlgoYieldVault: 3690309169,
  adminControl: 3690306989,
} as const;

export const PEX_ASSETS = {
  algo: 0,
  usdc: 31566704,
  xAlgo: 1134696561,
  fUsdc: 971384592,
  frUsdc: 971384593,
  /** Synthetic index placeholder — not an ASA, never transferable. */
  btcIndex: 9000000000000000,
} as const;

// ── Markets ───────────────────────────────────────────────────────────────────
// Both are ALGO/USDC-backed and share no capital. The distinction matters:
// ALGO/USD is asset-backed, so the pool holds its own index asset and partially
// self-hedges. BTC/USD is synthetic — the pool owes BTC-denominated PnL while
// holding ALGO and USDC, with nothing offsetting.
export const PEX_MARKETS = {
  algoUsd: { id: 1, label: "ALGO/USD", backing: "asset-backed" },
  btcUsd: { id: 2, label: "BTC/USD", backing: "synthetic" },
} as const;

/** v1 trades ALGO/USD only. */
export const ACTIVE_MARKET_ID = PEX_MARKETS.algoUsd.id;

/** USDC only in v1 — see SPEC "Collateral". Keeps one position per (market, side). */
export const COLLATERAL_ASSET_ID = PEX_ASSETS.usdc;

// ── Integrity pins ────────────────────────────────────────────────────────────
// Captured 2026-09-23, post-cutover. App IDs do not change on a PEX upgrade, so
// the approval-program hash is the ONLY thing that observes one. Poll it.
export const PEX_PROGRAM_SHA256 = {
  trading: "c6c2802f5b4356b8fa7f979670fb6ad12c18ead616fb4167459934bd75107ffe",
  orderOps: "492edbc198f2c54aad24980b031da954cfe49207bea65cfc932e49ca2606f3ae",
  tradingRiskOps: "2d5abf2599a4bae060f612df95f3c1e534557db992c645743054560be9535307",
  markets: "67f4cc4550abdfe1ef537976efcd89dcf49aee3548dbad47ef289951a6c4f49d",
  math: "1c2e5a3e1c8f2fb2492fcbf6f63facf8de84766b804b63f347c2a71486af79ae",
  adminControl: "08e7101a01485c84efe6d741a6e577c37dfb346e46644207f6b7d1e57c2f10d0",
} as const;

/**
 * Protocol manifest SHA-256 over the raw bytes as served.
 * The manifest supplies the ABI specs used to ENCODE args and the box formats used
 * to DECODE state — so whoever controls it controls both what we send and what we
 * display. One hash covers every method and every format; per-method pins cannot
 * be enumerated completely.
 */
export const PEX_PROTOCOL_MANIFEST_SHA256 =
  "d594c876fcd253ea18ff66607c41752102c75db233a4ba43a7ca5d17b55ca173";

/**
 * Oracle signer public key, read from PDexV2OrderOps global key "oc" and
 * cross-checked against PDexV2Trading global key "q" (identical 48 bytes).
 *
 * Pin it. The SDK verifies a payload's signature against a pubkey carried INSIDE
 * that same payload, which is not verification — it only checks a message signed
 * itself. There is no SDK path that reads this from chain.
 */
export const PEX_ORACLE_SIGNER_PUBKEY_HEX =
  "4cc6bcc8c281d1e1b5eec887adc373fee95f6e580125132e72303618d2e3dffb";

/** Trailing bytes of the same entry read 0x1e (30), matching the observed payload window. */
export const ORACLE_MAX_AGE_SEC = 20;

/**
 * PEX's published oracle bundle. Read-only, keyless, served from R2.
 * The path repeats the network because the base URL is itself network-scoped.
 */
export const PEX_ORACLE_BUNDLE_URL =
  "https://pub-1e72beea87f04ebfafce248132310425.r2.dev/mainnet/v2/oracle-payloads/mainnet/current.json";

/**
 * Algorand MainNet genesis hash, hex. Carried inside every signed oracle message.
 * Asserting it is what stops a TestNet-signed payload being replayed at a MainNet
 * user — the signature over it would be perfectly valid.
 */
export const ALGORAND_MAINNET_GENESIS_HASH_HEX =
  "c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf";

// ── Revenue ───────────────────────────────────────────────────────────────────
/**
 * Builder fee recipient. Recorded on-chain in the order box and publicly readable,
 * so it must also be disclosed in the UI.
 *
 * TODO(confirm): must be a Magnet Strategies treasury address opted in to USDC with
 * spendable ALGO for MBR BEFORE launch — the fee is paid in the collateral asset and
 * the address appears in `accounts` on every fee-bearing call. Not opted in,
 * plausibly every open fails for every user on day one.
 */
export const BUILDER_ADDRESS = "" as string;

/** Protocol cap is 10. `normalizeBuilderFee` throws above it rather than clamping. */
export const POSITION_BUILDER_FEE_BPS = 10;

/** Zero on a conversion the product forces. See SPEC "Revenue". */
export const SWAP_BUILDER_FEE_BPS = 0;

// ── Product constants ─────────────────────────────────────────────────────────
/** Absolute notional ceiling for launch, regardless of depth. Raise deliberately. */
export const LAUNCH_NOTIONAL_CEILING_USD = 250;

/** Share of live per-side OI headroom we are willing to take. */
export const OI_HEADROOM_SHARE = 0.2;

/** User-adjustable, disclosed. Anchored to the QUOTED EXECUTION PRICE, not the index. */
export const DEFAULT_SLIPPAGE_BPS = 50;

/**
 * Minimum distance a bracket trigger must clear the crossing bound by.
 * Provisional — derive from ORACLE_MAX_AGE_SEC x measured ALGO volatility.
 * At a ~2.3% buffer this is not a rounding detail.
 */
export const CROSS_MARGIN_BPS = 50;

/** Keeper fee escrowed per bracket, in USDC. Floor 0.10; read policy live. */
export const CHILD_KEEPER_FEE_USDC = 0.1;

/** Absolute cap on the escrow transfer, belt-and-braces with the 2x-displayed rule. */
export const MAX_KEEPER_FEE_ESCROW_USDC = 0.5;

/**
 * BLOCKED — do not build against this.
 * Not a size constraint: open + both brackets measures 13 transactions against a
 * ceiling of 16 and always fits. Blocked on cleanup symbols that exist in no SDK
 * or manifest — OCO_SIBLING_CANCELLED and the reason/status enums are chat-sourced,
 * and `v2_order_executed` has never fired on MainNet so OCO is unobservable there.
 */
export const PROTECTION_ENABLED = false;

// ── Degradation ───────────────────────────────────────────────────────────────
/**
 * What to do when a pin fails. Two states, not one: a PEX redeploy leaves existing
 * positions in the OLD app, so a blanket hard-fail strands everyone holding one at
 * exactly the moment the protocol is in flux.
 */
export type PinFailureMode = "block-opens" | "operational";

export const PIN_FAILURE_POLICY = {
  /** New positions and increases stop. */
  opens: "block-opens",
  /** Close, partial close, add-collateral and cancel stay live against the PINNED ids. */
  exits: "operational",
} as const;
