# MagnetFi — Lean Oracle

**Status: specification, pre-build.** Nothing here is implemented.

_Revised 2026-10-13 after an independent review (SOUND-WITH-CHANGES, one
BLOCKER). The decision to delete the bands was confirmed and independently
verified. Three things changed: the migration procedure would have **frozen the
protocol for 48 hours** (§6 step 4); removing the bot's bound left the posted
price with **nothing bounding it at all** (§2.2b); and the poll/post split was
**withdrawn** after its justification turned out to be wrong (§3)._

**One change, with one purpose: remove the last way this protocol can freeze
itself.**

A band-free oracle — the posted-price model exactly as it runs today, with the
anchor, the anchor band and the deviation guard deleted. The bot keeps its
current 5-minute cadence; the only bot change is dropping bounds that read an
anchor which no longer exists.

This **supersedes [ORACLE_V5_SPEC.md](./ORACLE_V5_SPEC.md) as the next step.**
v5 is built and proven; it is deferred, not abandoned — see §8.

---

## 1. Why — what actually caused the freezes

Three oracle freezes. Reading the record rather than the theory:

| when | cause | status |
|---|---|---|
| **2026-08-21** | the **contract's** anchor band rejected a valid post. `ADMIN.md:151` — bot alive, pricing fine, post failing `pc=512` | **still live** |
| 2026-10-07 | the **bot's** hardcoded `max_price` | fixed, Phase 0.1 |
| 2026-10-09 | same — `max_price` 900,000 against a legitimate 929,805 | fixed, Phase 0.1 |
| 2026-10-13 | the host rebooted | operational |

So the one *structural* cause still in place is the **contract's** bands. They
cannot be fixed by configuration; the oracle has no method to relax them. Only
a new contract removes them.

That also sets the scope. Removing them needs a new oracle — it does **not**
need signed payloads, a signing service, object storage, an opcode budget, or
any frontend change.

### The operator's position, which this implements

> *"There is a bigger risk of me not being able to liquidate loans on a flash
> crash than of me fumbling my private keys... I am assuming full
> responsibility of key safety here and don't want all these additive defense
> contracts at the current scale."*

The bands exist solely to bound a **compromised bot key**. That risk is
accepted. The bands' cost — a protocol-wide freeze, three times — is not.

---

## 2. The contract

A copy of `lp_oracle/contract.py` with the guards removed. Everything else is
unchanged, which is the point: this is the oracle that has been running since
launch, minus the parts that stopped it.

### 2.1 Removed

| removed | why it goes |
|---|---|
| `lp_anchor_<pool_id>` | the state the band reads |
| `set_price_anchor` | and the re-anchoring chore with it |
| ±25% anchor band | anti-compromise only; caused the 2026-08-21 freeze |
| ±50%-vs-prior guard | anti-compromise only, and it blocks genuine fast moves |

After this, `update_lp_price` asserts exactly three things: the sender is the
authorized updater, the price is non-zero, and the pool is whitelisted.

**`price > 0` stays.** A zero permanently bricks a pool (AUD-042) and that is a
bug-class failure, not a key-compromise one.

### 2.2 Unchanged

`authorized_updater` / `set_authorized_updater`, `add_pool`, `remove_pool`,
the two-role admin/guardian model with its 2-step rotations, `get_lp_price`,
and the `lp_price_` / `lp_ts_` keys the vault reads.

**The vault is not touched.** It reads those two keys by global-state key and
its oracle reference is swappable — `propose_lp_oracle` → 48h →
`confirm_lp_oracle`, with `cancel_pending_lp_oracle` as the guardian veto. That
claim is not theoretical: the v5 work proved it by running the **entire** vault
suite against a replacement oracle, 109 passing.

### 2.2b The posted price still needs ONE bound — a free one

The review found the hole this spec would otherwise leave, and it is not
hypothetical.

Today the posted LP price is bounded twice: by the contract's ±25% band and by
the bot's anchor-derived bound. This change removes both. `asset_price_bounds`
does **not** cover the gap — it bounds the *underlying asset* prices, while the
posted number comes out of `compute_lp_price`, which then divides by
`10 ** asset_a_decimals`, `10 ** asset_b_decimals` and `10 ** LP_DECIMALS`,
none of which is bounded by anything.

