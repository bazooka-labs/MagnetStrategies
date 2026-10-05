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

## Audit 3 (2026-09-26, post-remediation)

A third adversarial pass, briefed to falsify the Phase 1–5 claims rather than
accept them, and to derive the leg/field list from the group **the SDK actually
builds** rather than from the assertion's own list of checks.

It confirmed most remediations held — and found that one claim in this file did
not.

### The overstated claim, corrected

**Phase 3's verification section was wrong.** `perpsGroup.test.ts` contained
zero cases for `assertOpenWithTakeProfit`, which is the only assertion
`openPosition` calls. The 27 cases covered `assertOpenGroup` and
`assertCloseGroup`, neither of which production uses, and every group in them
was a hand-written object literal. So every Phase 3 take-profit fix shipped
untested — the B1 lesson wearing a different mask, recorded in that file's own
header.

Fixed in Phase 7: `perpsGroupReal.test.ts`, 28 cases over **real `@pdex/sdk`
0.6.3 groups captured from MainNet** and committed as a fixture.

### High

- **H-1 — the take-profit was validated against the wrong reference.**
  `takeProfitBounds` floored a long at `entry + 1`. PEX measures crossing
  against the signed oracle's **index band**, and with favourable impact a
  long's entry sits *below* `indexMin`. Reproduced live: entry
  `$0.115649238181`, `indexMin` `$0.115861449825`, and the old bound quotes
  `crossed: true`. A crossed take-profit executes on arrival, so the position
  opens and closes in one group — about **$1.58 on $50 at 9.27x, and no
  position**, under a card reading "Closes for $0.87 profit before costs".
  `CROSS_MARGIN_BPS` existed with exactly one reference in the tree: its own
  definition, and SPEC Invariant 12 was unimplemented.
- **H-2 — the assertion never read `t.type`.** Not once in 852 lines. Every
  check finds its leg by looking for a sub-object, so a transaction with none of
  them was invisible to all of them. An injected `acfg` reassigning
  `manager`/`clawback` on an ASA the user administers passed clean.
- **H-3 — `readPosition` failed open.** A bare `catch { return null }` meant a
  5xx, a timeout or a `decodePosition` throw all read as "no position". The
  whole one-position decision rests on that read, and a transient failure let
  the open proceed as a PEX *increase*, re-opening B3 and B5 together.

### Medium and Low

M-1 the assertion compared prices against values `openPosition` computed itself,
not against the screen, so Invariant 9 was not met for any price field · M-2 a
short's take-profit floor was `1n` · M-3 the oracle payload was ~12 s old at the
wallet prompt against a ~30 s window · M-4 `DisplayedTakeProfit.acceptablePrice12`
declared and never read · M-5 fees taken unpinned from `getTransactionParams`, so
a congested-network suggestion would build an **8.4 ALGO** group and the
assertion would hard-refuse every open · L-1 Math carriers counted but never
inspected · L-2 `onComplete`, `note` and the validity window unbound · L-3 an
amount edit discarded a deliberately-chosen take-profit · L-4 `"1e5"` → `"15"`,
the same family as the fixed `"-5"` · L-5 an oracle staleness check that could
never fire · L-7 no re-entrancy guard.

## What audit 3's remediation changed

**Phase 6 — the three High findings.** Take-profit bounds now derive from the
index band plus `CROSS_MARGIN_BPS`, and `openPosition` additionally asks PEX
itself via `quoteV2DecreaseOrder` and refuses on `crossed` — the card's bounds
are our arithmetic against a snapshot, this is the exchange's own answer
immediately before signing. `checkTxnShape` binds transaction types and exact
`axfer`/`pay` counts. `readPosition` fails closed.

**Phase 7 — test what production calls** (above).

**Phase 8 — M-1 through M-5.** `displayed` is now a **required** input to
`openPosition` and the fresh quote is refused if it has drifted past
`MAX_DISPLAY_DRIFT_BPS`; an optional field here would have been the fourth
documented control with no caller. The oracle is fetched **last**, after the
preflight, balance checks, one-position guard and order-id allocation — none of
which need a price — and the wallet prompt is refused outright if under
`MIN_SIGNING_BUDGET_SEC` of validity remains. Fees are pinned to `minFee` with
`flatFee`, so `MAX_GROUP_FEE_MICRO_ALGO` is a tripwire rather than the thing
deciding whether trading works.

**Phase 9 — the Lows.** Math carriers are asserted to be bare noops; `onComplete`,
notes and the validity window are bound; an amount edit no longer discards the
user's take-profit; `mustRefuseInput` refuses any input whose cleaning would
*change the number* (a minus sign or scientific notation) while still accepting
formatting that does not (`$1,000`); the unreachable staleness check is gone;
and a re-entrancy guard replaces relying on an `o2:` box collision to stop a
double click.

### Three bugs the fixes themselves introduced, caught before shipping

Worth recording, because in each case the thing that caught it was testing
against reality rather than against my model of it:

1. **The crossing check would have blocked 100% of trades.** `ok` is false on
   every pre-open `quoteV2DecreaseOrder` call, with the single reason
   `position_missing` — we are quoting a decrease against a position that does
   not exist yet. An earlier draft of the docstring said to block on `ok`.
   `blocking` now encodes the real rule.
2. **The typo guard accepted precisely the most likely typo.** A slipped decimal
   is exactly a factor of ten and `MAX_TAKE_PROFIT_MULTIPLE` is ten, so an
   inclusive bound accepted `$8,429` for `$84,290` exactly on the boundary. The
   typo edge is now exclusive.
3. **Banning notes and Math foreign-apps would also have blocked every trade.**
   Real groups carry `pdex-v2-linked-escrow-<id>` and
   `pdex-v2-linked-storage-<id>` notes, and Math carriers reference one or two
   foreign apps to buy opcode budget. Notes are now *bound* to those markers and
   pinned to the bracket's own child order id; foreign apps on carriers are
   deliberately not checked, while accounts and assets — the fields that could
   move value — are.

**Still open after audit 3:** B6 and the `doi:` format, both questions for
Ultrade. H-1's chain-side behaviour and the one-position guard under true
concurrency remain unverifiable while B6 blocks simulating any open+TP group.

---

## Audit 4 (2026-09-26)

Briefed to falsify audit 3's remediations and to hunt specifically for fixes
that are **too strict** as well as too loose. It found no way to make the group
carry a different number from the one the screen showed — the assertion layer
held under tamper runs against real decoded groups. The money moved to the
**input and display layers**, which three audits had treated as lower-stakes
than the group layer and which are in fact where the user's decision is formed.

### High

- **H1 — a decimal comma multiplied the stake by 100.** `mustRefuseInput` was
  `/-|[a-zA-Z]/`; a comma is neither, so it was stripped as punctuation.
  Measured: `"12,50"` → `1250`, `"1,5"` → `15`, `"0,05"` → `5`. On a phone,
  `inputMode="decimal"` renders a comma key in French, German, Spanish, Italian,
  Dutch and Brazilian locales — so a user typing $12.50 the only way their
  keyboard offers opens a **$1,250** position, with every figure on the card
  internally consistent with it. The Swiss apostrophe and the Arabic decimal
  separator failed identically.

  **This was the third instance of one defect**, after `"-5"` → `"5"` (Phase 5)
  and `"1e5"` → `"15"` (Phase 9). Both earlier fixes extended a blocklist. That
  approach was always going to keep losing, and this is what losing looks like.

- **H2 — the card printed a take-profit bound and then refused that exact
  number.** `fmtPrice` rounds to whole dollars above $1,000; `tpValid` compared
  against the unrounded bound. **5 of 8 measured edges were refused.** On a BTC
  long the crossing floor is never an integer, so it was unreachable
  essentially always — and take-profit is mandatory, so that is a dead end
  rather than an inconvenience. This is the "too strict" class, in the crossing
  guard added in Phase 6.

### Medium and Low

M1 `liquidationDirection` was decoded and **never read anywhere**, so with
notional ≤ collateral the permanent red box printed "Liquidation **$0.000000** ·
total loss of $1,000.00"; both markets are OI-capped far below $1,000, so anyone
with that much collateral saw it at every slider position · M2 the mandatory
take-profit was left **blank** (or silently stale) wherever +50%-of-stake
exceeded what a short can pay, which on a $1,000 ALGO short was every slider
position · M3 the debounced amount let the field lead every other figure, the
one place a screen number and a signed number were allowed to disagree · M4 the
drift guard covered two prices out of the four the user decides on, and its
entry bound would false-positive on ALGO's flat 55 bps impact step · L1 a
well-formed linked note passed on any leg · L2 accounts / foreign apps / foreign
assets unbound on the two calls that move money · L3 `lease` and `genesisHash`
never read · L4 the Math ceiling was tighter than a count we do not control ·
L5 the preflight cache policy was decided by string-matching user-facing copy ·
L6 `isNotFound` cannot distinguish "no box" from "no app" · L7 comment/config
drift on the oracle window.

