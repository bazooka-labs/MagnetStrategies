# Proposals Page — Design & Implementation Spec

> Authored: Claude Sonnet 4.6 — 2026-05-03
> Status: Approved for implementation

---

## Overview

The Proposals page is split into two independent but related systems:

1. **Liquidity Application Portal** — Algorand-native projects apply for Magnet treasury liquidity via a signed on-chain transaction.
2. **Governance Voting** — The Founder creates simple ballot proposals that Magnet holders vote on by temporarily locking their tokens.

These two systems serve different audiences. The Application Portal is for *external* projects pitching to the DAO. The Voting system is for *internal* Magnet holders deciding DAO direction.

---

## System 1: Liquidity Application Portal

### Design Goals
- Any Algorand project can apply for Magnet liquidity
- Applications are publicly visible on the website for 6 months
- No backend or database required — all data lives on-chain
- Spam is deterred by requiring a wallet signature and paying a network fee
- The submission fee can be raised to any amount if spam becomes a problem

### Mechanism

Applications are submitted as an **Algorand payment transaction** from the applicant's wallet to `APPLICATION_ADDRESS`:

| Field | Value |
|---|---|
| `to` | `APPLICATION_ADDRESS` (treasury/founder wallet) |
| `amount` | `APPLICATION_FEE` (currently `0` microALGO) |
| `note` | `magnet-apply:v1:` + base64(JSON payload) |

The applicant pays only the standard Algorand network fee (0.001 ALGO). Setting `APPLICATION_FEE > 0` adds an additional payment on top of the network fee and can be changed at any time without a contract upgrade.

**Why this works:**
- Requires an actual Algorand wallet — no anonymous bot submissions
- Creates an immutable, publicly verifiable on-chain record
- Zero backend: the indexer IS the database
- Raising `APPLICATION_FEE` is a one-line constant change

### JSON Payload (note field)

```
note = "magnet-apply:v1:" + btoa(JSON.stringify(payload))
```

```json
{
  "name": "Project Name",
  "asaTitle": "Token Name",
  "asaId": 12345678,
  "description": "What the project does and why Magnet liquidity would benefit both parties...",
  "contact": "Discord handle, email, or Twitter"
}
```

Field limits enforced by the frontend:
- `name`: 64 chars
- `asaTitle`: 32 chars
- `asaId`: valid integer
- `description`: 1000 chars
- `contact`: 128 chars

### Reading Applications

Applications are read from the Algorand Indexer at page load (server component, revalidated hourly):

```
GET /v2/accounts/{APPLICATION_ADDRESS}/transactions
  ?note-prefix={base64("magnet-apply:v1:")}
  &after-time={ISO date 6 months ago}
  &limit=50
```

Each transaction's `note` field is decoded and rendered as a collapsible card. Transactions older than 6 months are excluded by the `after-time` query parameter — no client-side filtering needed.

### Display

Applications render as collapsible cards sorted newest-first:
- **Collapsed**: Project Name, ASA Title, submission date
- **Expanded**: Full description, contact info, ASA ID, submitter wallet (truncated), "View on Algorand" link

### Submission Flow

1. User connects Algorand wallet
2. Clicks "Apply for Liquidity" → modal opens
3. Fills out 5-field form
4. Clicks "Submit Application"
5. Frontend constructs payment txn, sends to wallet for signing
6. On confirmation, page refreshes applications list

---

## System 2: Governance Voting

### Design Goals
- Founder creates simple ballot proposals (question + 2–4 choices)
- Any Magnet holder can vote; weight = token balance
- Prevent token movement during voting via temporary lock
- Votes are transparent and on-chain
- 7-day voting window

### Token-Locking Mechanism

To prevent a wallet from voting, moving tokens to a second wallet, and voting again:

When a voter casts a vote, they send their Magnet tokens to the `voting.py` contract as part of an **atomic transaction group**:

```
Group:
  [0] AppCall: cast_vote(proposal_id, choice_index)
  [1] AssetTransfer: voter → contract (Magnet tokens, any amount > 0)
```

The contract:
- Records the vote (choice + locked amount) in a per-voter box
- Prevents double-voting via box existence check
- Holds the tokens until the 7-day vote period ends

