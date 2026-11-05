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
import {
  GOVERNANCE_ERAS, isActive, type GovernanceEra, type Proposal,
} from "@/lib/governance";

type Snapshot = {
  proposals: Proposal[];
  loading: boolean;
  /**
   * A read failed, so this list may be incomplete.
   *
   * Separate from `proposals.length === 0`, which means "there are none". The
   * two used to be the same value and a rate-limited node could therefore say
   * "Nothing to vote on right now" while a vote was open.
   */
  incomplete: boolean;
};

/**
 * Loading is gated on there being an era to READ, not on mVote being live.
 *
 * Those differ for exactly as long as mVote is undeployed: the retired $U app
 * still holds the protocol's only voting history, and gating on the live
 * contract would blank that history until the new one ships.
 */
const HAVE_ERAS = GOVERNANCE_ERAS.length > 0;

/**
 * Keep what an era returned LAST time when it could not be read THIS time.
 *
 * `listProposals` resolves even when an era fails — it reports the failure in
 * `failed` rather than rejecting — so the `.catch` below does not run for the
 * common case. Replacing the list wholesale therefore discarded everything the
 * failed era had previously returned: a 503 on mVote dropped a LIVE proposal
 * off the page and showed "Nothing to vote on right now", underneath a banner
 * saying the read was incomplete. That is the exact bug the banner exists to
 * prevent, reintroduced one layer up.
 *
 * Carried-over proposals are stale. Stale and labelled beats absent and
 * silent, which is the same call `usePerpsPositions` makes about a position it
 * cannot price.
 *
 * Exported because the subtlety is worth a name and a test of its own.
 */
export function mergeAcrossEras(
  previous: Proposal[], fresh: Proposal[], failed: GovernanceEra[],
): Proposal[] {
  if (failed.length === 0) return fresh;
  const failedKeys = new Set(failed.map((e) => e.key));
  // Only eras that failed are carried; an era that read cleanly is authoritative,
  // including when it legitimately returned nothing.
  const carried = previous.filter((p) => failedKeys.has(p.era.key));
  return [...fresh, ...carried].sort((a, b) => b.endTime - a.endTime);
}

/** Replaced wholesale, never mutated: the identity IS the change signal. */
let snapshot: Snapshot = { proposals: [], loading: HAVE_ERAS, incomplete: false };
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
    .then(({ proposals, failed }) => {
      // `everLoaded` only latches on a COMPLETE read. A partial load used to
      // set it, which meant the automatic retry never fired and a transient
      // failure became permanent for the life of the page.
      if (failed.length === 0) everLoaded = true;

      set({
        proposals: mergeAcrossEras(snapshot.proposals, proposals, failed),
        loading: false,
        incomplete: failed.length > 0,
      });
    })
    .catch(() => {
      // Keep whatever was already shown. A failed read is not evidence that the
      // proposals went away, and blanking the list would say it is.
      set({ ...snapshot, loading: false, incomplete: true });
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