## What audit 4's remediation changed

**Phase 10 — the two High findings.** `perpsInput.ts` is now a **whitelist**
stated positively: *strip only what cannot change the number, refuse everything
else*. Currency symbols and whitespace are decoration and are stripped; a comma
is not, and is refused rather than guessed at, because `1,000` is one thousand
in en-US and one in de-DE and nothing in a keystroke resolves that. Refusals are
now **visible**, with a hint — a silent no-op leaves a user on a comma keypad
pressing their only decimal key and watching nothing happen. Multiple decimal
points are refused rather than collapsed, which was itself silently changing the
number.

For H2, `displayTakeProfitBounds` rounds each edge **outward** to the precision
it is printed at, and the card both displays and validates against that, so the
number on screen is by construction acceptable. The write path keeps the true
bounds, which are looser, so nothing the card accepts is refused there. The
precision rule and the formatter moved into `perpsQuote.ts` beside the bounds:
the card owning its own copy is precisely how the two drifted apart.

**Phase 11 — the Mediums.** The liquidation box is gated on
`liquidationDirection` and says plainly when a position cannot be liquidated.
The take-profit default falls back to a fixed move from entry, clamped into the
displayed bounds, so the mandatory field is never empty and never holds a target
solved for a different size. `tradable` now requires `amount === settledAmount`,
closing the debounce window before the button exists rather than after. The
drift guard gained the liquidation price, separate tolerances
(`MAX_ENTRY_DRIFT_BPS` sits above ALGO's 55 bps impact step so a pure impact
flip is not reported as "the price moved"), and `asRendered`-prefixed field
names so a future caller cannot quietly make the check circular again.

**Phase 12 — the Lows.** Notes are permitted only on the escrow and MBR legs and
pinned to this bracket's child order id; the collateral leg must carry none.
Accounts, foreign apps and foreign assets are bounded on every app call. `lease`
and `genesisHash` are read. The preflight caches on a `kind` discriminant rather
than on the wording of a sentence. `isNotFound`'s blind spot is documented
rather than papered over. And the capture script now mirrors production's fee
pinning — the fixture's whole purpose is to be a faithful capture, and an
"identical today" difference is still a difference.

**The test that would have caught H2 on day one** now exists: bound → printed →
retyped → validated, through the real formatter rather than a reimplementation
of it.

**Still open after audit 4:** B6 and the `doi:` format, both for Ultrade. H-1's
chain-side defence and the one-position guard under true concurrency remain
unverifiable while B6 blocks simulating any open+TP group. Whether
`MAX_DISPLAY_DRIFT_BPS` is non-circular cannot be confirmed until the button is
wired and there is a caller to inspect.

---

## The close path, and three gaps it exposed (2026-09-27)

Done while B6 was with Ultrade, because it is the one substantial piece of work
that does **not** depend on their answer — B6 could change the open+take-profit
group's shape, so further work on that path carries rework risk, while the close
path is a different flow entirely.

`assertCloseGroup` had **no real-bytes coverage**: it was exercised only by
hand-built object literals. That is the same weakness the open path had before
`__fixtures__` existed, and the same shape as the B1 escape. Real
`buildV2DecreaseOrCloseTransactions` output is now captured for both markets and
both sides — **3 transactions, all `appl`** (Trading with 16 args plus two Math
carriers), 40,000 µALGO — and `perpsCloseReal.test.ts` tampers it 14 ways.

Writing those tests found **three real gaps, all from one cause**: the Phase 12
per-transaction hardening went into `assertOpenGroup`'s loop, and
`assertCloseGroup` had its own duplicated copy that never received it. On a
close, a smuggled note, a lease, and an attacker address appended to the Trading
call's `accounts` all passed clean.

The fix is not three checks — it is `checkEveryTransaction`, one function both
paths call. Duplicating that loop is what made hardening one path silently miss
the other, and it would have happened again.

### `mf2:` and the close preview

`readMarketFunding` reads `market_funding_borrowing` — 15 uniform uint64s, 120
bytes, prefix `mf2:`, owned by Markets — **from the manifest's declared format**,
not by observation. (Worth noting by contrast: the manifest declares eighteen box
formats and `doi:` is not among them, which is the standing finding.)

Confirmed on a live $5.50 ALGO position why this was the blocker: **without
`mf2:` `quoteV2DecreasePosition` throws `funding factor regression`; with it the
quote returns `ok: true`.** It is deliberately not part of `readMarketState` — an
open never needs it, and a sixth box read in the ten-second refresh would cost
every user a round trip for a number only the close preview consumes.

`quoteClose` then needed the **same execution anchoring as `quoteOpen`**, for the
same reason B2 taught: measured on a live position, an index-anchored close quote
returns `ok: false` where the execution-anchored one returns `ok: true`. Verified
across five live positions, full and half closes, with payouts and PnL in both
directions.

**What is still missing before a user can close:** the management UI itself
(listing positions, choosing a size), and the close write path. The reads, the
quote and the assertion are all in place and tested.

---

## B6 resolved — and it was my assumption, not PEX (2026-09-27)

**Ultrade's answer: set the attached leg's `timeInForce` to
`TIME_IN_FORCE.GTC`, which is `1`. We were sending `0`.**

`TIME_IN_FORCE.GTC === 1` was in the pinned SDK's own constants the whole time.
I assumed `0` meant GTC and wrote that assumption into a comment as though it
were established — *"GTC. The SDK default is right; an override is not otherwise
caught."* — and then wrote an assertion that **enforced** `0`. So our own safety
check agreed with the bug and could never have surfaced it.

That one value is what the entire B6 investigation was chasing. It cost the
elimination of the builder fee, the keeper fee, the baseOrderId, three storage
payment amounts, the trader box, position existence, and both markets and sides,
plus an exec trace and a message to Ultrade. Every one of those eliminations was
correct and none of them could find it, because the cause was in the one place
nobody was looking: a constant I had already decided I knew.

Ultrade are shipping an SDK update that refuses bad values outright, and a
manifest update that finally declares `doi:`.

**Verified by simulation on MainNet**, same group, same funded sender, only the
value changed:

```
timeInForce = 0        -> assert failed pc=8175   (the original B6)
timeInForce = GTC (1)  -> assert failed pc=6359   (a DIFFERENT, later assert)
```

### What is still failing: `pc=6359`

The take-profit leg now gets past B6's assert and fails at a later one. From the
exec trace on the OrderOps call:

```
pc=6355  extract_uint64(<record>, 37)  -> 3690309160   (PDexV2Trading)
pc=6356  global CurrentApplicationID   -> 3690309166   (PDexV2OrderOps)
pc=6358  ==
pc=6359  assert -> fail
```

OrderOps asserts that an app id held at offset 37 of a record equals **its own**
app id, and the record carries **Trading's**. The record begins `0x50445832`
("PDX2"). `targetKind` is `PAIR (1)`, which is correct for a two-token market, so
that is not the cause.

This may well be what Ultrade's SDK update fixes — the group is built entirely by
`buildV2MarketOpenWithAttachedOrdersTransactions` from the pinned 0.6.3. **We
cannot check: `@pdex/sdk` is not on public npm** (it is vendored here as a
tarball), so the update has to come from them.

### `pc=6359` — the second half, and it was also ours

Found in `INTEGRATION_GUIDE.md`, new in SDK **0.6.4**:

> "For a pair-market entry, obtain **two separately targeted published oracle
> payloads**. The entry uses Trading; each child uses OrderOps. Never reuse the
> Trading payload for an OrderOps call."

A signed oracle message binds the app it may be presented to, and `targetAppId`
sits at **offset 37** — `magic(4) + version(1) + genesisHash(32)`, which is
exactly `HEADER_LEN` in `perpsOracle` and exactly the offset OrderOps reads at
`pc=6355`. We passed the Trading payload to the child, so OrderOps compared its
own application id against Trading's and refused.

The oracle bundle publishes an OrderOps-targeted payload for both markets, and
always has. We simply never asked for it.

**And our assertion was enforcing this too.** It compared the child leg's oracle
bytes against `shownOpen.oracleMessage` — the entry's payload — so a correct
group would have *failed* our check. That is the second of two controls that were
holding B6 in place rather than catching it.

Fixed: `openPosition` fetches both payloads in one `Promise.all` and the signing
budget is measured against whichever is older. The assertion now compares the
child against `shownTp.oracleMessage` **and** reads `targetAppId` from the signed
bytes to require OrderOps for the child and Trading for the entry — byte-equality
with what the client fetched only proves the group matches the client, and cannot
notice the client fetching the wrong payload, which is the mistake that happened.

### Verified end to end (2026-09-27)

Through the production build path, against MainNet, with a funded sender:

```
crossing check : blocking=false
assertion      : ok=true, 29 checks, 0 findings
simulation     : ok=true
```

