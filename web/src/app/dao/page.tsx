import Image from "next/image";
import { Card } from "@/components/ui";
import { MAGNET_TOKEN } from "@/lib/constants";
import { ClaimFounderButton } from "@/components/ClaimFounderButton";
import {
  Calendar,
  CheckCircle,
  FileText,
  Magnet,
  Scale,
  Shield,
  Users,
  Vote,
} from "lucide-react";

async function fetchHolderCount(): Promise<string> {
  try {
    let count = 0;
    let nextToken: string | undefined;
    do {
      const params = new URLSearchParams({ "currency-greater-than": "0", limit: "1000" });
      if (nextToken) params.set("next", nextToken);
      const res = await fetch(
        `https://mainnet-idx.algonode.cloud/v2/assets/${MAGNET_TOKEN.asaId}/balances?${params}`,
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

async function fetchTVL(): Promise<string> {
  try {
    const res = await fetch(
      `https://api.vestigelabs.org/assets/price?asset_ids=${MAGNET_TOKEN.asaId}&network_id=0`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return "—";
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry?.total_lockup) return "—";
    const tvl = Math.round(
      Number(entry.total_lockup) * Number(entry.price) * 2 * Number(entry.confidence)
    );
    return `${tvl.toLocaleString("en-US")} ALGO`;
  } catch {
    return "—";
  }
}

function TokenCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="relative rounded-xl border border-magnet-500/30 bg-gradient-to-br from-magnet-950/60 to-surface-light p-6 flex flex-col transition-all hover:border-magnet-500/50"
      style={{ boxShadow: "0 0 24px rgba(168,85,247,0.10), inset 0 0 32px rgba(168,85,247,0.04)" }}
    >
      <div className="absolute inset-x-0 top-0 h-px rounded-t-xl bg-gradient-to-r from-transparent via-magnet-500/50 to-transparent" />
      <p className="text-sm font-bold uppercase tracking-widest text-white mb-4">{label}</p>
      <div className="flex-1 flex flex-col justify-center">
        {children}
      </div>
    </div>
  );
}

export default async function DaoHomePage() {
  const [holderCount, tvl] = await Promise.all([
    fetchHolderCount(),
    fetchTVL(),
  ]);

  const phases = [
    {
      icon: <FileText className="h-5 w-5" />,
      title: "Proposal Submission",
      description:
        "Projects apply for liquidity support using the formal proposal template. Each must include project name, liquidity pair, capital requested, expected market impact, timeline, and known risks.",
    },
    {
      icon: <Users className="h-5 w-5" />,
      title: "Community Discussion",
      description:
        "Submitted projects are discussed openly in the MagnetDAO Discord. Members can ask questions, raise concerns, and build consensus before any vote.",
    },
    {
      icon: <Vote className="h-5 w-5" />,
      title: "Official Vote",
      description:
        "At the end of each quarter, eligible proposals go to an official on-chain vote. Voting is weighted at 1 Magnet = 1 Vote.",
    },
    {
      icon: <CheckCircle className="h-5 w-5" />,
      title: "Liquidity Deployment",
      description:
        "Winning proposals receive treasury-backed liquidity. Treasury acquires the project token and pairs it with Magnet in a liquidity pool on the selected DEX.",
    },
  ];

  return (
    <div className="relative">

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0">
          <Image src="/magnet-bg.png" fill alt="" className="object-cover object-center opacity-10" priority />
        </div>
        <div className="absolute inset-0 bg-surface/75" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 h-[700px] w-[700px] rounded-full bg-magnet-600/20 blur-3xl pointer-events-none" />

        <div className="relative mx-auto max-w-7xl px-4 pt-16 pb-16 sm:px-6 lg:px-8 lg:pt-24">
          <div className="text-center">
            <div className="flex justify-center mb-8">
              <div className="flex h-32 w-32 items-center justify-center rounded-2xl bg-gradient-to-br from-magnet-500 to-magnet-700 shadow-xl shadow-magnet-700/50 animate-float magnet-glow-pulse">
                <Magnet className="h-16 w-16 text-white" />
              </div>
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-6xl lg:text-7xl">
              <span className="glow-text">MagnetDAO</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-gray-400 leading-relaxed">
              A founder-guided liquidity DAO on Algorand. Magnet ($U) serves as
              both the governance token and the base asset in all liquidity
              pools — connecting voting power, treasury deployment, and fee
              generation.
            </p>
            <a
              href="https://bazookalabs.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-4 text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              A Bazooka Labs Product
            </a>
          </div>
        </div>
      </section>

      {/* Content */}
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">

        {/* Token Info Boxes */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-12">

          <TokenCard label="Magnet Token ($U)">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">ASA ID</span>
                <span className="text-sm font-mono font-semibold text-white">
                  {MAGNET_TOKEN.asaId}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Total Supply</span>
                <span className="text-sm font-bold text-white">
                  {MAGNET_TOKEN.totalSupply.toLocaleString()} $U
                </span>
              </div>
            </div>
          </TokenCard>

          <TokenCard label="Community">
            <div className="flex flex-col items-center justify-center py-4">
              <p className="text-4xl font-extrabold text-white" style={{ textShadow: "0 0 20px rgba(168,85,247,0.5)" }}>
                {holderCount}
              </p>
              <p className="text-xs text-gray-400 mt-2 uppercase tracking-widest">Holders</p>
            </div>
          </TokenCard>

          <TokenCard label="Liquidity Deployed">
            <div className="flex flex-col items-center justify-center py-4">
              <p className="text-2xl font-extrabold text-white" style={{ textShadow: "0 0 20px rgba(168,85,247,0.5)" }}>
                {tvl}
              </p>
              <p className="text-xs text-gray-400 mt-2 uppercase tracking-widest">Total TVL</p>
            </div>
          </TokenCard>

        </div>

        {/* Quarterly Cycle */}
        <div className="mb-12">
          <h3 className="text-xl font-semibold text-white mb-6 flex items-center gap-2">
            <Calendar className="h-5 w-5 text-magnet-400" />
            Quarterly Cycle
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {phases.map((phase, i) => (
              <Card key={phase.title} className="relative">
                <div className="absolute -top-3 -left-3 flex h-8 w-8 items-center justify-center rounded-full bg-magnet-600 text-white text-sm font-bold">
                  {i + 1}
                </div>
                <div className="mb-3 mt-2 flex h-10 w-10 items-center justify-center rounded-lg bg-magnet-600/10 text-magnet-400">
                  {phase.icon}
                </div>
                <h4 className="font-semibold text-white">{phase.title}</h4>
                <p className="mt-2 text-sm text-gray-400 leading-relaxed">
                  {phase.description}
                </p>
              </Card>
            ))}
          </div>
        </div>

        {/* Voting Rules */}
        <Card className="mb-8">
          <h3 className="text-xl font-semibold text-white mb-6 flex items-center gap-2">
            <Scale className="h-5 w-5 text-magnet-400" />
            Voting Rules
          </h3>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <h4 className="font-medium text-white mb-2">Mechanism</h4>
              <p className="text-sm text-gray-400">
                1 Magnet = 1 Vote. Token-weighted voting ensures those with the
                most exposure have the most influence — and the most at risk.
              </p>
            </div>
            <div>
              <h4 className="font-medium text-white mb-2">Eligibility</h4>
              <p className="text-sm text-gray-400">
                Any wallet holding Magnet tokens at the time of the vote may
                participate. No minimum holding required.
              </p>
            </div>
            <div>
              <h4 className="font-medium text-white mb-2">Timing</h4>
              <p className="text-sm text-gray-400">
                Official votes are held at the end of each quarter, after the
                discussion phase concludes in Discord.
              </p>
            </div>
            <div>
              <h4 className="font-medium text-white mb-2">Accountability</h4>
              <p className="text-sm text-gray-400">
                Larger holders carry more influence but also bear more downside if
                they support low-quality projects — creating built-in
                accountability.
              </p>
            </div>
          </div>
        </Card>

        {/* Founder Authority */}
        <Card className="mb-8">
          <h3 className="text-xl font-semibold text-white mb-6 flex items-center gap-2">
            <Shield className="h-5 w-5 text-magnet-400" />
            Founder Authority
          </h3>
          <p className="text-sm text-gray-400 leading-relaxed mb-4">
            MagnetDAO is a founder-led system. The Founder holds final approval
            authority over all liquidity decisions. This authority exists to:
          </p>
          <ul className="space-y-2">
            {[
              "Protect the token's value from low-quality or misaligned deployments",
              "Ensure treasury capital is deployed responsibly",
              "Maintain operational stability during the DAO's early development",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm text-gray-400">
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-magnet-500" />
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-gray-500">
            As the DAO matures and governance mechanisms strengthen, founder
            involvement in day-to-day decisions is expected to decrease while the
            proposal and voting system takes on greater autonomy.
          </p>
          <ClaimFounderButton />
        </Card>

        {/* No Proposals */}
        <Card>
          <h3 className="text-lg font-semibold text-white mb-4">
            When No Projects Apply
          </h3>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="rounded-lg bg-surface border border-gray-800 p-4">
              <h4 className="font-medium text-white mb-2">Rollover</h4>
              <p className="text-sm text-gray-400">
                Treasury funds accumulated that quarter roll over into the
                following quarter's deployment pool. No funds are lost.
              </p>
            </div>
            <div className="rounded-lg bg-surface border border-gray-800 p-4">
              <h4 className="font-medium text-white mb-2">Founder Nomination</h4>
              <p className="text-sm text-gray-400">
                The Founder may manually nominate projects for community
                consideration, which then follow the standard discussion and
                voting process.
              </p>
            </div>
          </div>
        </Card>

      </div>
    </div>
  );
}
