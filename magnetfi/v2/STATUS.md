# MagnetFi — where things stand

_Updated 2026-10-14. **Start here.** The document set has churned a lot in the
last week and several specs supersede each other; this page says what is live,
what is built, what is next, and which document to trust for what._

---

## 1. Live on mainnet, right now

| | | |
|---|---|---|
| LP Oracle | `3644230020` | **banded** — ±25% anchor, ±50%-vs-prior. Still the vault's oracle |
| **Lean oracle** | `3741272132` | deployed 2026-10-14, no band. **Queued, not yet live** — see §1b |
| PSM v3 | `3644230181` | reserve **$151.40 USDC** |
| Vault | `3671287267` | **3 open positions**, all the founder's own wallets |
| mUSD ASA | `3615600399` | **101.40** circulating |

**Interest rates** (set on chain 2026-10-14, matching the UI): U/tALGO **1000 bps**,
U/USDC **600 bps**. These apply to NEW vaults only — the rate is copied into the
vault box at `open_vault`, so the three open positions stay at 800/500/800 for
their whole life.

> **Open loans do NOT need to be closed for this migration.** That requirement
> (`REVAMP_PLAN.md:22`) is a consequence of deploying a new **vault**, the one
> contract with no repointing path; `ORACLE_V5_SPEC.md:84` tabulates it as the
> v4-vs-v5 difference — *"unwind every open position: yes | no"*. The lean
> oracle swap repoints the **oracle** via `propose_lp_oracle` →
> `confirm_lp_oracle` and never redeploys the vault, so vault boxes are
> untouched. Asserted, not inferred: see §3's rehearsal.

**Collateral registered on the vault:** U/tALGO `3163770927`, U/USDC `3673941603`.
**Registered on the oracle only** (priced, but nothing can borrow against them):
ALGO/USDC `1002590888`, U/ALGO `3617313492`.

### The feed — restored 2026-10-14

The bot stopped on 2026-10-13 after a host reboot; borrowing and all three
liquidation paths reverted for ~27 hours. Restarted 2026-10-14 18:44Z, first
posts at 18:49Z after the expected TWAP warm-up (`MIN_TWAP_READINGS = 3` at
~370s spacing, rebuilt from scratch because the outage was far past `max_gap`).

All four pools are posting. **ALGO/USDC and U/ALGO were priced for the first
time ever** — before this they carried only the seed `add_pool` wrote.

First live read of the cross-check, against a healthy feed: divergence
**0.04%–0.69%** across the four pools. That supersedes the 0.26–4.20% recorded
in §3b, which was measured against a feed frozen 23–109 hours and is an upper
bound rather than a sample — the 5% warn line has ~15x headroom over real lag,
not the 1.2x the stale numbers implied.

## 1b. ⚠️ Migration in flight — the 48h window

`propose_lp_oracle(3741272132)` was submitted **2026-10-14 20:46Z**.

| | |
|---|---|
| confirmable at | **2026-10-16 20:46:52Z** |
| vault still reads | `3644230020` (banded) until `confirm_lp_oracle` |
| both oracles | fed by separate bot instances, all four pools fresh on each |

Steps 1–5 of [ORACLE_LEAN_SPEC.md §6](./ORACLE_LEAN_SPEC.md) are done. The lean
oracle's deployed bytecode was verified to match the repo artifact exactly, its
pools were seeded from the live feed (0.00–0.03% off), and it carries **zero**
anchor keys.

**Until the confirm, three things must hold:**

- **Both bots keep running.** The banded oracle is still the vault's; stopping
  its instance freezes the protocol, and the timelock applies in both directions.
- **Do not rotate the vault admin.** `accept_admin` clears `pending_lp_oracle`
  (`vault/contract.py:288-292`) with no revert and no warning, silently
  restarting the 48 hours.
- **Confirm on posts, not on freshness.** `add_pool` sets `lp_ts_`, so a seeded
  oracle reads "fresh" for 30 minutes whether or not its bot ever worked. The
  test is a transaction from the bot wallet, not a recent timestamp. (This
  caught us once: the lean oracle showed four fresh pools while having received
  zero posts.)