**B6 is resolved and the trade button is no longer blocked.**

> **CORRECTION, 2026-09-27 (audit 5).** This run used a sender that is one of
> only **nineteen** accounts on MainNet holding a `t2:` trader box. It is
> evidence the path works **for an existing trader**; it is not evidence the
> button works for a new user — it did not. See F1 below.

### What 0.6.4 actually contains

Validation and documentation only — `assertV2OrderTimeInForce` plus the
integration guide. It changes no construction, so it would not have fixed
`pc=6359`; what fixed that was the guide. It *would* have turned B6 into an
immediate `RangeError` instead of a chain-level assert, which is worth having.

Also worth recording: `V2AttachedOrderLegInput.timeInForce` is documented as
*"defaults to childTimeInForce, then GTC"*. **Omitting it would have been
correct.** Passing `0` explicitly is what overrode a sensible default — the bug
came from being specific about something I had not checked.

Upgrading to 0.6.4 is deliberately a separate change: `PEX_SDK_VERSION`, the
vendored tarball, its SHA-256 and the solver re-verification all move together
(see `web/vendor/README.md`).

---

## `doi:` — the finding was half right (2026-09-27)

Ultrade said the `doi:` format went out in the latest SDK release. **I could not
verify that, and the evidence says it did not** — but chasing it found something
better, and the standing finding was partly my error.

### What I checked

| Check | Result |
|---|---|
| Newer release than 0.6.4? | No — remote HEAD is still `f54ebe3` |
| 0.6.4's source diff | `src/transactions.ts` only, 15 added lines |
| Does the SDK ship the protocol manifest? | **No.** `manifest.ts` only *loads* one, from `{baseUrl}/v2/protocol` on a builder backend |
| Is the manifest on the public CDN? | No — seven plausible paths under `pub-…r2.dev`, all 404. That bucket serves oracle payloads and latest prices only |

So the manifest is served by an API we do not have a URL for, and no manifest
ships with the SDK at all. Our vendored `pexProtocolManifest.json` still declares
eighteen box formats with no `dynamic_oi` among them.

### What it found instead

**`doi:` has been authoritatively declared all along — in SDK source, not in the
manifest.** `V2_DYNAMIC_OI_MARGIN_CONFIG_FIELDS` in `src/v2Risk.ts` lists exactly
our four fields in exactly our order, with
`V2_DYNAMIC_OI_MARGIN_CONFIG_SIZE = 32` (4 x uint64). It is unchanged since at
least 0.6.3, so it was available while three audits recorded the layout as
"pinned against nothing".

That framing was wrong. The manifest does not declare it; the SDK does. We were
inferring a layout that was published, and nobody looked in the second place.

`DYNAMIC_OI_FIELDS` is now the SDK's own constant rather than a copy of it, with
a module-load assertion that the field count still matches the declared byte
size. Verified live afterwards: both markets decode `version=1`, `flags=1`
(enabled), `k=1.0` on ALGO and `0.641026` on BTC — the values already documented.

### Resolved the same day: the manifest is published, and declares `doi:`

Ultrade published the protocol manifest to the public artifact bucket and
shipped **SDK 0.6.5** ("verified R2 protocol loading") to read it from there,
falling back to their backend. Content-addressed and hash-verified:

```
pointer   {base}/v2/protocol/mainnet/current.json   -> artifact_hash, artifact_path
artifact  {base}/v2/protocol/mainnet/<hash>.json
```

Fetched, and the artifact's SHA-256 matches its pointer. Compared against our
vendored copy:

- **+1 box format: `dynamic_oi_margin_config`** — prefix `646f693a` (`doi:`),
  `owner_app: PDexV2TradingRiskOps`, `value_size: 32`, four uint64s in our exact
  order. The field names differ from the SDK's (`version` vs
  `dynamic_oi_margin_version`) but the shape is identical.
- **`receipts` gained `enums` and `field_enums`** — additive metadata only. Same
  fields, same count, same order on all four order receipt types; no byte-layout
  change.
- Everything else byte-identical: apps, oracle, conformance, market types,
  `mbr_formula`, and all eighteen pre-existing box formats.

Adopted. Both pins updated to
`3bbce88472676525d208094ee8157a175b75f451d6c70781956be97c837a3b8f` — and they
are now **the same value**, because the published artifact is already serialised
canonically, so `JSON.stringify(JSON.parse(raw))` round-trips byte-for-byte.
Both constants stay: they check different things and a future reformat would
separate them again.

`doi:` is now cross-checked at module load against **three independent sources**
— the SDK's constants, the manifest's declared format (size, field count, field
widths, prefix and owner app), and the live box. The finding is closed.

Verified after adopting: manifest gate passes, program pins show no drift, `doi:`
and `mf2:` decode correctly on both markets, and an open+take-profit group still
asserts 29 checks with zero findings and simulates `ok=true`.

---

## The trade button is wired (2026-09-27)

`PerpsCard` now calls `openPosition` through `@txnlab/use-wallet`, the same
wallet stack the rest of the app uses.

**`displayed` is passed from the rendered memo, which is the point.** Audit 4
flagged that `MAX_DISPLAY_DRIFT_BPS` could not be verified as non-circular
because no caller existed. It exists now, and wiring it caught a real mismatch:
the card renders the index from `data.oracle.indexPrice12` (the mid of the
signed band) while the first draft passed `quote.indexPrice12` (the SDK's
`index_price` echoed back). Usually equal — but "usually" is not what
`asRendered` promises, and passing the quote's copy would have compared the
fresh oracle against a number the user never saw. Exactly the circularity the
field name exists to prevent.

**Verified live**: with a signer that throws if reached, a displayed index 5%
stale is refused before the wallet prompt; honest values pass through to the
signer.

Other things the live button required:

- **Every input locks while a signature is in flight** — market, side, amount,
  slider and take-profit. Without it the card underneath a wallet prompt is
  still editable.
- **A result belongs to the trade that produced it.** Changing any input clears
  it. `submitting` is deliberately *not* a dependency of that effect: it flips
  false immediately after `setResult`, so including it made the effect fire and
  wipe the result the user was waiting to see. Caught before shipping.
- **An unobserved confirmation is reported as unknown, never as failure** —
  amber, not red, with the txid and an explicit warning that opening again would
  add to the position. That false-failure-then-retry is what B5 was.
- The hero badge now reads "Live on MainNet" rather than "trading soon".

---

## Audit 5 (2026-09-27) — the wired submit path

The first audit run after the trade button existed. It found that the path had
only ever been verified using an account that could not represent a user.

### F1 — critical: every first-time trader was blocked

Trading asserts the caller's `t2:` box exists (`box_len; bury 1; assert`), and
our group never created it. **Nineteen accounts on all of PEX MainNet hold that
box.** Everyone else hit `pc=2907` and saw a raw TEAL assert — which reads as a
security incident and offered no remedy. No funds were at risk, because
`simulateGroup` catches it before the wallet prompt; the button simply did not
work for its actual audience.

Measured ladder:

| `storagePaymentMicroAlgo` | result |
|---|---|
| omitted | `pc=2907` — no `t2:` box |
| 29,300 | `pc=3180` — escrow below 70,900 |
| **100,200** | **`ok=true`** |

`t2:` decodes as `[storage_available, storage_locked, open_positions,
open_orders]`; a live trader reads `[300200, 100200, 1, 0]` — a persistent,
reusable escrow, locked on open and returned on close. So the payment is made
only when it is short, which keeps the audited nine-transaction group for anyone
already funded rather than accumulating idle ALGO every trade.

Teaching the assertion the eleven-transaction shape exposed two more checks that
had silently assumed the nine-transaction layout: `main_call_count` treated "the
only Trading call" as the open, and `entryGroupOffset` measured from whichever
Trading call came first, which is off by two once `fund_storage` leads.

### F2, F3, F4 — the submit path told the user things that were not true

- **F3.** `waitForConfirmation` throws for *two* different outcomes:
  `Transaction Rejected: <poolError>` and `not confirmed after N rounds`. Both
  collapsed into `confirmed: false`, so a user whose group had been **rejected**
  was told "this is not a failure, it will most likely confirm, do not open
  again" — every clause false, and it steers them away from the correct action.
  B5 inverted, and worse: B5 understated a success, this overstated a failure.
  Three outcomes now, rendered red / amber / green.
- **F4.** A dropped socket after the node accepted the group rejected out of
  `sendRawTransaction`, discarding the txid. The id is a property of the signed
  bytes, so it is computed before submission and carried into the error.
- **F2.** The take-profit auto-default had no `submitting` guard, so it fired on
  every ten-second refresh: the number on screen drifted while the wallet prompt
  was open and the group carried the click-time value. And because `tpPrice` was
  a dependency of the result-clearing effect, **the success banner and its txid
  deleted themselves within about ten seconds**, taking the "do not open again"
  warning with them and re-arming the button.

