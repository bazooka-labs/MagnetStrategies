"use client";

/**
 * Deposit and withdraw, signed in this UI.
 *
 * ── Why the gates are read before the form is usable ──
 * `quoteV2CvaIdleWithdraw` and friends return `ok: true` while the chain
 * rejects, and both cool-downs are `assert`ed in deployed bytecode. A Withdraw
 * button offered inside the window does not warn — it fails, after the wallet
 * prompt. So the gates decide what is offered, which is the same discipline the
 * terminal's exit gate applies. `strategy/preflight.ts` has the detail.
 *
 * ── Copy standard ──
 * Every cool-down message names a DURATION and never says "lock", "locked" or
 * "cannot": the user's standard, and a test in `liquidityPreflight.test.ts`
 * asserts it. "A short cool-down applies" is friendly and useless — someone who
 * acts on it gets a failed signature rather than a disappointment.
 *
 * ── Why the figures are the chain's, not a quote's ──
 * `quoteV2LpDeposit` is 1.65% high on shares minted and `quoteV2LpWithdraw`
 * 1.6% low on both payouts. The number shown after "You receive" comes from the
 * contract's own simulated receipt, which is also what the on-chain floor is
 * set from. The SDK quote is used only for the live estimate while typing, and
 * is labelled as an estimate.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, Clock, ExternalLink, Loader2 } from "lucide-react";
import algosdk from "algosdk";
import {
  depositToMarket, withdrawFromMarket, GatedError, PinDriftError,
  type LiquidityStage,
} from "@/lib/strategy/client";
import { SubmissionUnknownError } from "@/lib/strategy/submit";
import {
  readBalances, readMarketGateState, directCooldownGate, depositRestartsCooldown,
  marketDepositMinimumGate, MARKET_MIN_DEPOSIT_USD,
  type Balances, type Gate,
} from "@/lib/strategy/preflight";
import type { LpState } from "@/lib/strategy/reads";
import { storagePaymentFor } from "@/lib/strategy/group";

type Mode = "deposit" | "withdraw";

const STAGE_LABEL: Record<LiquidityStage, string> = {
  "verifying": "Checking PEX's contracts",
  "checking-wallet": "Checking your wallet",
  "pricing": "Getting a signed price",
  "building": "Building the transaction",
  "checking": "Running the safety checks",
  "simulating": "Simulating against the chain",
  "signing": "Waiting for your wallet",
  "submitting": "Sending",
  "confirming": "Waiting for confirmation",
};

const fmt = (micro: bigint, dp = 6) => (Number(micro) / 1e6).toFixed(dp).replace(/\.?0+$/, "");

/** Parse a typed amount to micro units, rejecting anything that is not a number. */
function toMicro(text: string): bigint | null {
  const t = text.trim();
  if (!t) return BigInt(0);
  if (!/^\d*\.?\d*$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  // Round rather than truncate, then re-check: 0.1 is not representable, and
  // truncating a typed "0.1" to 99999 µ would silently deposit less than asked.
  return BigInt(Math.round(n * 1e6));
}

export function LiquidityActions({
  marketId, label, algoUsd, poolValuePerShare, algod, address, signTransactions, onDone,
}: {
  marketId: number;
  label: string;
  /** For the $5 minimum and the input's dollar hint. Null when unavailable. */
  algoUsd: number | null;
  /** For the withdrawal's dollar hint. Null when unavailable. */
  poolValuePerShare: number | null;
  algod: algosdk.Algodv2 | null;
  address: string | null;
  signTransactions: ((txns: Uint8Array[]) => Promise<(Uint8Array | null)[]>) | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("deposit");
  const [algoText, setAlgoText] = useState("");
  const [usdcText, setUsdcText] = useState("");
  const [sharePct, setSharePct] = useState(100);
  const [bal, setBal] = useState<Balances | null>(null);
  const [lp, setLp] = useState<LpState | null>(null);
  const [stage, setStage] = useState<LiquidityStage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ txId: string; outcome: string; reason?: string; figures: Record<string, bigint> } | null>(null);

  const refresh = useCallback(async () => {
    if (!algod || !address) { setBal(null); setLp(null); return; }
    try {
      const [b, s] = await Promise.all([
        readBalances(algod, address),
        readMarketGateState(algod, marketId, address),
      ]);
      setBal(b); setLp(s);
    } catch {
      // Cleared rather than left standing: a stale balance drives the Max
      // button and the gates, and a wrong one is worse than an absent one.
      setBal(null); setLp(null);
    }
  }, [algod, address, marketId]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const algoMicro = toMicro(algoText);
  const usdcMicro = toMicro(usdcText);
  const malformed = algoMicro === null || usdcMicro === null;

  const depositUsd = useMemo(() => {
    if (algoUsd === null || algoMicro === null || usdcMicro === null) return null;
    return (Number(algoMicro) / 1e6) * algoUsd + Number(usdcMicro) / 1e6;
  }, [algoUsd, algoMicro, usdcMicro]);

  const shareMicro = useMemo(() => {
    if (!lp) return BigInt(0);
    const all = BigInt(Math.round(lp.shares * 1e6));
    return all * BigInt(Math.round(sharePct)) / BigInt(100);
  }, [lp, sharePct]);

  const nowSec = Math.floor(Date.now() / 1000);
  const cooldown = lp ? directCooldownGate(lp.updatedAtSec, nowSec) : null;
  const topUpWarning = mode === "deposit" && depositRestartsCooldown(lp);

  /** The gate that disables the button, decided before any transaction exists. */
  const blocking: Gate | null = useMemo(() => {
    if (mode === "withdraw") {
      if (lp && lp.shares <= 0) {
        return { code: "nothing_to_withdraw", message: "No position in this pool yet." };
      }
      return cooldown;
    }
    if (depositUsd !== null && depositUsd > 0) return marketDepositMinimumGate(depositUsd);
    return null;
  }, [mode, lp, cooldown, depositUsd]);

  const nothingEntered = mode === "deposit"
    ? !(algoMicro && algoMicro > BigInt(0)) && !(usdcMicro && usdcMicro > BigInt(0))
    : shareMicro <= BigInt(0);

  const busy = stage !== null;
  const canSubmit = !!algod && !!address && !!signTransactions
    && !busy && !malformed && !nothingEntered && !blocking;

  async function submit() {
    if (!algod || !address || !signTransactions) return;
    setErr(null); setDone(null);
    try {
      const r = mode === "deposit"
        ? await depositToMarket({
            algod, signTransactions, sender: address, marketId,
            algoMicro: algoMicro ?? BigInt(0),
            usdcMicro: usdcMicro ?? BigInt(0),
            depositUsd: depositUsd ?? undefined,
            onStage: setStage,
          })
        : await withdrawFromMarket({
            algod, signTransactions, sender: address, marketId,
            shareAmount: shareMicro,
            onStage: setStage,
          });
      setDone({ txId: r.txId, outcome: r.outcome, reason: r.reason, figures: r.figures });
      setAlgoText(""); setUsdcText("");
      void refresh();
      onDone();
    } catch (e) {
      if (e instanceof SubmissionUnknownError) {
        // Not a failure. The remedy is to CHECK, never to retry.
        setDone({ txId: e.txId, outcome: "unknown", reason: e.message, figures: {} });
      } else if (e instanceof GatedError || e instanceof PinDriftError) {
        setErr(e.message);
      } else {
        setErr(e instanceof Error ? e.message : "Something went wrong. Nothing was sent.");
      }
    } finally {
      setStage(null);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-magnet-600 to-magnet-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-magnet-900/40 transition-all hover:from-magnet-500 hover:to-magnet-400"
      >
        Add or remove liquidity
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-black/40 p-3">
      <div className="mb-3 inline-flex w-full rounded-lg border border-white/10 bg-black/40 p-0.5">
        {(["deposit", "withdraw"] as const).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); setErr(null); setDone(null); }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              mode === m
                ? "bg-gradient-to-r from-magnet-600 to-magnet-500 text-white"
                : "text-white/55 hover:text-white"
            }`}
          >
            {m === "deposit"
              ? <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />
              : <ArrowUpFromLine className="h-3.5 w-3.5" aria-hidden="true" />}
            {m === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>

      {!address && (
        <p className="mb-2 text-[11px] text-gray-400">Connect a wallet to continue.</p>
      )}

      {mode === "deposit" ? (
        <div className="space-y-2.5">
          {/* Both legs, independently. A one-sided deposit is valid on chain —
              it just arrives off the pool's ratio and is priced for it, which
              is what the impact figure in the estimate reflects. */}
          <AmountField
            label="ALGO" value={algoText} onChange={setAlgoText}
            max={bal ? BigInt(bal.algoSpendableMicro) : null}
            /* Leave room for what else comes out of the same pot.
               `algoSpendableMicro` is already net of min-balance, so this is
               the group fee (55,000) plus the `ml2:` box MBR on a FIRST
               deposit (26,500) — a MAX that spent either would build a group
               the balance gate then refuses. The MBR is zero once the box
               exists, so a returning depositor is not asked to reserve it. */
            reserveMicro={BigInt(55_000) + storagePaymentFor(!!lp && (lp.shares > 0 || lp.updatedAtSec > 0))}
            hint={bal ? `${fmt(BigInt(bal.algoSpendableMicro), 3)} spendable` : "—"}
          />
          <AmountField
            label="USDC" value={usdcText} onChange={setUsdcText}
            max={bal ? BigInt(bal.usdcMicro) : null}
            reserveMicro={BigInt(0)}
            hint={bal ? `${fmt(BigInt(bal.usdcMicro), 2)} held` : "—"}
          />
          {depositUsd !== null && depositUsd > 0 && (
            <p className="text-[10.5px] text-gray-500">
              About ${depositUsd.toFixed(2)} in total.{" "}
              {depositUsd < MARKET_MIN_DEPOSIT_USD && (
                <span className="text-amber-300">
                  Minimum is ${MARKET_MIN_DEPOSIT_USD.toFixed(2)}.
                </span>
              )}
            </p>
          )}
          {topUpWarning && (
            <div className="flex items-start gap-1.5 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[10.5px] leading-relaxed text-gray-400">
              <Clock className="mt-[1px] h-3 w-3 shrink-0 text-gray-500" aria-hidden="true" />
              {/* `updated_at` is rewritten on every deposit, so this restarts
                  the hour on the WHOLE position — not just the amount added.
                  Saying "a cool-down applies" would read as a one-time cost. */}
              <span>
                Adding to this position restarts the 1 hour withdrawal cool-down on all of it,
                not only on the amount you add.
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          <div>
            <div className="mb-1 flex items-baseline justify-between text-[10.5px]">
              <span className="font-semibold uppercase tracking-wider text-gray-500">Amount to withdraw</span>
              <span className="font-mono text-gray-400">
                {lp ? `${fmt(BigInt(Math.round(lp.shares * 1e6)), 6)} shares held` : "—"}
              </span>
            </div>
            <input
              type="range" min={1} max={100} step={1} value={sharePct}
              onChange={(e) => setSharePct(Number(e.target.value))}
              disabled={!lp || lp.shares <= 0}
              className="w-full accent-magnet-500"
            />
            <div className="mt-1 flex items-center justify-between">
              <div className="flex gap-1">
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    onClick={() => setSharePct(p)}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                      sharePct === p ? "bg-magnet-500/25 text-magnet-200" : "text-gray-500 hover:text-gray-300"
                    }`}
                  >{p}%</button>
                ))}
              </div>
              <span className="font-mono text-[11px] text-white">
                {fmt(shareMicro, 6)} shares
                {poolValuePerShare !== null && shareMicro > BigInt(0) && (
                  <span className="ml-1.5 text-gray-500">
                    ≈ ${((Number(shareMicro) / 1e6) * poolValuePerShare).toFixed(2)}
                  </span>
                )}
              </span>
            </div>
          </div>
          <p className="text-[10.5px] leading-relaxed text-gray-500">
            Paid out as ALGO and USDC, in the pool&apos;s current proportions. The exact
            amounts are read from PEX before you sign and bounded in the transaction.
          </p>
        </div>
      )}

      {malformed && (
        <p className="mt-2 text-[11px] text-amber-300">Enter a number.</p>
      )}

      {/* The gate, stated as a duration. Never "locked", never "cannot".
          ── No `!nothingEntered` guard here ──
          It had one, to stop an empty deposit form nagging about the $5
          minimum. That also suppressed "No position in this pool yet", because
          an empty POSITION also reads as nothing entered — so a wallet with no
          shares got a disabled Withdraw button and no reason for it. The
          minimum gate is only computed when the entered value is above zero, so
          it cannot fire on an empty form and the guard was never needed. */}
      {blocking && (
        <div className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
          <Clock className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{blocking.message}</span>
        </div>
      )}

      {err && (
        <div className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-red-200">
          <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{err}</span>
        </div>
      )}

      {done && <Outcome done={done} mode={mode} />}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-magnet-600 to-magnet-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-magnet-900/40 transition-all hover:from-magnet-500 hover:to-magnet-400 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {busy
          ? STAGE_LABEL[stage!]
          : mode === "deposit" ? `Deposit to ${label}` : `Withdraw from ${label}`}
      </button>

      <button
        onClick={() => { setOpen(false); setErr(null); setDone(null); }}
        disabled={busy}
        className="mt-1.5 w-full text-center text-[11px] text-gray-500 hover:text-gray-300 disabled:opacity-40"
      >
        Close
      </button>
    </div>
  );
}

