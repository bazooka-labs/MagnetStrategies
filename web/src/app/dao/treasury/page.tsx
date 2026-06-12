import { DollarSign, TrendingUp, Layers, Trophy, Calendar, Clock } from "lucide-react";
import { TreasuryChart, type ChartPoint } from "@/components/TreasuryChart";
import { StatCard, Card } from "@/components/ui";
import {
  FOUNDER_ADDRESS,
  VOTING_APP_ID,
  VOTING_NETWORK,
  ALGOD_URLS,
  INDEXER_URLS,
  MAGNET_TOKEN,
} from "@/lib/constants";

const USDC_ASA_ID = 31566704;
const USDC_DEC = 1_000_000;

// ─── Data fetching ─────────────────────────────────────────────────────────

async function fetchTotalUSDCInflows(): Promise<number> {
  if (!FOUNDER_ADDRESS) return 0;
  try {
    let total = 0;
    let next: string | undefined;
    do {
      const p = new URLSearchParams({
        address: FOUNDER_ADDRESS,
        "address-role": "receiver",
        limit: "1000",
      });
      if (next) p.set("next", next);
      const res = await fetch(
        `${INDEXER_URLS.mainnet}/v2/assets/${USDC_ASA_ID}/transactions?${p}`,
        { next: { revalidate: 86400 } }
      );
      if (!res.ok) break;
      const data = await res.json();
      for (const txn of (data.transactions ?? []) as Array<{
        "asset-transfer-transaction"?: { amount?: number };
      }>) {
        total += Number(txn["asset-transfer-transaction"]?.amount ?? 0);
      }
      next = data["next-token"] as string | undefined;
    } while (next);
    return total / USDC_DEC;
  } catch {
    return 0;
  }
}

