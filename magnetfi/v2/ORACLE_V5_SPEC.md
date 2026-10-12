# MagnetFi — Relay Oracle (v5)

**Status: contracts BUILT and green on LocalNet; publisher and frontend not
started.** `contracts/smart_contracts/relay_oracle/` and `.../opup/` compile
with the pinned puyapy 5.9.0 and pass 16 integration tests driven by the
production `signer/payload.py`. What remains is §1's off-chain surface, the
signing service, and the §6 migration.

_Revised 2026-10-11 after an independent design review (verdict:
SOUND-WITH-CHANGES, no blocker). The central claim — drop-in oracle, no vault
change, no migration — was verified by measurement, including the liveness
property and the opcode budget against the live mainnet vault. Four findings
changed the design and are marked inline: the loss bound in §4.5 was wrong
about **who pays**; TWAP was never stated and §4.2 depends on it; the
"no privileged writer" claim was false, so the break-glass in §2.5 now ships;
and a 48h repoint is **not** a rollback (§6)._

A new LP Oracle that accepts **signed, permissionlessly-relayed** prices, replacing
the bot-authorised oracle at `3644230020`. **The vault is not touched.**

---

## 1. Why this exists, and why it is not the v4 in LP_ORACLE.md

Three oracle freezes to date, zero key compromises. The protocol was defended
heavily against a stolen bot key and barely at all against the feed simply
stopping — and the second is the failure that keeps happening. When it does, the
vault fails closed and **all three `trigger_*_liquidation` paths revert** along
with borrowing, for as long as the feed is down.

