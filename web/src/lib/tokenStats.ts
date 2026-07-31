export const MAGNET_ASA_ID = 3081853135;

export async function fetchHolderCount(): Promise<string> {
  try {
    let count = 0;
    let nextToken: string | undefined;
    do {
      const params = new URLSearchParams({ "currency-greater-than": "0", limit: "1000" });
      if (nextToken) params.set("next", nextToken);
      const res = await fetch(
        `https://mainnet-idx.algonode.cloud/v2/assets/${MAGNET_ASA_ID}/balances?${params}`,
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

export async function fetchMagnetPriceUSDC(): Promise<string> {
  try {
    const [vestigeRes, algoRes] = await Promise.all([
      fetch(
        `https://api.vestigelabs.org/assets/price?asset_ids=${MAGNET_ASA_ID}&network_id=0`,
        { next: { revalidate: 300 } }
      ),
      fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=algorand&vs_currencies=usd",
        { next: { revalidate: 300 } }
      ),
    ]);
    if (!vestigeRes.ok || !algoRes.ok) return "—";
    const vestigeData = await vestigeRes.json();
    const algoData = await algoRes.json();
    const entry = Array.isArray(vestigeData) ? vestigeData[0] : null;
    if (!entry?.price) return "—";
    const algoUSD = algoData?.algorand?.usd;
    if (!algoUSD) return "—";
    const priceUSDC = Number(entry.price) * Number(algoUSD);
    return `$${priceUSDC.toFixed(6)}`;
  } catch {
    return "—";
  }
}

export async function fetchTVL(): Promise<string> {
  try {
    const res = await fetch(
      `https://api.vestigelabs.org/assets/price?asset_ids=${MAGNET_ASA_ID}&network_id=0`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return "—";
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry?.total_lockup) return "—";
    const tvl = Math.round(Number(entry.total_lockup) * Number(entry.price) * 2);
    return `${tvl.toLocaleString("en-US")} ALGO`;
  } catch {
    return "—";
  }
}