### F5, F6, F8, F9

`netCollateralUsd` — the "Backing the position" row — is now in the drift guard
with its own 50 bps tolerance, because PEX's fee rates are admin-mutable and a
change costing 5% of a small stake moves the liquidation price by less than its
own 150 bps tolerance · a **zero liquidation price is a sentinel, not a value**,
and feeding it to `drift` hit the zero-denominator branch and disabled the check
on 27% of slider positions; a screen that said "None" now requires the fresh
probe to agree · the "what leaves your wallet" line no longer omits the ALGO ·
the `doi:` cross-check returns a problem instead of throwing at module scope, so
a layout disagreement stops trading through the preflight rather than
white-screening the page.

Verified live after the fixes: honest values reach the signer; a 1%
`netCollateral` drift and a zero-sentinel liquidation price are both refused.
A box-less sender now passes assert and simulation through production
`openPosition`; an existing trader computes `pay=0` and does too.

### Still open from audit 5

**F7** — `quoteClose`'s `fundingFeeUsd` and `borrowingFeeUsd` do not scale with
the close fraction, while `payoutUsd` and `pnlUsd` halve exactly. Observed
across all 11 live positions, full and half. Whether that is correct PEX
semantics (position-level accrual settled in full) or an unscaled SDK field is
**unresolved, and must be answered before the management UI renders a cost
breakdown for a partial close.** A question for Ultrade.

---

## Audit 6 (2026-09-27) — the account matrix

Briefed to enumerate the states a real user can be in, because audit 5's F1
existed only because every prior audit had tested one or two accounts. It found
the same defect class again, in a different costume.

### F1 — high: every rekeyed account was blocked, 100% of the time

`simulateGroup` built an empty signature without `fixSigners`, so algod resolved
the authorizing address to the **sender** rather than the **auth address**:
*"should have been authorized by X but was actually authorized by Y"*. The group
was correct and a real wallet would have signed it correctly — **only our
pre-flight refused it**, and the error named PEX for a defect that was ours.

Rekeying is routine on Algorand: Pera and Defly vaults, multisig, hardware
rekeys, contract-controlled accounts. Confirmed on a live rekeyed PEX trader:
without `fixSigners`, refused; with it, `ok`, same group. Setting `authAddr` on
the `SignedTransaction` instead does **not** work.

This is audit 5's F1 in a different costume — a path recorded as verified end to
end, verified with senders that happened not to be rekeyed.

### F5 — we over-charged for the storage escrow, in exactly the repeat-user state

The chain asserts `storage_available >= V2_POSITION_BOX_MBR_MICRO_ALGO`
(**70,900**). The 100,200 constant is 70,900 plus the 29,300 consumed creating
the `t2:` box, so it is right only for a *first* trade. Measured by ladder:
99,700 fails at `pc=3180`, 100,200 passes. Across **all nineteen** live `t2:`
boxes, `locked = 29,300 + 70,900 × open_position_count` holds exactly, zero
mismatches.

Close your only position and `available` returns to 70,900 — enough to open
again — yet we asked for another 0.1002 ALGO into an escrow the UI cannot
withdraw from. **Nine of the nineteen live traders sit in that state today**,
which is precisely what `storagePaymentNeeded`'s own docstring claimed to
prevent.

### F2, F3, F4 and the rest

- **F3.** The storage payment was the only value-moving leg with **no anchor
  outside the caller**, so a tamper moving the group and the displayed value
  together passed. Now pinned to the SDK's constants.
- **F2.** Audit 5 froze the take-profit while signing — and not the other
  fourteen money figures, all memos over `data`. During a 20-40 second prompt
  the position size, liquidation price and cost table kept repainting while the
  group carried click-time values, and vanished entirely if `bar.open` flipped.
  The drift guard is structurally blind to this: it compares the fresh probe
  against the click-time `displayed` values, never against what the screen shows
  now. The whole view is snapshotted at click.
- **F4.** *"A small amount of ALGO… returned when you close"* was false twice: a
  first trade moves **252,900 µALGO**, and closing moves the escrow from locked
  to available **inside PEX**, not to the wallet. `withdraw_storage_credit` and
  `close_storage_account` are both in the pinned manifest; we offer neither.
- **F6** the ALGO minimum was a flat figure checked before the read that decides
  it · **F7** the result banner survived a wallet account switch · **F9** two
  more controls with no callers, `notionalAtBarPosition` (reimplemented in the
  card without its clamp) and `minimumCollateralUsd` · **F10** every oracle
  budget argument reasoned from a "~30 second cadence"; measured over 86
  samples, PEX publishes every **2-3 seconds** — 30 s is the validity window.
  The guards are correctly sized, but the number anyone would next tune them
  from was wrong by an order of magnitude.

### The account matrix, verified

Every row driven through production `openPosition` with a throwing signer:
never traded · funded trader · box exists but escrow spent · escrow exactly at
the threshold · position open on the same market+side (refused, accurately) ·
on a different one (proceeds) · not opted in to USDC · insufficient USDC. **No
raw TEAL assert reached a user in any constructible state.**

Not verifiable: insufficient spendable ALGO (every such account fails the USDC
check first, which runs earlier) and stale `o2:` boxes (OrderOps holds zero
boxes exchange-wide, so no account on MainNet is in that state).

### Still open

**No group in this codebase has ever been signed by a real wallet.** Every run,
across six audits, used a throwing signer. That is the one remaining link with
no execution behind it — and given F1, the first real signature is worth taking
on a rekeyed account specifically.

> **Superseded 2026-10-04** — all four write paths are now signed. Left in place
> because it is audit 7's record, not a current status. The current status is at
> the top of [SPEC.md](./SPEC.md).

**F7 from audit 5** — `quoteClose`'s funding and borrowing fees do not scale
with a partial close while payout and PnL do. Still a question for Ultrade,
still blocking a partial-close cost breakdown.

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

## The close payout was wrong in both directions (2026-09-28)

Found by asking Ultrade a question, not by auditing. Worth recording because the
lesson is about method: this code had survived six audits, and no audit caught it
because every audit checked the arithmetic we had written rather than whether we
were reading the right field.

**What we did:** read `collateral_delta` from `quoteV2CloseLike` and showed it as
the payout.

**What Ultrade said (2026-09-28):** *"Don't use `collateral_delta`. Aggregate
`primary_output_amount`, `pnl_output_amount` and the claimable token outputs by
asset ID."*

**Why one number could never have been right.** A close is not a single-asset
payout. On ALGO/USD a long gets its collateral back in **USDC** and its profit in
**ALGO**. One dollar figure did not just misstate the total — it hid an entire
leg. Measured against live MainNet positions:

| Position | Actually receives | We showed | Error |
|---|---|---|---|
| `DGJOWLTV…` | 15.88 ALGO + 5.57 USDC = $7.64 | $5.58 | understated 37.1% |
| `J65HYZUN…` | 13.79 ALGO + 5.19 USDC = $6.99 | $5.19 | understated 34.5% |
| `KANJIGXR…` | 45.40 USDC = $45.40 | $51.82 | **overstated 12.4%** |

Wrong in **both** directions, which matters: an understatement is a bad
experience, an overstatement is a number a user makes a decision on that the
chain will not honour.

**Fixed:** `quoteClose` aggregates outputs by asset; the panel lists them
per-asset ("You receive 15.88 ALGO + 5.57 USDC") rather than collapsing two
assets into one figure. `payoutUsd` is now **nullable** — USDC values 1:1 and the
market's index asset is priced by the signed oracle, and an output in anything
else withholds the total rather than guessing, while still showing the
per-asset amounts.

Per Ultrade, the funding/borrowing breakdown is **not** subtracted again: those
costs are already settled into collateral before the proportional withdrawal is
computed, which is also why they do not scale with the close fraction.

**SDK 0.6.4 → 0.6.6** in the same change. Its only quote change is one line in
`quoteV2CloseLike`: `forcedAccruedCostUsd` is now always charged to `costUsd`,
where it was previously charged only on liquidation and ADL. On a deficit close —
accrued costs exceeding position collateral — older quotes **overstated** the
payout. Solver re-verified on 0.6.6 as `vendor/README` requires: 240 randomised
cases, 2 overstatements, both at the $5 floor and both corrected by
`confirmCeiling` — the same documented imprecision as the 0.6.4 run. 0.6.6 does
not touch the open path.

**Method note.** Two of the three defects in this section came from asking the
protocol author a direct question. Neither was reachable by reading our own code
more carefully, because our code was internally consistent and wrong at the
boundary. Where a field's meaning is the protocol's to define, ask; do not audit
harder.

---

## Unaudited surface (2026-09-28) — scope for audit 7

Everything below landed **after** audit 6 and has had no adversarial review. It
is recorded here so the next audit has a list rather than a diff to rediscover.