After the vote period closes, the voter calls `claim_tokens(proposal_id)` to retrieve their full balance. The lock expiry is always `proposal_end_time` regardless of when they voted — a day-1 voter and a day-7 voter both unlock at the same time (end of the 7-day window).

### Founder Identification

The Founder is identified by wallet address. The frontend compares the connected wallet against `FOUNDER_ADDRESS` (same as `TREASURY_WALLET`). Founder-only UI elements (Create Proposal button) are hidden for all other wallets.

**Important:** Founder identification is frontend-only for UI gating. The smart contract enforces founder-only operations independently via its own `founder` global state key.

### Proposal Lifecycle

```
Founder creates proposal
         ↓
    ACTIVE (voting open immediately, 7-day window starts)
         ↓
  7 days pass (end_time reached)
         ↓
    ENDED (no more votes accepted)
         ↓
  Voters claim their tokens back
```

There is no separate "open voting" step — the vote starts the moment the founder submits the proposal and lasts exactly 7 days.

---

## Smart Contract: `contracts/voting/voting.py`

### Global State

| Key | Type | Description |
|---|---|---|
| `founder` | bytes | Founder's Algorand address |
| `magnet_asa_id` | uint64 | Magnet ASA ID (3081853135) |
| `proposal_count` | uint64 | Total proposals created |
| `pending_founder` | bytes | Pending new founder address (two-step transfer) |

### Box: Proposal (`prop_{id}`)

Fixed size: **304 bytes**

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | `start_time` (uint64, Unix timestamp) |
| 8 | 8 | `end_time` (uint64, start + 604800 = 7 days) |
| 16 | 8 | `votes_a` (uint64, total Magnet weight for choice A) |
| 24 | 8 | `votes_b` (uint64) |
| 32 | 8 | `votes_c` (uint64) |
| 40 | 8 | `votes_d` (uint64) |
| 48 | 128 | `question` (UTF-8, padded) |
| 176 | 32 | `choice_a` (UTF-8, padded) |
| 208 | 32 | `choice_b` (UTF-8, padded) |
| 240 | 32 | `choice_c` (UTF-8, padded, empty = not used) |
| 272 | 32 | `choice_d` (UTF-8, padded, empty = not used) |

### Box: Vote (`vote_{proposal_id_bytes}_{voter_address}`)

Fixed size: **16 bytes**

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | `choice` (uint64: 0=A, 1=B, 2=C, 3=D) |
| 8 | 8 | `locked_amount` (uint64, Magnet tokens locked) |

### Functions

| Function | Caller | Description |
|---|---|---|
| `create_proposal` | Founder | Creates a new ballot with question + 2–4 choices, 7-day window starts immediately |
| `cast_vote` | Any Magnet holder | Atomic group: AppCall + AssetTransfer. Locks tokens, records vote. One vote per wallet. |
| `claim_tokens` | Voter (after end_time) | Returns locked Magnet tokens via inner AssetTransfer |
| `optin_asa` | Founder | Contract opts in to Magnet ASA (called once after deploy) |
| `update_founder` | Founder | Proposes new founder address (two-step) |
| `accept_founder` | Pending founder | Completes founder transfer |

### Security Properties

- **Double-vote prevention**: `BoxCreate` on the vote box returns 0 if box exists — the `Assert` fails, rejecting the second vote
- **Token movement prevention**: Tokens held by the contract cannot be moved during the lock period; `claim_tokens` checks `Global.latest_timestamp() >= end_time`
- **Atomic group integrity**: `cast_vote` verifies `Gtxn[1]` is an AssetTransfer to the contract address with the correct ASA
- **Founder gating**: All administrative functions assert `Txn.sender() == App.globalGet(FOUNDERS_ADDRESS)`

---

## Frontend Architecture

### New Components

| Component | File | Description |
|---|---|---|
| `ApplyModal` | `components/ApplyModal.tsx` | Modal form for liquidity application submission |
| `ApplicationCard` | `components/ApplicationCard.tsx` | Collapsible card displaying a parsed on-chain application |
| `CreateProposalModal` | `components/CreateProposalModal.tsx` | Founder-only modal to create a voting proposal |
| `VotingProposalCard` | `components/VotingProposalCard.tsx` | Ballot card with vote choices, tallies, and vote button |
| `VoteModal` | `components/VoteModal.tsx` | Confirms vote choice, shows token lock amount and expiry |

