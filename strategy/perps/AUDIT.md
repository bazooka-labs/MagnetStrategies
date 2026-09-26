# Perps — Audit, 2026-09-26

Two adversarial audits of the Perps stack, run before the trade button was wired.
Non-overlapping briefs, both told that chain is ground truth and the spec has been
wrong before. **21 distinct findings, 5 ship-blocking.** They contradict each other
nowhere, and independently converged on one defect.

This file is the record of what was found, what was decided, and what remains. It
is not a summary of the spec — where the two disagree, this file is newer.

---

## Decision taken: one position per market and side

**Opening is refused while a position already exists on that `(market, side)`.**
To change size, close and re-open.

This was a live question the audit forced. PEX keeps exactly one position per
`(market, collateral asset, side)`, and a second open *increases* it. Supporting
increases is a second economic path with its own quoting, its own assertion
surface, and it is the mechanism that turns a false "not confirmed" into a
doubled position (B5). The product's proposition is one position, one target, a
few clicks — increase-position buys flexibility nobody asked for at a real
safety cost.

Two consequences worth stating, because they re-scope the fixes:

- **`position: null` is now correct for every open we permit.** The quote path
  does not need position awareness. What it needs is a guard.
- **`mf2:` is still required, but for the close preview, not for opens.** Any
  position-aware quote throws `funding factor regression` without it
  (reproduced), so the management surface depends on it. Opens do not.

---

## Ship-blockers

Each verified by execution, by me, independently of the auditor that raised it.

### B1 — the take-profit price is on the wrong side of the trigger

`perpsClient.ts` used `acceptableFromExecution` for the take-profit leg. That
helper is written for an **opening** order — a long pays up, a short receives
down. A take-profit is a **closing** order, so PEX requires the opposite side.
Confirmed in the SDK: for `DECREASE_TAKE_PROFIT`, a long needs
`acceptable <= trigger`.

Reproduced on all four market/side combinations — the builder throws
`bad_order_price` every time. Take-profit is mandatory, so this was **100% of
trades**. The button could never have worked.

**It escaped the tests because the harness hardcoded the correct value**
(`trigger * 0.997`) while production called the helper. A test that does not call
what the product calls proves nothing about the product.

### B2 — our own assertion blocks correct groups

`quoteOpen` anchors slippage to the **quoted execution price**, deliberately: an
index anchor fails at every size once price impact is charged. `assertOpenGroup`
then measured drift against the **index**. Two halves of one design disagreeing,
with the assertion winning by throwing.

Measured on live state: **3 of 4** cases blocked (106.3, 70.9, 56.5 bps from
index against a 50 bps tolerance). ALGO long passed only because impact happened
to be small that hour.

B1 and B2 mask each other — fixing B1 alone yields a group B2 refuses.

### B3 — every quote ignored the user's existing position

`position: null` was hardcoded and `readPosition` had **zero callers**. For a
holder of a live $245 position, the card showed liquidation at **$0.0712**; the
position-aware truth is **$0.0908** — a 27.5% understatement of the distance to
total loss, well inside a normal drawdown.

Resolved by the one-position decision plus a guard, rather than by building
position-aware quoting.

### B4 — a market switch can render one market's numbers under the other's label

`usePerpsMarket` guarded late responses with a `useRef`. A ref is one object for
the component's life: React runs the old effect's cleanup (`alive = false`) then
the new effect's setup (`alive = true`) before any in-flight promise resolves, so
the stale closure reads `true` and passes. Whichever read finishes **last** wins
and sticks for up to the refresh interval.

The comment above it claimed the opposite guarantee. Neither
`data.state.marketId` nor `data.oracle.decoded.marketId` — both present, both
authoritative — was ever compared against the requested market.

### B5 — a successful open was reported as failed, and the retry doubled the position