function AmountField({ label, value, onChange, max, reserveMicro, hint }: {
  label: string; value: string; onChange: (s: string) => void;
  max: bigint | null; reserveMicro: bigint; hint: string;
}) {
  const maxUsable = max === null ? null : (max > reserveMicro ? max - reserveMicro : BigInt(0));
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[10.5px]">
        <span className="font-semibold uppercase tracking-wider text-gray-500">{label}</span>
        <span className="font-mono text-gray-400">{hint}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/50 px-2.5 py-1.5 font-mono text-[13px] text-white outline-none placeholder:text-gray-600 focus:border-magnet-500/60"
        />
        <button
          onClick={() => maxUsable !== null && onChange(fmt(maxUsable, 6))}
          disabled={maxUsable === null}
          className="shrink-0 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] font-semibold text-gray-400 transition-colors hover:text-white disabled:opacity-40"
        >
          MAX
        </button>
      </div>
    </div>
  );
}

/**
 * Three outcomes, never two.
 *
 * "Unknown" is not a failure and must not read as one: the group stays valid
 * for the rest of its window and will most likely commit. Telling someone it
 * failed is what makes them do it a second time.
 */
function Outcome({ done, mode }: {
  done: { txId: string; outcome: string; reason?: string; figures: Record<string, bigint> };
  mode: Mode;
}) {
  const link = `https://allo.info/tx/${done.txId}`;
  const minted = done.figures.shares_minted;
  const algoOut = done.figures.long_out;
  const usdcOut = done.figures.short_out;

  const tone = done.outcome === "confirmed"
    ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
    : done.outcome === "rejected"
      ? "border-red-400/30 bg-red-500/10 text-red-200"
      : "border-amber-400/30 bg-amber-400/10 text-amber-200";

  return (
    <div className={`mt-2.5 rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed ${tone}`}>
      <div className="flex items-start gap-1.5">
        {done.outcome === "confirmed"
          ? <Check className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          : <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
        <div className="min-w-0">
          {done.outcome === "confirmed" && (
            <span>
              {mode === "deposit"
                ? <>Done. {minted !== undefined ? `${fmt(minted, 6)} pool shares` : "Shares"} added.</>
                : <>Done. {algoOut !== undefined && usdcOut !== undefined
                    ? `${fmt(algoOut, 6)} ALGO and ${fmt(usdcOut, 6)} USDC`
                    : "Funds"} paid out.</>}
            </span>
          )}
          {done.outcome === "rejected" && (
            <span>PEX refused this: {done.reason ?? "no reason given"}. Nothing moved.</span>
          )}
          {done.outcome === "unknown" && (
            <span>
              Sent, but we could not confirm it in time. This is not a failure — it will most
              likely still go through. Check the link before trying again.
            </span>
          )}
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 flex items-center gap-1 font-mono text-[10px] underline decoration-dotted opacity-80 hover:opacity-100"
          >
            {done.txId.slice(0, 10)}… <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