The guardian veto — `cancel_pending_lp_oracle` — is available throughout.

---

## 2. The plan, in one paragraph

The oracle has frozen three times. Two were the bot's own hardcoded bounds —
**fixed**. One, on 2026-08-21, was the *contract's* anchor band rejecting a
perfectly valid post, and that cause is **still live until the swap confirms**.
The fix is a new oracle with the bands deleted, swapped in behind the vault's
existing 48h timelock — deployed and queued as of 2026-10-14, see §1b.
The operator has accepted key-compromise risk explicitly; the bands only ever
bounded a compromised key, and their cost — a protocol-wide freeze — is not
accepted.

**Authoritative document: [ORACLE_LEAN_SPEC.md](./ORACLE_LEAN_SPEC.md).**

---

## 3. What is built

| | state |
|---|---|
| **Lean oracle contract** | **DEPLOYED `3741272132`** 2026-10-14 — schema 57/7, zero anchor keys on chain, deployed bytecode verified identical to the repo artifact |
| **Lean oracle: vault suite** | **108 passed / 20 skipped** (128 collected) — the whole suite run against it, as was done for v5 |
| **Migration rehearsal** | **9 tests, passing** — the §6 sequence executed on LocalNet with both oracles live |
| **Bot: adaptive bounds** | serves the banded AND lean oracle from one binary, decided per read — so the 48h parallel window needs no flag day |
| **Bot: composition warning** | warns when a pool's two sides disagree; never gates |
| **Bot: TWAP gap handling** | discards history across an outage rather than averaging through it |
| Phase 0 (bot) | all pushed, **none deployed** — see §1 |

**Still required before the lean oracle ships:** the doc sweep in §5, which
must happen at migration step 8 and **not before**.

#### The "price-plausibility monitor" was downgraded — 2026-10-14

Earlier revisions of this page listed an out-of-process price-plausibility
monitor as a ship blocker. **It was not a discussed requirement**; it entered in
the lean spec (§5, §6) and propagated here, and the reasoning behind calling it
a blocker does not hold up:

- The band-distance warning it was meant to "replace" existed to predict
  **band-caused freezes**. Removing the band removes that failure mode, so the
  indicator's purpose goes with it. The remaining freeze mode is staleness,
  already covered by `FeedWatch`'s `lp_ts_` age and `getOracleHealth.level`.
- The frightening **bug class** — a one-sided decimals slip putting the LP price
  at ~0.55x truth with every asset-price check green ($U has 5 decimals) — is
  covered by the composition check, which is **built** and set to warn at 5%.
- What is genuinely left is **key-compromise detection**, since the monitor's
  distinguishing feature was running outside the process whose key is the
  threat. That is the risk the operator accepted explicitly, and the same
  argument that deferred v5.

The claim that this change "trades a freeze cause for a blind spot" was half
wrong: the blind spot is for a **wrong-but-fresh price**, not for a freeze.

What was done instead, because it needs no new process, key or alert channel:
a **price cross-check surfaced in the admin panel** — see §3b.

**Say plainly what that is and is not.** The cross-check is a *pull* readout, not
an alert: no push, no channel, and it sits behind a connected admin wallet.
Detecting a wrong-but-fresh price with it requires somebody to be looking at the
page at the time. Right now it returns **"unknown" for every pool**, because the
feed has been down since 2026-10-13 and a stale feed is deliberately left
unjudged.

So the key-compromise risk the monitor was meant to cover is **accepted, not
covered**. That is a defensible position at ~$100 mUSD circulating with three
positions all belonging to the operator — but it is a risk acceptance, and it
should be re-opened by the same tripwire as v5: before a third-party borrower
opens a vault.

### Integration tests — done 2026-10-14

`MAGNETFI_ORACLE` now selects the oracle and runs the entire suite against it:

```
.venv-test/bin/python -m pytest tests/ -q                        # posted  119 passed,  9 skipped
MAGNETFI_ORACLE=lean  .venv-test/bin/python -m pytest tests/ -q  # lean    108 passed, 20 skipped
MAGNETFI_ORACLE=relay .venv-test/bin/python -m pytest tests/ -q  # relay   109 passed, 19 skipped
```