`waitForConfirmation(…, 6)` covers about 17 seconds against a validity window of
about 47 minutes, against a load-balanced endpoint whose 404s the SDK swallows by
design. On timeout the promise rejects, the txid is discarded, and the user is
told it failed while the group remains submittable and almost certainly commits.

The retry was the money part: the allocator would see the new order box, pick a
fresh id, and open a **second valid position**. The one-position guard removes
that path; the false failure is fixed separately by widening the wait and
surfacing the txid.

---

## High

- **H1 — the keeper-fee escrow leg's receiver and asset were unbound.** Only the
  amount was checked. Four tamper variants passed, including redirecting the leg
  to an attacker and swapping it to an arbitrary ASA — 100,000 units of a
  low-decimal asset is not $0.10.
- **H2 — the take-profit survived a market switch.** `tpTouched` was reset on
  side, amount and slider but not on the market buttons. A $0.30 ALGO target on
  a BTC short validates, and the card printed "Closes for $388.62 profit" on $100
  of collateral. Separately `CROSS_MARGIN_BPS` was defined and never referenced.
- **H3 — `error` gated nothing.** The banner read "trading is disabled" while the
  slider stayed live and every money figure rendered from a snapshot the hook had
  already judged unusable. **Found independently by both auditors.** Compounding
  it: a repeated identical error message is a no-op `setState`, so no re-render
  occurs and the "price signed Ns ago" indicator freezes.
- **H4 — three documented controls had zero callers:** `verifyProgramPins`
  (described in its own docstring as our sole automatic detection of a PEX
  upgrade), `assertBuilderAddressUsable`, and `readPosition`.

## Medium

MBR payment receiver unbound · extra calls to unrelated-but-pinned PEX apps pass ·
fees inflatable to the 250k cap against a real cost of 51k · the TP price check
uses `Math.abs` and so **structurally cannot catch B1** · TP size never compared
to the open's size · `maxKeeperFeeMicro` accepted as a parameter rather than read
from config · no upper bound on a long's take-profit, and the card printed a
$1.7bn payoff for one · `simulateGroup` **fails open** on a 200 with an
unexpected shape · the solver overstates by up to **+11.4%** just above the $5
floor and a systematic +2 bps on BTC/USD · `assertBaseOrderIdFree` treats a 5xx
as "free".

## Low

`openPosition` accepts NaN/Infinity and surfaces a raw `RangeError` · `"-5"`
sanitises to `"5"`, so a negative becomes a real position · roughly 28
synchronous quote evaluations per keystroke, 7–16 ms on desktop · **`doi:` has no
declared format in the manifest at all**, so that one layout is pinned against
nothing.

---

## What has been fixed

**Phase 1 — the six ship-blockers** (commit `c80f9a4`). B1–B5 as written above,
plus a sixth found only by running the fix: the bar offered the solver's exact
ceiling, and micro-unit rounding put it a hair over what the chain accepts.
`confirmCeiling` now walks the last step down.

**Phase 2 — make the screen trustworthy** (commit `9d03ec9`). H2, H3 and B4's
second half. `error` now gates `tradable` rather than only rendering a banner;
`dataTrusted` additionally requires a verified oracle signature. The market
switch clears the take-profit. `attemptAt` keeps the staleness line ageing while
a refresh repeatedly fails with an identical message.

**Phase 3 — close the assertion gaps** (this commit). H1, and the Medium items
that live in `perpsGroup.ts`:

- The keeper-escrow leg's receiver and asset are bound, not just its amount.
- The MBR payment's receiver is bound.
- `CALL_BUDGET` enumerates how many calls each pinned app may receive, so an
  extra call to an unrelated-but-pinned PEX app no longer passes.
- `MAX_GROUP_FEE_MICRO_ALGO` cut 250,000 → 120,000 against a real cost of 51,000.
- `acceptableWithin` replaces the `Math.abs` comparison that **structurally
  could not catch B1**: it derives the side the price may move from the leg's
  intent (opening vs closing) and the position side, so a wrong-side price is a
  finding rather than a distance.
