"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

const PANEL =
  "relative overflow-hidden rounded-2xl border border-white/10 bg-black/40 backdrop-blur-sm shadow-xl shadow-black/40";

export function AboutModal({
  triggerLabel,
  heading,
  children,
}: {
  triggerLabel: string;
  heading: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-300 transition-colors hover:border-magnet-500/50 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-magnet-500"
      >
        <Info className="h-3.5 w-3.5" />
        {triggerLabel}
      </button>

      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <div role="dialog" aria-modal="true" aria-label={heading} className={`${PANEL} w-full max-w-lg p-6 sm:p-8`}>
            <div className="flex items-start justify-between gap-4">
              <h2 className="font-display text-lg font-semibold text-white">{heading}</h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-gray-400 transition-colors hover:border-magnet-500/50 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-magnet-500"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm leading-relaxed text-gray-400">
              {children}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
