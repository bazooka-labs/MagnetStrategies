# UVote — Governance

UVote is Magnet Strategies' on-chain governance surface: **advisory, founder-led
voting over the $U token**. The founder posts an open question about the protocol's
direction; $U holders signal their preference by locking $U for the voting window.
The tally guides the founder, who executes under the protocol's existing safeguards.

> **Live on mainnet** — App ID `3679681107` · route `/vote` (magnetstrategies.io/vote)
> Token: $U (ASA `3081853135`). Technical + audit detail: [UVOTE_SPEC.md](./UVOTE_SPEC.md).

---

## What it is (and what it replaced)

UVote is the evolution of the original "MagnetDAO" concept. That earlier framing —
a quarterly cycle where outside projects applied for treasury-backed liquidity — was
too narrow: it limited voting to a single, niche decision (which liquidity pool to
fund) and boxed in what $U-holder input could actually shape.

UVote broadens the scope to **whatever question the founder puts forward**:

- **Liquidity** — which pairs or venues to prioritize, incentives.
- **Parameters** — advisory input on protocol settings (rates, LTVs, etc.).
- **Investments / treasury direction** — where protocol-owned capital is pointed.
- Anything else that benefits from holder signal.

The old quarterly-application model, its liquidity-application portal, and the
original voting app (`3554779766`, retired) are gone. UVote is the single governance
surface going forward.

---

## The model

**Founder-led, advisory.** This is not a decentralized DAO. The founder retains
execution authority; UVote produces a clear, on-chain mandate that guides decisions.
Framing every proposal honestly as advisory keeps expectations calibrated and keeps
the protocol inside the trust model its contracts were audited against.

**How a vote works:**

| | |
|---|---|
| **Who proposes** | Founder only. One open question with 2–4 choices. |
| **Window** | Fixed **7 days** per proposal; one active proposal at a time. |
| **How you vote** | Lock **whole $U** at the moment you vote — **1 $U = 1 vote** (your weight is the amount you lock). |
| **One vote per wallet** per proposal. Fractional $U isn't accepted (whole tokens only). |
| **Reclaim** | After the window closes, you reclaim your locked $U **in full**, plus a small refundable ALGO box deposit you funded when voting. |
| **Binding?** | No — advisory. Nothing executes on-chain from the result; the founder acts on the mandate. |

**Locking, not perpetual staking.** You lock $U *as the act of voting*, and it stays
locked only for the remainder of that proposal's window. It is not staked, delegated,
or at risk — it simply signals conviction and prevents double-counting.

---

## Guarantees for voters

These are properties of the deployed contract (see [UVOTE_SPEC.md](./UVOTE_SPEC.md)
for the audited detail), stated plainly:

- **Your $U always comes back.** The only way $U leaves the contract is *you*
  reclaiming your own recorded amount after the window closes. There is no founder
  sweep or admin path that can move locked voter funds.
- **No expiration on reclaim.** There is no deadline to claim; locked $U sits safely
  and is reclaimable at any time after the vote closes — waiting longer never risks
  it. (Practical caveats: keep your wallet, and stay opted into $U to receive it.)
- **Immutable & non-deletable.** The app cannot be upgraded or deleted, so the rules
  you voted under can't be changed out from under you.
- **Two independent audits passed** (build + a post-deploy adversarial pass) with no
  Critical/High findings; all three invariants — no vote manipulation, no lost funds,
  always reclaimable — hold in the live contract.

---

## Relationship to $U and the treasury

- **$U is the governance token.** Holding $U is what lets you participate; weight is
  proportional to how much you lock. This is a core utility of the token alongside its
  role as collateral and LP anchor across MagnetFi.
- **Treasury.** Proposals often direct how the Magnet Strategies treasury deploys
  liquidity. The treasury's live USDC balance is shown on the `/vote` page so voters
  can see the pool a decision is directing. Treasury deployment remains a founder
  action informed by the vote.

---

## Lifecycle at a glance

1. **Founder creates a proposal** (question + 2–4 choices) — opens a 7-day window.
2. **Holders vote** — lock whole $U on a choice; the tally updates on-chain.
3. **Window closes** (7 days) — voting ends; results are final and visible.
4. **Founder acts** on the advisory mandate.
5. **Voters reclaim** their $U (and box deposit) at any time after close.

---

## Further reading

- [UVOTE_SPEC.md](./UVOTE_SPEC.md) — contract internals, box layout, transaction
  shapes, the two audit passes, and the deploy record (App `3679681107`).
- [TOKENOMICS.md](./TOKENOMICS.md) — $U roles across the protocol.
- [Treasury](./TREASURY.md) — funding and deployment of protocol capital.
- Frontend: the `/vote` page (`web/src/app/vote/`) — see [web/README.md](../web/README.md).