- The take-profit's size is compared to the open's size.
- `maxKeeperFee` is read from config rather than accepted as a parameter — a
  parameter is only as trustworthy as its caller.
- `simulateGroup` fails **closed** on a 200 with an unexpected shape.

### The verification, and why it is in the repo

`web/src/lib/perpsGroup.test.ts`, 27 cases under `npm test`. Each takes a group
the assertion accepts, breaks exactly one thing that costs the user money, and
requires the assertion to name it **by its own finding code** — "something was
rejected" is not a pass, because B2 was a check firing for the wrong reason.

Two things this suite exists to prevent recurring:

1. **B1 escaped the old harness because the harness computed the price itself**
   (`trigger * 0.997`) while production called the helper. These cases call the
   same code the card does.
2. **The earlier harnesses were written to a scratch directory that was then
   deleted.** A test you cannot re-run is not a regression test. Hence in-repo.

Writing them caught a third thing worth recording: three cases initially failed,
and the tests were wrong, not the code. Each mutated the ABI argument while
leaving the displayed value alone, so the equality check fired first and the
directional bound never ran. The attack worth testing is a screen that displays
what it sends — a *consistent* lie — so those cases now mutate both.

**Phase 4 — H4, the controls with no callers.** `readPosition` was wired in
Phase 1 by the one-position guard. The other two now share
`web/src/lib/perpsPreflight.ts`, which is their only caller:

- `verifyProgramPins` — app IDs survive a redeploy untouched, so this is the
  only thing that notices a PEX upgrade. On drift: **block opens, keep exits
  live**, because a redeploy leaves existing positions in the old app and a
  blanket halt strands whoever is holding one.
- `assertBuilderAddressUsable` — if the treasury is not opted in to USDC, the
  builder-fee transfer fails and takes every open with it, for every user,
  presenting as our bug. Refuse early and say it is ours.

Neither belongs in the ten-second market refresh, so the preflight is cached
behind one shared promise with a five-minute TTL: the card starts it on mount,
and the write path awaits the same promise. **A read that did not complete fails
closed** — an incomplete check is not evidence the programs are unchanged — but
that outcome is deliberately not cached, so a dropped request does not hold
trading down for five minutes. The card offers a retry that bypasses the TTL.

The card gates on `canOpen === true`, not `!== false`: the value is null until
the first check returns, and "not yet verified" has to read as "no". The write
path re-runs the check rather than trusting the card — the card's gate is there
so the button is honest, the write path's so it is safe.

Two things running it against MainNet exposed:

1. **It took 11 seconds.** `verifyProgramPins` awaited six `getApplicationByID`
   calls in a loop, each pulling a whole approval program. Long enough that a
   user reaches the button before the check gating it returns. Parallelised:
   **1.5 seconds**, same result. Pins are intact and the builder address is
   opted in with 310 ALGO spendable, so wiring this did not block live trading.
2. **A message under the slider lied.** "No size on this side currently clears
   the exchange's checks. Try a different amount." rendered for *every* cause of
   `!tradable` — so during the contract check, and whenever it failed, it told
   the user to change an amount that was never the problem. It is now scoped to
   the case it describes. This is the same defect as H3, one layer down: a
   control was added and the screen was not re-read against it.

**Phase 5 — the remaining Medium and Low findings.**

- **No upper bound on a long's take-profit.** A long is mathematically unbounded,
  so `takeProfitBounds` returned no ceiling and the card printed "Closes for
  $1.7bn profit before costs". `MAX_TAKE_PROFIT_MULTIPLE` (10x entry) is a typo
  guard, not a claim about what the price can do, and the message says "check the
  decimal point" rather than "impossible". Take-profit is mandatory here precisely
  so a position closes; one set beyond any reachable price is functionally no
  take-profit at all.
