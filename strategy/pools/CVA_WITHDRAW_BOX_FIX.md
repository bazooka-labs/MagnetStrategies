# C-Vault withdraw — the missing `gm2:` box reference

**Status: BUILT, reviewed and shipped 2026-11-03**, after a real user
withdrawal failed in pre-flight. §9 records what the review corrected.

## 1. The failure

```
The pre-flight check did not pass, so nothing was sent:
logic eval error: invalid Box reference 0x676d323a0000000000000002
Details: app=3690309167, pc=7789, opcodes=swap; concat; box_len
```

`0x676d323a` is `gm2:`, followed by market **2**. The C-Vault's
`withdraw_from_market` reads every active market's allocation box, and our
group declares only market 1's.

Nothing was signed and no funds moved. The group dies in simulation.

## 2. Cause — and it was introduced by the fix for `pc=8526`

On 2026-11-03 the deposit path was failing at `pc=8526` because the SDK built
a mark call for every ACTIVE market while the contract counts only FUNDED ones
(it skips a market whose `gm2:` `lp_share_amount` is zero). The fix narrowed
`activeMarketIds` to the funded set via `markMarketsFor`.

That fixed the deposit. It also removed the only thing that was declaring
market 2's `gm2:` box on the withdraw path, because of an **inconsistency
inside the SDK**:

```js
// buildV2CvaDepositCall — unconditional
boxes: uniqueBoxRefs([
  v2CvaUserBoxKey(input.sender),
  ...v2CvaActiveAllocationBoxes(input, 0, v2CvaOptionalMarketId(input)),
]),

// buildV2CvaWithdrawCall (idle) — unconditional, same as deposit

// buildV2CvaWithdrawFromMarketCall — CONDITIONAL
boxes: [
  v2CvaUserBoxKey(input.sender),
  ...(activeMarkCalls.length ? [] : v2CvaActiveAllocationBoxes(input, cvaVaultAppId, input.marketId)),
  ...
]
```

Only the from-market withdrawal drops the allocation boxes when marks exist,
on the assumption that the mark calls carry them. Each mark call declares only
**its own** market's box. One mark therefore means one box, and market 2's
allocation is referenced nowhere.

**Deposit and idle-withdraw are immune**; from-market withdrawal is not. That
is why the deposit was verified working and this went unnoticed: *the deposit
was the only flow re-tested after the change.*

## 3. What the contract actually accepts — measured, not reasoned

