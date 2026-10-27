# CLAUDE.md

Working notes for Claude Code in this repo. Read before changing anything.

This file is a **map, a set of conventions, and the agreements we work under**.
It deliberately holds **no facts that live somewhere else** — no app IDs, no
addresses, no per-product status. Those have a single source of truth and this
file points at it. Every duplicated fact in this repo has eventually diverged,
which is the problem this file exists to stop rather than repeat.

---

## What this is

Magnet Strategies — an Algorand-native DeFi organisation. A monorepo holding a
Next.js frontend and the docs, contracts and bots for several products.
**The repo is public.** Treat everything in it as readable by users, partners
and anyone evaluating the protocol.

---

## Map

| Path | Holds | Entry point |
|---|---|---|
| `org/` | The organisation, $U tokenomics, treasury, roadmap | `org/OVERVIEW.md` |
| `magnetfi/` | MagnetFi — LP-collateral vaults, mUSD, PSM. The "Finance" nav item | `magnetfi/v2/OVERVIEW.md` |
| `strategy/` | The Strategy arm: shared doctrine + two products | `strategy/OVERVIEW.md` |
| `strategy/perps/` | Trading Terminal on PEX (nav: **Trade**) | `strategy/perps/OVERVIEW.md` |
| `strategy/pools/` | Strategy Pools + C-Vault on PEX (nav: **Strategy**) | `strategy/pools/OVERVIEW.md` |
| `predict/` | VPL volatility ladder. Its own tree, deliberately | `predict/OVERVIEW.md` |
| `vote/` | UVote governance | `vote/OVERVIEW.md` |
| `contracts/magnetdao/` | MagnetDAO-era contracts; only `uvote/` is live | — |
| `web/` | The Next.js frontend | `web/README.md` |
| `archive/` | Repo-wide finished work — closed audits and remediations | `archive/README.md` |
| `<product>/history/` | A product's own closed records — `magnetfi/v2/`, `strategy/perps/`, `org/` each have one | the folder's `README.md`, or the file's own banner |

The **app nav** is organised by user intent; the **repo** is organised by where
doctrine lives. They are allowed to differ, and do.

---

## Where facts live

Look these up; do not restate them in a doc.

| Fact | Source of truth |
|---|---|
| PEX app IDs, program hashes, oracle signer pin | `web/src/lib/perps.ts` |
| MagnetFi app IDs, mUSD ASA, admin address | `web/src/lib/magnetfi.ts` |
| $U / USDC ASA IDs, node URLs | `web/src/lib/constants.ts` |
| UVote app | `web/src/lib/uvote.ts` — **not** `constants.ts`, whose `VOTING_APP_ID` is the RETIRED 2026 voting app and is never read |
| VPL (Predict) | `web/src/lib/vpl.ts` |
| Nav items and routes | `web/src/components/Navbar.tsx` (+ `Navbar.test.tsx`) |
| Redirects | `web/next.config.js` |
| Live contract parameters (spreads, cooldowns, caps) | **The chain.** Read them; never hardcode |

That last row is a rule, not a preference. PEX's admin can change
`cva_mint_spread_bps` and friends at any time, so the UI reads them live.

---

## Doc conventions

Four types. Use these names; do not invent a fifth.

| File | Holds |
|---|---|
| `OVERVIEW.md` | What it is, why, **current status**, **open items**, links out. The entry point for a product. |
| `SPEC.md` | Mechanism detail — box layouts, selectors, invariants, group shapes. |
| `OPERATIONS.md` | Runbooks: deploy, keys, monitoring, what to do when it breaks. |
| `archive/` or `<product>/history/` | Anything **finished and not resuming**. Keep it; a public protocol showing how its failures were found is worth more than a tidy tree. Read the doc before moving it — `REVAMP_PLAN.md` and `AUDIT_HANDOFF.md` both sound historical and are live. |

Root `archive/` is for repo-wide closed work. A product keeps its own
`history/` when the records are dense protocol detail that only reads correctly
beside the contracts they describe — `magnetfi/v2/history/` is the example.
Either way every file in them carries a banner saying it is not current, and
names what has changed since.

**Status and open items go in that product's `OVERVIEW.md` and nowhere else.**
Separate `STATUS.md` / `TODO.md` / `NEXT.md` files are what rot fastest, because
three filenames guarantee two of them go stale. All five that existed have been
merged away — if you are about to create another, put a section in `OVERVIEW.md`
instead.

**`README.md` at the root is a map, not a status board.** If shipping a feature
means editing the README, the README is carrying something it should have
linked to instead.

---

## How we work

These are settled agreements, each learned from a specific failure. They are
here rather than in a private memory so they are reviewable, public, and apply
to anyone working in this repo.

**Measure, don't model.** Verify constants and dependencies against the live
system rather than reasoning about what they should be. Three wrong claims came
from coherent reasoning over unverified premises. Read the chain, run the
command, fetch the file.

**Simulation is not a signature.** A hermetic test passing says nothing about
whether a real wallet can sign the group. Several defects in the liquidity path
were invisible to tests and obvious to a MainNet simulation. Test the
first-time shape explicitly — the box-MBR bug reached production because every
test used a wallet that already had the box.

**Floors come from the contract's own receipt**, never from an SDK quote. The
quotes run ~1.65% high on deposits and ~1.74% low on withdrawals, which makes a
quote-derived floor unsatisfiable on chain.

**Assert behaviour, not source text.** Guard tests with the AST or real
behaviour; a comment containing the right words defeats a grep-based test. This
has bitten four times. When a test is meant to prevent something, verify it
fails when that thing is reintroduced — mutate the code, watch it go red, put
it back.

**Render visuals before shipping them.** Rasterise the page and look at it.
Reasoning about geometry and colour has missed real errors that one screenshot
caught: a clipped wallet button, a heading glow that rendered as nothing, a
contrast ratio under the accessible threshold.

**No hot fixes on money paths.** Queue the change as a spec, then run a fresh
review for breakage and attack vectors before pushing.

**Report outcomes faithfully.** If a submission's result is unknown, say
unknown. Reporting a refusal as "it will most likely still go through" was
worse than the bug that caused it.

---

## Verifying a change

From `web/`:

```bash
npx tsc --noEmit -p tsconfig.json   # types
npx vitest run                      # hermetic suite
npx next build                      # production build
```

MainNet tests are excluded from the default run by design — a suite that fails
when the network is down is a suite people stop trusting:

```bash
npx vitest run --config vitest.live.config.ts
```

Deploys are routine; do not ask for confirmation before a production deploy.

---

## Deliberate oddities — do not "fix" these

Each of these looks like a mistake and is not. They are listed so a future
session does not spend an afternoon correcting them.

- **`contracts/magnetdao/` keeps the old name.** `deploy_uvote.py` does a real
  package import from it, so renaming breaks the deploy of a live governance
  contract, and breaks it silently.
- **`strategy/perps/` and `components/strategy/` vs the UI labels.** The UI says
  "Trading Terminal" and "Trade"; the directories say `perps` and `strategy`.
  Labels, not a restructure.
- **The Haystack API key is a literal in client code.** It is TxnLab's published
  free-tier key, printed in their README and shared by every app using the
  default. It is not ours, not secret, and has always shipped in the browser
  bundle. See the comment in `web/src/components/HaystackSwap.tsx`.
- **The CSP is `Content-Security-Policy-Report-Only`.** Deliberate until the
  wallet-connector walkthrough in `web/next.config.js` has been completed.
- **`/strategy` is not in `next.config.js` redirects.** It used to redirect to
  `/trade`; it is now its own page.