- **`assertBaseOrderIdFree` treated a 5xx as free.** A bare `catch {}` meant a
  timeout, a dropped connection and a server error all returned "the id is free"
  — the single fact the function exists to establish. It now matches a 404
  narrowly and throws on anything it cannot positively identify as one. Nothing
  was ever at risk, since a collision is rejected on chain, but it reported a
  check as passed that had not run, and spent the user's wallet prompt to find out.
- **NaN and Infinity reached the write path.** `collateralUsd <= 0` is false for
  NaN, because NaN fails every comparison — so NaN passed the guard, reached
  `BigInt(Math.round(NaN))` and surfaced as a raw `RangeError`. Now
  `Number.isFinite`, plus guards on the take-profit price and slippage.
- **`"-5"` became `"5"`.** `replace(/[^0-9.]/g, "")` stripped the sign, so a
  negative did not fail — it turned into a real $5 position. Sanitising now lives
  in `perpsInput.ts` with its own tests: a minus is *refused* rather than
  corrected, extra dots collapse instead of parsing to NaN downstream, and
  `parseMoney` returns null rather than 0 so "nothing entered" and "zero" stay
  distinguishable.
- **~28 quote evaluations per keystroke.** The solver was wired to the raw input
  string, and `confirmCeiling` alone walks up to twelve quotes, so typing "100"
  ran the whole thing three times over. The input is now debounced 120 ms before
  it reaches the solver. The field itself is never debounced.

**The solver overstatement is closed, and not by a fix.** The +11.4% near the $5
floor was measured before `steppedCeilingUsd` and `confirmCeiling` landed in
Phase 1. Re-measured live across both markets, both sides and seven collateral
values from $5 to $100: **0.00% at all 24 points**, with the solver's own ceiling
accepted directly by the SDK quote (`confirmCeiling` returns it unchanged on the
first step). $5 itself reports closed — "too small once fees are taken out" —
which is the floor behaving as documented, not a regression.

**Still open:** `doi:` has no declared format in the manifest, so that layout is
pinned against nothing. That is a question for Ultrade, not a code change, and it
sits with B6 in the list below.

---

## Root causes

Grouped, because fixing symptoms here would leave the causes in place.

1. **Open-versus-close direction confusion** — B1, and the direction-blind check
   that cannot catch it.
2. **One design, two disagreeing halves** — B2.
3. **Position awareness never built** — B3, H4, and the close path.
4. **"What was displayed" treated as trustworthy.** Every assertion compares the
   group against what the screen showed. When the screen is wrong (B4, H2) they
   all pass. This is the deepest one and no single fix addresses it.
5. **Controls written and never wired** — H4, `CROSS_MARGIN_BPS`.

---

## What the old verification got wrong

Two claims in the commit history are false and are corrected here.

- **"33 of 33 attacks caught."** True as stated, but it tested the attacks that
  were imagined rather than the fields that were left unbound. The replacement
  must enumerate every transaction leg and every field, then assert each one is
  checked — derived from the group, not from a list of ideas.
- **"Zero overstatements" from the solver.** The sweep set
  `position_impact_factor_bps` to zero to "isolate the margin solve", then the
  code shipped into a market where impact is 55 bps. Re-sweep with real impact.

Both failures share a shape: **the test was easier than the thing it claimed to
test.** B1 is the sharpest instance — the harness hardcoded a correct value where
production called a broken helper.

---

## Clean results worth keeping

- **Box decoding is correct.** Every `*_FIELDS` list matches the manifest
  name-for-name and in order. Across the whole manifest only two fields are not 8
  bytes — `position_state.position_id` (uint48) and `side` (uint16) — and both
  are handled. `decodePosition` verified against all 11 live position boxes.
- **The manifest hash gate is fail-closed and correctly placed**; no path builds
  a group without it.
- **Prefix filtering is honoured server-side** — verified by differential, not
  assumed.