Four shapes built against the live chain and simulated, same wallet, same
share amount (the admin's full 20,831,065 shares):

| | shape | result |
|---|---|---|
| A | `marks=[1]` (what ships today) | `invalid Box reference gm2:2` — pc **7789** |
| B | `marks=[1,2]` | `assert failed` — pc **8526**, the deposit bug returns |
| C | `marks=[]` | `assert failed` — pc **8234**, the funded mark is required |
| D | `marks=[1]` **+ `gm2:2` declared** | **OK** |

So the two lists must genuinely diverge: **exactly the funded markets get mark
CALLS, and every active market gets a box REFERENCE.** No single SDK input
expresses that for this builder.

Observed on the real group: the vault's withdraw call already carries
`gm2:1` at `appIndex 0` (self-reference) plus **four empty padding slots**, so
the extra reference fits without restructuring the group.

## 4. The change

In `cvaGroup.ts`, in the from-market branch of `buildCvaWithdraw` only:

1. After the SDK builds the group, locate the call carrying a `gm2:`
   reference — **by content**, not by index. Group shape changes with
   recall carriers (11, 13 or 15 transactions across the options above), so an
   absolute index is the defect that caused `pc=8526` in the first place.
2. For every market in `snap.state.activeMarkets` with no `gm2:` reference on
   that call, write one into an empty padding slot, `appIndex: 0`.
3. If there is no empty slot, **throw**. Silently dropping a reference puts us
   back here; a loud failure before signing costs a user nothing.
4. Re-assign the group id, since the transaction bytes changed. Clear the
   existing `group` field first or `assignGroupID` refuses.

**It must NOT touch anything else.** Only `gm2:` references for markets the
snapshot says are active, only into empty slots, only on that one call.

## 5. Why not the alternatives

- **Widening `activeMarketIds`** is option B: measured to fail.
- **Dropping marks entirely** is option C: measured to fail.
- **Patching the vendored SDK** would put the terminal's trading maths in
  scope for a liquidity fix; `vendor/README.md` forbids bumping it in
  isolation, and editing it is worse.
- **Reverting the `markMarketsFor` fix** trades a broken withdrawal for a
  broken deposit.

## 6. Risks this introduces

- **Post-build mutation of a group that is about to be signed.** This is the
  serious one. Mitigated by doing it before our own assertion and before
  simulation, so both run against the patched bytes, and by restricting the
  edit to empty box slots.
- **Our assertion does not inspect box references at all** (`cvaGroup.ts` has
  no `boxes` check). So the patch is unverified by the assertion that exists
  to catch exactly this kind of thing. The change should add a check that the
  only difference between pre- and post-patch is `gm2:` references for active
  markets.
- **Box reference limits.** 8 per transaction, and a group budget. Today the
  call uses 2 of 6 declared slots. A third active market would need
  re-checking rather than assuming room.

## 7. Test plan

Hermetic, must fail on today's code:

1. A fixture group with `marks=[1]` and active markets `[1,2]` — assert the
   patched group declares `gm2:` for both.
2. The locator finds the vault call by box content, not index: reorder the
   group and it must still find it.
3. No empty slot -> throws.
4. Markets already referenced are not duplicated.
5. Nothing other than box references differs between input and output.

Live simulation, **all three CVA flows plus the composite**, because testing
one flow is what caused this:

6. C-Vault deposit (the `pc=8526` regression must stay fixed).
7. From-market withdrawal — the failing case.
8. Idle withdrawal — currently unreachable (`idle_long`/`idle_short` are 0)
   but must not be broken by the change.
9. USDC-only exit: withdrawal + ALGO→USDC swap, which is the path the user
   actually used.
10. A non-admin holder, so the fix is not accidentally specific to one wallet.

## 8. Review

Fresh reviewer, per CLAUDE.md, before anything ships: does the post-build
mutation open any way to alter what the user signs beyond the box list, and is
the "find the call by its box content" locator robust to a group shape we have
not seen?


---

## 9. What the independent review corrected

Reviewed cold before shipping. Verdict was safe-to-ship, with three things
this document and the code had wrong. All are fixed; none changed the
approach.

**The call being patched is `mark_market`, not `withdraw_from_market`.**
§4 and the code comment both said "the vault call", meaning the withdrawal.
In the real 13-transaction group the withdrawal call carries `gu2:<sender>`
and `ml2`, while `mark_market` carries `[gm2:<id>, [marketsApp, mf2:<id>]]`
(SDK `transactions.js:1543`) — so the mark is the first to hold an allocation
box and is what the locator finds. **It works because box references are
POOLED across the group**: the vault reads the allocation during
`withdraw_from_market` through a reference any transaction declared. The
mechanism is sound and the description was wrong.

**`present` was computed from one call, not the group.** Latent: when a
second market becomes funded it gets its own mark call with its own `gm2:`,
and a per-call view would add a duplicate, burn a padding slot, and
eventually throw "no room" for a reference the group already had. Now
computed across every transaction.

**The locator did not check ownership.** `isGm2` matched on name alone, so a
12-byte `gm2:`-shaped name declared by another app at a non-zero `appIndex`
could be matched — and we would then write `appIndex: 0` onto a transaction
that is not the vault. Now requires `appIndex === 0` **and** the transaction's
app to be the C-Vault.

**A mutation survived the first test file.** Writing into the first
*non-gm2* slot rather than the first *empty* one passed all nine tests —
because the fixture had only `gm2:1` and padding, with no non-empty neighbour
to destroy. In the real group that slot holds `mf2:1`. The fixture now uses
the captured shape and a test pins that every pre-existing reference keeps its
value and position; the mutation dies.

**Confirmed clean by the review:** the patch writes only
`applicationCall.boxes`, only into zero-length padding slots; fee, args,
accounts, foreign apps/assets, amounts and sender are untouched; the
encode/decode roundtrip preserves the added reference so the signed bytes
really contain it; group re-assignment preserves order and yields one id
across all 13; deposit and idle-withdraw are not touched.

**Accepted as a gap, not a defect:** our group assertion still does not
inspect box references. A wrong or missing reference causes a failed
simulation and nothing is sent — it cannot produce a different outcome. The
final `simulateGroup` on the patched bytes is the effective check, and it is
what caught `pc=7789` in the first place.
