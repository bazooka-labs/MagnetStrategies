"use client";

// Extracted from PerpsCard so it can be tested for REAL.
//
// Audit 11's structural finding was that no React component in this repo could
// be tested behaviourally — vitest ran in `node` with a `.test.ts`-only glob —
// so every card guard was pinned by a string match. Three of those tests passed
// under the bugs they claimed to prevent, including this component's own
// `problem` rule. A file that can be mounted is the fix.

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A section of the form that folds away.
 *
 * The card shows everything at once, which is right for someone who knows what
 * they are looking at and intimidating for someone who does not. The exits are
 * the two parts a first-time reader can safely meet later — the position opens
 * without either.
 *
 * ── What collapsing must never hide ────────────────────────────────────────
 * A value that is SET, and a problem with it.
 *
 * The header carries the summary, so a take-profit folded away still shows its
 * price; collapsing hides the controls, not the commitment. And `problem`
 * forces the section open and keeps it open, because the alternative is a
 * disabled submit button with its explanation folded out of sight. Clicking
 * collapse while a warning is up appears to do nothing — which is the intent,
 * and the amber summary says why.
 */
export function FormSection({
  title, summary, problem, open, onToggle, children,
}: {
  title: React.ReactNode;
  summary: string;
  /** A validation failure: forces the body open and turns the summary amber. */
  problem?: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const shown = open || !!problem;
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={shown}
        className="flex w-full items-center justify-between gap-2 rounded-lg py-1 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magnet-500"
      >
        <span className="text-xs font-medium uppercase tracking-wider text-gray-500">{title}</span>
        <span className="flex items-center gap-1.5">
          <span className={`font-mono text-[11px] tabular-nums ${problem ? "text-amber-300/90" : "text-white/45"}`}>
            {summary}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-white/35 transition-transform ${shown ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {shown && children}
    </div>
  );
}