### Page Layout (`proposals/page.tsx`)

```
┌─────────────────────────────────────┐
│ Section 1: Apply for Liquidity      │
│  "Apply" button (→ ApplyModal)      │
│  [ApplicationCard]                  │
│  [ApplicationCard]                  │
│  ...                                │
├─────────────────────────────────────┤
│ Section 2: Governance Votes         │
│  "Create Proposal" (founder only)   │
│  [VotingProposalCard] active        │
│  [VotingProposalCard] ended         │
│  ...                                │
└─────────────────────────────────────┘
```

### New Constants (`lib/constants.ts`)

```typescript
export const FOUNDER_ADDRESS = "";          // set to treasury/founder wallet
export const APPLICATION_ADDRESS = "";      // same as FOUNDER_ADDRESS for now
export const APPLICATION_FEE = 0;          // microALGO (0 = only network fee)
export const APPLICATION_NOTE_PREFIX = "magnet-apply:v1:";
export const VOTING_APP_ID = 0;            // set after voting.py deployment
export const VOTE_DURATION_SECONDS = 604800; // 7 days
export const APPLICATION_WINDOW_MONTHS = 6;
```

### New Types (`types/dao.ts`)

```typescript
export interface LiquidityApplication {
  txId: string;
  submitter: string;
  submittedAt: number;       // Unix timestamp
  name: string;
  asaTitle: string;
  asaId: number;
  description: string;
  contact: string;
}

export interface VotingProposal {
  id: number;
  question: string;
  choices: string[];         // 2–4 non-empty strings
  votes: number[];           // parallel array, one count per choice
  startTime: number;
  endTime: number;
}

export interface VoterRecord {
  proposalId: number;
  choice: number;
  lockedAmount: number;
}
```

---

## Deployment Phases

### Phase 1 — This Session
- [x] `PROPOSAL.md` documentation
- [ ] `contracts/voting/voting.py` smart contract
- [ ] Updated `constants.ts` with new constants
- [ ] Updated `types/dao.ts` with new types
- [ ] Full proposals page UI overhaul
- [ ] `ApplyModal` — form + on-chain transaction construction
- [ ] `ApplicationCard` — collapsible display
- [ ] `CreateProposalModal` — founder-only ballot creation
- [ ] `VotingProposalCard` — live vote tallies + vote button
- [ ] `VoteModal` — lock confirmation

### Phase 2 — After Wallet Setup
- [ ] Set `FOUNDER_ADDRESS` and `APPLICATION_ADDRESS` in `constants.ts`
- [ ] Applications become submittable on-chain

### Phase 3 — After Contract Deployment
- [ ] Deploy `voting.py` to testnet, set `VOTING_APP_ID`
- [ ] Call `optin_asa` on deployed contract (one-time setup)
- [ ] End-to-end vote flow testing on testnet

### Phase 4 — Mainnet
- [ ] Deploy `voting.py` to mainnet
- [ ] Update `VOTING_APP_ID`, `FOUNDER_ADDRESS`, `APPLICATION_ADDRESS`
- [ ] Adjust `APPLICATION_FEE` if spam becomes an issue

---

## Open Questions

1. **APPLICATION_ADDRESS**: Should applications go to the founder wallet, a dedicated DAO application-inbox address, or the voting contract address? Using the founder wallet keeps things simple. Using a dedicated address is cleaner and separates concerns.

2. **Proposal voting power snapshot**: Currently, vote weight = tokens locked at vote time. This means a whale can vote with 100K tokens and immediately claim them once the period ends. Alternative: snapshot balance at proposal creation time, allow voting without locking. Locking is the stronger anti-gaming mechanism but adds friction.

3. **Claim UX**: After a vote ends, voters must manually call `claim_tokens`. Should the UI show a "Claim your tokens" prompt on the proposals page for any expired votes the connected wallet participated in?
