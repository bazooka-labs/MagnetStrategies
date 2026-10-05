# Audit 9 — remediation spec

Written before the code, 2026-10-05. Five findings from
[AUDIT.md](./AUDIT.md#audit-9--2026-10-04). All five are fixed here.

Order is deliberate: HIGH 1 and LOW 4 are the same defect seen from two sides —
a gate whose membership nothing checks — so they are specified together and
fixed in one change.

---

## 1 + 4 — make the exit gate real, and make it typed

### What is wrong

`EXIT_BLOCKING_KINDS` narrows the client's exit gate to `{drift, unreachable}`.
`PositionsPanel` gates Close and Cancel on `preflight.canOpen !== true`, which
also blocks on `builder` and `layout`. The panel cannot do better: the hook
returns `{ canOpen, reason }` and never exposes `kind`.

Separately, the set is `ReadonlySet<string>`, so membership is unchecked —
`"drifttypo"` compiles clean and silently stops `drift` blocking exits.

### The change

**`perpsPreflight.ts`** — replace the set with a total map, so a new `kind`
cannot be added without classifying it:

```ts
export type PreflightKind = "ok" | "drift" | "builder" | "layout" | "unreachable";

/** Whether each refusal blocks an EXIT (close, cancel), as opposed to an open. */
export const EXIT_BLOCKS: Record<PreflightKind, boolean> = {
  ok: false,
  drift: true,
  unreachable: true,
  builder: false,
  layout: false,
};
export const exitBlocked = (kind: PreflightKind): boolean => EXIT_BLOCKS[kind];
```

`PreflightResult.kind` becomes `PreflightKind` rather than an inline union, so
the map and the result cannot disagree.

`EXIT_BLOCKING_KINDS` is **removed**, not kept as an alias. An alias would leave
the untyped `.has(string)` call available, which is the defect.

**`usePerpsPreflight.ts`** — expose `kind`, so the panel can apply the same
rule. `null` while the first check is in flight, matching `canOpen`.

**`PositionsPanel.tsx`** — gate exits on the exit rule, not on `canOpen`:

```ts
const checking = preflight.canOpen === null;          // unchanged
const blocked = checking
  ? "Checking the exchange contracts…"
  : preflight.kind !== null && exitBlocked(preflight.kind)
    ? (preflight.reason ?? "Trading is unavailable right now.")
    : null;
```

`null` must still read as "not yet", never as permission — that was the
regression review caught inside the audit-8 remediation, and it is easy to
reintroduce while narrowing a gate.

### What must NOT change

The **card** keeps gating opens on `canOpen === true`. Opens legitimately block
on `builder` and `layout`; only exits do not.

### Tests

New, in `perpsPreflight.test.ts`:

- `exitBlocked` is true for exactly `drift` and `unreachable`, false for
  `ok`/`builder`/`layout` — asserted over `Object.keys(EXIT_BLOCKS)` so a kind
  added later without a test still fails the count assertion.
- The map covers every member of `PreflightKind` (compile-time via `Record`,
  restated at runtime so the count is pinned).

---

## 2 — allocate above the highest RESERVED id

### What is wrong

`allocateBaseOrderId` returns `highest + 1`, where `highest` comes from
`listOrderIds` — which enumerates **existing** `o2:` boxes. A bracket parent
reserves three slots and, with no children, occupies one. So the next
allocation can land inside a live bracket's reserved stride.

Reachable: bare limit order → base 1, box 1 only; second bare limit order →
highest 1 → base **2**, which is order 1's take-profit slot.

### The change

```ts
const baseOrderId = highest + ORDER_ID_STRIDE;
```

**Why `+ STRIDE` and not a reserved-set computation.** An order at id `K`
reserves at most `K+2`. For any `K <= highest`, `K+2 <= highest+2 < highest+3`.
So `highest + 3` clears every stride any existing order can hold, without
reading a single order box to find out which ones are bracket parents. The
cheaper, more obviously-correct bound beats the precise one here: it needs no
extra network read and no assumption about which ids are parents.

Cost is id space, and there is none worth counting — `ORDER_ID_MAX_BASE` is
`2^61 - 3`. At three ids per order an account would need ~7.7×10^17 orders to
exhaust it.

A fresh account now starts at base 3 rather than 1. `validateLinkBaseOrderId`
requires `0 < base <= 2^61-3`, so 3 is valid.

### Tests

In `perpsOrders.test.ts`:

- With existing `[]` → base is `ORDER_ID_STRIDE`, and `reserved` is contiguous.
- With existing `[1]` (the childless-parent case that motivated this) → base is
  `4`, **not** `2`, and `2` is not in `reserved`.
- With existing `[1, 2, 3]` → base is `6`.
- `reserved` never intersects `existing`, swept over several shapes — this is
  the property, and the one a future change must not break.

---

## 3 — import the constants the comment claims to use

`PerpsCard.tsx`'s `moves` hard-codes `100_200` and `99_700` while its comment
says it is derived from the client's constants. Import
`LIMIT_ORDER_BOX_MBR_MICRO_ALGO` and `ORDER_BOX_MBR_MICRO_ALGO` from
`perpsGroup.ts` and use them. They are `bigint`; `moves` works in `number`, so
convert at the point of use and say why.

`firstTradeExtra` is also `100_200` but is a *different quantity* — the
first-trade storage MBR, which coincidentally equals the limit order-box MBR.
It gets its own named constant rather than sharing the import, or a later change
to one silently moves the other.

---

## 5 — correct the fee literal, and stop calling the rest measured

Bare limit is `18_000`, not `20_000` (measured: group `cezp/Nh/`, 7 txns —
submit 14,000 plus four 1,000 carriers).

The comment's measurement table is corrected to what was actually observed, and
re-stated as what it is: these are the fee totals seen on real groups, and the
carrier count can vary with resource packing, so the line says "about" and is
rounded up rather than presented as exact. Overstating the ALGO cost is the safe
direction for a disclosure; implying it was measured when it was not is the part
worth fixing.

---

## Out of scope

- The `isBracketParent` flag that widens `assertCancelGroup`'s accepted box set
  stays as it is. With fix 2 in place, `base+1`/`base+2` can no longer be
  another live order, which is what made the widening uncomfortable.
- Whether PEX itself validates a child's `link_base_order_id` before acting on a
  probed slot is still unverified. Fix 2 makes it unreachable from our client, so
  it stops being load-bearing; it is not worth two live orders to establish.

## Done means

`tsc` clean, `next build` clean, the full suite green, and the new tests fail
when their fix is reverted — verified by reverting each, as with the FOLKS icon
guards. A guard that has not been seen to fail is not known to be a guard.


---

# What the pre-push review changed

The spec above was written before the code. A fresh adversarial pass over the
finished change found five things, two of them HIGH, and **one of them was a
defect this remediation introduced**. All are fixed; the spec is left as written
so the record shows what was wrong with it.

## The close DOES pay a builder fee — the HIGH 1 fix was half wrong

The spec kept audit 8's exclusion of `builder` from the exit gate, on audit 8's
stated grounds that "a close pays no builder fee we need an opt-in for".

That is false. `closePosition` passes
`builderFee: { BUILDER_ADDRESS, POSITION_BUILDER_FEE_BPS }`, and
`assertCloseGroup` **requires** the close leg's builder tuple to be exactly that
— it fails `builder_address` otherwise. So with no opt-in the close's fee
transfer fails at the chain and the close fails.

Enabling the button for that state did not fix "offered, then refuses"; it moved
the refusal from a plain banner to an opaque simulation error after the click.
Strictly worse than what it replaced, and three comments asserted it was right.

**Fixed by splitting the kind**, which `BuilderCheck` already supported:

| kind | cause | blocks exits |
|---|---|---|
| `builder_optin` | not opted in to the collateral asset | **yes** — the close's fee transfer fails |
| `builder_balance` | below minimum balance | no — receiving an ASA costs the receiver nothing |

The narrow gate survives for the case it was actually written for, and no longer
covers a case where the close genuinely cannot succeed.

## The base-id fix did nothing for existing users

The spec's "Out of scope" claim — "with fix 2 in place, `base+1`/`base+2` can no
longer be another live order" — is true only for ids allocated **after** this
ships. Every id already on chain came from the old `highest + 1` rule, so a user
can already hold orders 1 and 2 where 2 sits in 1's reserved slot. For them the
stride declaration still names an unrelated live order, and `assertCancelGroup`
still cannot tell: id 2 is legitimately inside the stride it was told to expect.

The spec also said establishing PEX's behaviour here was "not worth spending to
confirm". It costs nothing: the order box's `flags` word packs
`mode * 2^61 + parentId`, the SDK reads it with
`v2OrderLinkBase(flags) = flags % 2^61` (`transactions.js:691`,
`orderLifecycle.js:268-276`), and our decoder already carries `flags` and never
used it.

**Fixed in `cancelOrder`**: when cancelling a bracket parent, read the owner's
orders once and refuse if a reserved slot holds an order whose packed parent is
not this one. Empty slots are still declared — the contract probes them either
way, which is why the stride is declared at all.

## MEDIUM 3 was two-thirds done, under a comment arguing against finishing it

`firstTradeExtra` stayed the literal `100_200` with a comment explaining that it
is a different quantity from the order-box MBR and so should not share the
import. The premise is right and the conclusion was wrong: the correct constant
already existed in the module this file now imports from —
`STORAGE_ESCROW_MICRO_ALGO`, derived from the SDK's
`V2_OPEN_ORDER_EXECUTION_STORAGE_ESCROW_MICRO_ALGO` and the same one
`assertOpenGroup` checks the storage payment against.

So the finding's own headline was still open for the third figure, inside its own
fix, behind a comment pre-arguing against the fix. Now imported.

## The test labelled "the property" passed with the bug in place

"never returns ids that collide with an existing one" asserted only that the new
stride misses `existing`. Under `highest + 1` the new stride is {H+1, H+2, H+3}
and every existing id is ≤ H — so it passed with the defect present. A test that
tests around the bug, which is the exact failure this codebase already names for
the audit-8 tamper table.

Rewritten to assert the real property: the new stride must not intersect the
stride any **existing** order reserves, whether or not those boxes were created.
Verified to fail under `highest + 1`.

Also added, because review found the HIGH 1 panel fix had **zero** coverage —
reverting it left all tests green: `exitBanner(canOpen, kind, reason)` is
extracted out of the JSX and unit-tested, including that a pending check never
reads as permission and that a revert to the open-gate rule is caught.

## LOW 5's Record was total at compile time only

`exitBlocked` was a bare `EXIT_BLOCKS[kind]`, so a value from outside the type —
a cached result from an older build — indexed to `undefined` and read as "does
not block": the same runtime fail-open the `Set` had, under a comment saying the
Record had closed it. Now `?? true`, and tested.

## Correction to this spec

The tests landed in `perpsExitGate.test.ts`, not the `perpsPreflight.test.ts` and
`perpsOrders.test.ts` named above.
