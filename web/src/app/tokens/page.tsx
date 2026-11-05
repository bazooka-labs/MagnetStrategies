import { TokensView } from "@/components/tokens/TokensView";
import { TokensSplash } from "@/components/tokens/TokensSplash";
import { MusdTokenView } from "@/components/tokens/MusdTokenView";
import { GovernanceSection } from "@/components/tokens/GovernanceSection";
import { MUSD_ASA_ID, fetchHolderCount, fetchMusdMarketPriceUsd } from "@/lib/tokenStats";

/**
 * /tokens — the mUSD page.
 *
 * It held two assets until 2026-11-04 and fetched five figures for them. The
 * Magnet Token view and its three reads moved to `app/strategy/page.tsx`; what
 * is left is mUSD, with Exchange and Governance as its two pills.
 */
export default async function TokensPage() {
  const [musdHolders, musdPrice] = await Promise.all([
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
        exchangeView={<MusdTokenView holders={musdHolders} marketPrice={musdPrice} />}
        governanceView={<GovernanceSection />}
      />
    </>
  );
}
