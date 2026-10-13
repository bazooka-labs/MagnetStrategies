# MagnetFi — Lean Oracle + poll/post split

**Status: specification, pre-build.** Nothing here is implemented.

Two changes that share one purpose: **remove the remaining ways this protocol
can freeze itself.**

1. **A band-free oracle contract.** The posted-price model exactly as it runs
   today, with the anchor, the anchor band and the deviation guard deleted.
2. **Separate polling from posting in the bot.** Poll every 5 minutes, post
   every 10. Same behaviour, 50% of the fees, and no new mechanism.

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

### 2.3 State schema — declare it at the ceiling

3 uints per pool (price, ts, active) instead of 4. Byte slots: updater, admin,
guardian, and two pendings.

**`StateTotals(global_uints=57, global_bytes=7)`** — 64 total, the measured AVM
cap. The current oracle declares 40/6, which caps it at 10 pools.

The schema is **frozen at creation**, so under-declaring costs a redeploy *plus
another 48h repoint*. 57 uints is 19 pools. The extra MBR is about 0.5 ALGO,
paid once. Cheap against being stuck at 10 pools when a 11th collateral arrives.

---

## 3. The bot: split polling from posting

### 3.1 The problem with a single interval

`POLL_INTERVAL` currently governs both how often the price is measured and how
often it is written. They have different costs and different constraints, and
conflating them makes the cheap knob dangerous.

Measured: **polling is free** (read-only algod); **posting is 0.001 ALGO**.
Observed over 47 hours: 1,121 posts, 1.121 ALGO, flat minimum fee.

And the binding constraint is not cost, it is **restart margin**:

```
MIN_TWAP_READINGS × POLL_INTERVAL  must be  <  ORACLE_FRESHNESS
          3       ×      300       =  900   <    1800        ✓
          3       ×      600       = 1800   =    1800        ✗ no margin
          3       ×      900       = 2700   >    1800        ✗ 15-min outage per restart
```

Raising the single interval to 10 minutes leaves a **10-minute stale gap after
every restart** — the failure of 2026-10-13. At 15 minutes it is worse, and
`MAX_TWAP_AGE = 1800` would hold only three readings, so one late cycle drops
it to two and **posting stops entirely**.

### 3.2 The change

```python
POLL_INTERVAL   = 300   # unchanged — TWAP resolution AND retry granularity
POST_INTERVAL   = 600   # new — the only thing that costs money
TWAP_WINDOW     = 7     # 5 -> 7, a 30-minute smoothing span
```

| | poll 5 / post 5 (today) | **poll 5 / post 10** | poll 10 / post 10 |
|---|---|---|---|
| warm-up | 15 min | **15 min** | 30 min |
| TWAP span | 20 min | **30 min** | 30 min |
| cost, 4 pools | $4.14/mo | **$2.07/mo** | $2.07/mo |
| restart gap | none | **none** | **10 min** |

The middle column is the same cost as the right one with the sharp edge gone.

### 3.3 The post clock lives on chain, not in a file

`update_pool` posts when `now - lp_ts_<pool_id> >= POST_INTERVAL`, reading
`lp_ts_` from the oracle exactly as `read_onchain_price` reads `lp_price_`.

No new local state, and three properties fall out for free:

- **Survives restarts.** A restart cannot reset the clock and lose the saving.
- **Retries immediately.** A failed post never updated `lp_ts_`, so the next
  5-minute poll sees the interval still elapsed and tries again — the retry
  granularity stays at 5 minutes even though the cadence is 10.
- **Cannot drift from reality.** The chain is the record of what was posted.

### 3.4 A guard against the next person turning this knob

An assertion, tested:

```python
assert MIN_TWAP_READINGS * POLL_INTERVAL < ORACLE_FRESHNESS
```

These four constants constrain each other and nothing currently says so. I
found the 15-minute collision only because it was questioned. The next person
should get a test failure, not a production gap.

### 3.5 The bot's anchor-derived bounds go

Phase 0.1 made the bot derive `min_price`/`max_price` from `lp_anchor_`, so its
bounds could not drift from the contract's band. **With no band, there is
nothing to stay inside**, and a bound that stops the bot posting is the same
halt as a band that stops the chain accepting.

So `effective_bounds`, `anchor_bounds` and `read_onchain_anchor` are removed
from the posting path, along with the Phase 0.6 posted-price bound check.

Phase 0.1 and 0.6 were correct for the oracle they were written against. They
retire with it.

### 3.6 What the bot keeps, and why it is not the same thing