- **No cross-market bleed in the library modules.** Every function takes one
  market's state per call. The leak is in the hook (B4), not the maths.
- **The oracle refuses** wrong app, wrong market, wrong genesis hash, non-pinned
  signer, stale, future-dated, and malformed bands — all read from the signed
  bytes rather than the JSON envelope.
- **`usdToPrice12` is exact and robust** against every hostile input tried.

---

## B6 — the take-profit leg is rejected by OrderOps (found 2026-09-26, after the audits)

Not from either audit. It surfaced the first time `openPosition` was driven
end-to-end against a funded account, which is exactly what the audits could not
do and what the old harnesses never did.

**Symptom.** Simulation fails at app `3690309166` (OrderOps), `pc=8175`,
`opcodes=bz label191; intc_1 // 1; label193:; assert`.

**Isolated to the attached-order leg.** The identical open *without* a
take-profit simulates `ok=true` for the same account, and a trivial self-payment
as that account also simulates fine — so this is neither a signature artefact nor
an account prerequisite.

Invariant across every variable tried:

| Varied | Result |
|---|---|
| builder fee present / absent entirely | `pc=8175` |
| keeper fee 0.10 → 0.25 USDC | `pc=8175` |
| `baseOrderId` 1 → 9000 | `pc=8175` |
| storage payment 99,700 / 129,000 / 29,300 | `pc=8175` |

The trader-box hypothesis was tested and is **wrong**: the account has a `t2:`
box on Trading but none on OrderOps, and funding the 29,300 µALGO
`V2_TRADER_BOX_MBR_MICRO_ALGO` does not change the failure.

**Context that may matter.** OrderOps holds **zero boxes exchange-wide** — no
order is live anywhere on PEX — and `v2_order_executed` has never fired on
MainNet. Orders were placed historically (49 bracket cleanups are on chain), so
either something changed at an upgrade, or attached orders need something not
present in the SDK's own builder output.

**Two further eliminations, 2026-09-26.** An exec trace shows the order
arguments arriving correctly — `orderKind=2`, `linkMode=3`, and an acceptable
price *below* the trigger, which is the side the contract requires for a long
take-profit. The failure is immediately after a box read returning empty
(`pc=8163` pushes `0x`, `pc=8165` pops it, `pc=8175` asserts). And the outcome is
identical whether or not the account already holds a position on that market and
side, which rules out the position box.

**Next step:** this is a question for Ultrade rather than more black-box probing.
Give them the pc and the isolation, and ask what a valid
`submit_linked_order` requires that an SDK-built group does not carry. Do not
guess further — four variables have already been eliminated and guessing a fifth
is not evidence.

---

## Open

1. **Does PEX itself reject a tampered transfer (H1)?** *Partly answered,
   2026-09-26.* With a funded trader as sender, an open-only group simulates
   `ok=true`, and redirecting the **collateral** transfer to an attacker is
   **rejected by the chain**. So for that leg there is a real second line of
   defence behind the assertion.

   **The actual H1 leg is still unresolved.** The unbound keeper-fee escrow
   exists only in the open+take-profit group, and that group cannot be simulated
   at all while B6 stands. So "the chain would catch it" remains unproven for the
   leg that is actually unbound. Fix it regardless; re-test once B6 clears.

   A caution on method: a second mutation in the same run — inflating fees to the
   group cap — also showed as rejected, but that mutation rewrote every
   transaction's fee and so probably broke fee pooling rather than tripping a fee
   ceiling. It is not evidence that an overpaid fee is refused, and is not
   recorded as such.
2. **`doi:` is pinned against nothing.** Ask Ultrade for a declared format, or
   pin by observation and say so.
3. **These were two instances of the same model reviewing its own work.** That
   catches assumptions and arithmetic — it did, repeatedly — but it is weakest
   where the error is systematic rather than local. Before this holds meaningful
   money, an outside reviewer is worth more than a third bot.
