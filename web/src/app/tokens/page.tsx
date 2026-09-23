import { TokensView } from "@/components/tokens/TokensView";
import { MagnetTokenView } from "@/components/tokens/MagnetTokenView";
import { MusdTokenView } from "@/components/tokens/MusdTokenView";
import {
  MAGNET_ASA_ID, MUSD_ASA_ID,
  fetchHolderCount, fetchMagnetPriceUSDC, fetchTVL, fetchMusdMarketPriceUsd,
} from "@/lib/tokenStats";

export default async function TokensPage() {
  const [holders, price, tvl, musdHolders, musdPrice] = await Promise.all([
    fetchHolderCount(MAGNET_ASA_ID),
    fetchMagnetPriceUSDC(),
    fetchTVL(),
    fetchHolderCount(MUSD_ASA_ID),
    fetchMusdMarketPriceUsd(),
  ]);

  return (
    <TokensView
      magnetView={<MagnetTokenView holders={holders} price={price} tvl={tvl} />}
      musdView={<MusdTokenView holders={musdHolders} marketPrice={musdPrice} />}
    />
  );
}