| kept | catches |
|---|---|
| TWAP smoothing | single-block pool manipulation |
| multi-route cross-check | derivation and route bugs |
| CompX divergence | a wrong second opinion |
| `asset_price_bounds` | a ×1e6 scaling slip — wide, and three orders of magnitude from any real price |
| pool `asset_1_id` / `pool_token_asset_id` checks | a misconfigured pool |

These catch **bugs**. Key custody has nothing to do with them: a bug still runs
our code. Only a stolen key bypasses them, and that is the accepted risk.

---

## 4. What this does not change

- The bot still holds a key the contract trusts. Accepted (§1).
- The price can still be up to `POST_INTERVAL + POLL_INTERVAL` old when a
  liquidator acts. At 10/5 that is 15 minutes against a 30-minute window.
- A dead bot still freezes the feed after 30 minutes. Operational: a VPS and a
  watchdog, not a contract change.

v5 addresses the first two. It is deferred because they are worth less than
they cost while every borrower is the operator (§8).

---

## 5. The risk, stated plainly

Without the bands, **a compromised bot key can set any price.**

Bounded in one direction only: `circulating mUSD ≤ psm_usdc` caps over-minting
at the PSM reserve. It does **not** cap the other direction — a price set too
low makes every borrower liquidatable at 500–700 bps, irreversibly, and that
loss falls on **borrowers**.

Three things worth being clear about:

1. **This is not new exposure relative to v5.** A compromised v5 *signer* can
   set any price too. Same blast radius, different key.
2. **It is new relative to today.** The bands bound a compromised key to ±25%
   of the anchor. That bound is being deliberately given up.
3. **It is bounded by who borrows.** Today all three vaults are the operator's
   own wallets, so a compromise costs the operator. That stops being true the
   moment a third party borrows.

**Tripwire:** before a third-party borrower opens a vault, re-answer this. The
upward rate limit in
[LP_ORACLE.md](./LP_ORACLE.md#designs-considered-and-rejected) is the design to
reach for first — it was rejected for defending only against key compromise,
which is exactly the argument that changes when the loss stops being yours.

---

## 6. Migration

Same shape as any oracle swap, and the vault keeps serving throughout.

1. Deploy the lean oracle. Reproducible build, bytecode matched.
2. `set_authorized_updater(<bot address>)`.
3. `add_pool` for all four, each with a fresh price — `3163770927` U/tALGO,
   `3673941603` U/USDC, `1002590888` ALGO/USDC, `3617313492` U/ALGO. Price in
   **human units** in the Admin UI; it scales by 1e6.
4. Point the bot's `config.json` at the new `oracle_app_id` and let it run.
   **Both oracles run in parallel** — the old one keeps serving the vault, and
   the bot can post to either.
5. **Confirm all four stay fresh**, and re-check immediately before step 6.
6. `propose_lp_oracle(<new>)` → **48h** → `confirm_lp_oracle()`.
   ⚠️ `accept_admin` clears `pending_lp_oracle` (`vault/contract.py:288-292`),
   so an admin rotation mid-window silently restarts the 48 hours.
7. Frontend: the oracle id in `magnetfi.ts`; `getOracleHealth`, which reads
   `lp_anchor_` and computes a band that no longer exists; `OracleHealthPanel`;
   and `magnetfiOps.ts`'s `set_price_anchor` call, a method that is gone.
8. Retire the old oracle.

**Before step 6, simulate it.** Read-only against mainnet:
`[confirm_lp_oracle, update_lp_price, trigger_full_liquidation]`. Same-group
state visibility is proven, so one simulation exercises the whole new path
against the real vault before anything is submitted. `confirm_lp_oracle`
validates only `!= 0`, so a typo'd app id otherwise commits a 48h freeze.

**Rollback** is real here, unlike under v5: the old oracle still works and the
bot can post to it, so repointing back is a 48h wait with a *functioning* feed
behind it rather than a dead one.

### What replaces the band-distance warning

`getOracleHealth`'s distance-to-band was built after the 2026-10-07 post-mortem
as a **leading** freeze indicator — its own comment says "nothing in the product
showed it". With no band there is no distance, and the only remaining signal is
the lagging `lp_ts_` age.

A freshness/liveness monitor is therefore a **deliverable of this change**, not
a follow-up. Without it the change trades a freeze cause for a blind spot.

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

- `MIN_TWAP_READINGS × POLL_INTERVAL < ORACLE_FRESHNESS` (§3.4)
- posts when `now - lp_ts_ >= POST_INTERVAL`, not before
- a failed post leaves `lp_ts_` unchanged and the next **5-minute** poll retries
- a restart does not reset the post clock
- `TWAP_WINDOW = 7` yields a 30-minute span at 5-minute polling
- no anchor read remains on the posting path — asserted over the AST, since a
  regex would match the prose explaining why it was removed

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