[LP_ORACLE.md → v4](./LP_ORACLE.md#v4--signed-payloads-decided-2026-10-07-not-yet-built)
answers this by removing the stored price entirely: the user carries a signed
payload in their own transaction and the **vault** verifies it. That is a vault
change, and the vault is the one contract with **no repointing path** — so it
drags along a migration that unwinds every open position, repoints the PSM
through a 48h timelock, re-registers every pool and re-canaries each one. That
cost is the entire reason the plan welded v4 to the lender-contract work.

**That premise does not hold.** The vault reads the oracle by **global-state
key**, not by method call:

```python
# vault/contract.py:207-219
price, exists = op.AppGlobal.get_ex_uint64(self.lp_oracle_app_id.value,
                                           Bytes(b"lp_price_") + op.itob(pool_id))
ts,    exists = op.AppGlobal.get_ex_uint64(self.lp_oracle_app_id.value,
                                           Bytes(b"lp_ts_")    + op.itob(pool_id))
return ts + UInt64(ORACLE_FRESHNESS) >= Global.latest_timestamp
```

So **any** app exposing `lp_price_<pool_id>` and `lp_ts_<pool_id>` as uint64
global state satisfies the vault, and `lp_oracle_app_id` is swappable:
`propose_lp_oracle` → 48h → `confirm_lp_oracle`, with `cancel_pending_lp_oracle`
giving the guardian a veto (`vault/contract.py:985-1012`).

### The actual goal, stated precisely

Not "eliminate stored prices." It is: **the price must never be the reason a
liquidation cannot run.** Those are different requirements, and the second is
satisfied by letting *anyone* make the price fresh on demand:

```
liquidator submits, atomically:
   [ post_signed_price(payload, sig) ,  trigger_*_liquidation(...) ]
```

`post_signed_price` writes `lp_ts_ = Global.latest_timestamp`, so when the vault
checks freshness in the same block the price is **zero seconds old**. The 1800s
window cannot block anyone willing to carry a payload. Borrowing is identical.

| | v4 (vault verifies) | **v5 (relay oracle)** |
|---|---|---|
| unwind every open position | yes | **no** |
| PSM repoint + 48h | yes | **no** |
| re-register pools on the vault | yes | **no** — vault state untouched |
| re-canary every pool | yes | **no** |
| migration | deploy, `add_pool` ×4, repoint 48h, **off-chain surface below** | |

⚠️ **"One frontend line" was wrong** and is corrected here. On-chain the vault
needs nothing; off chain the surface is six files plus a service that does not
exist yet:

| | |
|---|---|
| `web/src/lib/magnetfi.ts:45` | the `oracle` constant |
| `web/src/lib/magnetfiReads.ts` | `getOracle`, and `getOracleHealth` (86-100) — reads `lp_anchor_`, computes the band |
| `admin/OracleHealthPanel.tsx` | the band UI |
| `web/src/lib/magnetfiOps.ts:123,125` | calls `set_authorized_updater`, which ceases to exist |
| `web/src/lib/magnetfiDeploy.ts:142-143` | the deploy wizard's oracle group |
| `oracle_bot/config.json` | `oracle_app_id` |

and, to actually *get* the liveness benefit, every price-gated call site in
`magnetfiOps.ts` (~5) must learn to fetch a bundle and prepend a post.

**The signing service does not exist.** `magnetfi/v2/signer/` holds only
`payload.py` and its tests. Key custody, publishing to object storage with
`no-cache` headers, and the relay are most of the remaining work — §6 step 4
assumes them in one line. Scope accordingly.

v4 remains the better end state. It should be folded into the lender-contract
migration, when a vault redeploy has to happen anyway. v5 removes the urgency.

---

## 2. Contract design

### 2.1 State

| key | type | per | notes |
|---|---|---|---|
| `lp_price_<pool_id>` | uint64 | pool | mUSD per LP × 1e6. **Read by the vault.** |
| `lp_ts_<pool_id>` | uint64 | pool | last write time. **Read by the vault.** |
| `lp_active_<pool_id>` | uint64 | pool | whitelist flag |
| `signer_pubkey` | bytes(32) | — | the pinned ed25519 key |
| `pending_signer` | bytes(32) | — | queued rotation |
| `pending_signer_eta` | uint64 | — | timelock expiry |
| `admin`, `guardian`, `pending_admin`, `pending_guardian` | bytes(32) | — | unchanged model |

**`StateTotals(global_uints=57, global_bytes=7)` — declared near the cap on
purpose.** The schema is frozen at creation, and under-declaring costs a
redeploy *plus another 48h repoint*, which is the exact cost v5 exists to avoid.

3 uints per pool (price, ts, active) × 12 = 36 — no anchor (§2.6) — plus
`pending_signer_eta`. The measured AVM cap is **exactly 64** global entries, so
declaring 57 + 7 leaves the real ceiling at **19 pools** rather than the 12 we
need today. Creator MBR is `100,000 + 28,500 × uints + 50,000 × bytes` →
**2.12 ALGO** against 1.57 at a minimal 41/6. **Half an ALGO buys permanent
headroom**, paid once by the admin key.

**The anchor goes entirely — key, setter and band.** See §2.6, which is the
whole point of v5 and the easiest thing to get wrong.

### 2.2 `post_signed_price(message: bytes, signature: bytes)` — permissionless

No sender check. Assertions, **in this order**:

1. `len(message) == 85`
2. `extract(0, 37) == MAGIC ‖ VERSION ‖ GENESIS` — one slice, three constants
3. `target_app == Global.current_application_id`
4. `lp_active_<lp_asa_id>` exists and is 1
5. `price_min > 0` and `price_max >= price_min`
6. `issued_at <= Global.latest_timestamp + CLOCK_SKEW`
7. `Global.latest_timestamp - issued_at <= min(PAYLOAD_MAX_AGE, payload.max_age)`
8. `len(signature) == 64` — ~2 units for a legible error instead of an opcode
   failure after 1900 are already spent
9. **then** `ed25519verify_bare(message, signature, signer_pubkey)`

Writes `lp_price_<lp_asa_id>` and **`lp_ts_<lp_asa_id> = issued_at`** — the
payload's own timestamp, not `Global.latest_timestamp`.

Costs nothing and preserves the whole liveness property, since step 7 already
bounds `issued_at` to ~35s of the present and the vault's window is 1800s. What
it buys: an **honest age**. Writing `latest_timestamp` would report every post
as zero seconds old, including a replayed 30s-old payload — so the UI's and the
monitor's only remaining age signal would be meaningless precisely when it
matters. Step 6 still forbids a future `issued_at`, so this can never be
written ahead of now.

⚠️ **Step 7 must be written as `issued_at + effective_max_age >=
Global.latest_timestamp`**, not as a subtraction. `latest_timestamp - issued_at`
underflows and panics the moment `CLOCK_SKEW > 0`, because step 6 then permits
`issued_at > latest_timestamp`. The subtraction form is safe only by the
accident that skew is currently 0 — an undocumented coupling that would bite
whoever acts on §7.6.

**Bindings before signature, deliberately.** Measured: the whole bindings block
costs **49** opcode units against **1900** for the verify. A misdirected payload
should fail for 49 and give a legible error, not a budget-exceeded one.

**Which price is written.** `price_min` and `price_max` are equal today (see
[SIGNED_PAYLOAD.md](./SIGNED_PAYLOAD.md) — the capacity is reserved, the policy
is not decided). v5 writes `price_min`. When a real band is introduced, the
vault would want collateral at `min` and debt at `max`, and a single stored
scalar cannot express that — **so a real band is a v4 feature, not a v5 one.**
Recorded here so nobody assumes otherwise: enabling a band under v5 silently
values everything at the conservative end.

### 2.6 Every price gate is removed — on chain AND in the signer

This is the commitment v5 exists to honour: *"there is a bigger risk of me not
being able to liquidate loans on a flash crash than of me fumbling my private
keys."* Key-compromise risk is accepted; the defences built against it go.

| gate | where | status under v5 |
|---|---|---|
| ±25% anchor band | contract | **removed** |
| ±50%-vs-prior guard | contract | **removed** |
| `lp_anchor_`, `set_price_anchor`, the re-anchoring chore | contract | **removed** |
| anchor-derived `min_price`/`max_price` | **signer** | **removed — see below** |
| `asset_price_bounds` | signer | **removed** |
| wide scaling-slip band (`PRICE_SANITY_*`) | signer | **kept** — see below |
| TWAP smoothing | signer | **kept, normative** (§4.0) |
| multi-route + CompX cross-check | signer | **kept, normative** (§4.0) |

#### The signer-side bound has to go too, and a draft of this spec missed it

An intermediate draft kept `lp_anchor_` as "advisory state, asserted on by
nothing" so that `oracle_bot.effective_bounds` could keep deriving its ±24%
bound from it. **That would have defeated the entire exercise.**

Under v5 the signer does not post — it *signs*. If it refuses to sign, **no
payload exists, so nobody can post**, and permissionless relay buys nothing. The
halt does not disappear; it moves from the chain to the signer and is just as
total. A bound that halts the signer is the same object as a band that halts the
chain, wearing a different hat.

Measured 2026-10-12, with the current anchors:

| pool | vs anchor | bot headroom left |
|---|---|---|
| **U/tALGO** | **+14.5%** | **8.3%** |
| U/USDC | +8.4% | 14.4% |
| ALGO/USDC | +5.3% | 17.8% |
| U/ALGO | +6.5% | 16.5% |

So the gate is not theoretical — it is currently 8% from firing on U/tALGO.

**What replaces it: nothing, and deliberately.** With no on-chain band there is
nothing for a signer bound to stay inside, so the 2026-10-10 bug class it was
built for — bot bounds drifting out of agreement with the contract band —
**cannot occur, because neither side exists.**

#### What is kept, and why it is not the same thing

`payload.encode()` keeps one wide band: `PRICE_SANITY_MIN = 1_000` to
`PRICE_SANITY_MAX = 1_000_000_000`, i.e. **$0.001 to $1,000 per LP token**.

It is not a manipulation defence and not a compromise defence. It exists to
catch a **×1e6 or ÷1e6 scaling slip**, the likeliest bug in this path, which
would otherwise be signed and accepted — live prices are ~0.9–2.6e6 and a ×1e6
slip lands at 9e11. It is three orders of magnitude clear of any real price in
either direction, so **it never needs touching and can never rot.** That is the
difference from the band that did: that one was tight, per-pool, and
hand-maintained.

TWAP and the cross-checks stay because they catch **bugs and manipulation**,
which key custody has nothing to do with — a bug still runs our code, and a
thin-pool spike is not a stolen key. Only a compromised signer bypasses them,
and that is the accepted risk, with the honest cost stated in §4.5.

### 2.3 Kept, unchanged in spirit

- `add_pool(pool_id, initial_price)` — admin. Seeds `price`, `ts`, `active=1`.
  Still seeds a price so the vault's `assert price > 0` is never hit in the gap
  before the first relay.
- `remove_pool(pool_id)` — admin, same AUD-046 warning.
- `propose_admin` / `accept_admin` / `propose_guardian` / `accept_guardian`.
- `get_lp_price(pool_id)` readonly.

### 2.4 Removed

| removed | why |
|---|---|
| `authorized_updater`, `set_authorized_updater` | no privileged writer exists |
| `update_lp_price` | replaced by `post_signed_price` |
| `lp_anchor_`, `set_price_anchor`, the ±25% band | anti-compromise only, superseded by the signature — and the chore goes with them (§2.6) |
| ±50%-vs-prior guard | same, and it is itself a halt source |

### 2.5 Signer key rotation, and the break-glass

`propose_signer(pubkey)` → **48h** → `confirm_signer()`, with
`cancel_pending_signer()` for the guardian — the pattern the vault already uses
for the oracle repoint, and for the same reason: a settable signer key would
otherwise be an instant takeover path for a compromised admin.

#### `admin_set_price(pool_id, price)` — admin, immediate. **Ships.**

The first draft rejected this "because it reintroduces exactly the trusted
writer v5 removes." **That objection was illusory, and the review was right to
kill it.**

§2.3 keeps `add_pool` and `remove_pool`, both admin. **`remove_pool` followed by
`add_pool` is already an arbitrary admin price write with a fresh timestamp, in
two transactions.** So the capability exists either way; refusing to name it
bought no safety and only ensured the workaround would be an undocumented hack
that looks like routine pool maintenance in an explorer. A named method is
auditable; the hack is not.

What declining it *did* cost is the only remedy for the failure mode below.

#### Why it is needed: the failure that actually triggers a rollback

Under v5, **staleness is self-healing** — anyone can post. So the scenario that
forces a retreat is not a dead feed. It is a **posting bug**: a binding that can
never be satisfied, a wrong pinned pubkey, a wrong `target_app`, a deleted OpUp
app, a typo in the repoint. Then *nobody* can post, and permissionless relay
buys nothing because no valid payload exists.

v5 also **removes the lever that resolved the last incident**. On 2026-10-09 a
bound disagreement was fixed by `set_price_anchor` in one admin transaction.
Under v5 a signer that will not sign cannot be worked around at all.

`admin_set_price` is the floor under both. Documented break-glass: it writes a
price the signer did not produce, and every use should be explained.

## 3. Opcode budget and group shape

Measured on mainnet via `simulate`, reading `global OpcodeBudget` out of the AVM:

| | units |
|---|---|
| `ed25519verify_bare` | **1900** |
| budget per app call | **700** |
| full verifier (all 8 steps) | **1953** |
| bindings alone (steps 1–7) | **49** |
| inner no-op app call | **+683 net** |

| inner call to **self** | **prohibited** — `attempt to self-call` |
| inner call from an **unfunded** app | works at fee 0; no app funding needed |

### The arithmetic, stated correctly

An earlier draft said "three app calls' worth (2100) leaves 147 units… four is
the floor." **That omitted the consumer's own app call, which puts another 700
into the same pool.** The real formula is:

```
budget pool = 700 × (top-level app calls) + 682 × (inner app calls)
```

**The group needs exactly two app calls** — `post_signed_price` and the vault
call — plus the oracle's own inner OpUp. Padding to four top-level calls, which
the old wording invited, is pure waste.

### Measured end to end, against the live vault

The reviewer built the full §2.2 verifier in TEAL — 3 inner OpUp calls, all nine
bindings against a real 85-byte payload and a real signature, both state writes
— and put the **live mainnet vault's `trigger_full_liquidation`** in the same
group:

```
txn0:  1398 entry → 3444 after 3 inner → 3379 bindings → 1472 verify → 1451 writes
txn1:  the real vault ran 188 opcodes to its expected health-factor assert
```

The verifier costs ~1995 and **leaves 1451** for the rest of the group. The
vault's 188 covered the box read, overdue check, interest accrual, the cross-app
price *and* freshness reads and the LTV arithmetic; the remaining seize maths,
box write and three inner transfers are the same order, so the whole liquidation
is ~300–450. **About 3× headroom.** Two app calls and three inner calls is
correct; even two inner calls would fit.

### The OpUp app

**Self-inner-calls are prohibited — measured, not assumed.** So a separate
minimal OpUp app ships. Two properties it must have:

- **Non-updatable and non-deletable.** It becomes a permanent liveness
  dependency of the liquidation path; an admin who deletes it bricks posting
  with no recourse short of `admin_set_price`.
- **It needs no funding** (measured: inner calls work from an unfunded app at
  fee 0). The *caller* covers the inner fees by pooling, ~0.004 ALGO per post.
  The app account must never pay, or spamming it drains the app.

`extra-opcode-budget` is **simulate-only**. It does not exist on submission and
must not appear in any design.

## 4. Permissionless relay — consequences, examined

### 4.0 The signer MUST publish a smoothed, cross-checked price — normative

This was missing from the first draft, which described the relay as "today's bot
minus signing authority" and thereby assumed TWAP by inheritance. It is a
**requirement of v5**, not a property it happens to have:

- **TWAP smoothing.** LP_ORACLE.md calls dropping it "the one genuinely
  catastrophic thing that could be dropped here, and it must not be." Signing a
  *spot* price on a pool as thin as U/tALGO means anyone who can move it for one
  block can make us sign anything.
- **A second-source cross-check** on the derived asset price — today the
  multi-route median plus CompX, per
  [LP_ORACLE.md → Second-source options](./LP_ORACLE.md#second-source-options-if-compx-goes-away).

This is also what makes §4.2's payload-selection option harmless: on a smoothed
price two payloads seconds apart differ by a negligible fraction of the recent
move. **On spot prices the same selection is real money.** The two sections are
load-bearing on each other.

### 4.1 Who posts

- **The relay** (today's bot, minus signing authority) keeps the price warm
  every ~5 min so passive readers — the UI's health factors, the admin panel —
  see something current. It needs no key of any privilege; **anyone could run
  one**, and if ours dies the protocol still works.
- **Any actor who needs certainty** bundles a post with their own call.

### 4.2 The lookback option — a real addition, bounded

With no "freshest available" rule — and there cannot be one — whoever posts
chooses **which** valid payload. A borrower would pick the highest collateral
price in the window; a liquidator the lowest.

That exposure is bounded by `PAYLOAD_MAX_AGE` (30s, plus ~5s of measured
chain-clock lag — the window is *longer* than it reads; see SIGNED_PAYLOAD.md).

**An earlier draft called this "60× tighter than today's 1800s window." That was
a category error.** 1800s is a staleness *tolerance*, not a selection set:
today exactly one price exists at any instant, and a liquidator's only freedom
is *when* to send. v5 adds a genuine new freedom — choose among the ~6–8
payloads currently inside the age window — **on top of** that same timing
freedom. It is an addition, not a reduction.

It is a *small* addition, and with §4.0's smoothing close to zero, which is why
it is acceptable. But it must be stated as an addition or the next reader
mis-prices it.

### 4.3 No monotonicity requirement — deliberately

An obvious guard is "reject a payload older than the last one stored." **It is
rejected here, and the reason is stronger than a grief.**

A strict `issued_at > stored` rule lets anyone post a maximally-fresh payload
every block for ~0.001 ALGO, after which **every** in-flight group carrying an
older payload reverts. That is not a one-transaction nuisance — it is a cheap,
permanent liveness kill aimed squarely at the liquidation path, i.e. at the one
thing v5 exists to protect.

What it would prevent is the selection option in §4.2, which §4.0's smoothing
already reduces to near nothing. The guard costs far more than it buys.

### 4.4 Spam and state growth

Posting costs the poster ~0.004 ALGO and overwrites existing keys. `add_pool` is
still admin-only, so **no unprivileged action creates state** — no MBR growth,
no DoS surface. A spammer pays to keep our price fresh.

(An earlier draft also claimed "there is no longer a privileged writer." Not
true: `remove_pool` + `add_pool` is an admin price write, and §2.5 now names
that capability as `admin_set_price` rather than leaving it an undocumented
workaround.)

### 4.5 What a compromised signer can do — and who actually pays

**Corrected 2026-10-11 by design review.** An earlier draft said the risk was
"consistent with the accepted v4 risk — loss capped at the PSM reserve, the
reserve being the founder's own money." **That is wrong, and wrong in the
direction that matters.**

The `circulating mUSD ≤ psm_usdc` invariant caps the **price-too-high**
direction: over-minting. It says nothing about **price-too-low**. And the
price-too-low direction is where v5 differs from v4:

- **Under v4**, a bad payload harms only whoever carries it — and no borrower
  would ever carry one that liquidates them. Borrowers are **immune** to a
  low-price payload.
- **Under v5 the price is shared state**, so one poisoned low post makes **every
  borrower liquidatable by any honest third-party liquidator**, at the vault's
  500–700 bps penalty (`liq_penalty_t1` / `t2`). Those seizures are irreversible
  and the loss falls on **borrowers**, not on the PSM reserve.

The PSM cap does not bound this at all, and the §4.5 tripwire — written about
third-party PSM *deposits* — does not cover it either.

**Second correction: the 1800s figure is not the attacker's reach.** A
compromised signer bundles the poison post with its own exploit atomically: a
one-block window under **both** v4 and v5. The 1800s describes how long
*everyone else* is involuntarily mispriced afterwards. What v5 adds is the
collateral damage, not the attack.

Small today — 3 vaults, ~$950 — and unbounded in the size of the book. So the
honest statement of the trade is: **v5 avoids the migration by making a signer
compromise cost borrowers their collateral rather than costing only the
counterparties who chose to use a bad payload.** That belongs in the tripwire
list alongside the PSM one, and it is an argument for reaching v4 rather than
settling at v5.

Mitigation of duration, not of possibility: the relay keeps posting every 5
minutes, so an honest post displaces a bad one quickly in practice.

### 4.6 A payload is unusable for its first few seconds

`Global.latest_timestamp` is the **previous** block's time — measured **5s
behind wall clock**. Step 6 admits a payload only when `issued_at <=
latest_timestamp + CLOCK_SKEW`, and `CLOCK_SKEW` is currently **0**.

So the newest entry in a 4–6s-cadence bundle is **always rejected**, and every
payload is unusable for roughly its first 3–5 seconds. Retryable, not a halt —
a relay or a liquidator simply takes the next-newest. But two consequences:

- SIGNED_PAYLOAD.md's "a future skew of zero works because the lag already
  supplies the slack" is backwards for *admission*. The lag makes the forward
  check **stricter**; it is slack for the **expiry** only. `payload.py`'s own
  docstring says "CLOCK_SKEW is not small" forty lines above setting it to 0.
- A signer whose clock runs 2s fast loses ~7s of every payload's life.

§8 must include "post a payload issued this second," or the first mainnet
liquidation discovers this.

## 5. What v5 does not solve

- The price is still stored, so `lp_ts_` still ages. A passive reader with no
  payload can still see stale data — the UI, mainly.
- `ORACLE_FRESHNESS = 1800` stays in the vault, unchangeable without a redeploy.
  It stops *mattering* for anyone carrying a payload; it still governs everyone
  else.
- A real price band needs v4 (§2.2).
- The standing fee does not vanish while we choose to run a relay.

---

## 6. Migration runbook

### 6.0 The gate — simulate the confirm before submitting it

`confirm_lp_oracle` validates only `!= 0`, so a typo'd app id commits the vault
to a 48h freeze. **Before submitting it, simulate — read-only, against mainnet —
the group:**

```
[ vault.confirm_lp_oracle , oracle.post_signed_price , vault.trigger_full_liquidation ]
```

Same-group state visibility is proven (§2 liveness), so that one simulation
exercises the *entire* new path against the real vault before anything is sent.
This is how the liveness claim in this spec was verified in the first place, and
it is the cheapest insurance available on the riskiest step.

Order matters. **The new oracle must be warm before the vault points at it**, or
the vault goes stale the instant it switches.

1. Deploy the OpUp app (if needed — §3) and the v5 oracle. Reproducible build,
   bytecode matched, as was done for vault `3671287267`.
2. `propose_signer(<pubkey>)`, wait 48h, `confirm_signer()` — or set it at
   deploy, which avoids the first wait. **Decide which.**
3. `add_pool` for all four, each with a fresh price:
   `3163770927` U/tALGO · `3673941603` U/USDC · `1002590888` ALGO/USDC ·
   `3617313492` U/ALGO. Price in human units in the Admin UI (it scales by 1e6).
4. Point the signer at the **new** oracle app id (`target_app`) and start
   publishing. Start the relay against the new oracle.
5. **Let it run and confirm all four stay fresh** — and **re-check freshness
   immediately before step 6's confirm**, not only before the propose. The 48h
   gap is exactly where a relay dies, and `confirm` switches the vault
   instantly. The old oracle keeps serving the vault untouched throughout; the
   two run in parallel with no conflict, since the old one has no signature path
   and the new one has no bot path.

   ⚠️ `accept_admin` on the vault **clears `pending_lp_oracle`**
   (`vault/contract.py:288-292`, P21-04). An admin rotation during the window
   silently restarts the 48 hours.
6. `propose_lp_oracle(<new oracle>)` on the vault → **48h** → `confirm_lp_oracle()`.
   Guardian can `cancel_pending_lp_oracle` at any point before.
7. Frontend — the full list is in §1. **Better than flipping the constant:** have
   the frontend read the oracle app id out of the **vault's own global state**,
   which already stores it, and delete the constant entirely. Otherwise there is
   a window between step 6's confirm and the deploy where the UI prices
   positions off the *old* oracle while the vault uses the *new* one.

   `OracleHealthPanel`'s band-distance reading **goes entirely** — there is no
   anchor and no band (§2.6), so the panel must be reworked, not relabelled. A
   **bundle-freshness / signer-liveness monitor** replaces it as the leading
   indicator. That monitor
   is a v5 deliverable, not a follow-up: `getOracleHealth`'s own comment records
   that the distance-to-band was built after the 2026-10-07 post-mortem because
   "nothing in the product showed it," and without a replacement v5 ships with
   only the lagging `lp_ts_` age.
8. Retire the old oracle.

**Rollback — and an honest account of what it is not.**

Until step 6 confirms, nothing has changed and backing out is free.

After it, repointing to `3644230020` means **48 hours with the vault aimed at a
broken oracle**: no borrowing, no liquidations. That is worse than any of the
three freezes v5 exists to prevent, so it is **not a rollback** and the first
draft should not have called it one. It is a last resort.

The real protections, in the order they apply:

1. **§6.0's simulation gate** — the riskiest step becomes verifiable before it
   is submitted.
2. **`admin_set_price`** (§2.5) — a posting bug stops being a freeze and
   becomes an inconvenience the admin writes through.
3. **A non-deletable OpUp app** (§3) — it is a permanent liveness dependency of
   the liquidation path, so it must not be deletable or updatable by anyone,
   including us.

Keep the old bot runnable until v5 has proven itself regardless.

---

## 6.5 `target_app` — a semantic drift to record now

SIGNED_PAYLOAD.md (offset 37) and `payload.py` both document `target_app` as
"ONE **vault** app id." §2.2 reinterprets it as the **oracle's** app id.
Semantically fine — it is "the verifying app" — but SIGNED_PAYLOAD.md calls
itself the byte-for-byte contract, so **amend it** rather than leave the two
disagreeing.

Forward consequence, while the format is still free: when v4 lands the verifier
becomes the vault, so **a payload valid for the v5 oracle is not valid for the
v4 vault**. Any parallel run needs two payloads per pool per tick, under two
bundle keys. Cheap, but it belongs in the v4 plan now rather than being
discovered then.

## 7. Open decisions

Settled by the 2026-10-11 review, recorded so they are not re-opened:

- ~~Self-inner-call~~ — **prohibited, measured.** A separate OpUp app ships (§3).
- ~~Signer-loss policy~~ — `admin_set_price` ships (§2.5), so a lost key is no
  longer a 48h freeze. Keep an offline backup anyway; the two are not exclusive.
- ~~Pool capacity~~ — declare 57/7 now (§2.1), ceiling 14 pools, +0.5 ALGO once.

Genuinely still open:

1. **Signer key set at deploy, or via the timelock?** At deploy avoids a 48h
   wait before the first post; via the timelock keeps one mechanism. Recommended:
   at deploy, rotation timelocked thereafter.
2. **Does the relay keep running?** Recommended yes — it is what keeps passive
   readers honest and shortens §4.5's exposure window.
3. **`CLOCK_SKEW`** (§4.6). 0 costs the first ~3–5s of every payload. A small
   positive value recovers it but requires §2.2 step 7's underflow-safe form.
4. **Who may call `admin_set_price`** — admin alone, or admin with a guardian
   veto window. Admin alone matches the capability `remove_pool`+`add_pool`
   already confers; a veto adds friction to the one lever that unfreezes things.

## 8. Test plan

Against `contracts/tests/` (67 integration/adversarial) and the signer's 59:

- Every binding failure rejects: wrong app, wrong/unregistered pool, wrong
  network, zero price, inverted band, future payload, expired payload, a payload
  expired by its own `max_age` before the global ceiling.
- A valid signature with wrong bindings rejects; a right payload with a tampered
  message or signature rejects; a payload signed by a non-pinned key rejects.
- Malleated signature (S+L) rejects — pynacl and the AVM were measured to agree.
- **The liveness property, end to end:** with a feed deliberately stale beyond
  1800s, `[post_signed_price, trigger_full_liquidation]` in one group succeeds.
  This is the whole reason v5 exists and must be an executable test.
- Opcode budget holds with the real verifier plus a real vault call in-group.
- Permissionless: a sender with no role posts successfully; posting does not
  create state; `add_pool` still rejects a non-admin.
- Rotation: propose/confirm/cancel, guardian veto, and that an old key stops
  verifying the moment the new one is confirmed.
- **A payload issued this second is rejected** (§4.6) — pin the behaviour so it
  is a known property, not a surprise at the first mainnet liquidation.
- **The real group budget**, as a regression baseline: 2 top-level app calls +
  3 inner, verifier ~1995 units, ≥1400 left for the vault call (§3).
- `remove_pool` + `add_pool` is an admin price write — assert it works, since
  `admin_set_price` exists precisely so nobody has to use it.
- The OpUp app being deleted makes `post_signed_price` revert — which is why it
  must be deployed non-deletable (§3).
- `lp_ts_` carries `issued_at`, so a replayed 30s-old payload reports age ~30s
  and not 0 (§2.2).
- Schema: a 20th pool fails to register, proving the declared ceiling is real
  and known rather than discovered later.
- **No price is ever refused for being far from anything** (§2.6): a price 10x
  the last one posts successfully, on chain and through the signer. This is the
  commitment v5 exists to honour and it should fail loudly if someone
  reintroduces a bound.
