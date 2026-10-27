# Lean-oracle migration — record

> **History. Complete 2026-10-17; nothing here is current.**
> Lifted from the former `magnetfi/v2/STATUS.md` when that file was merged into
> `OVERVIEW.md`. Kept intact because two findings in it generalise well beyond
> this migration — see "What this taught us" below. For how the oracle works
> now, read [ORACLE_LEAN_SPEC.md](../ORACLE_LEAN_SPEC.md); for current state,
> [OVERVIEW.md](../OVERVIEW.md).
>
> Figures and app states below are as they were at the time of writing and have
> not been refreshed.

## 1b. Lean-oracle migration — COMPLETE

`confirm_lp_oracle` landed **2026-10-17 19:01:15Z**. The vault reads
`3741272132`; `pending_lp_oracle` and its ETA are both cleared.

| | |
|---|---|
| proposed | 2026-10-14 20:46Z |
| confirmed | **2026-10-17 19:01:15Z** |
| vault reads | `3741272132` (lean, no band) |
| frontend constant | repointed in `web/src/lib/magnetfi.ts` *before* the confirm |

**Evidence the switch was safe.** Both oracles ran concurrently off separate
bot instances. Over the 21h overlap, 1,017 posts paired within 120s diverged by
at most **0.04%** (median ~0.000%); at matched sampling times on confirm day the
worst was **0.0009%**. Larger instantaneous readings (up to ~0.14%) are sampling
offset between two independently-scheduled bots, not disagreement — they
collapse the moment the trailing oracle posts.

**Step 8 is DONE — the banded oracle is retired.** 2026-10-17, by decision:
we are running one oracle, not keeping a standby.

Rollback was the only argument for keeping `3644230020` fed, and it was always
weaker than it first looked here: rollback carries the same 48h timelock, so a
proposal gives 48 hours of notice to revive a feed that warms up in ten
minutes, and the bot, both configs and the launcher are all in this repo. The
banded instance died silently at 18:56Z and cost nothing. Reviving it is a
`git pull` and one command.

Removed with it: the second bot from `start_oracles.cmd` (it would otherwise
have restarted the banded feed at the next logon), `setPriceAnchor` and the
"Re-anchor price" admin form, the anchor/band fields on `PoolOracleHealth` and
their panel rows, and ADMIN.md's re-anchoring procedure. The app itself cannot
be deleted — no delete handler — so it and its ~1.5 ALGO MBR sit on chain
forever, unread.

### ⚠️ The bot key's compromise impact changed from bounded to unbounded

This is the part of the migration that made something worse, and it is not
hidden in a diff.

ADMIN.md's bot-key row read **"bounded price movement, not unbounded"**, and
that was true: a post had to land within ±50% of the prior one and ±25% of the
admin anchor, so a compromised updater key bought bounded mispricing plus
staleness. `update_lp_price` on the lean oracle
(`LeanOracle.approval.teal:263-347`) asserts only sender, price > 0 and pool
active, then writes — no deviation check, no bounds, no rate limit. A holder of
`authorized_updater` can post **any price** for any pool.

**The loss is still bounded, and the first draft of this section got that
wrong.** Two limits the key does not control:

- **Upward.** Over-borrowing against an inflated price mints mUSD, and
  `psm_v3/contract.py:439` caps issuance at
  `circulating + amount <= _total_backing()`. Backing is real USDC
  (`_psm_usdc_balance() + _deployed_backing()`), **not** oracle-priced
  collateral, so the same attack cannot inflate the ceiling. Headroom today is
  ~$50 (§1). It scales with the PSM, not the oracle.
- **Downward.** All three `trigger_*_liquidation` methods are
  `_assert_admin()`. A crashed price seizes nothing by itself; it needs the
  admin to act on it.

§2.2b's TVL-balance invariant is often called the replacement for the band. It
is not, twice over: it lives in the **bot**, which a key holder bypasses by
posting directly, and it **warns rather than gates** even when it does run
(`oracle_bot.py:887`).

Consequences, in order:

1. **`QX7EPGRC…` should be rotated.** It is the live `authorized_updater`, and
   it has been pasted into shell history on two machines and stored in a
   Windows user registry hive. The honest framing is "can mint up to the PSM's
   free backing, and can make the admin liquidate the wrong people" — not "can
   drain the vault". That is a smaller problem than the band's removal first
   suggested, and it grows with the PSM reserve.
2. **The independent cross-check is no longer a nice-to-have.** The admin
   Oracle-health panel's "Independent" column (pool TVL ÷ issued LP tokens,
   third-party sourced) is now the only thing that can catch a wrong-but-fresh
   price. It is a pull mechanism nobody is obliged to look at.
3. **§5's upward rate limit is the real fix** and is still deferred. The lean
   oracle stores prior price and prior timestamp per pool, so the tripwire
   needs no new state — the spec notes the 57-uint ceiling was chosen so this
   stays possible.

### Two things this migration taught us

**`confirm_lp_oracle` does not look at the oracle.** Its gate is
`Global.latest_timestamp >= pending_lp_oracle_eta` — the BLOCK timestamp. It
says nothing about whether the incoming oracle has ever posted. Once the 48h
has elapsed the call succeeds against a feed that is arbitrarily stale, and
since `ORACLE_FRESHNESS` (1800s) gates `open_vault`, `borrow_more` and all
three `trigger_*_liquidation`, confirming onto a dead oracle freezes borrowing
**and liquidations** in one transaction. The incoming feed must be verified
live immediately before the confirm; nothing on chain will do it for you.

**A single bot instance is a single point of failure.** A power cut on
2026-10-15 took the lean oracle down for 48h because its instance did not
restart. That was harmless only because the oracle was not yet live. The feed
now auto-starts at logon via `oracle_bot/start_oracles.cmd`, launched from a
stub in the Windows Startup folder. Verified by an actual power cycle on
2026-10-17, fast enough that no pool approached the freshness gate.

That launcher started BOTH bots when it was verified; it starts only the lean
one since step 8 retired the banded oracle later the same day. It still sets
`TWAP_STATE_PATH` explicitly, because if a second bot is ever run again each
needs its own state file — two sharing one corrupts the history.

---

## 2. The plan, in one paragraph

The oracle has frozen three times. Two were the bot's own hardcoded bounds —
**fixed**. One, on 2026-08-21, was the *contract's* anchor band rejecting a
perfectly valid post. That cause is **gone**: the fix was a new oracle with the
bands deleted, swapped in behind the vault's existing 48h timelock, confirmed
2026-10-17 19:01Z and the banded oracle retired the same day (§1b).
The operator has accepted key-compromise risk explicitly; the bands only ever
bounded a compromised key, and their cost — a protocol-wide freeze — is not
accepted.

**Authoritative document: [ORACLE_LEAN_SPEC.md](../ORACLE_LEAN_SPEC.md).**

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
