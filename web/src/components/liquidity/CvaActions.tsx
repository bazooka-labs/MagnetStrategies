"use client";

/**
 * C-Vault deposit and withdraw.
 *
 * ── Why withdrawals are in DOLLARS, not a percentage slider ──
 * The pools use a share slider because nothing about them is denominated in
 * dollars. Every constraint on this vault is: a $5 withdrawal floor, a 0.2%
 * entry and exit spread, per-call caps in USD. A percentage slider would make
 * the floor a surprise at the low end, where it actually bites. So dollars are
 * primary, Max covers the full exit, and the share count sits underneath so the
 * conversion is visible rather than hidden.
 *
 * The share count is what gets signed: the amount typed is approximate, because
 * NAV moves between the quote and the signature. The receipt after the fact is
 * the chain's own figure.
 *
 * ── Why the snapshot is not read here ──
 * It carries oracle payloads that live 20 seconds and the vault prices itself
 * within one block, so `cvaClient` reads it at the moment of the action. This
 * component reads only the cheap, long-lived state the gates need.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, Clock, ExternalLink, Info, Loader2,
} from "lucide-react";
import algosdk from "algosdk";
import {
  depositToCvaVault, withdrawFromCvaVault, readCvaFormState,
  cvaDepositGates, cvaWithdrawGates, usdToShares, sharesToUsd,
  type CvaFormState, type CvaWithdrawOutput,
} from "@/lib/strategy/cvaClient";
import { GatedError, PinDriftError, type LiquidityStage } from "@/lib/strategy/client";
import { SubmissionUnknownError, SubmissionRefusedError } from "@/lib/strategy/submit";
import { cvaStoragePaymentFor } from "@/lib/strategy/cvaGroup";
import { primaryGate, type Gate, type Notice } from "@/lib/strategy/preflight";

type Mode = "deposit" | "withdraw";

const STAGE_LABEL: Record<LiquidityStage, string> = {
  "verifying": "Checking PEX's contracts",
  "checking-wallet": "Checking your wallet",
  "pricing": "Pricing the vault",
  "building": "Building the transaction",
  "checking": "Running the safety checks",
  "simulating": "Simulating against the chain",
  "signing": "Waiting for your wallet",
  "submitting": "Sending",
  "confirming": "Waiting for confirmation",
};

const trim = (n: number, dp: number) => n.toFixed(dp).replace(/\.?0+$/, "");

/** Parse a typed amount, rejecting anything that is not a plain number. */
function toNumber(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  if (!/^\d*\.?\d*$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function CvaActions({
  algoUsd, algod, address, signTransactions, onDone,
}: {
  /** For converting the ALGO leg to dollars. Null when unavailable. */
  algoUsd: number | null;
  algod: algosdk.Algodv2 | null;
  address: string | null;
  signTransactions: ((txns: Uint8Array[]) => Promise<(Uint8Array | null)[]>) | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("deposit");
  const [algoText, setAlgoText] = useState("");
  const [usdcText, setUsdcText] = useState("");
  const [outText, setOutText] = useState("");
  /**
   * What you receive. USDC by default — the vault pays out ALGO + USDC and has
   * no swap method of its own, so this converts the ALGO leg as a SECOND GROUP
   * in the same signature. See swapGroup.ts.
   */
  const [output, setOutput] = useState<CvaWithdrawOutput>("usdc");
  const [form, setForm] = useState<CvaFormState | null>(null);
  const [stage, setStage] = useState<LiquidityStage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{
    txId: string; outcome: string; figures: Record<string, bigint>;
    converted?: { usdcOutMicro: bigint; dustAlgoMicro: bigint };
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!algod) { setForm(null); return; }
    try { setForm(await readCvaFormState(algod, address)); }
    catch {
      // Cleared rather than left standing: these drive the gates and the Max
      // button, and a stale read is worse than an absent one.
      setForm(null);
    }
  }, [algod, address]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const algoAmt = toNumber(algoText);
  const usdcAmt = toNumber(usdcText);
  const outUsd = toNumber(outText);
  const malformed = algoAmt === null || usdcAmt === null || outUsd === null;

  const depositUsd = useMemo(() => {
    if (algoAmt === null || usdcAmt === null) return 0;
    return (algoUsd !== null ? algoAmt * algoUsd : 0) + usdcAmt;
  }, [algoAmt, usdcAmt, algoUsd]);

  const heldUsd = form?.held ? form.held.shares * form.navPerShare : 0;
  const shareAmount = useMemo(() => {
    if (!form || outUsd === null) return BigInt(0);
    const want = usdToShares(outUsd, form.navPerShare);
    const all = BigInt(Math.round((form.held?.shares ?? 0) * 1e6));
    return want > all ? all : want;
  }, [form, outUsd]);

  const { gates, notice } = useMemo(() => {
    if (!form) return { gates: [] as Gate[], notice: null as Notice | null };
    return cvaDepositGates(form, {
      algoLegMicro: Math.round((algoAmt ?? 0) * 1e6),
      usdcLegMicro: Math.round((usdcAmt ?? 0) * 1e6),
      depositUsd,
    });
  }, [form, algoAmt, usdcAmt, depositUsd]);

  const wGates = useMemo(
    () => (form ? cvaWithdrawGates(form, outUsd ?? 0) : []),
    [form, outUsd]);

  const blocking = mode === "deposit" ? primaryGate(gates) : primaryGate(wGates);
  const nothingEntered = mode === "deposit" ? depositUsd <= 0 : shareAmount <= BigInt(0);
  const busy = stage !== null;
  const canSubmit = !!algod && !!address && !!signTransactions
    && !busy && !malformed && !nothingEntered && !blocking;

  async function submit() {
    if (!algod || !address || !signTransactions) return;
    setErr(null); setDone(null);
    try {
      const r = mode === "deposit"
        ? await depositToCvaVault({
            algod, signTransactions, sender: address,
            algoMicro: BigInt(Math.round((algoAmt ?? 0) * 1e6)),
            usdcMicro: BigInt(Math.round((usdcAmt ?? 0) * 1e6)),
            depositUsd, onStage: setStage,
          })
        : await withdrawFromCvaVault({
            algod, signTransactions, sender: address,
            shareAmount, withdrawUsd: outUsd ?? 0, output, onStage: setStage,
          });
      setDone({
        txId: r.txId, outcome: r.outcome, figures: r.figures,
        ...("converted" in r && r.converted ? { converted: r.converted } : {}),
      });
      setAlgoText(""); setUsdcText(""); setOutText("");
      void refresh();
      onDone();
    } catch (e) {
      if (e instanceof SubmissionRefusedError) {
        /**
         * Refused by the node: NOTHING was sent.
         *
         * This used to fall through to the generic handler and render the
         * `unknown` copy — "it will most likely still go through" — which was
         * false, and told the user to go and check a transaction that did not
         * exist. An error is the honest rendering.
         */
        setErr(e.message);
      } else if (e instanceof SubmissionUnknownError) {
        setDone({ txId: e.txId, outcome: "unknown", figures: {} });
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
        Deposit or withdraw
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

      {!address && <p className="mb-2 text-[11px] text-gray-400">Connect a wallet to continue.</p>}

      {mode === "deposit" ? (
        <div className="space-y-2.5">
          {/* The vault takes both assets and allocates them itself — the user
              picks no market, which is the whole point of the managed option. */}
          <Field
            label="ALGO" value={algoText} onChange={setAlgoText}
            hint={form ? `${trim(form.algoSpendableMicro / 1e6, 3)} spendable` : "—"}
            onMax={form ? () => {
              const reserve = 74_000 + Number(cvaStoragePaymentFor(form.held !== null));
              setAlgoText(trim(Math.max(0, (form.algoSpendableMicro - reserve) / 1e6), 6));
            } : undefined}
          />
          <Field
            label="USDC" value={usdcText} onChange={setUsdcText}
            hint={form ? `${trim(form.usdcMicro / 1e6, 2)} held` : "—"}
            onMax={form ? () => setUsdcText(trim(form.usdcMicro / 1e6, 6)) : undefined}
          />
          {depositUsd > 0 && (
            <p className="text-[10.5px] text-gray-500">
              About ${depositUsd.toFixed(2)} in total.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          <Field
            label="Withdraw (USD)" value={outText} onChange={setOutText}
            prefix="$"
            hint={form?.held ? `$${heldUsd.toFixed(2)} available` : "—"}
            onMax={form?.held ? () => setOutText(heldUsd.toFixed(2)) : undefined}
          />
          {/* The conversion, shown rather than hidden: shares are what is
              signed, and the dollar figure is approximate because NAV moves. */}
          {shareAmount > BigInt(0) && form && (
            <p className="text-[10.5px] text-gray-500">
              ≈ {trim(Number(shareAmount) / 1e6, 6)} vault shares at $
              {form.navPerShare.toFixed(6)} each. The exact payout is read from PEX
              before you sign.
            </p>
          )}
          {/* What you receive. Both options are honest about their cost. */}
          <div>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-gray-500">
              Receive as
            </div>
            <div className="inline-flex w-full rounded-lg border border-white/10 bg-black/40 p-0.5">
              {(["usdc", "both"] as const).map((o) => (
                <button
                  key={o}
                  onClick={() => setOutput(o)}
                  className={`flex-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                    output === o ? "bg-white/[0.08] text-white" : "text-white/50 hover:text-white"
                  }`}
                >
                  {o === "usdc" ? "Convert to USDC" : "ALGO + USDC"}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[10.5px] leading-relaxed text-gray-500">
            {output === "usdc" ? (
              <>
                {/* ── Why the label is "Convert to USDC", not "All USDC" ──
                    "Convert" names what we DO; "All USDC" would promise an
                    outcome we cannot guarantee, since roughly 1% stays ALGO
                    and the conversion can fail. A verb is honest about a
                    process; a noun claims a result.

                    The last sentence replaces a recovery feature. A button to
                    convert the leftover would cost 0.043 ALGO in fees against
                    ~0.19 ALGO of dust — 23% of it — so the right answer is to
                    tell the user plainly and let them decide, not to build a
                    control they should not press. */}
                The vault pays out ALGO and USDC. We&apos;ll convert the ALGO for you in
                the <strong className="font-semibold text-gray-300">same signature</strong>,
                so you receive close to all of it as USDC — a little under{" "}
                <strong className="font-semibold text-gray-300">1%</strong> stays as ALGO,
                and the conversion costs about 0.4%. If the conversion doesn&apos;t go
                through you simply keep the ALGO and can swap it yourself whenever you
                like; <strong className="font-semibold text-gray-300">nothing is
                lost</strong>.
              </>
            ) : (
              <>
                Paid out as <strong className="font-semibold text-gray-300">ALGO and
                USDC</strong>, in the vault&apos;s current proportions — no conversion, so
                no conversion cost.
              </>
            )}{" "}
            This vault&apos;s minimum withdrawal is $
            {form ? form.vault.minWithdrawUsd.toFixed(2) : "5.00"}.
          </p>
        </div>
      )}

      {malformed && <p className="mt-2 text-[11px] text-amber-300">Enter a number.</p>}

      {/* A notice sits beside an ENABLED button; a gate disables it. */}
      {mode === "deposit" && notice && !blocking && (
        <div className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[10.5px] leading-relaxed text-gray-400">
          <Info className="mt-[1px] h-3 w-3 shrink-0 text-gray-500" aria-hidden="true" />
          <span>{notice.message}</span>
        </div>
      )}

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

      {done && <CvaOutcome done={done} mode={mode} />}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-magnet-600 to-magnet-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-magnet-900/40 transition-all hover:from-magnet-500 hover:to-magnet-400 disabled:cursor-not-allowed disabled:opacity-45"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {busy
          ? STAGE_LABEL[stage!]
          : mode === "deposit"
            ? "Deposit to C-Vault"
            : output === "usdc" ? "Withdraw as USDC" : "Withdraw from C-Vault"}
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

function Field({ label, value, onChange, hint, onMax, prefix }: {
  label: string; value: string; onChange: (s: string) => void;
  hint: string; onMax?: () => void; prefix?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[10.5px]">
        <span className="font-semibold uppercase tracking-wider text-gray-500">{label}</span>
        <span className="font-mono text-gray-400">{hint}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          {prefix && (
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[13px] text-gray-500">
              {prefix}
            </span>
          )}
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            className={`w-full rounded-lg border border-white/10 bg-black/50 py-1.5 font-mono text-[13px] text-white outline-none placeholder:text-gray-600 focus:border-magnet-500/60 ${
              prefix ? "pl-6 pr-2.5" : "px-2.5"}`}
          />
        </div>
        <button
          onClick={onMax}
          disabled={!onMax}
          className="shrink-0 rounded-lg border border-white/10 px-2 py-1.5 text-[10px] font-semibold text-gray-400 transition-colors hover:text-white disabled:opacity-40"
        >
          MAX
        </button>
      </div>
    </div>
  );
}

function CvaOutcome({ done, mode }: {
  done: {
    txId: string; outcome: string; figures: Record<string, bigint>;
    converted?: { usdcOutMicro: bigint; dustAlgoMicro: bigint };
  };
  mode: Mode;
}) {
  const f = done.figures;
  const minted = f.cva_shares_minted ?? f.shares_minted;
  const algoOut = f.long_out ?? f.long_amount_out;
  const usdcOut = f.short_out ?? f.short_amount_out;
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
          {done.outcome === "confirmed" && (mode === "deposit"
            ? <span>Done. {minted !== undefined ? `${trim(Number(minted) / 1e6, 6)} vault shares` : "Shares"} added.</span>
            : done.converted
              /* Converted: report the TOTAL USDC and NAME the dust. Claiming
                 an all-USDC payout the group did not make is the kind of small
                 lie that costs trust on a money screen. */
              ? <span>
                  Done. {trim((Number(usdcOut ?? 0) + Number(done.converted.usdcOutMicro)) / 1e6, 6)}
                  {" "}USDC paid out
                  {done.converted.dustAlgoMicro > BigInt(0)
                    && `, plus ${trim(Number(done.converted.dustAlgoMicro) / 1e6, 6)} ALGO that could not be converted`}.
                </span>
              : <span>Done. {algoOut !== undefined && usdcOut !== undefined
                  ? `${trim(Number(algoOut) / 1e6, 6)} ALGO and ${trim(Number(usdcOut) / 1e6, 6)} USDC`
                  : "Funds"} paid out.</span>)}
          {done.outcome === "rejected" && <span>PEX refused this. Nothing moved.</span>}
          {done.outcome === "partial" && (
            // Half-done is its own state. Calling it success or failure would
            // both be false, and the user needs to know which half happened.
            <span>
              Your funds left the vault, but the conversion didn&apos;t go through.
              <strong className="font-semibold"> Nothing is lost</strong> — the ALGO and
              USDC are both in your wallet, and you can swap the ALGO yourself whenever
              you like.
            </span>
          )}
          {done.outcome === "unknown" && (
            <span>
              Sent, but we could not confirm it in time. This is not a failure — it will most
              likely still go through. Check the link before trying again.
            </span>
          )}
          <a
            href={`https://allo.info/tx/${done.txId}`}
            target="_blank" rel="noopener noreferrer"
            className="mt-1 flex items-center gap-1 font-mono text-[10px] underline decoration-dotted opacity-80 hover:opacity-100"
          >
            {done.txId.slice(0, 10)}… <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