Borrow, repay, accrual, all three liquidation paths and the adversarial tests
pass with the oracle swapped underneath, so the drop-in claim is demonstrated
rather than argued.

Two things that needed fixing to make that meaningful:

- **The flag conflated two properties.** A single `RELAY` switch mixed *how a
  price arrives* (privileged app call vs signed payload) with *whether the
  contract bounds it*. The lean oracle keeps the writer and drops the band, so
  keyed off one flag the suite skipped the band tests and the writer test
  together — leaving the lean oracle's authorization gate untested exactly where
  it is the only gate left. Now split into `BANDED` and `RELAY`.
- **A rejection test was passing for the wrong reason.** Under `relay`,
  `test_only_authorized_updater_can_post` passed because `update_lp_price` does
  not exist on that contract, not because a gate rejected the sender. It is now
  skipped there and runs under `lean`, where the gate is real.

The removal is also asserted **positively**, not just inferred from a skip:
`test_unbanded_oracle_accepts_any_move` posts +30%, then −62% against the prior,
then a 20x, with no re-anchor. `test_anchor_band_25pct` asserts the banded
oracle **rejects** the very same +30% post — same input, opposite outcome, both
asserted. `test_gates_that_survive_the_band_removal` pins the three surviving
asserts by message.


### Migration rehearsal — done 2026-10-14

`contracts/tests/test_migration_rehearsal.py` — 9 tests, run from the banded
oracle because that is where the migration starts. It stands up a **second,
lean oracle beside the live one** and executes the §6 sequence.

The existing repoint tests in `test_roles_timelock.py` propose
`proto.oracle.app_id` — the oracle already in use — so they prove the timelock
mechanics but cannot show which oracle the vault prices from. The rehearsal
seeds the two oracles at **different prices (1.00 vs 2.00)** and reads the
vault's borrowing capacity to the micro-unit: an exact capacity is an exact
price, so "did the cutover happen" is answered by protocol behaviour instead of
by reading a global and trusting it means something.

What it pins:

| | |
|---|---|
| step 4 | repointing the only bot **freezes the protocol** — the new oracle fresh and correct, the old one merely unfed, borrowing dead anyway |
| step 4 | recovery is just feeding the old oracle again, which is what the second instance is for |
| pending | a proposal is not a cutover: capacity stays at the old oracle's price for the whole window |
| step 6 | after confirm, capacity doubles to the lean oracle's price |
| step 6 | an **admin rotation mid-window silently restarts the 48h** — `pending_lp_oracle` is cleared with no revert and no warning |
| step 8 | once cut over, letting the old oracle go stale is harmless |
| rollback | real: through the return window the lean oracle keeps serving, so the wait happens with a **live** feed |
| positions | a loan opened **before** the swap carries straight through it and still repays and closes afterwards |
| repayment | needs **no fresh oracle** — so a dead feed can never trap a borrower |

The freeze case and the post-cutover case are the actual proof, as a pair: the
same stale-old / fresh-new chain state is a total freeze while the swap is
pending and completely fine once it is confirmed. Verified non-vacuous by
mutation — giving both oracles the same price breaks exactly the three tests
that depend on the discriminator.

**A testing finding that applies beyond this file.** Grouped calls — and every
vault operation is an atomic group — go through algokit's simulate path, which
reports `logic eval error: assert failed pc=3151` and **drops the assert
comment**. So an error-message assertion cannot work there, only on single app
calls. The rehearsal therefore proves causes by construction: a boundary (cap
succeeds, cap+1 does not, which pins the price exactly) or a before/after where
the single intervening change is the suspected one. Worth knowing that existing
`pytest.raises(Exception)` on a grouped call cannot tell "rejected for the right
reason" from "rejected for a fee error".

## 3b. The price cross-check — shipped 2026-10-14

Every other signal on the oracle answers **"is the price fresh"**. None could
see a price that is **wrong but fresh**, and the one non-age signal in the admin
panel — distance to the anchor band — disappears with the lean oracle.

`web/src/lib/magnetfiPriceCheck.ts` adds an independent read, surfaced per pool
in the Oracle Health panel:

```
independent price = third-party pool TVL (USD) / on-chain issued LP tokens
```