**$U has 5 decimals** — an unusual value, one digit from 6. A one-sided decimals
slip makes that side's TVL 10× too small, so the LP price lands at ~0.55× truth
with **every asset price inside its bounds, the multi-route cross-check green,
and CompX green**, because all three check *asset* prices. The TWAP then
faithfully smooths a consistently wrong number straight into a borrow and
liquidation input. §3.6's claim that the remaining checks "catch bugs" is false
for precisely the bug class that writes a wrong number.

**The fix costs nothing and cannot rot.** In a Tinyman v2 constant-product pool
the two sides' USD values are equal by arbitrage, so assert they match:

```
|tvl_a − tvl_b| / pool_tvl  <  tolerance        (a few percent)
```

This catches a one-sided decimals or price slip with **no dependence on the
absolute price level**, so there is no constant to maintain and nothing to
drift out of date. It is not a band: it cannot reject a real price move, because
a real move keeps both sides equal.

(Observed live, every pool: sides balanced to within $11 on a $1.7M pool.)

### 2.3 State schema — declare it at the ceiling

3 uints per pool (price, ts, active) instead of 4. Byte slots: updater, admin,
guardian, and two pendings.

**`StateTotals(global_uints=57, global_bytes=7)`** — 64 total, the measured AVM
cap. The current oracle declares 40/6, which caps it at 10 pools.

The schema is **frozen at creation**, so under-declaring costs a redeploy *plus
another 48h repoint*. 57 uints is exactly 19 pools. MBR measured on LocalNet:
40/6 → 1,540,000 µA, 57/7 → 2,074,500 µA, so **+0.53 ALGO**, paid once by the
deploying wallet — which needs ~3.6 ALGO free during the window, since both
oracles are live.

**57 leaves zero headroom for a future *named* global uint, and that is
deliberate.** The one remedy this spec defers to — the upward rate limit in §5's
tripwire — needs only the prior price and prior timestamp, both of which this
oracle already stores per pool. So the ceiling choice does not foreclose it. If
any pause flag or per-pool max-age becomes plausible, 42 uints (14 pools) leaves
15 slots and still doubles today's capacity.

---

## 3. The poll/post split — proposed, then withdrawn

An earlier draft of this spec split `POLL_INTERVAL` from a new `POST_INTERVAL`
to halve posting fees. **The review killed it, and was right to.** Recorded here
rather than deleted, because the reasoning is the useful part.

### What I got wrong

**The arithmetic was computed on a number the loop does not control.**
`sleep_for = max(0, POLL_INTERVAL - elapsed)` (`oracle_bot.py:1443-1451`), so
real spacing is `max(POLL_INTERVAL, cycle_time)`. Production `twap_state.json`
shows consecutive readings **369–370s apart**, not 300 — a cycle takes ~70s, and
that grows with pool count on a design declaring room for 19.

**The restart-gap justification was simply false.** `TwapState` is persistent,
so a restart reloads the window and the first cycle can post immediately. There
is no warm-up on restart at either interval, and therefore no "10-minute restart
gap" to avoid. That was the entire case I made for the split.

**`TWAP_WINDOW = 7` would have been a no-op.** At 370s spacing `MAX_TWAP_AGE =
1800` holds at most 5 readings, so today's window already saturates the cutoff.
The §7 test asserting a 30-minute span would have passed on synthetic
timestamps and been false on the box.

**The saving is smaller than I quoted.** The measured rate — 1,121 posts in 47h
— is ~$2.1/month, which is what I attributed to the *post-10* column. Real
saving: **$1–1.7/month.**

### What it would have cost

Not a restart gap but **retry budget**, measured at the real 370s spacing:

| consecutive failed posts before the vault freezes | post-5 | post-10 |
|---|---|---|
| | **4** | **3** |

And the specific combination worth caring about: a 15-minute host reboot — the
2026-10-13 failure — **plus one failed post freezes the vault under post-10 and
does not under post-5.**

