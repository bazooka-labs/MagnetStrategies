import { TokensView } from "@/components/tokens/TokensView";
import { fetchHolderCount, fetchMagnetPriceUSDC, fetchTVL } from "@/lib/tokenStats";

export default async function TokensPage({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  const [holders, price, tvl] = await Promise.all([
    fetchHolderCount(),
    fetchMagnetPriceUSDC(),
    fetchTVL(),
  ]);

  return (
    <TokensView
      holders={holders}
      price={price}
      tvl={tvl}
      initialTab={searchParams.tab === "musd" ? "musd" : "magnet"}
    />
  );
}
