# MagnetFi — where things stand

_Updated 2026-10-14. **Start here.** The document set has churned a lot in the
last week and several specs supersede each other; this page says what is live,
what is built, what is next, and which document to trust for what._

---

## 1. Live on mainnet, right now

| | | |
|---|---|---|
| LP Oracle | `3644230020` | **banded** — ±25% anchor, ±50%-vs-prior |
| PSM v3 | `3644230181` | reserve **$151.40 USDC** |
| Vault | `3671287267` | **3 open positions**, all the founder's own wallets |
| mUSD ASA | `3615600399` | ~$100 circulating, essentially all in the mUSD/USDC pool |

**Collateral registered on the vault:** U/tALGO `3163770927`, U/USDC `3673941603`.
**Registered on the oracle only** (priced, but nothing can borrow against them):
ALGO/USDC `1002590888`, U/ALGO `3617313492`.

### ⚠️ The feed is down

The oracle bot stopped on 2026-10-13 after a host reboot and has not been
restarted. All pools are past the vault's 30-minute freshness window, so
**borrowing and all three liquidation paths are currently reverting.** No
exposure — every position is the founder's and none is near liquidation — but
nothing else in this document matters until it is running.

**Fix:** `git pull` on the bot host, then restart. The pull also deploys four
pools instead of two; ALGO/USDC and U/ALGO have **never been posted to**, which
is why their price still equals the seed `add_pool` wrote.

---

## 2. The plan, in one paragraph

The oracle has frozen three times. Two were the bot's own hardcoded bounds —
**fixed**. One, on 2026-08-21, was the *contract's* anchor band rejecting a
perfectly valid post, and that cause is **still live**. The fix is a new oracle
with the bands deleted, swapped in behind the vault's existing 48h timelock.
The operator has accepted key-compromise risk explicitly; the bands only ever
bounded a compromised key, and their cost — a protocol-wide freeze — is not
accepted.

**Authoritative document: [ORACLE_LEAN_SPEC.md](./ORACLE_LEAN_SPEC.md).**

---

## 3. What is built but not deployed

| | state |
|---|---|
| **Lean oracle contract** | compiled, schema 57/7, no anchor or band in the TEAL |
| **Bot: adaptive bounds** | serves the banded AND lean oracle from one binary, decided per read — so the 48h parallel window needs no flag day |
| **Bot: composition warning** | warns when a pool's two sides disagree; never gates |
| **Bot: TWAP gap handling** | discards history across an outage rather than averaging through it |
| Phase 0 (bot) | all pushed, **none deployed** — see §1 |

**Still required before the lean oracle ships:** contract integration tests (the
full vault suite run against it, as was done for v5), a LocalNet rehearsal of
the whole migration, a **price-plausibility monitor** running outside the bot
process, and the doc sweep in §5.

## 4. Built, proven, and deliberately shelved

The **v5 relay oracle** — signed payloads any third party can relay — is fully
built: payload format (59 tests), contracts (compiled, 17 tests), signer (19
tests), the drop-in claim demonstrated by running the entire vault suite against
it, and the liveness property executable.

It is deferred, not abandoned. What it adds over the lean oracle — zero-second
pricing at the moment of liquidation, and no key the contract trusts — is worth
less than it costs **while every borrower is the operator**. Both become
valuable the moment that stops being true.

**Tripwire — before a third-party borrower opens a vault:** re-answer the
key-compromise question. Without the bands, a compromised bot key can set any
price, and the PSM invariant caps only the over-minting direction. See
[ORACLE_LEAN_SPEC.md §5](./ORACLE_LEAN_SPEC.md).

---

## 5. Which document to trust

| document | status |
|---|---|
| **STATUS.md** (this) | current |
| **ORACLE_LEAN_SPEC.md** | **current plan** — the next thing to build |
| ORACLE_V5_SPEC.md | built and proven, **deferred**; carries the notice |
| SIGNED_PAYLOAD.md | current, describes v5's wire format |
| REVAMP_PLAN.md | phase structure still useful; **Phase 2 is superseded** by the lean spec |
| LP_ORACLE.md | accurate for the **live banded** oracle; its "v4" section is superseded |
| **ADMIN.md** | **accurate for what is running** — see below |
| LAUNCH_RUNBOOK.md | accurate for adding a pool to the **banded** oracle |
| TODO.md | its "path forward" predates both re-scopes; use this page instead |
| AUDIT.md, AUDIT_HANDOFF.md | **historical records.** P19-03 documents the anchor band as a finding that was *addressed*; the band is now being removed deliberately. Do not rewrite the record — it is what was true then |
| PSM.md, VAULT.md, LIQUIDATION.md, mUSD.md, OVERVIEW.md, FOLKS_ADAPTER.md | unaffected |

### ADMIN.md is not stale yet, and must not be "fixed" early

`ADMIN.md:151` tells the operator how to recognise an **anchor-band rejection**
and re-anchor out of it. That guidance is **correct today** and stays correct
for the whole 48h migration window, because the banded oracle remains the
vault's oracle until `confirm_lp_oracle`. U/tALGO currently sits at `933,838`
against an anchor of `870,000` — about 16% of room to the ceiling — so this is
a live procedure, not a historical one.

It becomes wrong at **migration step 8**, not before. The same applies to the
re-anchor action in the admin UI: removing it early takes away the only remedy
for a freeze that can still happen.

---

## 6. Open decisions

**Settled:** the composition check warns rather than gates, at 5%; a TWAP gap
discards history (option A) above 2× the expected cycle spacing.

**Open:**

- **A storage bucket** — only needed if v5 is revived; the lean oracle needs none.
- **Interest rates.** Two admin calls, affecting new vaults only:
  `set_rate(3163770927, 1000)` and `set_rate(3673941603, 600)`. Live values are
  800 and 500.
- **Vault-side registration for ALGO/USDC and U/ALGO** — deliberately deferred
  until the migration, so the pools are registered once rather than twice.