It would also have added a **silent total freeze mode**: the gate compares the
bot's wall clock against the chain's `lp_ts_`, so a clock ~12 minutes slow
pushes the effective cadence past `ORACLE_FRESHNESS` with no error anywhere —
healthy logs, accepted posts, every liquidation path reverting. This file
already carries a four-hour clock-labelling bug found on that same host.

### Conclusion

**$1/month for six minutes of a thirty-minute outage budget, plus a new silent
freeze mode, on a protocol whose documented failure is freezing.** Posting stays
at `POLL_INTERVAL`. If fees ever matter, the honest lever is fewer pools, not a
longer interval.

## 3b. The bot's remaining change

With the split withdrawn, the bot change reduces to one thing: **remove the
anchor-derived bounds**, because the anchor they read no longer exists.

Removed: `effective_bounds`, `effective_bounds_with_anchor`, `anchor_bounds`,
`read_onchain_anchor`, `_last_anchor`, the Phase 0.6 posted-price bound, and the
re-anchor `twap.clear` block — the last of which is the **only** working
instance of "drop stale TWAP history", so see the note below before deleting it.

Phase 0.1 and 0.6 were correct for the oracle they were written against. They
retire with it.

**Replaced by** the TVL-balance invariant in §2.2b, which bounds the posted
price without a constant to maintain.

**Also in the same change, or §8's "proven" claim stops being true:**
`signer/signer.py` calls `get_lp_price(..., apply_anchor_bounds=False)` and
`signer/tests/test_signer.py` monkeypatches `effective_bounds`. Both break the
moment the kwarg and the function go. One line each.

### A pre-existing problem this makes last longer

`MAX_TWAP_AGE` measures from the **newest** reading, so after an outage
pre-outage readings within 1800s survive and the trapezoid weights the downtime
at full width. Measured with the real `TwapState`: a 20-minute outage during a
genuine 30% drop produces a first post of **885,350 against a 700,000 spot** —
understating the crash by 26%, at exactly the moment liquidation matters.

The re-anchor `twap.clear` was the only remedy in the codebase and this change
deletes its trigger. Either segment the history and average only the newest
contiguous run, or post spot when the window contains a gap. **Not optional** —
it is the same flash-crash case §5 says the operator ranks above key loss.

## 4. What this does not change

- The bot still holds a key the contract trusts. Accepted (§1).
- The price can still be ~6 minutes old when a liquidator acts (the observed
  cycle spacing), against a 30-minute window.
- A dead bot still freezes the feed after 30 minutes. Operational: a VPS and a
  watchdog, not a contract change.

v5 addresses the first two. It is deferred because they are worth less than
they cost while every borrower is the operator (§8).

---

## 5. The risk, stated plainly

Without the bands, **a compromised bot key can set any price.** The first draft
of this section got the consequences wrong in four ways; the review corrected
them and the corrections mostly make it *less* alarming, not more.

### What a poisoned price actually does

**A price set too HIGH is the one the bot key can do alone.** It makes genuinely
unhealthy vaults **un-liquidatable** — the same `_oracle_price` feeds the health
factor — with no capital and no second transaction. **That is the
flash-crash-cannot-liquidate failure the operator ranks above key loss**, and
the PSM invariant does not bound it: `circulating ≤ psm_usdc` caps *minting*,
not this. The first draft missed it entirely.

**A price set too LOW is not reachable by the bot key alone.** All three
liquidation paths are admin-gated (`vault/contract.py:650, 700, 786`), so
"every borrower becomes liquidatable" additionally requires the **operator** to
act on the poisoned price. That makes it an operational risk, and it changes
what the control should be: an independent price check before liquidating, not
necessarily an on-chain limit.

### Versus v5 — the asymmetry runs both ways

The first draft claimed "identical blast radius". True per post, misleading as
risk:

- **In this design's favour:** `set_authorized_updater` is **immediate**, so a
  detected compromise is revoked in one transaction. v5's signer rotation is
  `propose_signer` → **48h** → `confirm_signer`.
- **Against it:** this key lives on the always-on bot host that also fetches a
  third-party bundle over HTTPS. v5's lives on an inbound-closed, single-purpose
  box. Same radius, materially different probability.

Expected loss is the product of both. Neither design dominates.

