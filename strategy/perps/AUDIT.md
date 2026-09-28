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
