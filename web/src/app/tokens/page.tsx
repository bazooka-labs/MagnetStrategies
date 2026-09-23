import { TokensView } from "@/components/tokens/TokensView";
import { MagnetTokenView } from "@/components/tokens/MagnetTokenView";
import { MusdTokenView } from "@/components/tokens/MusdTokenView";
import { fetchHolderCount, fetchMagnetPriceUSDC, fetchTVL } from "@/lib/tokenStats";

export default async function TokensPage() {
  const [holders, price, tvl] = await Promise.all([
    fetchHolderCount(),
    fetchMagnetPriceUSDC(),
    fetchTVL(),
  ]);

  return (
    <TokensView
      magnetView={<MagnetTokenView holders={holders} price={price} tvl={tvl} />}
      musdView={<MusdTokenView />}
    />
  );
}
