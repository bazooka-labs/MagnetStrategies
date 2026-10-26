# MagnetFi v2 doc consolidation — proposal

> **For review. Nothing has been deleted or moved yet.**
> Draft of the merged entry point: [OVERVIEW.draft.md](./OVERVIEW.draft.md).

Three documents overlap: `OVERVIEW.md` (222 lines), `STATUS.md` (464) and
`TODO.md` (220). Each carries status, and they disagree.

## The contradictions found

Every one of these was checked against the chain or the code, not against
another document.

| Fact | `OVERVIEW.md` | `STATUS.md` | `TODO.md` | On chain |
|---|---|---|---|---|
| U/tALGO rate | 8% | 1000 bps | 8% | **1000 bps** |
| U/USDC rate | 5% | 600 bps | 5% | **600 bps** |

The rates changed on 2026-10-14. `STATUS.md` was updated; the other two were
not, and neither says it might be stale. A reader has no way to tell which of
the three to believe.

Other drift:

- **`STATUS.md`'s own header says "Updated 2026-10-14"** while its body
  describes events through 2026-10-17. The document contradicts its own date.
- **`TODO.md` says "Last updated 2026-08-19"** — two months stale — and its
  "🔴 Blocking — must be done before mainnet launch" section still reads as
  pre-launch, in a document that states on the line above that the protocol is
  live on mainnet.
- **`TODO.md` points at oracle app `3644230020`** in its staleness-alert design.
  That is the retired banded oracle; the live one is `3741272132`.
- **`TODO.md` refers to "v4 oracle: signed payloads"** and links
  `LP_ORACLE.md#v4`. What shipped is the *lean* oracle; signed payloads are v5
  and deferred. Three naming schemes for two contracts.
- **`TODO.md`'s tripwire** "Moot once v4 ships — there is no band" is resolved:
  the band is gone.

Confirmed still accurate, as of this draft: PSM reserve **$151.40**, circulating
mUSD **101.40**, vault `3671287267`, PSM `3644230181`, lean oracle `3741272132`.

## What the draft does differently

**It does not restate figures that change.** The rates, reserve, circulating
supply and position count are pointed at — chain, `magnetfi.ts`, or the admin
panel — rather than copied. That is the only change that actually prevents this
recurring; a fourth document restating them would rot the same way.

**Status, open items and tripwires live in one place.** `CLAUDE.md`'s convention
is that these belong in the product's `OVERVIEW.md` and nowhere else.

**`STATUS.md`'s "which document to trust" table is preserved**, because it is
the single most useful thing in this folder — eight of the thirteen documents
need a qualifier before a reader should act on them, and two carry active
warnings.

## Proposed moves

| Document | Proposal |
|---|---|
| `OVERVIEW.md` | **Replaced** by the draft. |
| `STATUS.md` §1, §5, §6 | Live state, doc index and open decisions → merged into the draft. |
| `STATUS.md` §1b, §3, §3b, and the rehearsal findings | → `archive/LEAN_ORACLE_MIGRATION.md`. The migration completed 2026-10-17; this is its forensic record and it is worth keeping intact — the `confirm_lp_oracle` finding and the grouped-call assertion finding both generalise. |
| `TODO.md` deployment status + resolved audit items | → `archive/V2_DEPLOYMENT_RECORD.md`. |
| `TODO.md` tripwires + genuinely-open items | → merged into the draft. |
| `REVAMP_PLAN.md` | **Stays live.** It supersedes `TODO.md`'s ordering and is still the sequencing authority. |
| `AUDIT_HANDOFF.md`, `V3_IMPLEMENTATION_PLAN.md` | **Stay live.** Both are forward-looking. |
| Everything else | Unchanged. |

Net: 3 overlapping documents → 1 live entry point + 2 archived records.

## Open questions — need your call

**1. The two unchecked "blocking" key items.** `TODO.md` lists these as required
before mainnet, unticked, in a protocol that has been live for months:

- *Create the guardian cold multisig (2-of-3 hardware), distinct from admin and
  oracle-bot keys.*
- *Create the oracle bot wallet (separate hot key).*

The oracle bot wallet plainly exists — `QX7EPGRC…` is posting. **The guardian is
the one I cannot verify from here.** The contract rejects `guardian == admin` at
deploy, so *a* guardian address was set; whether it is a 2-of-3 hardware
multisig or a single hot key is not something the chain tells me. Which is it?
The answer changes whether this is a stale checkbox or an open risk — the
guardian is what vetoes a timelocked repoint and recovers a compromised admin.

**2. Does the bot-key rotation have a blocker I don't know about?** It is
admin-only, immediate, and one call. It has been recommended in this session
and in the docs repeatedly. If something is stopping it, that reason should be
written down; if not, it should be done before this consolidation lands, so the
merged document does not ship with it as its headline open item.

**3. Archive naming.** I propose `archive/LEAN_ORACLE_MIGRATION.md` and
`archive/V2_DEPLOYMENT_RECORD.md`. Say if you would rather they stay in
`magnetfi/v2/` under a `history/` subfolder — the argument for that is proximity
to the product; the argument against is that `archive/` is now the one place a
reader learns nothing there is current.
