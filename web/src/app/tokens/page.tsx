import { TokensView } from "@/components/tokens/TokensView";
import { TokensSplash } from "@/components/tokens/TokensSplash";
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
    <>
      {/*
        A sibling of the content, never a parent: the splash blurs the live page
        behind it, and an ancestor with a running opacity animation would become
        a backdrop root and leave it blurring nothing.
      */}
      <TokensSplash />
      <TokensView
        magnetView={<MagnetTokenView holders={holders} price={price} tvl={tvl} />}
        musdView={<MusdTokenView holders={musdHolders} marketPrice={musdPrice} />}
      />
    </>
  );
}
