# Cover — Product Definition and Architecture Spec

Cover is a simplified product surface over PEX perpetual positions. A user buys a number of fixed-size units, chooses how aggressively to size them, optionally sets a profit target and a reminder duration, and signs one transaction. No chart, no order book, no trading vocabulary.

**Product name is not final.** "Cover" is the working name for both the product and its unit. It was chosen over "contract" deliberately: *contract* plus a payout table is the vocabulary of a derivatives offering and is not worth borrowing.

**Status:** Design stage. Nothing is built or deployed.

Read [OVERVIEW.md](./OVERVIEW.md) first for PEX platform facts, verified constants, and the integration paths that were rejected.

---

## The Central Architectural Fact

**Cover requires no smart contract of our own.**

Every economic action is a PEX call signed by the user's wallet:

| Action | Mechanism | Who executes |
|---|---|---|
| Open a Cover | `buildV2OpenOrIncreaseCall` | User's wallet |
| Attach profit target | `DECREASE_TAKE_PROFIT` bracket, same group | User's wallet |
| Close early | `buildV2DecreaseOrCloseCall` | User's wallet |
| Profit target fires | PEX stored order | PEX keeper network |
| Liquidation | PEX permissionless liquidation | Any third party |
| ADL | PEX pool-solvency backstop | PEX keeper |

We write no TEAL, hold no funds, hold no admin key over user positions, and have no pause authority. Our attack surface is **what our frontend constructs and what our interface claims**, not what a contract of ours can be made to do.

This should shape the audit. The exploitable questions are not "can the contract be drained" — there is no contract. They are:

