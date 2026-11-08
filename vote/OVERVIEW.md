# Governance — mVote

Magnet Strategies' on-chain governance surface: **advisory, founder-led voting
weighted by mUSD**. The founder posts an open question about the protocol's
direction; mUSD holders signal their preference by locking whole mUSD for the
voting window. The tally guides the founder, who executes under the protocol's
existing safeguards.

> **Contract:** `contracts/mvote/mvote/mvote.py` · config in
> `web/src/lib/governance.ts` · surfaced as the **Governance** pill of
> [`/tokens`](https://magnetstrategies.io/tokens#governance), the mUSD page.
> `/vote` and `/dao` 308-redirect there; neither is a page any more.
> Voting asset: mUSD (ASA `3615600399`, 6 decimals).
> Technical + audit detail: [SPEC.md](./SPEC.md).

> **Live on mainnet — App ID `3763268387`**, deployed 2026-11-05 through the
> wallet-signed handshake in the admin panel, so no seed phrase touched a
> script or a terminal. App address
> `MLBEG4JXINAGGUSZN5WFXY4WBXQYLV6PLMKRQYNQBYJQX63NKSDILBQKLI`.
>
> Verified against the chain BEFORE the site was pointed at it: approval hash
> `Y75UDPAF34BUYCVMAXDXYFN5GVC5WNFMB47UKAX3Q5WKJ3PYG5ZEM4SAEQ`, byte-identical to the audited contract; `musd_asa_id` = 3615600399,
> fixed at creation with no setter; founder = the MagnetFi admin wallet;
> schema 3 uints / 2 byte-slices; opted in to mUSD holding none; 200,000 µALGO
> spare over its minimum balance, exactly as the audits predicted.

> **UVote is retired.** The previous generation (App `3679681107`) voted with
> **$U** and is no longer written to. It stays readable so its one closed
> proposal survives as history, tagged with the asset its tally is denominated
> in. Retiring it stranded nobody: measured against mainnet 2026-11-05 it holds
> 0 $U with 0 outstanding vote boxes, and its proposal closed 2026-08-27. The
> reclaim path still points at it regardless — see "Why the claim path stays".

---


## Where the Live proposals pill lives

In the **mUSD hero**, top right, since 2026-11-07. (It sat beside an "About
mUSD" button until that modal was replaced by an inline paragraph the same
day.) It rode in the
Magnet Token hero on /strategy for three days, on a discovery argument: that
page had the traffic and nothing else in the nav pointed at a vote. Voting is
weighted by mUSD, so the holder who can act on the count is the one reading
the mUSD page — and the Governance pill it opens is on that same page.

**It needs an explicit event, not just its href.** Pressing it is now a
same-page navigation, and Next routes a hash change through the history API
without firing `hashchange` — so `TokensView`'s listener never ran and the
pill set the URL while leaving Exchange selected. A live count above a button
that did nothing.

## The dot on the Governance pill

**Since 2026-11-08 the Governance pill itself carries a pulsing dot whenever a
vote is open.** The hero pill said so already, but only from the Mint tab, and
the pill row is what a reader scans to decide where to go — a vote could be
open with nothing in the navigation suggesting it.

It is deliberately the *same* dot as the hero pill's: same size, same shape,
same pulse, so "a vote is open" reads as one vocabulary rather than two
different notifications. It adds a halo, because on the pill row it carries
the message alone — the hero pill has a number and the word "proposals" beside
it. On the selected pill it turns white; `magnet-400` on that pill's
magnet-600→500 gradient is purple on purple. An `sr-only` span makes the
button announce itself as "Governance, a proposal is open".

**One count, three consumers.** The dot, the hero pill and this section all
read `useLiveProposalCount`, which wraps the module-level store — so the dot
costs no extra network read and cannot disagree with the number beside it.
That hook also owns the 15-second re-render that notices a window *closing*:
`isActive` compares `endTime` to the browser clock, nothing in the store
changes when that crosses, and a component re-rendering only on store updates
goes on advertising a closed vote. That timer had been written twice and
missed once before it was hoisted.

The dot shows on `count > 0` even when a read came back `incomplete`. An
unreadable era means the count may be *low*, but every proposal counted was
actually read — the hero pill prints a dash there because it claims a total,
while a dot claims only "at least one", which survives.

That shipped nowhere: it was caught by clicking the pill in a real browser
before the push. A jsdom test passed throughout, because it dispatched
`hashchange` by hand — the one event the real navigation does not produce.
The pill now dispatches `OPEN_GOVERNANCE` as well as navigating, and both
sides of that contract are tested. **Simulation is not a signature** applies
to UI events as much as to signing.

`TokensView` also keeps the URL in step with the selected pill, so the hash
can no longer go stale against the view.


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
execution authority; mVote produces a clear, on-chain mandate that guides decisions.
(It said UVote until 2026-11-08 — that contract is retired, and the sentence defining
the current model was still naming it.)
Framing every proposal honestly as advisory keeps expectations calibrated and keeps
the protocol inside the trust model its contracts were audited against.

**How a vote works:**

| | |
|---|---|
| **Who proposes** | Founder only. One open question with 2–4 choices. |
| **Window** | Fixed **7 days** per proposal; one active proposal at a time. |
| **How you vote** | Lock **whole mUSD** at the moment you vote — **1 mUSD = 1 vote** (your weight is the amount you lock). The minimum vote is therefore $1. |
| **One vote per wallet** per proposal. Fractional mUSD isn't accepted (whole tokens only). |
| **Reclaim** | After the window closes, you reclaim your locked mUSD **in full**, plus the refundable 0.0269 ALGO box deposit you funded when voting. Network fees (~0.006 ALGO) are not refunded. |
| **Binding?** | No — advisory. Nothing executes on-chain from the result; the founder acts on the mandate. |

**Locking, not perpetual staking.** You lock mUSD *as the act of voting*, and it stays
locked only for the remainder of that proposal's window. It is not staked, delegated,
or at risk — it simply signals conviction and prevents double-counting.

---

## Guarantees for voters

These are properties of the deployed contract (see [SPEC.md](./SPEC.md)
for the audited detail), stated plainly:

- **Your mUSD always comes back.** The only way mUSD leaves the contract is *you*
  reclaiming your own recorded amount after the window closes. There is no founder
  sweep or admin path that can move locked voter funds.
- **No expiration on reclaim.** There is no deadline to claim; locked mUSD sits safely
  and is reclaimable at any time after the vote closes — waiting longer never risks
  it. (Practical caveats: keep your wallet, and stay opted into mUSD to receive it —
  a closed-out holding makes the inner transfer fail until you opt back in.)
- **Nobody can block a reclaim, including us.** mUSD has no freeze address and
  no clawback address, and on Algorand an address left unset at asset creation
  can never be set afterwards. `contracts/mvote/check_musd_asset.py` re-measures
  this against mainnet; it is the single assumption the guarantee rests on.
- **Immutable & non-deletable.** The app cannot be upgraded or deleted, so the rules
  you voted under can't be changed out from under you.
- **Two independent audits passed** (build + a post-deploy adversarial pass) with no
  Critical/High findings; all three invariants — no vote manipulation, no lost funds,
  always reclaimable — hold in the live contract.

---

## Relationship to the tokens and the treasury

- **mUSD is the governance token.** Holding mUSD is what lets you participate;
  weight is proportional to how much you lock, one whole mUSD to one vote.
- **$U is no longer a governance token.** Its utility is collateral and LP
  anchor across MagnetFi, plus the strategy itself. That is a narrowing, and a
  deliberate one — see "Why mUSD rather than $U".
- **Treasury.** Proposals often direct how the Magnet Strategies treasury deploys
  liquidity. The treasury's live USDC balance is shown inside the "How voting works"
  panel on the Governance pill, paired with the reader's own vote power, so a voter
  sees the pool a decision is directing beside the weight they would bring to it. It
  moved there from the token metric rows on 2026-11-08 and is shown in one place
  only — two copies on one page invite the question of which is current. Treasury
  deployment remains a founder action informed by the vote.

---

## The mUSD pivot — done

**Shipped 2026-11-05.** Voting moved from $U to mUSD.

### Why mUSD rather than $U

- **It gives mUSD a use beyond the peg.** A reason to hold the stablecoin that
  is not yield is a reason to mint it.
- **$U keeps its scarcer jobs.** Collateral and LP anchor across MagnetFi,
  where locking supply for a voting window has a cost mUSD does not carry.
- **Vote-buying is not free, and the PSM is why.** mUSD is minted through our
  own UI at **0% fee** and redeemed at **100 bps**, so acquiring voting weight
  and leaving again costs 1% — small, but not nothing, and it is revenue to the
  protocol rather than to a market maker.
- **The real defence is structural.** Voting is **advisory and founder-led**:
  the founder writes the question, writes the choices, and is not obliged to
  act on a result they disagree with. A bought vote buys a signal, not an
  outcome.

### Why a new contract rather than a reconfigured one

`magnet_asa_id` was set at creation and has **no setter**, deliberately: an app
that can be repointed at another asset is an app whose locked balance and
recorded debts can be made to disagree. So mVote is a separate deployment, and
`musd_asa_id` is fixed the same way.

### Why the claim path stays pointed at the retired app

Nobody has an outstanding $U lock — that was measured, and the measurement is
about one moment. A stranded voter is forever. `claimTokens` takes an era and
works against either generation, so a $U lock that somehow existed could still
be reclaimed through the live UI. It costs a few lines and removes the whole
question.

### What a future asset change would require

The same thing this one did: a new app, a new era in `governance.ts`, and the
old one marked `retired`. The era model exists so that is additive rather than
a migration — proposals carry their own asset and decimals, so two generations
can be displayed side by side without either lying about the other's numbers.

---

## Lifecycle at a glance

1. **Founder creates a proposal** (question + 2–4 choices) — opens a 7-day window.
2. **Holders vote** — lock whole mUSD on a choice; the tally updates on-chain.
3. **Window closes** (7 days) — voting ends; results are final and visible.
4. **Founder acts** on the advisory mandate.
5. **Voters reclaim** their mUSD (and box deposit) at any time after close.

---

## Further reading

- [SPEC.md](./SPEC.md) — contract internals, box layout, transaction
  shapes, the two audit passes, and the deploy record (App `3679681107`).
- [TOKENOMICS.md](../org/TOKENOMICS.md) — $U roles across the protocol (governance is no longer one).
- [Treasury](../org/TREASURY.md) — funding and deployment of protocol capital.
- Frontend: `web/src/components/tokens/GovernanceSection.tsx`, with the proposal
  and voting UI in `web/src/components/vote/` — see [web/README.md](../web/README.md).
