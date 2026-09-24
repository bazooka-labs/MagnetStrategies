// ── Perps — frontend config and pinned constants ──────────────────────────────
// Leveraged positions on PEX, a third-party perpetuals protocol by Ultrade.
// Magnet Strategies writes no contract here: every economic action is a PEX call
// signed by the user's wallet. See strategy/perps/SPEC.md.
//
// EVERYTHING IN THIS FILE IS A BUILD-TIME CONSTANT BY DESIGN.
// The SDK resolves app and asset IDs from a backend-supplied deployment manifest,
// and the collateral transfer's destination is derived from one of them. A poisoned
// manifest therefore redirects user funds while every asset-movement check still
// passes, because it checks against the same poisoned source. Pin, then assert.

/** SDK version this file is pinned against. Never float this. */
export const PEX_SDK_VERSION = "0.6.3" as const;

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

/**
 * Markets the card offers. Both are live and verified end to end: oracle payload,
 * solver, confirming quote and group construction all work per market.
 *
 * They are NOT interchangeable. BTC/USD is synthetic — the pool owes
 * BTC-denominated PnL while holding ALGO and USDC, with nothing offsetting — and
 * its dynamic-OI factor is 641,026 against ALGO's 1,000,000. Every derived number
 * is read per market; none of it is shared.
 */
export const ENABLED_MARKET_IDS: readonly number[] = [
  PEX_MARKETS.algoUsd.id,
  PEX_MARKETS.btcUsd.id,
];

/** Which market the card opens on. */
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
 * The SAME manifest hashed in canonical form — `JSON.stringify(JSON.parse(raw))`.
 *
 * Two hashes because they check different things. The raw hash above is
 * provenance: it identifies the exact file as delivered, and is what you compare
 * when re-fetching from PEX. This one is the runtime control: a bundler hands the
 * app a parsed object, never the original text, so the file's byte hash is
 * unverifiable at runtime. Canonical re-serialisation is stable across
 * parse/stringify round-trips (verified), which makes it checkable in the browser.
 *
 * Asserting only the raw hash would mean asserting nothing at runtime.
 */
export const PEX_PROTOCOL_MANIFEST_CANONICAL_SHA256 =
  "10a879f93baef40a48649c1e9b6a2bb4664e593008e115c4acd6c550af737d3d";

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
 * Builder fee recipient — the MagnetFi admin address, by deliberate choice.
 *
 * Verified on chain 2026-09-23: valid checksum, opted in to USDC (31566704),
 * 310 ALGO spendable, not rekeyed.
 *
 * This address never signs anything in this product. It is a RECIPIENT: it sits in
 * `accounts` so the fee transfer can reach it and is written into the order box as
 * a record. Publishing it exposes no private key.
 *
 * It is the same key that controls MagnetFi's PSM, vault and oracle, which was
 * raised and accepted. The disclosure half of that concern is moot — the address
 * is already committed in this public repo (`magnetfi.ts`) and rendered on several
 * user-facing pages, so the Perps UI reveals nothing new. What remains is that the
 * key now also accrues revenue, so sweeping means signing with it. Accepted
 * deliberately; revisit if sweep frequency rises.
 *
 * If this address is ever NOT opted in to USDC, every open fails for every user and
 * it presents as our bug. `assertBuilderAddressUsable` in perpsReads is the preflight.
 */
export const BUILDER_ADDRESS = "KNML6OW2XVXYSSGQX7EBLBMSLAPY6QFNBZUJMNEFIEXIIVJLMW4VINYU6A" as string;

/** Protocol cap is 10. `normalizeBuilderFee` throws above it rather than clamping. */
export const POSITION_BUILDER_FEE_BPS = 10;

/** Zero on a conversion the product forces. See SPEC "Revenue". */
export const SWAP_BUILDER_FEE_BPS = 0;

// ── Product constants ─────────────────────────────────────────────────────────
/**
 * Sanity tripwire on notional, NOT a product cap.
 *
 * The fixed $250 launch ceiling was removed: it did not scale, and at $250 of
 * collateral it delivered 1.0x, which is not a leverage product. The real ceiling
 * is solved live from five constraints and is genuinely bounded — measured at
 * ~$1,214 on ALGO/USD and ~$1,340 on BTC/USD, rising as PEX deepens.
 *
 * What remains is a tripwire set far above any plausible solved value. It exists
 * for one case only: a decode or arithmetic bug producing an absurd headroom, so
 * the bar cannot render a wildly wrong right-hand end. If this ever binds in
 * normal use, something upstream is broken — treat it as an alarm, not a limit.
 */
export const MAX_PLAUSIBLE_NOTIONAL_USD = 25_000;

/**
 * Share of live per-side OI headroom one position may take.
 *
 * This is an availability control, not a risk one. A single user consuming all
 * remaining headroom closes the side for the next visitor, who then loads the
 * card and is told the market is unavailable. Half keeps the book open while
 * still allowing a position that matters.
 */
export const OI_HEADROOM_SHARE = 0.5;

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
 * STILL FALSE — one of the two blockers is cleared, the other is not.
 *
 * Cleared in SDK 0.6.3: the cleanup and status registries now ship as
 * `V2_ORDER_BRACKET_CLEANUP_REASON` and `V2_ORDER_STATUS`, with
 * OCO_SIBLING_CANCELLED (3) documented as "Linked TP/SL executed; the other
 * child was removed". That is the OCO-on-execution guarantee Protection needs,
 * and it is now a published contract rather than a chat message. 0.6.3 is
 * additive — no contract change — so the behaviour always existed; what changed
 * is that it is now stated.
 *
 * NOT cleared: nobody has watched it happen. `v2_order_executed` has still never
 * fired on MainNet, so OCO remains unobserved by us. A published table is better
 * evidence than a chat message and is still not a measurement — and this codebase
 * has already been burned once by treating a described cleanup as a verified one.
 *
 * Flip this only after a TestNet position with a linked TP/SL has one leg execute
 * and the sibling is observed removed, with the receipt read back. Needs a funded
 * TestNet account.
 *
 * Not a size constraint: open + both brackets measures 13 transactions against a
 * ceiling of 16 and always fits.
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