**On the money path — audit these first.**

1. **Take-profit quick-picks** (`PerpsCard`, `TP_TARGETS = [0.1, 0.25, 0.5]`).
   These compute a take-profit **trigger price from a target profit percentage**,
   and that price is **signed**. The default stake was also removed, so the
   amount field now starts empty. Arithmetic here reaches the chain.
2. **The overlay contract** (`PerpsCard` → `PerpsView` → `PerpsChart`). The card
   reports entry, liquidation, take-profit and stop as `CardOverlay`; the chart
   draws them. Deliberately one-directional — the chart derives nothing — because
   two components computing a liquidation price separately is how they come to
   disagree. Verify the direction has not been reversed anywhere, and that a
   stale overlay cannot outlive the quote it came from.
3. **The `frozen` snapshot** during signing. What the user is agreeing to while
   the wallet is open must not be re-derived from live state underneath them.
4. **`PositionsPanel`'s per-asset payout rendering** — new code on the numbers
   the section above corrects.

**Presentational, but with a safety property.**

5. **The chart** (`PerpsChart`, `perpsChart.ts`, `PerpsChartPanel`). Candles come
   from **Coinbase**; the advanced view is a **TradingView** embed. Neither is
   the feed PEX prices against. The guard is that the basic chart draws PEX's
   oracle as a dashed violet line from the *same signed payload the card quotes
   from*, and the caption states plainly that neither chart is the price you
   trade at. **The advanced view cannot carry that overlay** — it is a
   third-party iframe with no runtime API — so in that view the order card is the
   only place the oracle price appears. Check the caption still says so.
   Interaction state (zoom, 2D pan, axis drags) is local to the chart and touches
   no quote.
6. **The single card.** Chart, order form and positions are one `Panel` divided
   by `Seam`s; each section draws the seam above itself so the positions list
   takes its rule with it when no wallet is connected. Sections render no border
   or background of their own.
7. **`PerpsInfoModal`** — the risk disclosure moved here from inline explainers.
   Confirm nothing load-bearing was lost in the move: this is now the only place
   some of it is stated.

**Known-absent, not a finding.** There is no close **write** path, by design —
see the yield-recall question below. `PositionsPanel` says so in the UI rather
than showing a button it cannot honour.

---

## The keeper runs — and orders execute on MainNet (2026-09-28)

**This falsifies a claim repeated through six audits.** The B6 write-up said
*"we've never observed `v2_order_executed` on MainNet"*, and the SPEC treated
keeper execution as unproven. It was true when written and is not true now.

Measured on MainNet, 2026-09-28:

- `execute_order` on `PDexV2OrderOps` (3690309166) has been called **376 times
  this month** by a single keeper, `PVAOUWLBP5…`, most recently at 12:00 UTC —
  eight hours before our own first trade.
- Those are **real executions, not orphan cleanups**, which was the specific
  alternative the B6 note left open. The inner transactions of two sampled
  calls show collateral moving into the PEX escrow (12.22 and 25.04 USDC, to
  the same address our own collateral went to), a **100,200 µALGO storage
  payment creating a fresh position box**, and the keeper taking ~0.051 USDC.
  Collateral in plus a new position box is an OPEN, not a close.
- Two other traders have used `submit_order` — the standalone limit-entry path
  — 16 times.

**Why it matters beyond limit orders.** Our product attaches a take-profit and
tells the user it closes their position automatically. That claim rested on
keeper infrastructure nobody had observed working. It works.

**Four orders rest on chain today**, and all four decode against the manifest's
`order_state` layout exactly: two standalone limit entries (short, $90 and
$200, triggers $0.14 and $0.13369), one bracket child, and our own take-profit
— whose `position_id` (75), `size_usd_delta` ($88.479362), `trigger_price`
($0.14) and `builder_fee_bps` (10) reconcile with the `p2:` box and the
submitted group.

Two incidental observations:

- **Our keeper fee is roughly double everyone else's.** We escrow $0.10; the
  other builder escrows $0.051, and the keeper actually collected ~0.051 on the
  executions sampled. Worth revisiting — it is the user's money, held.
- The other builder's address (`74V3IRMV…`) takes **3 bps** where we take 10.

## `PositionState` needed the owner, and the failure was silent (2026-09-28)

Found while building the order reader, and it is a display-a-false-alarm bug
rather than a blank field.

`analyzeV2OrderLifecycle` matches an order to its position through
`v2PositionKeyFromPosition`, which builds `owner:marketId:collateralAssetId:side`
and reads `owner` **off the position object**. The owner is in the `p2:` box
KEY, not its value, so `decodePosition` never set it. A position without it keys
as `"undefined:1:31566704:1"`, matches nothing, and the order comes back
`position_missing` with `cleanupReason: "position_missing"`.

SPEC.md requires `position_missing` be shown as **"Orphaned — funds still
locked"** and never as resolved. So the consequence of a missing field was
telling a user their only exit was dead while it was armed and fine — observed
exactly that way against our own live healthy position before the cause was
found. `decodePosition` now takes the owner and `PositionState` carries it.

---

## The full lifecycle has run on MainNet (2026-09-29)

Opened 2026-09-28 19:59 UTC, take-profit executed by a keeper 2026-09-29 05:02
UTC at round 65496626, unattended, at our own trigger. Both boxes — `p2:` and
`o2:` — are gone.

On a $6 stake the account received **40.393029 ALGO + 5.744601 USDC** (about
$11.38 at the trigger), plus 0.0997 ALGO of order-box MBR refunded on execution.
The keeper took the full $0.10 escrowed.

**This is the first end-to-end confirmation in the project's history**, and it
settles three things that were previously inference:

1. Keepers execute *our* orders, not merely orders in aggregate.
2. **The two-leg payout is real** — collateral back in USDC, profit paid in
   ALGO. Exactly the shape `collateral_delta` hid, now confirmed by settlement
   rather than by a quote. The 2026-09-28 fix was correct.
3. **The keeper fee is a cost, not float.** Refunded on cancel; kept by the
   keeper on execution. An earlier note in this session called it refundable
   float, which was wrong.

---

## The reserved stride, a third time — cancel (2026-10-04)

Found by a real cancel failing in production, not by an audit. Worth its own
entry because it is the same root cause as two earlier defects and nothing in
the codebase had generalised it.

A limit entry was placed with **no take-profit** and then could not be cancelled:

    invalid Box reference o2:…0000000000000002
    app=3690309166, pc=5306, opcodes=concat; dup; box_len

**`cancel_order` on a bracket parent probes BOTH reserved child slots**, and a
box reference must be *declared* even for a box that does not exist —
`box_len` on an undeclared key is that error rather than a zero. Our builder
always submits a limit entry as `BRACKET_PARENT`, so the slots are always
probed, whether or not a child was ever created.

The UI derived the children from the orders it could see, found none, and
declared none. Verified by simulation on the live order:

| declared | result |
|---|---|
| nothing | fails on slot 2 |
| slot 2 only | fails on slot 3 |
| slots 2 and 3 | **ok** |

**The rule is the STRIDE, never the observed children.** `ORDER_ID_STRIDE` is 3
and the contract touches all three slots.

### Why this is the third time, and what it should have taught

- The limit **submit** path needed `base + 1` and `base + 2` added by hand,
  because the SDK declares only the base order's box.
- `assertOpenLimitGroup` read three argument offsets wrongly and survived
  because of a value coincidence (audit 8, SB1).
- Now **cancel** needs the same two references for the same reason.

Each was found separately and fixed locally. The generalisation — *anything
touching a bracket parent must declare the whole stride* — existed in a comment
on the submit path and was not carried anywhere else. Both the submit patch and
the cancel fix now say so explicitly, and `perpsCancelAssert.test.ts` pins it.

A note on how it was caught: **this is the first defect in this product found by
a user action rather than by an audit or a simulation sweep.** Three audits and
dozens of simulated groups did not reach it, because every simulated cancel was
run against orders that already had children — the audit-8 review's own cancel
tests used the three live protection orders, all of which were children. The
case that failed needs a bracket parent with *no* child, which only exists after
someone places a targetless limit order. That shape became possible the day the
take-profit became optional.

---

## Audit 8 (2026-10-02) — and the offset that hid behind a coincidence

Two ship-blockers, four HIGH, three MEDIUM, five LOW. Both ship-blockers were on
the limit path. Full remediation and its own review in
[AUDIT-8-REMEDIATION.md](./AUDIT-8-REMEDIATION.md); fixed in `5f85472`.

### SB1 — three ABI offsets, masked by a four-way coincidence

