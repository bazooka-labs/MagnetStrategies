# MagnetFi — Relay Oracle (v5)

**Status: specification, pre-build.** Nothing here is implemented.

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
| migration | deploy, `add_pool` ×4, repoint 48h, one frontend line | |

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

`StateTotals(global_uints=37, global_bytes=6)` → 3 uints × **12 pools** = 36,
plus `pending_signer_eta`. Byte slots: 4 roles + 2 signer keys.

**`lp_anchor_` is gone.** The signature is the integrity mechanism; an anchor
band bounded a compromised *writer*, and there is no longer a privileged writer.

### 2.2 `post_signed_price(message: bytes, signature: bytes)` — permissionless

No sender check. Assertions, **in this order**:

1. `len(message) == 85`
2. `extract(0, 37) == MAGIC ‖ VERSION ‖ GENESIS` — one slice, three constants
3. `target_app == Global.current_application_id`
4. `lp_active_<lp_asa_id>` exists and is 1
5. `price_min > 0` and `price_max >= price_min`
6. `issued_at <= Global.latest_timestamp + CLOCK_SKEW`
7. `Global.latest_timestamp - issued_at <= min(PAYLOAD_MAX_AGE, payload.max_age)`
8. **then** `ed25519verify_bare(message, signature, signer_pubkey)`

Writes `lp_price_<lp_asa_id>` and `lp_ts_<lp_asa_id> = Global.latest_timestamp`.

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
| `lp_anchor_`, `set_price_anchor`, ±25% band | anti-compromise only; superseded by the signature |
| ±50%-vs-prior guard | same, and it is itself a halt source |

### 2.5 Signer key rotation

`propose_signer(pubkey)` → **48h** → `confirm_signer()`, with
`cancel_pending_signer()` for the guardian — the pattern the vault already uses
for the oracle repoint, and for the same reason: a settable signer key would
otherwise be an instant takeover path for a compromised admin.

> **Decision needed — the 48h freeze risk.** If the signer key is *lost*,
> rotation takes 48h, and the feed is stale throughout: no borrowing, no
> liquidations. Options:
> **(a)** keep an offline backup of the signer key, accept the timelock
> *(recommended — it keeps the contract honest and makes loss implausible)*;
> **(b)** a shorter timelock for signer rotation specifically;
> **(c)** an admin break-glass `admin_set_price` — rejected in this draft,
> because it reintroduces exactly the trusted writer v5 removes.

---

## 3. Opcode budget and group shape

Measured on mainnet via `simulate`, reading `global OpcodeBudget` out of the AVM:

| | units |
|---|---|
| `ed25519verify_bare` | **1900** |
| budget per app call | **700** |
| full verifier (all 8 steps) | **1953** |
| bindings alone (steps 1–7) | **49** |
| inner no-op app call | **+683 net** |

One app call affords 700. The verify needs 1900. **Three app calls' worth (2100)
leaves 147 units for everything else and is not enough; four is the floor.**

### Chosen shape: the oracle buys its own budget

`post_signed_price` issues **3 inner no-op app calls** before verifying, so the
caller's group stays `[post_signed_price, their_call]` — two transactions, no
filler the frontend has to assemble, and composable with anything else.

- Inner calls are sent with `fee=0`; the **caller's** outer transaction covers
  them by fee pooling, roughly **0.004 ALGO** per post. The app account must
  never pay, or spamming it drains the app.
- **Target: a minimal OpUp app we deploy and control.** Not a third party's —
  `305162725` exists and accepts anyone's NoOp, but depending on an app we do
  not own puts a liveness dependency in the liquidation path.
- ⚠️ **To verify at build time:** whether the AVM permits an app to issue inner
  calls to *itself*. If it does, the separate OpUp app is unnecessary. The
  measurement above used inner calls to a distinct app; self-recursion is
  believed to be prohibited, but this spec does not rest on belief — check it,
  and drop the extra app if it turns out to be allowed.
- `extra-opcode-budget` is **simulate-only**. It does not exist on submission
  and must not appear in any design.