1. Can our frontend construct a transaction group that harms a user who signs it?
2. Can our displayed numbers mislead a user into a position they did not intend?
3. Does any optional component (see [Duration](#duration-the-hard-problem)) grant us authority over user funds, and if so, what is the blast radius when it is compromised?

---

## Threat Model

| Actor | Can do | Cannot do |
|---|---|---|
| Magnet Strategies (honest) | Construct transaction groups, set builder fee, display quotes | Move user funds, open or close positions, alter PEX state |
| Magnet Strategies (compromised frontend) | Construct a *malicious* group and present it for signature | Bypass the wallet's signature prompt |
| PEX protocol | Everything within its own contracts, including ADL | — |
| PEX oracle signer | Set the price range all execution derives from | — |
| PEX keeper network | Execute stored orders, liquidate, ADL | Open positions on a user's behalf |
| Third-party liquidator | Liquidate any position below maintenance | Liquidate a healthy position |
| Network observer | Read every position, order, fee and builder address on-chain | — |

**The dominant risk is a compromised or buggy frontend presenting a harmful group to a user who trusts the brand and signs without reading.** Algorand wallets display group contents, but users do not reliably read them. This is the same trust posture as every non-custodial dApp, and it is not eliminated by having no contract — it is merely the only risk left.

**Mitigations required:**

- Transaction group construction goes through a single audited module. No ad-hoc group assembly in UI components.
- Every group is simulated (`simulate_transactions`) before presentation, and the simulated outcome is what the UI displays.
- The group's asset movements are asserted against the user's selection before the signature prompt: exactly one collateral transfer, of the expected asset, of the expected amount, to the expected PEX application address.
- Builder address is a build-time constant, not a runtime value from any API response.

---

## Operating Model

Magnet Strategies operates:

- **The frontend.** Route `web/src/app/hedge/perps/`, inside the existing app and connect-wallet flow.
- **A read backend.** Required for the PEX protocol manifest (`GET /v2/protocol`) and for decoding market boxes. This is the one unavoidable server dependency.
- **A notification service.** Duration reminders and ADL alerts. No authority over funds.
- **No keeper with signing authority** in v1. See [Duration](#duration-the-hard-problem).

Magnet Strategies does **not** operate: the exchange, the price oracle, the liquidation network, or the order-execution keepers. All four are PEX.

---

## Constants

PEX-side constants are listed in [OVERVIEW.md](./OVERVIEW.md#verified-parameters) and are **TestNet values**. MainNet risk configuration is undocumented and must be read live. Nothing in this spec may hardcode a PEX risk parameter.

Cover-side constants:

| Constant | Value | Notes |
|---|---|---|
| `COVER_UNIT_USD` | 10 | Collateral committed per unit |
| `COVER_MIN_UNITS` | 1 | $10 ≥ PEX $5 minimums at every band |
| `COVER_MAX_UNITS` | 25 | $250 ceiling for v1; raise after live observation |
| `BUILDER_ADDRESS` | MS treasury | Build-time constant |
| `POSITION_BUILDER_FEE_BPS` | ≤ 10 | Protocol cap is 10 |
| `SWAP_BUILDER_FEE_BPS` | 0 for forced conversions | See [Collateral](#collateral) |
| `DEFAULT_SLIPPAGE_BPS` | 50 | User-adjustable, disclosed |
| `ORACLE_MAX_AGE_SEC` | 20 | Reject quotes on payloads older than this |

---

## Product Model

### Units

A Cover is **$10 of committed collateral**. The user buys N of them. Committed capital is `N × 10` USD and is the user's maximum loss.

### Aggressiveness bands

Bands are defined by **liquidation buffer**, not by leverage multiple. The system solves for whatever leverage delivers the target buffer against the *current* margin requirement. The multiplier is an implementation detail the user never sees.

```
buffer = (1 / leverage) − maintenance_margin_rate
leverage = 1 / (target_buffer + maintenance_margin_rate)
```

At the TestNet maintenance rate of 2.5%:

| Band | Target buffer | Resolves to | Notional per unit |
|---|---|---|---|
| No leverage | ~97% | 1× | $10 |
| Low | 20% | ~4.4× | $44 |
| Moderate | 10% | ~8× | $80 |
| High | 5% | ~13.3× | $133 |

This is deliberate: the maximum band lands near 13×, not 20×. A 20× position liquidates on a ~2.5% adverse move, which is inside ordinary daily movement for ALGO. The product does not offer it.

**The band is stable in the dimension that matters.** If PEX's maintenance requirement changes, leverage shifts and the buffer the user was shown stays true.

### Direction

`Protect against a drop` (short) and `Protect against a rise` (long). Presented as outcomes, not as sides.

### Duration

`24 hours · 72 hours · 1 week · Until I close`. **In v1 this sets a reminder, not an enforced close.** See below — the wording constraint is a correctness requirement, not a copy preference.

### Profit target

Optional percentage move that auto-closes via a native PEX take-profit bracket. Defaults:

- **`Until I close`** → target **off**. A target caps protection; on an open-ended hedge that is counterproductive.
- **Bounded duration** → target **on**, since the user has already declared they want a bounded outcome.

### Worked example

5 Covers, Moderate, protect against a drop, TestNet params, ALGO at $0.0866:

```
committed          $50
leverage           ~8×
notional           $400
liquidation buffer ~10%   (ALGO rising ~10% ends the position)
```

Illustrative payoff, net of fees. **These figures are computed by the SDK against live state, never by us, and never hardcoded:**

| ALGO moves | User receives |
|---|---|
| −20% | ~$128 |
| −10% | ~$89 |
| −5% | ~$69 |
| +10% | $0 — position closed |

---

## Duration: The Hard Problem

**A time-based automatic close is not natively enforceable on Algorand, and the obvious workaround does not exist.**

Algorand transactions carry a validity window of at most **1000 rounds** (`lastValid − firstValid ≤ 1000`), roughly 50 minutes. A close transaction therefore **cannot be pre-signed at open time** for execution 24, 72 or 168 hours later.

PEX's stored orders do not close this gap. All three order kinds — `OPEN_LIMIT`, `DECREASE_TAKE_PROFIT`, `DECREASE_STOP_LOSS` — are **price**-triggered. GTD sets an expiry on the *order*, not a timed close of the *position*. There is no time-triggered close primitive.

That leaves three options.

### Option A — Advisory duration (v1, selected)

The declared duration is a **reminder**. At expiry we notify; the user closes with one tap. Nothing is enforced.

- **Authority granted to Magnet Strategies: none.**
- **Blast radius of full compromise of our infrastructure: zero user funds.**

**Wording is a correctness requirement.** The UI must never say "closes after 72 hours." Acceptable phrasing: *"We'll remind you after 72 hours."* A user who believes a close is guaranteed and does not receive one has been misled by us, and that is a user-harm finding regardless of whether funds moved.

### Option B — Delegated close authority (v2, requires its own audit)

A delegated LogicSig, signed once by the user at open, authorizing our keeper to submit a close of that specific position later. Because a delegated LogicSig approves a *program* rather than a pre-built transaction, the 1000-round window does not apply — the keeper builds the transaction at expiry.

If this is ever built, the program must bind **all** of:

- Exact position coordinates: market ID, collateral asset ID, side, and owner
- Method: decrease-or-close only. Never a payment, asset transfer, rekey, opt-out, or any other application call
- Recipient: proceeds to the position owner only
- A minimum acceptable price, to prevent execution into a manipulated range
- `lastValid` bounded to the declared expiry window, so authority expires with the Cover
- A `lease` to make it one-shot and prevent replay

**And the risk must be stated plainly in the spec that proposes it:** a delegated LogicSig is a signed blank cheque within the bounds of its program. Our keeper would hold one per open Cover. A keeper compromise is therefore an attack on *every* open position simultaneously, and a single scoping bug — one missing field check that permits a payment instead of a close — is a total-loss vulnerability.

This is a materially different security posture from v1 and must not be added incrementally. It needs its own spec, its own audit, and a deliberate decision that the convenience is worth the blast radius.

### Option C — Rekey

Rejected outright. Never rekey a user account.

### Consequence for v1

Ship Option A. Duration is a reminder, honestly worded. Bounded cost is achieved instead through the profit target and through live display of accrued holding cost — not through a clock we cannot enforce.

---

## Collateral

**Default to USDC.** Posting ALGO as collateral on an ALGO-denominated position makes the collateral's USD value move with the position, turning the liquidation price into a moving target and making the payout harder to reason about. USDC gives a clean denominator.

If the user holds only ALGO, offer an ALGO→USDC swap. Constraints:

- The swap is disclosed as a separate step with its own cost, never bundled silently.
- **`SWAP_BUILDER_FEE_BPS` is 0 for a conversion the user did not seek.** The protocol permits 100 bps on swaps, ten times the position cap. Charging maximum on a conversion the product forced is indefensible for a brand whose sibling product's founding document treats operator trust as the binding constraint. If a swap fee is ever introduced here it is a deliberate, disclosed, separately-decided product choice.
- Verify whether the swap and the position open fit in one signed group within Algorand's group size and resource-reference limits. PEX trading methods are resource-heavy and carry their own resource-carrier transactions. If they do not fit, it is two signatures, and the UI must set that expectation before the first prompt.

**mUSD is explicitly out of scope as a funding path.** See [OVERVIEW.md](./OVERVIEW.md#out-of-scope--musd-as-a-funding-path).

---

## Availability Gating

Bands are not always available. PEX tightens margin requirements dynamically as open interest approaches its per-side cap, and the 70% pool utilization ceiling can block a side entirely regardless of leverage.

**Gating is a local computation, not a network round trip.** The SDK computes quotes and risk client-side. Read market state on an interval, then evaluate any hypothetical order size and band instantly as the user changes inputs.

```
read      mp2: (pool)  mo2: (open interest)  mf2: (funding/borrowing)  ma2: (adaptive funding)
decode    via protocol manifest
compute   effective max leverage per side, remaining capacity per side  [local]
derive    which bands are deliverable at the user's current unit count  [local]
```

Two distinct unavailability states, with different messages and different user actions:

| State | Cause | Message shape |
|---|---|---|
| Band unavailable | Dynamic margin tightened near the OI cap | "High is unavailable right now — capacity is limited." Lower bands still work. |
| Side unavailable | Pool utilization at ceiling, or reserves committed | Nothing works on that side, including 1×. Different message, different suggested action. |

**Prefer a ceiling to a wall.** Because any size can be evaluated locally, show the limit rather than a disabled button: *"Max at High: 4 Covers."* It tells the user how to get to yes and costs nothing extra.

**Structural note for this product specifically.** Hedging demand is correlated — in an ALGO drawdown everyone wants the same side at the same time. Cover will systematically push into whichever side is already constrained, at exactly the moment users want it. Design the capacity messaging for that case rather than treating it as an edge case, and consider nudging users to open cover while capacity exists.

**Gating is a snapshot, not a guarantee.** State can shift between the read and the signature. Gating removes predictable failures; it does not remove all failures. A clean on-chain rejection handler is still required, and the acceptable-price bound is a separate rejection path gating cannot touch.

---

## Quote Accuracy

Display accuracy is a security property here, because there is no contract to exploit and misleading numbers are the primary way a user can be harmed.

**Required:**

1. **Every displayed payout is net** of open fee, close fee, builder fee, keeper fee where a bracket is attached, and accrued funding and borrowing. A screen that says $100 when $98.40 lands is a trust failure.
2. **The profit target is never presented as guaranteed.** PEX documents these orders as conditional. The trigger arms when the *oracle* crosses the level; a keeper then executes, and in a fast move it can fill worse. `≈$148` is correct; "you will receive $148" is not.
3. **Holding cost is shown live and labelled as variable.** Borrowing accrues with utilization; funding is charged *or received* hourly depending on which side of the OI imbalance the user is on. A hedger on the light side may be **paid** to hold. Never quote either as fixed.
4. **Funding share is read, never assumed.** `opposing_trader_share_bps` is live on-chain state. Hardcoding 25% is a defect.
5. **Quotes refuse to render on a stale oracle.** Payloads carry a ~30s validity window. Past `ORACLE_MAX_AGE_SEC`, show a stale state rather than a stale number.
6. **The builder fee is disclosed.** It is publicly readable on-chain; concealing it in the UI is the same category of problem as a closed price feed.

---

## State

Cover holds **no protocol state of its own**. Everything economically meaningful lives in PEX boxes: the position in `p2:`, the bracket order in `o2:`, market context in `mp2:` / `mo2:` / `mf2:` / `ma2:`.

The only Cover-specific data is **user intent** — declared duration and the unit count the position was composed from. Neither is required for correctness; both exist to drive reminders and display.

Options, in order of preference:

1. **On-chain note.** A 0-ALGO self-payment carrying a JSON payload under an `ms:cover:` prefix, mirroring the pattern already in `web/src/lib/contact.ts`. Zero backend, cross-device, publicly verifiable, consistent with house architecture. Costs one extra transaction and ~0.001 ALGO.
2. **`localStorage`.** Free, but lost across devices and browsers.

If (1) is used, apply the same defensive decoding discipline as `contact.ts`: a note is only trusted as the user's own intent when `txn.sender === the position owner`. Nothing in this payload should ever be trusted for a financial calculation — it drives reminders and presentation only, and a forged note must be incapable of causing loss.

---

## Invariants

1. **Magnet Strategies never custodies user funds.** No flow routes user assets to an address we control, other than the disclosed builder fee.
2. **Magnet Strategies never holds authority to open or increase a position.** In v1 we hold no authority to close one either.
3. **Every state-changing action is wallet-signed** by the position owner.
4. **No MagnetFi state is read or written** by any Cover code path.
5. **No PEX state feeds MagnetFi solvency.** Cover does not spend the PEX dependency. See the coupling rule in [OVERVIEW.md](./OVERVIEW.md#the-dependency-coupling-rule).
6. **Displayed payout ≤ realistically achievable payout** under the quoted conditions. Round against the user.
7. **`builder_fee_bps` ≤ the protocol cap**, is a build-time constant, and is disclosed in the UI.
8. **No PEX risk parameter is hardcoded.** Margin rates, caps, fees, funding share and utilization limits are read live.
9. **No transaction group is presented for signature without a successful simulation** whose outcome matches what is displayed.

---

## Residual Trust

What a Cover user is trusting, stated plainly because the product's honesty depends on it:

| Trusted party | For what | Our mitigation |
|---|---|---|
| PEX contracts | Correct settlement, margin, liquidation, ADL | None available. No audit is advertised. Disclose. |
| PEX oracle signer | The price range all execution derives from | Freshness and target validation; refuse stale payloads |
| PEX keeper network | Executing stored orders and ADL | None available |
| Folks Finance, xALGO | Pool assets are partly deployed there via `lent_qty` | Transitive and unavoidable while trading against these pools. Disclose. |
| Magnet Strategies frontend | Constructing the group the user believes they are signing | Single audited module, mandatory simulation, asserted asset movements |
| Magnet Strategies backend | Protocol manifest used to decode box state | Version-check the manifest; refuse to quote on mismatch |

**A stale protocol manifest across a PEX upgrade means silently wrong decoding and therefore silently wrong quotes.** This is the least obvious failure mode in the system and deserves explicit attention in review.

---

## Edge Cases

| Case | Required behaviour |
|---|---|
| Insufficient spendable ALGO for MBR and fees | Detect before the prompt. ~0.30 ALGO for a position with a bracket. Most common first-transaction failure. |
| USDC not opted in | Detect and offer opt-in as an explicit step |
| Band becomes unavailable between render and signature | Clean rejection handler; re-quote rather than retry blindly |
| Acceptable price exceeded mid-flight | Funds return. Explain as a price move, not an error. |
| Oracle payload stale at signing time | Block the signature; do not submit on a stale price |
| Profit target fills worse than trigger | Expected behaviour. Payout display must have set this expectation. |
| ADL reduces or closes a profitable position | Notify promptly and explain. Highest-severity surprise in the product. |
| Liquidation | Notify. Buffer was disclosed at purchase; restate what happened. |
| Position already closed when a duration reminder fires | Suppress the reminder |
| Market paused by PEX | Surface honestly; we have no override |
| User closes partially outside our UI | Read live position state as truth; never trust cached unit counts for financial display |

---

## What Is Deliberately Not Here

- **No custom smart contract.** If a proposal adds one, it changes the threat model in this document and requires re-review.
- **No mUSD funding path.** Excluded by decision. See [OVERVIEW.md](./OVERVIEW.md#out-of-scope--musd-as-a-funding-path).
- **No enforced time-based close in v1.** Not available without delegated authority.
- **No 20× band.** The maximum is buffer-defined and lands near 13×.
- **No chart.** PEX is oracle-priced; a chart would be decorative and would imply the user should be timing entries.
- **No stop-loss above liquidation in v1.** PEX supports decrease orders, so a "keep something rather than ride to zero" exit is possible later. Ship without it and see whether users ask.

---

## Build Order

1. **Read path.** Protocol manifest, deployment manifest, application IDs. Decode `mp2:` / `mo2:` / `mf2:` / `ma2:` for both markets. Nothing else can be trusted until this is verified against live MainNet state.
2. **Measure.** Live borrowing and funding rates, real utilization, real per-side capacity, and the MainNet values of every parameter listed as TestNet-only. **Design decisions that depend on holding cost are blocked until this exists.**
3. **Quote engine.** Local band→leverage resolution, payoff table, holding cost, availability gating. Verified against SDK output, not reimplemented.
4. **Group construction.** Single audited module. Simulation mandatory. Asset-movement assertions.
5. **UI.** Four screens: units → band → confirm → covered state.
6. **Notifications.** Duration reminders, ADL alerts, liquidation alerts.
7. **Post-trade view.** Portfolio integration for users who want the detailed position.

Steps 1 and 2 are prerequisites, not preliminaries. Every number in this spec marked TestNet is a placeholder until step 2 replaces it.

---

## Open Questions

- Does the position builder fee apply on decrease as well as open? Confirm against `v2Quotes` before quoting round-trip cost.
- Can an ALGO→USDC swap and a position open fit in one signed group within resource-reference limits?
- Do resting limit orders pre-reserve open-interest capacity, or only the storage escrow? Affects whether parked conditional orders consume the capacity gating reads.
- What is the MainNet value of every TestNet parameter in [OVERVIEW.md](./OVERVIEW.md#verified-parameters)?
- Is there a published PEX audit? Not advertised in the repo; worth asking directly given the relationship.
