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

**Next step:** this is a question for Ultrade rather than more black-box probing.
Give them the pc and the isolation, and ask what a valid
`submit_linked_order` requires that an SDK-built group does not carry. Do not
guess further — four variables have already been eliminated and guessing a fifth
is not evidence.

---

## Open

1. **Does PEX itself reject the escrow redirection (H1)?** Unresolved: simulating
   as a fresh account fails a per-account box prerequisite. Settleable for free by
   simulating as one of the known position holders. It changes the severity, not
   the fix.
2. **`doi:` is pinned against nothing.** Ask Ultrade for a declared format, or
   pin by observation and say so.
3. **These were two instances of the same model reviewing its own work.** That
   catches assumptions and arithmetic — it did, repeatedly — but it is weakest
   where the error is systematic rather than local. Before this holds meaningful
   money, an outside reviewer is worth more than a third bot.