---

## 4. Permissionless relay — consequences, examined

### 4.1 Who posts

- **The relay** (today's bot, minus signing authority) keeps the price warm
  every ~5 min so passive readers — the UI's health factors, the admin panel —
  see something current. It needs no key of any privilege; **anyone could run
  one**, and if ours dies the protocol still works.
- **Any actor who needs certainty** bundles a post with their own call.

### 4.2 The lookback option is bounded, and tighter than today

With no "freshest available" rule — and there cannot be one — whoever posts
chooses **which** valid payload. A borrower would pick the highest collateral
price in the window; a liquidator the lowest.

That exposure is bounded by `PAYLOAD_MAX_AGE` (30s, plus ~4s of chain-clock lag
— the window is *longer* than it reads; see SIGNED_PAYLOAD.md). **Today the
window is 1800s**, so v5 tightens the same exploit by roughly 60×. It is a
strict improvement, not a new hole.

### 4.3 No monotonicity requirement — deliberately

An obvious guard is "reject a payload older than the last one stored." **It is
rejected here.** It would hand an attacker a one-transaction grief: post a
payload one second fresher and every in-flight transaction carrying an older one
reverts. The rollback it prevents is bounded by §4.2 and is already 60× tighter
than the status quo, so the guard costs more than it buys.

### 4.4 Spam and state growth

Posting costs the poster ~0.004 ALGO and overwrites existing keys. `add_pool` is
still admin-only, so **no unprivileged action creates state** and there is no MBR
growth and no DoS surface. A spammer pays to keep our price fresh.

### 4.5 What a compromised signer can do — a real difference from v4

In v4 a bad payload harms only whoever uses it. **Under v5 the price is shared
state, so one bad post poisons every reader until replaced** — and `lp_ts_` is
refreshed by that post, so the vault treats it as current for up to
`ORACLE_FRESHNESS` (1800s), which lives in the vault and cannot be shortened
without the redeploy v5 exists to avoid.

Consistent with the accepted v4 risk — loss capped at the PSM reserve, the
reserve being the founder's own money — but **strictly worse than v4 on this
axis**, and the honest cost of avoiding the migration. It is also a reason the
PSM tripwire stands: before any third-party deposit, this is re-answered.

Partial mitigation available for free: the relay keeps posting every 5 minutes,
so an honest post displaces a bad one quickly in practice. That is a mitigation
of *duration*, not of *possibility*.

---

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
5. **Let it run and confirm all four stay fresh.** The old oracle keeps serving
   the vault untouched throughout — the two run in parallel with no conflict,
   since the old one has no signature path and the new one has no bot path.
6. `propose_lp_oracle(<new oracle>)` on the vault → **48h** → `confirm_lp_oracle()`.
   Guardian can `cancel_pending_lp_oracle` at any point before.
7. Frontend: `DEPLOYMENTS.mainnet.oracle` in `web/src/lib/magnetfi.ts`, plus the
   admin panel's oracle ops and `getOracleHealth` (the anchor/band fields in
   `OracleHealthPanel` no longer exist — that panel needs reworking).
8. Retire the old oracle.

**Rollback:** until step 6 confirms, nothing has changed. After it, `propose_lp_oracle`
back to `3644230020` — which still holds its state — and wait 48h. Keep the old
bot runnable for exactly that reason until v5 has proven itself.

---

## 7. Open decisions

1. **Signer-loss policy** — §2.5 (a), (b) or (c). Recommended (a).
2. **Signer key set at deploy, or via the timelock?** At deploy avoids a 48h
   wait; via the timelock keeps one mechanism. Recommended: at deploy, with
   rotation timelocked thereafter.
3. **Self-inner-call** — §3. Decides whether a second app ships.
4. **Does the relay keep running?** Recommended yes: it is what keeps passive
   readers honest and shortens §4.5's exposure.
5. **12 pools or more?** 3 uints each; the AVM cap is 64 global key-value pairs.

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
