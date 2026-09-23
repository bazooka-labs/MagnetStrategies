import { fetchTotalTvlUsd } from "@/lib/pools";
import { AGGREGATE_TVL_ENABLED, fetchAggregateTvlUsd } from "@/lib/tvlAggregate";

export const MAGNET_ASA_ID = 3081853135;
export const MUSD_ASA_ID = 3615600399;
const USDC_ASA_ID = 31566704;

export async function fetchHolderCount(assetId: number): Promise<string> {
  try {
    let count = 0;
    let nextToken: string | undefined;
    do {
      const params = new URLSearchParams({ "currency-greater-than": "0", limit: "1000" });
      if (nextToken) params.set("next", nextToken);
      const res = await fetch(
        `https://mainnet-idx.algonode.cloud/v2/assets/${assetId}/balances?${params}`,
        { next: { revalidate: 3600 } }
      );
      if (!res.ok) break;
      const data = await res.json();
      count += (data.balances as unknown[])?.length ?? 0;
      nextToken = data["next-token"] as string | undefined;
    } while (nextToken);
    return count.toLocaleString("en-US");
  } catch {
    return "—";
  }
}

async function fetchAlgoUSD(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=algorand&vs_currencies=usd",
      { next: { revalidate: 300 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return Number(data?.algorand?.usd) || null;
  } catch {
    return null;
  }
}

export async function fetchMagnetPriceUSDC(): Promise<string> {
  try {
    const [vestigeRes, algoUSD] = await Promise.all([
      fetch(
        `https://api.vestigelabs.org/assets/price?asset_ids=${MAGNET_ASA_ID}&network_id=0`,
        { next: { revalidate: 300 } }
      ),
      fetchAlgoUSD(),
    ]);
    if (!vestigeRes.ok || !algoUSD) return "—";
    const vestigeData = await vestigeRes.json();
    const entry = Array.isArray(vestigeData) ? vestigeData[0] : null;
    if (!entry?.price) return "—";
    const priceUSDC = Number(entry.price) * algoUSD;
    return `$${priceUSDC.toFixed(6)}`;
  } catch {
    return "—";
  }
}

/** Live mUSD/USDC market price from Vestige, for the peg-health stat. Raw number (not a
 * pre-formatted string, unlike the other fetchers here) since the caller needs it for the
 * under-peg comparison, not just display. */
export async function fetchMusdMarketPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.vestigelabs.org/assets/price?asset_ids=${MUSD_ASA_ID}&network_id=0&denominating_asset_id=${USDC_ASA_ID}`,
      { next: { revalidate: 300 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    return entry?.price ? Number(entry.price) : null;
  } catch {
    return null;
  }
}

export async function fetchTVL(): Promise<string> {
  // The aggregate runs alongside the hardcoded sum. While AGGREGATE_TVL_ENABLED is false it
  // is shadow-only: computed and logged for comparison, never displayed. fetchAggregateTvlUsd
  // never throws and never returns a value below the hardcoded floor, so this cannot regress
  // the displayed number or fail the build. See ASA_TVL_SPEC.md.
  const [floorUsd, algoUSD, agg] = await Promise.all([
    fetchTotalTvlUsd(),
    fetchAlgoUSD(),
    fetchAggregateTvlUsd(),
  ]);

  if (agg) {
    const delta = floorUsd ? ((agg.usdTotal - floorUsd) / floorUsd) * 100 : null;
    console.log(
      `[tvl] floor=$${floorUsd?.toFixed(2) ?? "n/a"} aggregate=$${agg.usdTotal.toFixed(2)}` +
        `${delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%)`}` +
        ` pools=${agg.poolsCounted} discovered=${agg.fromDiscovery} unresolved=${agg.floorUnresolved}` +
        `${agg.guardsFired.length ? ` guards=[${agg.guardsFired.join(",")}]` : ""}`,
    );
  }

  // Never display less than the hardcoded floor: understating TVL reads as liquidity leaving.
  const chosen = AGGREGATE_TVL_ENABLED && agg ? Math.max(agg.usdTotal, floorUsd ?? 0) : floorUsd;

  if (chosen == null || !algoUSD) return "—";
  const tvlAlgo = Math.round(chosen / algoUSD);
  return `${tvlAlgo.toLocaleString("en-US")} ALGO`;
}