`assertOpenLimitGroup` read `A[1]` as `orderKind`, `A[3]` as `marketId` and
`A[4]` as `ownerOrderId`. The SDK's real order is `ownerOrderId, orderKind,
targetKind, marketId`. `assertOpenWithTakeProfit` had it right all along.

**It passed everything anyone ran because `ORDER_KIND_OPEN_LIMIT`,
`ORDER_TARGET_PAIR`, ALGO/USD's `marketId` and a fresh account's `baseOrderId`
are all the literal `1`.** Four unrelated values that happen to be equal.

What it cost: BTC/USD limit orders were **impossible at any order id**, and every
account holding an `o2:` box was locked out on both markets — which is everyone
who had opened with a take-profit, since that creates a box at `base + 1`. They
saw *"Safety check failed, so nothing was sent"* on a correct group. And
`orderKind` was compared to nothing, while three other fields were compared to
the wrong things.

**The lesson is about the tamper table, not the offsets.** The four tampers run
when this shipped touched the escrow amount, the trigger (`A[9]`), a carrier
account and the MBR receiver. **Not one of the three broken indices.** The table
read as thorough and proved nothing. The replacement sweeps every entry-leg
argument position and asserts each one is bound — and a mutation test confirmed
it: deleting any one of the twelve per-index checks makes the sweep name exactly
that index.

A smaller note worth keeping: an explicit `orderKind` check was added as part of
the fix and then **removed**, because writing the test showed it could never
fire — the entry leg is *located* by that field. An unreachable check is worse
than none, because it reads as coverage.

### SB2 — a stale trigger survived a market switch

`[marketId]` reset the take-profit and not the limit trigger. A `$0.12` ALGO
trigger carried onto BTC/USD did not trip the crossing guard, because that guard
tests `trigger >= index` and `1.2e11 >= 8.46e16` is false. The card then quoted
against a payload rescaled to the stale trigger: entry `$0.120249`, liquidation
`$0.093459`, submit enabled, on a market at `$84,573`. A short tripped its own
test; a long did not.

### The four HIGH findings, in one line each

- **Fee caps:** the limit and cancel paths called `checkEveryTransaction` and
  **discarded its return value**, which is the group's total fee. MainNet
  accepted a 5.03 ALGO limit group and a 5 ALGO cancel on all three live orders.
- **An unasserted OrderOps call** rode inside a close and a bare open: a real
  close plus an injected `cancel_order` — cancelling that user's own take-profit
  — passed and simulated. On a partial close the position survives with its
  protection silently removed.
- **The storage payment was unasserted** on the bare-open path: **50 ALGO** into
  an escrow this UI cannot withdraw from, on a group presented as "open a $20
  position", assertion green and MainNet green. The check that catches it existed
  twelve hundred lines away on the other path.
- **The preflight lied.** It told the user *"Existing positions can still be
  closed"* while `closePositionInner` refused on exactly that condition — three
  artefacts contradicting each other, one of them the string the user reads.

### What held, and is worth recording as held

`checkMathCarriers`' relaxation — audit 8's own Tier 1 concern — **survived
attack**: the allow set is built from non-Math calls' resources, and every one of
those is independently bounded by `checkEveryTransaction` in the same pass, so a
carrier genuinely cannot widen the group's reach. The close path held completely:
all 11 live positions close, the two-shape loop re-asserts per shape, and the
re-group on the limit path cannot leave asserted bytes differing from signed
bytes. The synthetic oracle payload cannot reach a group. The exit-cost
itemisation reconciles to within $0.0078 on a $343 payout.

### The remediation's own review found a regression

Fixing the "what leaves your wallet" line for a targetless **market** open broke
it for a targetless **limit** order, which always escrows a keeper fee and always
pays a 100,200 µALGO box MBR. The line understated the ALGO by 4x and omitted the
keeper fee entirely — directly above a sentence telling the user their money was
being escrowed.

It is now **derived from the same constants the client bills against**, because
hand-written prose over four combinations is what invited the error. And HIGH 6
was only half-fixed on the first pass: cancel was gated in the client but not in
the UI, an unresolved preflight still read as permission, and the gate swept in
two refusal kinds — our own builder opt-in and the leverage ceiling — that no
exit touches.

---

## Unaudited surface (2026-09-29) — scope for audit 8 (RUN; see above)

Everything below landed **after** audit 7's remediation (`9c19778`) and has had
no adversarial review. It is a far larger and more dangerous surface than audit
7's: that pass reviewed UI over an existing money path. This adds **four new
write paths**, changes **three controls the market path already depended on**,
and makes a mandatory safety input optional.

### Tier 1 — controls that were WEAKENED or widened

These are first because they are the ones most likely to be waved through as
"needed for the new flow", and each one also guards the paths that existed
before.

1. **`checkMathCarriers` was relaxed, twice.** It originally required carriers
   to name no accounts and no assets. It now permits (a) anything an asserted
   call in the same group already references, (b) the pinned apps' own
   addresses derived from `PEX_APPS`, and (c) on the close path, an explicit
   allow-list. Each step had a real reason; the question for audit 8 is whether
   the composition still holds. Specifically: an asserted call's `accounts`
   array is attacker-influenced only if that call is itself compromised —
   verify that rather than assuming it.
2. **`checkEveryTransaction` gained `allowAccounts` / `allowAssets` /
   `allowApps`.** On the close path these admit the yield-recall resources:
   vault and consensus addresses, the Folks pool and its manager, the proposer
   set, receipt assets. The argument is that we BUILD the registry, so the set
   is closed and enumerated rather than a widened rule. **Test that argument.**
   If `readYieldRegistry` can be made to return an attacker's address, this
   allow-list carries it straight through the assertion.
3. **`GroupShape` gained `orderOps` and `mathMax`**, and `checkCallBudget`
   branches on both. Market shapes leave them undefined and should behave
   exactly as before — confirm that is true rather than intended.
4. **`MAX_CLOSE_GROUP_FEE_MICRO_ALGO = 200,000`** against a measured 120,000,
   and `SHAPE_CLOSE` carries `applMax: 16` / `mathMax: 14` against a measured 7.
   Headroom was deliberate — the SDK derives carrier counts from pool and yield
   state — but headroom is also slack an attacker can use. Is 200,000 the right
   number, and is the close path's fee actually bounded by anything else?

### Tier 2 — new write paths, none signed by a real wallet

5. **`closePosition`** (`perpsClient.ts`). Builds, asserts and simulates **two
   recall shapes**, taking the first that passes. Audit the loop: can a shape
   that fails the assertion be reached, and is the assertion re-run per shape
   rather than once?
6. **`readYieldRegistry`** (`perpsReads.ts`). Constructs the SDK's
   `marketYieldRegistry` from chain — `mxac:`, `yc2:`, the Folks pool's `pm`
   global state, and the `pr` box on the consensus app. **This is the highest-
   leverage new read in the codebase**: its output decides which accounts and
   apps the close assertion will then permit. A compromised or misread source
   here defeats the allow-list in item 2.
7. **`openLimitOrder`** and the box-reference patch — two `o2:` references the
   SDK omits, added to a carrier, followed by a group-id re-assignment. Audit
   whether the re-group can ever leave the asserted bytes different from the
   signed bytes.
8. **`cancelOrder` / `assertCancelGroup`.** **Still never simulated against a
   live order** — there were none resting when it was written and none since.
9. **`assertOpenLimitGroup`** — three correct shapes pass, four tampers fail.
   Nothing outside that list is verified.

### Tier 3 — the take-profit became optional

10. **A position can now be opened with no exit order at all.** That was
    forbidden until closing existed. Audit the pair together: if closing is
    ever unavailable — PEX paused, preflight refusing, a quote PEX will not
    accept — a user holding a targetless position has no exit but liquidation.
    Is that state reachable, and does the UI say so?
11. **`SHAPE_OPEN` and `assertOpenGroup` are reachable for the first time.**
    They were written for the bare open and have never run against a real
    group. `SHAPE_OPEN_STORAGE` is new and **has never been exercised at all** —
    it needs a first-time trader opening with no target.
12. **Two gates are skipped when no target is set**: the take-profit bounds
    re-check, and `quoteTakeProfitCrossed` — the latter skipped entirely rather
    than having its result ignored, because the SDK throws on a zero trigger
    inside it. Confirm neither skip leaks into the path where a target IS set.

### Tier 4 — display and read paths

13. **The `o2:` decoder, `usePerpsOrders`, and the orders UI** — layout verified
    against four live orders, all since executed.
14. **`PositionState.owner`** — omitting it makes every healthy take-profit read
    `position_missing`, which this document requires be shown as "Orphaned —
    funds still locked".
15. **`fundingNetUsd` and the itemised exit-cost line** — pulled once for not
    reconciling, restored after the cause was found. Verify the terms sum to the
    headline on live positions.
16. **The funding rate on the card** (`adaptive.saved_factor_*`). The PAYING
    side's rate was verified against two positions' actual accrual; the
    receiving side deliberately gets no number. Check that the direction is read
    from `saved_factor_side` and never inferred from the imbalance.
17. **The synthetic oracle payload in `PerpsCard`** — prices scaled to a limit
    trigger for display. **Verify it cannot reach a group by any path.**
18. **The combined fee line, the market/limit toggle, the conditional "if
    filled" labels, and the close button.** The close button is gated on
    `close.ok`; check that a stale quote cannot make it offer a close PEX would
    refuse.

### Method notes for whoever runs audit 8

- **A tamper test against a transfer must use an opted-in receiver.** A redirect
  to a non-opted-in address is refused with `receiver error: must optin`, which
  looks like a protocol control and is not. This nearly wrote a false
  reassurance into this file.
- **`allowUnnamedResources` is a diagnostic, never a remedy.** It is how the
  limit group's missing box references were found; using it to make a group pass
  manufactures a green pre-flight.
- **Watch for `as never` on assertion inputs.** One was used on
  `assertCloseGroup` and silently swallowed five missing fields, including the
  recall mode and caps — exactly what that check exists to verify. Any cast on
  the way into an assertion is suspect.
- **A raised cap can silently retire a test.** Raising the close fee bound to
  200,000 left the existing fee-tamper test (45,000 per transaction) passing
  trivially. It was raised to 80,000. Check every bound that moved for a test
  that no longer exercises it.
- **Simulation disagreements are usually resource references, not logic.** Three
  separate close/limit bugs presented as `unavailable Account`, `unavailable
  App` and `invalid Box reference`. Read the account or app named — it points at
  the missing piece directly.
- **Sample sizes.** Audit 5 was wrong by generalising from one account. There
  are currently ten live positions and **zero resting orders**, so any
  order-path claim against live data has a sample size of zero and should say
  so.

---

## Open

1. ~~**Does PEX itself reject a tampered transfer (H1)?**~~ **CLOSED 2026-09-29.
   Yes, on both legs.** The test needed a buildable open+take-profit group,
   which B6 blocked; B6 cleared and this simply had not been run.

   Built a real 9-transaction open+take-profit for a funded account with no
   position (simulates `ok: true` untampered), then redirected each transfer in
   turn. Both are refused on chain with `logic eval error: assert failed`:

   | Tamper | Result |
   |---|---|
   | keeper-fee escrow → attacker | **rejected** by the contract |
   | collateral transfer → attacker | **rejected** by the contract |
   | keeper-fee escrow inflated $0.10 → $5 | **rejected** by the contract |

   So there is a genuine second line of defence behind `assertOpenWithTakeProfit`
   on the leg H1 was about. Our assertion is not the only thing standing there.

   **A method trap that nearly produced the wrong answer, and would have
   produced a FALSE one in the reassuring direction.** The first run used
   `777…4MSJUVU` as the attacker and both redirects came back "rejected" — with
   the reason `receiver error: must optin`. That is not a protocol control at
   all; that address is simply not opted in to USDC, and a real attacker would
   be. Re-running with an opted-in receiver is what produced the `assert failed`
   above and the actual finding.

   This is the same shape as the fee-pooling caution recorded below: a rejection
   is only evidence when its REASON is the control you are testing. Any future
   tamper test against a transfer must use an opted-in receiver, or it proves
   nothing.

2. ~~**`doi:` is pinned against nothing.**~~ **CLOSED.** The protocol manifest
   declares it as `dynamic_oi_margin_config` — prefix `646f693a` (`doi:`),
   owner `PDexV2TradingRiskOps`, 32 bytes, four uint64s, `DynamicOiMarginConfigV1`.
   It arrived with the manifest re-pin that came alongside the SDK bump, so this
   item was stale rather than open.

   It is now pinned in **three independent places** and `dynamicOiLayoutProblem()`
   asserts they agree: the SDK's `V2_DYNAMIC_OI_MARGIN_CONFIG_*` constants, the
   manifest format, and the live box. Verified 2026-09-29 — all three agree, and
   the live factors read 1.0 on market 1 and 0.641026 on market 2, matching what
   [OVERVIEW.md](./OVERVIEW.md) documents. The check returns rather than throws,
   so a future drift stops trading through the preflight instead of taking down
   the page.
3. ~~**The yield-recall question gates the close write path.**~~ **CLOSED.**
   Answered by Ultrade (always recall, `yieldRecallMode: 1`) and then settled by
   execution: close is built, asserted, and signed on MainNet — 7 transactions,
   20.87 xALGO recalled, fee exactly 120,000 µALGO as measured. A position opened
   through our UI no longer has only two exits; the user closes it when they
   choose. The registry is built from chain rather than from Ultrade's API, so
   this does not depend on an endpoint we do not control.
4. ~~**No group in this codebase has ever been signed by a real wallet.**~~
   **CLOSED 2026-10-04.** All four write paths now have real signatures from a
   real wallet: `openPosition` (market, with take-profit), `openLimitOrder`,
   `closePosition`, `cancelOrder`. This stood open across eight audits and was
   the largest remaining category of unknown.

   It was worth what it cost to close. Simulation never reached wallet encoding,
   group ordering as the wallet presents it, the signing budget, or submission —
   and the **one defect a user found before an audit did** (the cancel stride,
   below) lived precisely there: every simulated cancel had run against orders
   that already had children, so the bug was invisible to the sweep that was
   supposed to catch it.
5. **These were instances of the same model reviewing its own work.** That
   catches assumptions and arithmetic — it did, repeatedly — but it is weakest
   where the error is systematic rather than local. The close-payout defect above
   is the case in point: internally consistent, wrong at the boundary, invisible
   to six passes. Before this holds meaningful money, an outside reviewer is
   worth more than another bot.


---

## Cancel, measured end to end (2026-10-04)

The stride fix (`430fcbf`) was verified by refund rather than by simulation.
Cancelling the live limit order — id 1, `OPEN_LIMIT`, market 1, long,
$60.847808 at a $0.12 trigger, no child — returned **everything** escrowed:

| | returned |
|---|---|
| collateral | 6 USDC |
| keeper fee | 0.1 USDC |
| storage MBR | 100,200 µALGO |
| group fee paid | 14,000 µALGO (cap 40,000) |

Two things this settles that were previously inference:

1. **The keeper fee really is refunded on cancel.** [NEXT.md](./NEXT.md) records
   it as refunded-on-cancel, kept-on-execution. The execution half was observed
   on 2026-09-29; the cancel half is observed here. Both halves are now measured.
2. **The storage MBR returns to the wallet on cancel**, as a `pay` inner
   transaction — it does *not* stay in PEX's reusable escrow the way it does on
   close. The info modal asserted the opposite in plain language. Fixed below.

### Disclosure drift found while verifying it — `PerpsInfoModal.tsx`

Four claims in the risk/explainer modal had gone stale under features shipped
after it was written. For a product whose threat surface *is* what the interface
claims, these are defects, not copy nits:

| claim | was | now |
|---|---|---|
| take-profit | "**Every** position carries a take-profit. It closes automatically… so you do not have to watch it." | optional; explicitly states nothing closes an unprotected position in your favour |
| keeper fee | "pays for your take-profit to be executed" | per attached trigger; none attached, none paid |
| storage ALGO | "released back into that escrow when you close, **not returned to your wallet**" | distinguishes close (escrow) from cancel (wallet), per the measurement above |
| title | "About Perps" | "About the Trading Terminal" — the rename missed this file and its `aria-label` |

The first is the serious one. Take-profit became optional precisely so a user
could let a leveraged long run; the modal still promised that same user their
position would close itself. It also gained the two features it never mentioned:
closing early, and what a resting limit order does with collateral.

**A near-miss worth recording.** The draft replacement read "take-profit and
stop-loss are optional," because the working conversation had referred to stop
loss as the optional thing. **Stop-loss is not implemented.** `stopLossPrice12`
is hardcoded `null` (`PerpsCard.tsx:547`); there is no input, and no write path
constructs a `DECREASE_STOP_LOSS` order. `PositionsPanel` and `PerpsView` only
*label* and *draw* kind 3 if one existed, so the scaffolding reads as a feature
on inspection. Checking the write path before writing the sentence is what
caught it. Advertising an absent protection feature on a leveraged-trading screen
is among the worst claims this UI could make.

> **Superseded 2026-10-05** — stop-loss ships on market entries (`e2adc4d`), one
> protective leg at a time. Left in place because it is audit 9's record of what
> was true when it ran, and because the near-miss it describes — nearly writing
> "stop-loss is optional" into a risk modal for a feature that did not exist —
> is the reason the feature got built. Current status is at the top of
> [SPEC.md](./SPEC.md).


## The targetless open, signed (2026-10-04)

A market short with **no take-profit** — the branch where `wantsTakeProfit` is
false, which had been built and simulated but never signed. Group `gcAk14P4`,
round 65675835.

`SHAPE_OPEN` matched exactly: 1 axfer, 0 pay, 1 trading call, 3 math carriers,
**0 orderOps**. Fee 34,000 µALGO against the 120,000 cap. **Zero `o2:` boxes**
after the fact, which is the assertion that matters — the targetless path must
attach nothing, and this is the first evidence from settlement rather than from
simulation that it does.

Fee accounting reconciles exactly, which is the first independent check of the
combined line item on the card:

| | USDC | rate on $46.437896 notional |
|---|---|---|
| sent | 6.000000 | |
| Magnet fee | −0.046441 | 10.001 bps |
| PEX fee | −0.027864 | 6.000 bps |
| **collateral in `p2:`** | **5.925695** | combined **16.001 bps** |

Position id 105, side 2, market 1, entry $0.130546998, 7.837x. The uint48/uint16
packing decodes correctly on a *fresh* position id (105, not 0) — the earlier
decode bug was invisible on legacy id-0 positions, so this is the first fresh,
non-zero id to round-trip since it was fixed.

Two further firsts: the **short side** had never been signed (every prior trade
was a long), and this trade landed twenty minutes after the disclosure fix above.
It is the live confirmation of the corrected sentence — a single 6 USDC transfer,
no keeper fee, no 99,700 µALGO order box, no storage payment. Under the old copy
the user would have been told this position closes itself at a take-profit. It
has two exits: closed by hand, or liquidated.

**`SHAPE_OPEN_STORAGE` is still unexercised.** There is no `pay` leg here because
the trader's storage box already existed. It needs a genuinely first-time trader
opening with no target, which is the one remaining unsigned shape.


---

# Audit 9 — 2026-10-04

Scope: `5f85472^..HEAD` — the audit-8 remediation itself plus everything after
it (the cancel stride fix, the disclosure corrections). ~1,000 added lines,
centred on `perpsGroup.ts` (+276) and `perpsClient.ts` (+113).

Five findings. No ship-blocker: nothing here lets a group move funds the screen
did not describe. The serious one is the opposite failure — a user who **cannot
get out** in a state where the code was specifically rewritten to let them.

## HIGH 1 — the narrowed exit gate is defeated by the UI

`EXIT_BLOCKING_KINDS` was audit 8's HIGH 6 fix: close and cancel must not be
blocked by refusals that cannot affect them. It narrows the client's exit gate
to `{drift, unreachable}`, deliberately excluding `builder` (our treasury's own
USDC opt-in) and `layout` (the leverage ceiling).

The UI does not use it:

| | gate | blocks on |
|---|---|---|
| `perpsClient.ts:1146,1303` | `EXIT_BLOCKING_KINDS.has(pre.kind)` | drift, unreachable |
| `PositionsPanel.tsx:144` | `preflight.canOpen !== true` | drift, unreachable, **builder**, **layout** |

So on `builder` or `layout` the client would build and submit a close happily,
and the panel disables the button and shows a banner. The only path a user has
is the panel, so the fix is **inert where it matters**.

`PositionsPanel.tsx:123` claims "The same gate the write paths use — audit 8
HIGH 6." It is not the same gate. The client's own comment at 1298 says blocking
escrow recovery on builder/layout "would be a self-inflicted trap" — the panel
builds that trap.

**Root cause:** `usePerpsPreflight` returns `{ canOpen, reason }` and never
exposes `kind`, so the panel *cannot* apply `EXIT_BLOCKING_KINDS`. The
remediation added the narrow gate to the write path and never plumbed the field
the UI would need to honour it.

**Consequence:** if our builder address loses its USDC opt-in, every user with
an open position is reduced to two exits — take-profit or liquidation. That is
the exact state closing was built to end, reachable by a misconfiguration on our
side rather than theirs.

**Fix:** expose `kind` from the hook and gate the panel on
`EXIT_BLOCKING_KINDS`, keeping `null` as "not yet" rather than permission.

## MEDIUM 2 — the allocator can hand out an id inside a live bracket's stride

`allocateBaseOrderId` takes `highest + 1`, commented "the whole stride sits
above every id already in use". That holds only when every reserved slot is
occupied. `listOrderIds` enumerates **existing `o2:` boxes**, and a bracket
parent with no children occupies one slot of the three it reserves.

Reachable from the state this account was in on 2026-10-04:

1. Bare limit order → base 1, reserves {1,2,3}, creates **box 1 only**.
2. Second bare limit order → `listOrderIds` sees {1}, highest 1, base **2** —
   inside order 1's reserved stride.
3. Cancelling order 1 declares boxes 1, 2, 3 (correctly, per the stride rule),
   and `cancel_order(1)` probes slots 2 and 3 — where slot 2 is now an
   unrelated live order.
4. `assertCancelGroup` **passes**: box 2 is in `expected` via the stride.

Whether PEX then touches order 2 depends on it validating the child's
`link_base_order_id`, which is **not verified here** — it needs two live orders
to test and was not worth spending to confirm. Either way neither of our two
layers prevents the collision or can detect it, and "our layer is the control"
is this product's whole thesis.

**Fix:** allocate above the highest *reserved* id, not the highest existing one
— `highest + ORDER_ID_STRIDE` when the highest belongs to a bracket parent, or
simply always. The fourth occurrence of the reserved stride causing a defect.

## MEDIUM 3 — "derived from the constants" is not true

`PerpsCard.tsx`'s `moves` says deriving it "from the same constants the client
bills against means the text cannot drift from the group again." It hard-codes
`100_200` and `99_700` as literals. The real constants are
`LIMIT_ORDER_BOX_MBR_MICRO_ALGO` and `ORDER_BOX_MBR_MICRO_ALGO`
(`perpsGroup.ts:1261,1263`), and are not imported.

The drift it claims to have closed is still open — and a comment asserting a
guarantee the code does not provide makes it *less* likely to be caught, which
is the same failure mode as audit 8's unreachable check reading as coverage.

**Fix:** import the two constants. One line each.

## LOW 4 — a typo in `EXIT_BLOCKING_KINDS` compiles

Typed `ReadonlySet<string>`, so membership is unchecked against the `kind`
union. Verified by substituting `"drifttypo"`: **zero** tsc errors, and `drift`
silently stops blocking exits. A new `kind` likewise defaults to not-blocking.

**Fix:** `Record<PreflightKind, boolean>` so every kind must be classified at
compile time.

## LOW 5 — one fee literal does not match measurement

`moves` models a bare limit at 20,000 µALGO. Measured on chain: **18,000**
(group `cezp/Nh/`, 7 txns — submit 14,000 plus four 1,000 carriers). Overstates
by 0.002 ALGO, so the direction is safe, but the comment says these were
"Measured, and matching this arithmetic", and for this case they were not.

Verified against real groups: market bare **34,000** (twice, two accounts),
market with target **51,000** + 99,700 box, limit bare **18,000** + 100,200 box.

## Method note

Findings 1 and 4 came from reading the gate and then testing it rather than
trusting the comment beside it — both comments asserted the property that was
missing. Finding 5 came from measuring the four combinations on chain instead of
reading the measurement already written in the comment.


---

## The Ultrade questions, closed out (2026-10-05)

Four letters were drafted to Ultrade and kept in the repo rather than a scratch
directory. Three are now discarded; what each concluded is recorded here so
deleting the draft does not delete the finding.

**B6 — "OrderOps rejects the attached take-profit leg." Never sent, and it was
ours.** Resolved 2026-09-27: the rejection came from an assumption in our own
code, not from PEX. Two of our own controls were holding the defect in place —
the `timeInForce` check demanded 0 where GTC is 1, and the child's oracle
payload was compared against the entry's rather than its own. Sending this would
have asked Ultrade to explain our bug. The second question in the same draft,
`doi:` having no declared format, was already stale: the manifest declares it,
and it is now pinned in three independent places.

**YIELD-RECALL — answered 2026-09-29.** *"Always use recall."* So
`yieldRecallMode: 1` unconditionally, with the registry built from chain state
rather than Ultrade's API. Captured in SPEC.md and NEXT.md.

**CLOSE-RECALL — downgraded, then closed by construction.** Both remaining
details answered themselves:

- `XALGO_PROVIDER_FEE_CREDIT_MICRO_ALGO = 20,000` is not a value needing
  confirmation, it is a deliberate over-provision. The failure modes are
  asymmetric: too low and the group underpays and dies in **simulation**, before
  a wallet opens; too high and the user overpays a few thousand microALGO,
  bounded by `MAX_CLOSE_GROUP_FEE_MICRO_ALGO`. Confirmed sufficient against a
  live position, and close has since run 20/20 and settled on MainNet.
- Proposer addresses *are* supplied — `readXalgoProposers` reads them from the
  consensus app's `pr` box.

**CLOSE-QUOTE — kept, and still unanswered.** Which fields of
`quoteV2DecreasePosition` scale with `sizeUsdDelta` on a PARTIAL close. It
blocks nothing today because partial close is not built: `closePosition` closes
in full. It is the groundwork for the day that changes, and it is the one of the
four that genuinely still needs Ultrade.
