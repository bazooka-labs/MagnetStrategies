"use client";

/**
 * One copy of the proposal list, shared by everything that counts it.
 *
 * The hero's "Live proposals" pill and the Governance section at the foot of
 * the page both need the same answer. Fetched independently they would be two
 * reads of one box set on every page load, and — the part that actually matters
 * — two numbers that can disagree: a pill advertising a vote that the section
 * below has already closed, or the reverse, right after someone votes.
 *
 * So the list lives in a module-level store that both subscribe to. One fetch,
 * one truth, and `refresh()` from either reaches both.
 *
 * `useSyncExternalStore` rather than a context: the two consumers sit in
 * different branches of a tree whose top is a SERVER component, and wrapping
 * them in a provider would mean making that boundary client — which is what
 * keeps /tokens shipping its content in statically generated HTML.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type algosdk from "algosdk";
import { useWallet } from "@/hooks/useWallet";
import { listProposals } from "@/lib/governanceReads";
import { GOVERNANCE_ERAS, isActive, type Proposal } from "@/lib/governance";

type Snapshot = { proposals: Proposal[]; loading: boolean };

/**
 * Loading is gated on there being an era to READ, not on mVote being live.
 *
 * Those differ for exactly as long as mVote is undeployed: the retired $U app
 * still holds the protocol's only voting history, and gating on the live
 * contract would blank that history until the new one ships.
 */
const HAVE_ERAS = GOVERNANCE_ERAS.length > 0;

/** Replaced wholesale, never mutated: the identity IS the change signal. */
let snapshot: Snapshot = { proposals: [], loading: HAVE_ERAS };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let everLoaded = false;

function set(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function load(algod: algosdk.Algodv2): Promise<void> {
  // Concurrent callers share the one request rather than racing: both consumers
  // mount in the same tick on first paint.
  if (inflight) return inflight;
  set({ ...snapshot, loading: true });
  inflight = listProposals(algod)
    .then((proposals) => { everLoaded = true; set({ proposals, loading: false }); })
    .catch(() => {
      // Keep whatever was already shown. A failed read is not evidence that the
      // proposals went away, and blanking the list would say it is.
      set({ ...snapshot, loading: false });
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useGovernanceProposals() {
  const { algodClient } = useWallet();
  const state = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  useEffect(() => {
    if (!HAVE_ERAS || !algodClient || everLoaded || inflight) return;
    void load(algodClient);
  }, [algodClient]);

  const refresh = useCallback(() => {
    if (algodClient) void load(algodClient);
  }, [algodClient]);

  return { ...state, refresh };
}

/** The count the pill advertises, defined once so it cannot drift from the list. */
export const liveCount = (proposals: Proposal[]): number =>
  // A retired era cannot have a live proposal, but say so rather than rely
  // on its last window having closed.
  proposals.filter((p) => p.era.accepting && isActive(p)).length;