### What the bands were actually worth

Measured against live vault parameters (`ltv_` 6000/6500, `liq_` 7500): a post
13–20% low **already** makes a max-LTV vault liquidatable — inside the ±25%
band. So the band never prevented liquidation *eligibility*; it bounded the
*magnitude* of borrower loss. And the ±50%-vs-prior guard is ratchetable ~16×
within a single atomic group, with no reaction time, so removing it costs
essentially nothing.

Of the three claims in the first draft, only "it bounds a compromised key to
±25%" was precisely true — and it is weaker than it reads.

### The break-glass levers this design keeps

These are the response plan, and belong in the runbook:

| lever | who | speed |
|---|---|---|
| `pause()` — gates both borrow paths | admin | immediate (`unpause` is guardian-only, so a stolen hot key cannot lift it) |
| `set_authorized_updater` | admin | immediate |
| `remove_pool` + `add_pool` | admin | one group — an arbitrary price overwrite |

### Tripwire

**Before a third-party borrower opens a vault**, re-answer this. Today every
vault is the operator's own, so a compromise costs the operator. The upward
rate limit in [LP_ORACLE.md](./LP_ORACLE.md#designs-considered-and-rejected) is
the design to reach for — it was rejected for defending only against key
compromise, which is exactly the argument that changes when the loss stops being
yours. It needs no new state (§2.3).

### Nothing else validates the posted price — so something must

After this change `FeedWatch.check` tests **age** only, `check_algo_against_pex`
compares the bot's own ALGO derivation rather than the posted LP price, and
`getOracleHealth`'s only non-age signal was the band.

So §6's monitor is not merely a liveness monitor. It must compare the **posted
`lp_price_` against an independently derived price, per pool**, and it must run
**outside the bot process**, whose key is the threat being monitored. Without
that, this change trades a freeze cause for a blind spot in the exact dimension
it just unbounded.

## 6. Migration

Same shape as any oracle swap, and the vault keeps serving throughout.

1. Deploy the lean oracle. Reproducible build, bytecode matched.
2. `set_authorized_updater(<bot address>)`.
3. `add_pool` for all four, each with a fresh price — `3163770927` U/tALGO,
   `3673941603` U/USDC, `1002590888` ALGO/USDC, `3617313492` U/ALGO. Price in
   **human units** in the Admin UI; it scales by 1e6.
4. ⚠️ **Run a SECOND bot instance for the new oracle. Do not repoint the first.**

   An earlier draft said "point the bot's config at the new oracle — both run
   in parallel." **That would have frozen the protocol for 48 hours.** The bot
   holds exactly one oracle id (`BotConfig.oracle_app_id`), so repointing it
   stops feeding the OLD oracle — which is still the vault's oracle for the
   whole timelock. It goes stale in 30 minutes and borrowing plus all three
   liquidation paths revert until `confirm_lp_oracle`, with no shortcut back
   because the timelock applies in both directions.

   So: a second process, with its **own `config.json`** (the `ORACLE_APP_ID`
   env var is dead whenever the file carries the key) **and its own
   `TWAP_STATE_PATH`**, since `STATE_FILE` is a module-level singleton and the
   two would otherwise corrupt each other's window. Fees double for 48 hours —
   about $0.15.

5. **Watch BOTH oracles.** `FeedWatch` only knows `cfg.oracle_app_id`, so each
   instance is blind to the other's. Confirm all four pools are fresh **on the
   old oracle** throughout, and **on the new one** immediately before step 6.
6. `propose_lp_oracle(<new>)` → **48h** → `confirm_lp_oracle()`.
   ⚠️ `accept_admin` clears `pending_lp_oracle` (`vault/contract.py:288-292`),
   so an admin rotation mid-window silently restarts the 48 hours.
7. Frontend — and the ordering matters in **both** directions:

   - The oracle id in `magnetfi.ts` must change **at or before** step 6's
     confirm, or the UI reports the wrong oracle's freshness across the switch.
   - The **"Re-anchor price" action must SURVIVE until step 8.** The old banded
     oracle is the vault's oracle for 48 more hours and can still freeze exactly
     as it did on 2026-08-21 — and U/tALGO currently has only ~16% of up-room
     to its ceiling. Removing the band's only remedy while the banded oracle is
     still load-bearing is the specific hazard here.
   - Ship the new ABI as a **versioned artifact** (`LPOracleLean.arc56.json`),
     not by overwriting `LPOracle.arc56.json` — the admin panel deploys from
     that file and the old oracle's UI still needs it.
   - Also: `magnetfiOracleHealth.test.ts`, `OperationsPanel.tsx`'s re-anchor
     form, and `magnetfiDeploy.ts`'s "sets price AND the ±25% anchor" comment.
8. **Stop posting to the old oracle.** ✅ **DONE 2026-10-17.** It cannot be
   deleted — the contract has no delete handler, so app `3644230020` and its
   ~1.5 ALGO MBR are permanent. "Retire" meant shut down its bot instance and
   remove its UI, nothing more.

   What was removed: `start_oracles.cmd` now launches one bot, not two (it
   would otherwise have revived the banded feed at the next logon);
   `setPriceAnchor` and the "Re-anchor price" admin form, which pointed at a
   method the lean oracle does not implement; the anchor/band fields on
   `PoolOracleHealth` and their panel rows, permanently null without an
   anchor; and the re-anchor guidance in ADMIN.md.

   What was NOT removed: `config.json`, kept beside `config.lean.json` as the
   record of the retired feed's configuration.

   **One thing got worse and is recorded rather than glossed.** ADMIN.md's
   bot-key compromise row read "bounded price movement, not unbounded" because
   the band bounded it on chain. With the band gone, a holder of the updater
   key can post an arbitrary PRICE. The LOSS stays bounded — mUSD issuance is
   capped at the PSM's real-USDC backing (`psm_v3:439`), and all three
   liquidation triggers are admin-gated — so that row now distinguishes the
   two rather than claiming the vault can be drained.

   §2.2b's TVL-balance invariant is **not** the replacement bound, despite
   being written here as one. It runs in the bot, which a key holder bypasses,
   and it warns rather than gates (`oracle_bot.py:887`; [OVERVIEW.md](./OVERVIEW.md) recorded
   the warn-not-gate decision). §5's upward rate limit remains the real
   remedy, and remains deferred.

**A structural fix for the whole class of ordering mistakes above:** have the
bot and `getOracleHealth` read the active oracle from the **vault's own**
`lp_oracle_app_id` global (present and readable on mainnet) instead of a local
constant. Then "pointed at the wrong oracle" becomes impossible rather than a
step someone has to remember.

**Before step 6, simulate it.** Read-only against mainnet:
`[confirm_lp_oracle, update_lp_price, trigger_full_liquidation, open_vault, borrow_more]`
— the borrow paths included because they are where §5's upward attack runs and
where the PSM cap applies. Same-group
state visibility is proven, so one simulation exercises the whole new path
against the real vault before anything is submitted. `confirm_lp_oracle`
validates only `!= 0`, so a typo'd app id otherwise commits a 48h freeze.

**Rollback** is real here, unlike under v5: the old oracle still works and the
bot can post to it, so repointing back is a 48h wait with a *functioning* feed
behind it rather than a dead one.

> **Rehearsed on LocalNet, 2026-10-14** —
> `contracts/tests/test_migration_rehearsal.py` (9 tests) executes this whole
> sequence with a second lean oracle standing beside the live banded one, and
> pins each claim above to protocol behaviour: the step-4 freeze, the
> "proposal is not a cutover" window, the cutover itself, the `accept_admin`
> restart, step 8's harmless staleness, and this rollback paragraph. The two
> oracles are seeded at different prices so the vault's borrowing capacity
> reads back which one it is pricing from. See [history/LEAN_ORACLE_MIGRATION.md](./history/LEAN_ORACLE_MIGRATION.md).

### Documentation that becomes actively wrong — these are incident runbooks

`ADMIN.md:149-153` is the "Recognizing an anchor-band rejection" entry that
tells the operator to re-anchor. After this it must read *"the lean oracle has
no band — if a post fails, it is not this"*, or the next outage gets diagnosed
against a mechanism that no longer exists. Same for `LAUNCH_RUNBOOK.md`
(several), `LP_ORACLE.md`, `REVAMP_PLAN.md` Phase 0.1/0.6, and `AUDIT.md`
P19-03. `add_pool`'s own docstring justifies the anchor as "closing the
first-post manipulation window (AUD-003/AUD-043)" — that window reopens, so
restate it rather than leave the code contradicting itself.

### What replaces the band-distance warning

`getOracleHealth`'s distance-to-band was built after the 2026-10-07 post-mortem
as a **leading** freeze indicator — its own comment says "nothing in the product
showed it". With no band there is no distance, and the only remaining signal is
the lagging `lp_ts_` age.

A freshness/liveness monitor is therefore a **deliverable of this change**, not
a follow-up. Without it the change trades a freeze cause for a blind spot.

> **Revised 2026-10-14.** Half of this is wrong and the conclusion was too
> strong. The band-distance warning predicted **band-caused freezes**; removing
> the band removes that failure mode, so there is no freeze blind spot to fill —
> staleness is still covered by `FeedWatch`'s `lp_ts_` age and
> `getOracleHealth.level`. What is actually lost is the ability to notice a
> **wrong-but-fresh** price, and for the bug class that matters most (a
> one-sided decimals slip, §2.2b) the composition check already covers it.
>
> The out-of-process requirement was specifically about **key compromise** — a
> risk the operator has accepted, by the same argument that deferred v5. So this
> is **not a ship blocker**. Delivered instead: a price cross-check in the admin
> panel comparing each posted `lp_price_` against third-party pool TVL divided
> by on-chain `issued_pool_tokens` — independent of the bot's entire pricing
> path, and needing no new process, key or alert channel.

---

## 7. Test plan

Against `contracts/tests/` (110) and `oracle_bot/tests/` (139).

**Contract** — reuse the v5 harness: `MAGNETFI_ORACLE=lean` runs the whole vault
suite against it. Borrow, repay, accrual, all three liquidation paths, attacks
and authz must pass untouched; only the band tests change.

- a price 10× the previous one posts — the commitment, failing loudly if a
  guard returns
- a price 1/10th the previous one posts — the other direction, which is where
  the loss falls (§5)
- `price = 0` still rejects (AUD-042)
- an unregistered pool still rejects
- a non-updater still rejects
- `set_price_anchor` no longer exists
- a 19th pool registers; a 20th fails — the declared ceiling is real and known

**Bot**

- the TVL-balance invariant rejects a one-sided decimals slip (§2.2b) — build it
  from the $U 5-decimal case, which is the one that reaches production
- it does **not** reject a genuine large price move, in either direction
- no anchor read remains on the posting path — asserted over the **AST**, since
  a regex would match the prose explaining why it was removed
- a TWAP window spanning an outage does not silently understate a crash (§3b)
- the signer still works with the kwarg gone

**Harness.** `conftest.py`'s `RELAY` flag conflates two orthogonal properties —
`set_anchor` is a no-op only when `RELAY`, while `oracle_post` uses
`update_lp_price` only when *not* `RELAY`. A `lean` mode needs band-ness
separated from payload-ness. Three suites pin anchor behaviour and must be
**rewritten rather than skipped**: `test_oracle.py` (`test_reanchor_enables_larger_move`),
`test_smoke.py`, `test_attacks_authz.py`.

---

## 8. Relationship to v5

v5 is **built, tested and proven** — payload format (59 tests), RelayOracle and
OpUp (compiled, 17 tests), signer (19 tests), the drop-in claim demonstrated by
running the full vault suite against it, and the liveness property executable.

It is deferred because what it adds over this — zero-second pricing at the
moment of liquidation, and no key the contract trusts — is worth less than it
costs **while every borrower is the operator**. Both become valuable the moment
that changes, which is the same tripwire as §5.

Nothing is wasted. The hard part was proving the vault does not notice an
oracle swap, and this change is that same swap through the same timelock.

v5's own numbers argue for this ordering too: it costs **4× the fee per post**
(three inner OpUp calls to afford the signature), so the spec's claim that
posting fees "go" is only true if no relay runs — and it recommends one.