async function fetchCurrentUSDC(): Promise<number> {
  if (!FOUNDER_ADDRESS) return 0;
  try {
    const res = await fetch(
      `${ALGOD_URLS.mainnet}/v2/accounts/${FOUNDER_ADDRESS}`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    const holding = (data.assets as { "asset-id": number; amount: number }[] | undefined)
      ?.find((a) => a["asset-id"] === USDC_ASA_ID);
    return Number(holding?.amount ?? 0) / USDC_DEC;
  } catch {
    return 0;
  }
}

async function fetchProposalCount(): Promise<number> {
  if (!VOTING_APP_ID) return 0;
  try {
    const res = await fetch(
      `${ALGOD_URLS[VOTING_NETWORK]}/v2/applications/${VOTING_APP_ID}`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    const gs: { key: string; value: { uint?: number } }[] = data.params?.["global-state"] ?? [];
    const entry = gs.find((e) => Buffer.from(e.key, "base64").toString() === "proposal_count");
    return Number(entry?.value?.uint ?? 0);
  } catch {
    return 0;
  }
}

interface VoteEpoch {
  epochNumber: number;
  question: string;
  choices: string[];
  votes: number[];
  startTime: number;
  endTime: number;
  winnerIndex: number | null;
}

async function fetchVoteEpochs(): Promise<VoteEpoch[]> {
  if (!VOTING_APP_ID) return [];
  const now = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(
      `${INDEXER_URLS[VOTING_NETWORK]}/v2/applications/${VOTING_APP_ID}/boxes`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return [];
    const data = await res.json();

    const propBoxes = (data.boxes ?? []).filter((b: { name: string }) => {
      try { return atob(b.name).startsWith("prop_"); } catch { return false; }
    });

    const epochs: VoteEpoch[] = [];

    for (const box of propBoxes) {
      try {
        const boxRes = await fetch(
          `${INDEXER_URLS[VOTING_NETWORK]}/v2/applications/${VOTING_APP_ID}/box?name=${encodeURIComponent("b64:" + box.name)}`,
          { next: { revalidate: 3600 } }
        );
        if (!boxRes.ok) continue;
        const boxData = await boxRes.json();
        const bytes = Uint8Array.from(atob(boxData.value), (c) => c.charCodeAt(0));
        const view = new DataView(bytes.buffer);

        const startTime = Number(view.getBigUint64(0));
        const endTime = Number(view.getBigUint64(8));
        if (endTime > now) continue;

        const votesRaw = [
          Number(view.getBigUint64(16)),
          Number(view.getBigUint64(24)),
          Number(view.getBigUint64(32)),
          Number(view.getBigUint64(40)),
        ];

        const dec = new TextDecoder();
        const question = dec.decode(bytes.slice(48, 176)).replace(/\0/g, "").trim();
        const rawChoices = [
          dec.decode(bytes.slice(176, 208)).replace(/\0/g, "").trim(),
          dec.decode(bytes.slice(208, 240)).replace(/\0/g, "").trim(),
          dec.decode(bytes.slice(240, 272)).replace(/\0/g, "").trim(),
          dec.decode(bytes.slice(272, 304)).replace(/\0/g, "").trim(),
        ];

        const choices: string[] = [];
        const votes: number[] = [];
        rawChoices.forEach((c, i) => {
          if (c) { choices.push(c); votes.push(votesRaw[i]); }
        });

        const nameBytes = Uint8Array.from(atob(box.name), (c) => c.charCodeAt(0));
        const idView = new DataView(nameBytes.buffer, 5);
        const id = Number(idView.getBigUint64(0));

        const maxVotes = Math.max(...votes);
        const winnerIndex = maxVotes > 0 ? votes.indexOf(maxVotes) : null;

        epochs.push({ epochNumber: id, question, choices, votes, startTime, endTime, winnerIndex });
      } catch {
        // skip malformed box
      }
    }

    return epochs.sort((a, b) => a.epochNumber - b.epochNumber);
  } catch {
    return [];
  }
}

async function fetchDailyUSDCHistory(): Promise<ChartPoint[]> {
  if (!FOUNDER_ADDRESS) return [];
  try {
    // Fetch current balance first so we can anchor the reconstruction correctly
    const acctRes = await fetch(
      `${ALGOD_URLS.mainnet}/v2/accounts/${FOUNDER_ADDRESS}`,
      { next: { revalidate: 3600 } }
    );
    if (!acctRes.ok) return [];
    const acctData = await acctRes.json();
    const holding = (acctData.assets as { "asset-id": number; amount: number }[] | undefined)
      ?.find((a) => a["asset-id"] === USDC_ASA_ID);
    const currentMicro = Number(holding?.amount ?? 0);

    // Collect all USDC transactions
    const records: { roundTime: number; delta: number }[] = [];
    let next: string | undefined;
    do {
      const p = new URLSearchParams({ "asset-id": String(USDC_ASA_ID), limit: "1000" });
      if (next) p.set("next", next);
      const res = await fetch(
        `${INDEXER_URLS.mainnet}/v2/accounts/${FOUNDER_ADDRESS}/transactions?${p}`,
        { next: { revalidate: 86400 } }
      );
      if (!res.ok) break;
      const data = await res.json();
      for (const txn of (data.transactions ?? []) as Array<{
        sender: string;
        "round-time": number;
        "asset-transfer-transaction"?: { receiver: string; amount: number };
      }>) {
        const xfer = txn["asset-transfer-transaction"];
        if (!xfer) continue;
        const delta = xfer.receiver === FOUNDER_ADDRESS
          ? Number(xfer.amount)
          : -Number(xfer.amount);
        records.push({ roundTime: txn["round-time"], delta });
      }
      next = data["next-token"] as string | undefined;
    } while (next);

    if (records.length === 0) return [];

    records.sort((a, b) => a.roundTime - b.roundTime);

    // Anchor: derive the balance before the first tracked transaction from the known current balance
    const totalDelta = records.reduce((sum, r) => sum + r.delta, 0);
    let balance = currentMicro - totalDelta;

    const dayMap = new Map<string, number>();
    for (const { roundTime, delta } of records) {
      balance += delta;
      const date = new Date(roundTime * 1000).toISOString().slice(0, 10);
      dayMap.set(date, balance);
    }

    const sortedDates = Array.from(dayMap.keys()).sort();
    const today = new Date().toISOString().slice(0, 10);
    const result: ChartPoint[] = [];
    let last = currentMicro - totalDelta; // pre-history baseline

    for (
      let d = new Date(sortedDates[0] + "T00:00:00Z");
      d.toISOString().slice(0, 10) <= today;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const key = d.toISOString().slice(0, 10);
      if (dayMap.has(key)) last = dayMap.get(key)!;
      result.push({ date: key, balance: Math.max(0, last / USDC_DEC) });
    }

    return result;
  } catch {
    return [];
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtUSDC(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateRange(startTs: number, endTs: number): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  const start = new Date(startTs * 1000).toLocaleDateString("en-US", opts);
  const end = new Date(endTs * 1000).toLocaleDateString("en-US", opts);
  return `${start} → ${end}`;
}

const CHOICE_LABEL = ["A", "B", "C", "D"];

// ─── Page ──────────────────────────────────────────────────────────────────

export default async function TreasuryPage() {
  const [totalFunded, currentUSDC, proposalCount, voteEpochs, chartData] = await Promise.all([
    fetchTotalUSDCInflows(),
    fetchCurrentUSDC(),
    fetchProposalCount(),
    fetchVoteEpochs(),
    fetchDailyUSDCHistory(),
  ]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">

      {/* Header */}
      <div className="mb-10">
        <h1 className="text-2xl font-bold text-white">Treasury</h1>
        <p className="mt-1 text-sm text-gray-500">
          Live analytics on MagnetDAO treasury funding, deployments, and governance history.
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-10">
        <StatCard
          label="Total Funded"
          value={fmtUSDC(totalFunded)}
          sublabel="Cumulative USDC inflows"
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <StatCard
          label="Available Balance"
          value={fmtUSDC(currentUSDC)}
          sublabel="Current treasury USDC"
          icon={<DollarSign className="h-5 w-5" />}
        />
        <StatCard
          label="Governance Votes"
          value={String(proposalCount)}
          sublabel="Total proposals created"
          icon={<Layers className="h-5 w-5" />}
        />
      </div>

      {/* Balance Chart */}
      <Card className="mb-10">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-sm font-semibold text-white">USDC Balance History</h3>
            <p className="text-xs text-gray-600 mt-0.5">Daily snapshots, mainnet treasury wallet</p>
          </div>
          <span className="flex items-center gap-1 text-xs text-gray-700">
            <Clock className="h-3 w-3" /> Updated daily
          </span>
        </div>
        <TreasuryChart data={chartData} />
      </Card>

      {/* Governance History */}
      <div>
        <div className="mb-6">
          <h2 className="text-xl font-bold text-white">Governance History</h2>
          <p className="mt-1 text-sm text-gray-500">
            Completed MagnetDAO governance votes and their on-chain results.
          </p>
        </div>

        {voteEpochs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-800 px-6 py-10 text-center">
            <p className="font-medium text-gray-500">No completed votes yet</p>
            <p className="mt-1 text-sm text-gray-700">
              Results will appear here after proposals close.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {voteEpochs.map((epoch) => {
              const { decimalFactor } = MAGNET_TOKEN;
              const displayVotes = epoch.votes.map((v) => Math.floor(v / decimalFactor));
              const totalVotes = displayVotes.reduce((a, b) => a + b, 0);

              return (
                <Card key={epoch.epochNumber}>
                  {/* Epoch header */}
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div>
                      <div className="flex items-center gap-2.5 mb-1.5">
                        <span className="text-xs font-bold uppercase tracking-widest text-magnet-500">
                          Vote Epoch {epoch.epochNumber}
                        </span>
                        {epoch.winnerIndex !== null && (
                          <span className="flex items-center gap-1 rounded-full bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 text-xs text-yellow-400">
                            <Trophy className="h-3 w-3" />
                            {epoch.choices[epoch.winnerIndex]} won
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-semibold text-white leading-snug">
                        {epoch.question}
                      </p>
                    </div>
                    <div className="flex-shrink-0 text-right space-y-1">
                      <p className="flex items-center justify-end gap-1 text-xs text-gray-600">
                        <Calendar className="h-3 w-3" />
                        {fmtDateRange(epoch.startTime, epoch.endTime)}
                      </p>
                      <p className="text-xs text-gray-700">
                        {totalVotes.toLocaleString()} $U cast
                      </p>
                    </div>
                  </div>

                  {/* Choice results */}
                  <div className="space-y-2.5">
                    {epoch.choices.map((choice, i) => {
                      const pct = totalVotes > 0
                        ? Math.round((displayVotes[i] / totalVotes) * 100)
                        : 0;
                      const isWinner = epoch.winnerIndex === i;

                      return (
                        <div key={i}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <div className="flex items-center gap-2">
                              <span className="w-4 text-center font-bold text-gray-600">
                                {CHOICE_LABEL[i]}
                              </span>
                              <span className={isWinner ? "text-yellow-300 font-semibold" : "text-gray-400"}>
                                {choice}
                              </span>
                              {isWinner && <Trophy className="h-3 w-3 text-yellow-400" />}
                            </div>
                            <span className="text-gray-600">{pct}%</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded-full bg-gray-800/80 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${
                                  isWinner
                                    ? "bg-gradient-to-r from-yellow-600 to-yellow-400"
                                    : "bg-gray-700"
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="w-24 text-right text-xs text-gray-700">
                              {displayVotes[i].toLocaleString()} $U
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
