# MagnetFi v2 — LP Vault + mUSD

## What is this?

MagnetFi v2 leverages yield-bearing LP tokens as collateral for Magnet's own
Algorand-native stablecoin **mUSD**. Users deposit Tinyman LP tokens and borrow
mUSD, where the peg is guaranteed by a protocol-owned reserve module. Repayment
is mandatory but interest-only; principal is optional and unlocks collateral.

Admin-managed, with a two-role security model: a hot **admin** key controls
rates, reserve levels and liquidation triggers; a cold **guardian** key can
pause the protocol, veto the timelocked oracle/vault repointing powers, and
recover a lost or compromised admin key. No external governance at launch. Full
trust model: [ADMIN.md](./ADMIN.md).

> ⚠️ **The guardian is a single cold key, not the 2-of-3 multisig the design
> calls for.** `unpause()` and `propose_guardian()` are guardian-only in all
> three contracts, so losing that key permanently removes the containment layer
> and a compromise of it freezes the protocol with no admin recovery. It cannot
> move funds or change parameters. See
> [ADMIN.md](./ADMIN.md#guardian-wallet-cold) and the tripwires below.

---

## Status

**Live on Algorand mainnet.** Oracle, PSMv3 and Vault operating on U/tALGO and
U/USDC collateral; borrows validated end to end. v3 productive reserves live;
the Folks yield adapter is built and testnet-validated but **not yet
whitelisted**.

### Where to read the live state

This document deliberately does **not** restate figures that change. Every one
of them has diverged across documents at least once — the interest rates were
recorded three different ways in three files in this folder, and two were wrong.

| What | Read it from |
|---|---|
| App IDs (oracle, PSM, vault), mUSD ASA, pool wiring | `web/src/lib/magnetfi.ts` — `DEPLOYMENTS.mainnet`, `POOL_WIRING` |
| Interest rates per pool | The vault's `rate_<pool_id>` globals, on chain |
| PSM reserve, circulating mUSD, vault ceiling | The PSM app account and the mUSD ASA, on chain |
| Open positions and their health | The vault's boxes, or the admin panel |
| Oracle freshness and price cross-check | The admin Oracle Health panel |

The admin panel reads all of these live. If a number here and the chain
disagree, the chain is right and this line is the bug.

### The oracle: lean, no band

The vault has priced from the **lean oracle** since 2026-10-17 19:01Z, swapped
in behind the 48h timelock. The banded oracle it replaced is retired — nothing
posts to it, the vault does not read it, and it cannot be deleted (no delete
handler), so it sits on chain unread.

**The band was removed deliberately.** The oracle had frozen three times; two
were the bot's own hardcoded bounds and are fixed, and the third was the
*contract's* anchor band rejecting a valid post. The bands only ever bounded a
compromised key, and their cost — a protocol-wide freeze — was not accepted.
Authoritative: [ORACLE_LEAN_SPEC.md](./ORACLE_LEAN_SPEC.md). Migration record:
[history/LEAN_ORACLE_MIGRATION.md](./history/LEAN_ORACLE_MIGRATION.md).

**The consequence, stated plainly:** a holder of `authorized_updater` can post
**any price** for any pool. There is no deviation check, no bounds and no rate
limit on chain. The loss is still bounded in both directions — over-borrowing
is capped by the PSM's backing invariant, which counts real USDC and not
oracle-priced collateral; and all three `trigger_*_liquidation` methods are
admin-only, so a crashed price seizes nothing by itself. But "bounded" here
means *bounded by the PSM reserve*, and it grows with the reserve.

---

## Product surfaces

1. **LP-collateral vaults (these contracts).** Deposit Tinyman LP tokens,
   borrow mUSD. Built and owned by MagnetFi.
2. **Single-token markets (CompX).** Lend or borrow individual assets via
   partner CompX's pools, surfaced read-only with a deep-link. Hosted and
   operated by CompX; MagnetFi adds no contract surface or custody.

Everything else in this document set concerns the LP-vault contracts only.

---

## Architecture

```
Admin Wallet (Bazooka Labs)
    ↓
PSM Contract              ← holds USDC reserves; issues and redeems mUSD
    ↕
Vault Contract            ← accepts LP collateral; mints mUSD up to PSM ceiling
    ↕
LP Oracle Contract        ← values LP positions by (LP balance / total LP supply) × pool TVL
    ↕
mUSD ASA                  ← Algorand-native stablecoin; total minted ≤ PSM USDC reserves
```

### Core invariant

> **Circulating mUSD ≤ PSM USDC reserves at all times.**

"Circulating" is all mUSD not held by the PSM, regardless of whether it entered
via vault borrowing or direct PSM mint. Enforced at contract level. The two
entry paths stress it differently:

- **Vault borrow** — PSM issues mUSD without receiving USDC: circulating rises,
  PSM USDC unchanged, vault ceiling shrinks.
- **PSM direct mint** — USDC enters as mUSD is issued: both sides rise equally,
  the invariant is never stressed, ceiling unchanged.

So the practical constraint is vault minting. Admin cannot withdraw PSM USDC
below circulating mUSD. The peg is mathematically guaranteed while it holds.

---

## Peg Stability Module

A protocol-owned fixed-rate swap module, not an AMM.

| Direction | Rate | Fee |
|---|---|---|
| USDC → mUSD (mint) | 1:1 | 0% — friction-free entry |
| mUSD → USDC (redeem) | 1:1 | 1% → treasury wallet |

- A first-class user-facing product: anyone can mint mUSD with USDC, no vault.
- The redemption fee routes to treasury per transaction; it does not accumulate
  in reserves.
- No external LPs; all reserves protocol-owned.
- **Productive reserves (v3, live):** idle reserves deploy into low-risk
  on-chain yield through vetted, timelocked adapters while mUSD stays fully
  redeemable. See [PSM.md](./PSM.md#productive-reserves-v3).

---

## Vault

Each vault is an LP collateral position: deposit a Tinyman LP token, mint mUSD
up to the LTV limit.

| Vault | LP Pair | LTV | Liq. threshold | Status |
|---|---|---|---|---|
| U/tALGO LP | $U + tALGO | 60% | 75% | live |
| U/USDC LP | $U + USDC | 65% | 75% | live |
| ALGO/USDC | ALGO + USDC | — | — | priced on the oracle, **not vault-registered** |
| U/ALGO | $U + ALGO | — | — | priced on the oracle, **not vault-registered** |

**Rates are not listed here on purpose** — read them from the vault's
`rate_<pool_id>` globals. They changed on 2026-10-14 and this table said
otherwise for twelve days.

Rates **lock at open**: the rate is copied into the vault box, so a change
applies to new vaults only and never reprices an open position.

The bottom two rows are priced by the oracle but have no vault-side rate, LTV,
liquidation threshold or LP ASA, so nothing can be borrowed against them. They
render as inert "Coming soon" cards and carry an ORACLE ONLY badge in the admin
panel.

### Repayment

- **Interest-only** — interest owed roughly quarterly (~90 days).
- **Principal optional** — repaying in full returns all collateral; no mandatory
  repayment date.
- **Grace** — admin may trigger micro-liquidation at 90 days of non-payment.
  Interest accrues until the admin acts.
- **Clock resets** on every interest payment or liquidation event.
- `pay_interest()` is the single repayment path (always charges interest before
  touching principal), with clamp-and-refund on overpay.

---

## Liquidation

Two independent triggers, both admin-manual. Full detail:
[LIQUIDATION.md](./LIQUIDATION.md).

**Path 1 — missed payment (micro-liquidation).** 90+ days since last interest
payment. Seizes LP covering accrued interest + 5% buffer. Debt cleared, position
continues, clock resets.

**Path 2 — health-factor breach (tiered).** Health factor below 1.0, with
pre-calibrated tiers so the admin acts without calculating under pressure:

| Health factor | Action |
|---|---|
| 0.95 – 0.9999 | seize ~35% LP + 5% penalty; position continues |
| 0.85 – 0.9499 | seize ~77% LP + 7% penalty; position continues |
| < 0.85 | full seizure; position closed, no surplus refund |

If both apply, Path 2 takes precedence. Redeeming LP splits collateral across
both pooled assets, halving price impact on either — which matters for $U
stability during a liquidation.

---

## LP Oracle

```
position_value = (user_lp_balance / total_lp_supply) × pool_TVL
pool_TVL       = (asset_A_reserves × price_A) + (asset_B_reserves × price_B)
```

Sources are **on-chain Tinyman v2 pool reserves**, cross-checked against CompX's
Flux oracle. No external price API — the original Vestige integration was
removed when its endpoint retired, which was also the P19-02 single point of
failure.

**Circuit breakers: none on chain** since the lean oracle. The contract accepts
any price from the authorized updater. What still gates a post, all bot-side:
per-asset price bounds, the CompX divergence check, and a spot-vs-TWAP upward
spike block.

**The independent cross-check** (`web/src/lib/magnetfiPriceCheck.ts`) is the only
signal that can catch a price that is *wrong but fresh*: third-party pool TVL ÷
on-chain issued LP tokens, which touches none of our asset prices, decimals,
route selection or TWAP. Warn at 5%, critical at 15%. It is a **pull readout
behind a connected admin wallet, not an alert** — catching a bad price with it
requires somebody to be looking.

---

## Interest rate model

Fixed rates, set per vault type, locked at the moment a position opens.

- New vaults open at the current advertised rate.
- Existing positions are never retroactively repriced.
- Admin may adjust the rate for new vaults; this never affects open positions.

Fixed rates are viable here specifically because the PSM anchors the peg
mechanically. Utilisation-based models need a rate signal to restore a peg;
the PSM's guaranteed redemption arbitrage does it without one.

---

## Revenue

**Automatic:** PSM redemption fee (1% of each mUSD→USDC swap, to treasury per
transaction); protocol-owned DEX LP fees if treasury mUSD is deployed.

**Admin-collected:** vault loan interest (accumulates in the vault, swept via
`collect_fees()`); micro-liquidation late fee; health-liquidation surplus.

Loan interest scales with vault TVL; redemption fees scale with mUSD volume.
Collected mUSD can convert to USDC and enter the PSM (growing the vault ceiling)
or become protocol-owned DEX liquidity (building mUSD depth).

---

## Admin controls

| Action | Guard |
|---|---|
| Add USDC to PSM | None — admin can always add |
| Withdraw USDC from PSM | Cannot drop below outstanding mUSD |
| Set vault interest rates | Max 3000 bps (30% APR) |
| Trigger micro-liquidation | 90+ days since last payment |
| Trigger health liquidation | Health factor below threshold |
| Collect loan interest | None |
| Repoint oracle or vault | 48h timelock, guardian can veto |

---

## What this is not

- Not trustless — admin holds real discretionary power.
- Not a public AMM PSM — all reserves are protocol-owned.
- Not automated — no keeper bots or on-chain automation.
- Not cross-chain — Algorand only.

---

## Open items

**The guardian is a single key.** The design calls for a 2-of-3 cold multisig
and the deployment never got one. Moving it is a guardian-signed
`propose_guardian` → `accept_guardian` on each of the three contracts, so it
can be done without redeploying anything — but only while the current key still
works, because the admin cannot replace a guardian it has lost.

**Rotate the oracle bot key.** The current `authorized_updater` key is treated
as exposed and is scheduled for rotation. Since the anchor band was removed the
updater can post any price, so this is the highest-priority open item on the
protocol. Rotation is `set_authorized_updater` — admin-only, immediate, and
needs no redeploy. The bound on what an exposed updater is worth to an attacker
is in [ADMIN.md](./ADMIN.md#oracle-bot-wallet-hot).

**`ALERT_WEBHOOK_URL` and `HEARTBEAT_URL` are unset.** Two prior feed outages ran
~27h and ~48h before anyone noticed. The feed now auto-starts at logon, which
addresses the restart but not the detection.

**Bot redundancy.** A single instance is a single point of failure. Auto-start
at logon is verified by an actual power cycle; a second host is not built.

**The upward rate limit on the lean oracle** is the real fix for the unbounded
key, and is deferred. The oracle already stores prior price and timestamp per
pool, so it needs no new state — the 57-uint schema was chosen to keep this
possible. [ORACLE_LEAN_SPEC.md §5](./ORACLE_LEAN_SPEC.md).

**Vault-side registration for ALGO/USDC and U/ALGO.** Both are priced on the
oracle; neither has vault-side parameters. ALGO/USDC is a **risk** fix before a
growth one — the collateral book is entirely $U-denominated, and U/tALGO is thin
enough that seizing a large position would move the price against the
liquidator.

**Folks yield adapter — not whitelisted.** Built and testnet-validated.

**A professional third-party audit** before significant TVL. Internal review is
24 passes plus adversarial and oracle-bot tests; real-fund custody warrants an
external firm. [AUDIT_HANDOFF.md](./AUDIT_HANDOFF.md) is the package.

**Public PSM deposits** remain pinned — deliberately parked until ALGO/USDC
proves borrow demand exists. [PSM.md](./PSM.md#public-deposits--pinned).

**Sequencing for all of the above:** [REVAMP_PLAN.md](./REVAMP_PLAN.md), which
supersedes the ordering this document's predecessor carried.

---

## Tripwires — conditions, not intentions

Written down because decisions made at $950 have a habit of still being in force
at $100k.

**Before a third-party borrower opens a vault** — re-answer the key-compromise
question. Without the band a compromised bot key can set any price, and the PSM
invariant caps only the over-minting direction. The risk is currently *accepted*,
not covered, and that acceptance rests on every borrower being the operator.

**Before the PSM accepts a single third-party deposit** — the same question
again. Today's acceptance rests on the reserve being the founder's own money.
Both halves stop being true with outside deposits, and *"I accept the risk"*
stops being one person's sentence to say.

**Before third-party funds of any kind** — the guardian should be a real 2-of-3
cold multisig. A single-key guardian is survivable while the only thing it can
freeze is the operator's own $151; it is not a position to defend to someone
else's depositors.

**Before any public deposit** — liquidation must be proven working, and
permissionless-vs-admin decided deliberately rather than by default. One hot key
operated by one person is not a solvency plan at scale.

---

## Which document to trust

| Document | Status |
|---|---|
| **This file** | Current. Start here. |
| [ORACLE_LEAN_SPEC.md](./ORACLE_LEAN_SPEC.md) | **Executed 2026-10-17**, all 8 steps. Still the reference for why the oracle looks like this; §5's rate limit is the one deferred piece |
| [ADMIN.md](./ADMIN.md) | Accurate for what is running — swept 2026-10-17 |
| [PSM.md](./PSM.md) · [VAULT.md](./VAULT.md) · [LIQUIDATION.md](./LIQUIDATION.md) · [mUSD.md](./mUSD.md) · [FOLKS_ADAPTER.md](./FOLKS_ADAPTER.md) | Current |
| [REVAMP_PLAN.md](./REVAMP_PLAN.md) | Live. Phase structure still governs; **Phase 2 is superseded** by the lean spec |
| [AUDIT_HANDOFF.md](./AUDIT_HANDOFF.md) | Live — the package for the upcoming v3 audit. §8.3's manipulation bound is no longer a live safety argument and carries a dated note |
| [V3_IMPLEMENTATION_PLAN.md](./V3_IMPLEMENTATION_PLAN.md) | Live — phased delivery of productive reserves |
| [ORACLE_V5_SPEC.md](./ORACLE_V5_SPEC.md) · [SIGNED_PAYLOAD.md](./SIGNED_PAYLOAD.md) | Built and proven, **deferred**. v5 adds zero-second pricing at liquidation and no key the contract trusts — worth less than it costs while every borrower is the operator |
| ⚠️ [LP_ORACLE.md](./LP_ORACLE.md) | Describes the **retired** banded oracle. Its band/anchor material and its "a compromised key is bounded" claim no longer describe anything live |
| ⚠️ [LAUNCH_RUNBOOK.md](./LAUNCH_RUNBOOK.md) | Its add-a-pool procedure targets the **retired** oracle app and the wrong config file. Do not follow it without reading the banner |
| [AUDIT.md](./AUDIT.md) | **Historical record.** P19-03 documents the anchor band as a finding that was *addressed*; the band was then removed deliberately. Do not rewrite it — it is what was true then |

---

## Further reading

- [web/README.md](../../web/README.md) — frontend site map, Bank tabs, admin console
- [reference/folks-sdk/](./reference/folks-sdk/) — upstream source the adapter was
  derived from, kept so the derivation stays checkable
- [history/](./history/README.md) — closed records: the lean-oracle migration and
  the v2 deployment record. Nothing in there is current
