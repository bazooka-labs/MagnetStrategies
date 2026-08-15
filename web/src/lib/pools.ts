// $U liquidity pools showcased on /pools. Live fee + farm APRs are fetched server-side
// (see app/api/pools/route.ts): Tinyman by pool address, Pact by pool id. Farm APR
// appears automatically whenever a DEX runs an incentive program — no manual upkeep.

export type PoolDex = "tinyman" | "pact";

export type Pool = {
  id: string;      // internal key
  pair: string;    // display, e.g. "U / tALGO"
  partner: string; // the non-U token unit name
  dex: PoolDex;
  ref: string;     // tinyman → pool account address; pact → pool id
  addLiquidityUrl: string;
};

/** Live-fetched numbers merged onto an Pool. APRs are percentages (e.g. 36.78). */
export type PoolData = Pool & {
  tvlUsd: number | null;
  feeApr: number | null;
  farmApr: number | null;   // null when no active farm
  totalApr: number | null;
};

export const POOLS: Pool[] = [
  // ── Tinyman ──
  {
    id: "u-talgo", pair: "U / tALGO", partner: "tALGO", dex: "tinyman",
    ref: "AIR4CSC54U33WCX4JTMJA4X6PHBVG7OGX7XVV2MCACYSSDULZNJ2KNGRZI",
    addLiquidityUrl: "https://app.tinyman.org/pool/AIR4CSC54U33WCX4JTMJA4X6PHBVG7OGX7XVV2MCACYSSDULZNJ2KNGRZI",
  },
  {
    id: "u-mooj", pair: "U / MOOJ", partner: "MOOJ", dex: "tinyman",
    ref: "YLJXI33PTPUPCPVDEW77QCBCZAZY7LFEO3MYNL4OAG7T6JJAVMVSKCV52I",
    addLiquidityUrl: "https://app.tinyman.org/pool/YLJXI33PTPUPCPVDEW77QCBCZAZY7LFEO3MYNL4OAG7T6JJAVMVSKCV52I",
  },
  // ── Pact ──
  {
    id: "u-alpha", pair: "U / ALPHA", partner: "ALPHA", dex: "pact",
    ref: "3274459498", addLiquidityUrl: "https://app.pact.fi/add-liquidity/3274459498",
  },
  {
    id: "u-compx", pair: "U / COMPX", partner: "COMPX", dex: "pact",
    ref: "3277903617", addLiquidityUrl: "https://app.pact.fi/add-liquidity/3277903617",
  },
  {
    id: "u-hay", pair: "U / HAY", partner: "HAY", dex: "pact",
    ref: "3214038100", addLiquidityUrl: "https://app.pact.fi/add-liquidity/3214038100",
  },
  // ── Pending pool identification ──
  // U / FOLKS — pool not yet located on Pact or Tinyman (it runs the active farm).
  // Add here once found: { id: "u-folks", pair: "U / FOLKS", partner: "FOLKS", dex, ref, addLiquidityUrl }.
];

export const DEX_LABEL: Record<PoolDex, string> = { tinyman: "Tinyman", pact: "Pact" };