The numerator is Tinyman's own analytics figure, the denominator is
`issued_pool_tokens` from the pool's local state under validator app
`1002541853`. Neither touches our asset prices, decimals handling, route
selection or TWAP — so it is independent of the entire path that produces
`lp_price_`. The decimals-slip bug class (§2.2b of the lean spec: $U's 5
decimals putting the LP price at ~0.55x truth with every asset check green)
shows up here as **~45% divergence**.

**Verified against mainnet 2026-10-14.** All four registered pools returned an
independent price, diverging from the posted one by **0.26%-4.20%** while
the feed was 23-109 hours stale — upper bounds from a dead feed, NOT a
calibration sample:

| pool | posted | independent | divergence |
|---|---|---|---|
| ALGO/USDC `1002590888` | 1.149714 | 1.152716 | 0.26% |
| U/tALGO `3163770927` | 0.933838 | 0.899364 | 3.83% |
| U/ALGO `3617313492` | 0.869922 | 0.834855 | 4.20% |
| U/USDC `3673941603` | 2.520573 | 2.473703 | 1.89% |

Design decisions worth keeping:

- **Warn at 5%, critical at 15%.** 5% matches the composition check's agreed
  tolerance and absorbs the two legitimate causes of disagreement — the posted
  price is TWAP-smoothed so it lags spot, and the third-party TVL is sampled at
  a different instant. 15% sits far above any plausible lag and far below the
  ~45% bug signature.
- **A stale feed is left unjudged.** Divergence on an old price is expected and
  the staleness alarm has already fired; reporting it again as "wrong" would be
  two alarms for one fault. The numbers still show, the verdict does not.
- **It cannot gate anything.** Pull-only, like the rest of the panel, so a
  Tinyman outage degrades it to "unknown" and never looks like a bad price. The
  cross-check runs in its own try/catch *after* the health read, so it cannot
  cost the freshness readout during an outage — which is the readout that
  matters most then.
- **On a critical reading the panel says pause, not re-anchor.** Re-anchoring a
  wrong price makes it postable rather than fixing it, and the re-anchor button
  sits directly below.

10 tests cover the classification; the network paths are deliberately untested,
since a test that fetched would be testing Tinyman's uptime.

**Two limits worth stating.** The thresholds are **provisional**: the only live
readings available came from a feed frozen 23-109 hours, so they are upper
bounds rather than a calibration sample, and 5% WARN should be re-measured once
the bot is running. And the check is independent of *our* pricing path, not of
an attacker — Tinyman's `liquidity_in_usd` for a $U pool derives from Tinyman's
own $U price, which comes from these same thin pools.

**Known gap:** the panel iterates `ACTIVE_POOL_WIRING`, which lists only the two
vault-wired pools, so **ALGO/USDC and U/ALGO are not displayed** even though the
cross-check already knows their addresses. That is pre-existing and will resolve
when those two are wired vault-side at the migration.

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

**Done 2026-10-14:**

- ~~**Interest rates.**~~ `set_rate(3163770927, 1000)` and
  `set_rate(3673941603, 600)` are on chain and now match the UI. The drift had
  been open since `9aa945a`, where the cards were updated to the intended rates
  and the calls were never made.

**Open:**

- **A storage bucket** — only needed if v5 is revived; the lean oracle needs none.
- **Vault-side registration for ALGO/USDC and U/ALGO** — still deferred. Both
  are now priced on BOTH oracles, but neither has a vault-side rate, LTV,
  liquidation threshold or LP ASA, so nothing can be borrowed against them. They
  render as inert "Coming soon" cards and carry an ORACLE ONLY badge in the
  admin health panel.
- **Rotating the oracle bot key.** `QX7EPGRC…` had its mnemonic pasted into a
  terminal and a chat transcript on 2026-10-14. It is the authorized updater on
  **both** oracles now, so rotation is two `set_authorized_updater` calls, both
  admin-only and immediate. Doing it inside the 48h window means the lean oracle
  never goes live trusting an exposed key. The blast radius is bounded to
  posting prices — it cannot move funds — and while the banded oracle is live
  the ±25% band bounds it further; after the swap it does not.
