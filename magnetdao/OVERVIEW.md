# Magnet Strategies — Overview

## What is Magnet Strategies?

Magnet Strategies is an Algorand-native DeFi organization founded in June 2025, built on years of hands-on Algorand DeFi experience dating back to the inception of DeFi on the Algorand blockchain. Its core objective is to grow the value of the Magnet token ($U) at a rate that outpaces ALGO itself — through diversified yield strategies rather than a single bet.

Active strategies include:
- **Strategic liquidity pools** — DEX LP positions that generate continuous swap fees (governed by MagnetDAO)
- **Liquid staking & node rewards** — Algorand consensus participation income
- **Stablecoin lending** — yield on stable positions within the Algorand ecosystem

A Bazooka Labs product.

---

## MagnetDAO

MagnetDAO is the liquidity governance arm of Magnet Strategies. It operates on a quarterly cycle: projects apply for treasury-backed liquidity, the community discusses and votes, and winning proposals receive a Magnet-paired DEX deployment. LP fees flow back to the treasury and compound into future cycles.

For $U holders, this means passive exposure to many of Algorand's top projects through Magnet's liquidity pairings — without managing individual positions.

---

## The Magnet Token

| Field | Value |
|---|---|
| Name | Magnet |
| Ticker | $U |
| ASA ID (mainnet) | 3081853135 |
| Total Supply | 750,000 $U |
| Decimals | 5 (1 $U = 100,000 base units) |
| Decimal factor | 100,000 |
| Network | Algorand mainnet |
| Founded | June 2025 |

$U serves as both the governance token (1 $U = 1 vote in MagnetDAO) and the anchor asset in every treasury-deployed liquidity pool.

---

## Treasury

The treasury is funded by revenue from Bazooka Labs' applications, allocated quarterly. Treasury is held at the founder wallet and deployed into Algorand DEX liquidity pools upon proposal approval.

**Founder/Treasury Wallet:** `VM2JLZMKFLE635FXX54MU4TY6JUDIMLNRXOQDZUX3FKUFLS2BPEO2VL7QM`

Treasury capital is deployed by acquiring the winning project's token and pairing it with Magnet in a DEX liquidity pool. DEX selection is flexible per deployment (TinyMan, etc.).

---

## On-Chain Systems

### 1. Liquidity Application Portal

Projects apply for treasury liquidity by submitting a signed Algorand payment transaction to the founder wallet. The application payload is JSON-encoded in the transaction note field with a known prefix.

- **Note prefix:** `magnet-apply:v1:`
- **Payload fields:** `name`, `asaTitle`, `asaId`, `description`, `contact`
- **Submission fee:** 0 microALGO above the standard network fee (adjustable via `APPLICATION_FEE` constant)
- **Visibility window:** 6 months from submission date
- **Read method:** Algorand Indexer note-prefix query on the founder wallet's transaction history

### 2. Governance Voting Contract

Token-locking on-chain voting for governance decisions. The Founder creates ballot proposals; $U holders vote by locking tokens in an atomic transaction group.

**Security audit completed 2026-05-22.** Two medium findings (missing co-signer check in `cast_vote`, votes for non-existent choices) and two low findings documented in TODO.md under "v2 Contract". Current risk is low; fixes targeted for v2 deploy before significant voting volume.

**Deployed contract (mainnet, live as of 2026-05-15):**
- **App ID:** 3554779766
- **Contract address:** `OKJJKZER5Z2DQY4655PST3WHFQRB6UQARP4QGXBAYQFJJCZLY27KMR5YAM`
- **Founder:** `VM2JLZMKFLE635FXX54MU4TY6JUDIMLNRXOQDZUX3FKUFLS2BPEO2VL7QM` (accepted on-chain 2026-05-15)
- **Source:** `contracts/voting/voting.py`
- **Deploy script:** `contracts/deploy_voting.py` (requires `FUNDER_MNEMONIC` env var)

**Mechanics:**
- Founder calls `create_proposal` with question + 2–4 choices
- Vote window: 7 days from creation
- Voters cast by sending an atomic group: AppCall (`cast_vote`) + AssetTransfer (whole $U tokens locked in contract)
- Only whole $U tokens accepted — fractional dust stays in voter's wallet
- One vote per wallet per proposal, enforced by BoxCreate existence check
- After the window closes, voters call `claim_tokens` to retrieve locked $U (fee-pooled inner ASA transfer, outer fee = 2000)
- Proposal boxes remain on-chain permanently as governance history

**Box layout:**
- Proposal box: `prop_{uint64_id}` — 304 bytes
- Vote box: `vote_{proposal_id_bytes}{voter_pubkey}` — 16 bytes (choice index + locked amount)

---

## Web Application

**Live URLs:**
- Landing page: https://magnetstrategies.io
- DAO app: https://magnetstrategies.io/dao

**Stack:** Next.js 14.2.35 · TypeScript · Tailwind CSS · algosdk v3 · @txnlab/use-wallet-react v4 · sonner (toast notifications)

### Route Structure

| Route | Description |
|---|---|
| `/` | Magnet Strategies landing page — full-bleed background, live stats, action cards (Vestige, TinyMan, MagnetDAO), social links, About modal, "A Bazooka Labs Product" link |
| `/dao` | MagnetDAO home — hero + "A Bazooka Labs Product" link + governance info (quarterly cycle, voting rules, founder authority, token info cards) |
| `/dao/proposals` | Liquidity application submissions + active/past governance votes |
| `/dao/treasury` | Live USDC stats, daily balance chart with time-range selector (30D/90D/6M/All), governance vote history |

### Key Components

| File | Purpose |
|---|---|
| `AboutModal.tsx` | Landing page — purple-tinted button + modal with Magnet Strategies / MagnetDAO overview copy and risk disclosure |
| `Navbar.tsx` | DAO app navbar — "Magnet Strategies" brand linking to `/`, gradient magnet icon, wallet connect |
| `Footer.tsx` | DAO app footer — "Magnet Strategies" / "A Bazooka Labs Product", X and Discord links |
| `ApplyModal.tsx` | Wallet-signed payment tx with note-field JSON payload; shows Lora transaction link on success |
| `ApplicationCard.tsx` | Collapsible card for each liquidity application; includes Lora transaction link |
| `CreateProposalModal.tsx` | Founder-only — fetches `proposal_count` to build correct `prop_` box name, sends `create_proposal` AppCall |
| `VotingProposalCard.tsx` | Per-proposal vote display and claim button; toast notifications on success/error; Lora contract link in footer; `claim_tokens` uses flat_fee=true, fee=2000 |
| `VoteModal.tsx` | Atomic group: cast_vote AppCall + whole-token AssetTransfer; declares both `prop_` and `vote_` boxes; toast notifications on success/error |
| `ClaimFounderButton.tsx` | Visible only to pending founder; calls `accept_founder` on-chain; uses raw REST API (not algosdk) for global state reads |
| `TreasuryChart.tsx` | SVG line chart — daily USDC balance history anchored to current balance; 30D/90D/6M/All range selector |

### Data Sources

| Data | Source | Cache |
|---|---|---|
| Magnet TVL | Vestige API (`api.vestigelabs.org`) | 1h |
| Holder count | Algorand Indexer (paginated balances query) | 1h |
| $U price in USDC | Vestige × CoinGecko ALGO/USD | 5min |
| Treasury USDC balance | algod account query | 1h |
| USDC balance history | Indexer tx history anchored to current balance | 24h |
| Total USDC inflows | Indexer — sum all USDC receiver txns on founder wallet | 24h |
| Liquidity applications | Indexer note-prefix query on founder wallet | live (client fetch) |
| Voting proposals / boxes | Indexer box reads on voting contract | live (client fetch) |
| Proposal count | algod global state on voting contract | 1h |

### Constants (`web/src/lib/constants.ts`)

```ts
VOTING_APP_ID = 3554779766          // mainnet voting contract
VOTING_NETWORK = "mainnet"
MAGNET_TOKEN.asaId = 3081853135     // mainnet ASA
MAGNET_TOKEN.totalSupply = 750_000  // display units
MAGNET_TOKEN.decimals = 5
MAGNET_TOKEN.decimalFactor = 100_000
FOUNDER_ADDRESS = "VM2J..."         // treasury + admin gating
APPLICATION_NOTE_PREFIX = "magnet-apply:v1:"
APPLICATION_FEE = 0                 // raise if spam becomes an issue
VOTE_DURATION_SECONDS = 604800      // must match voting.py VOTE_DURATION
```

### Wallet Config (`web/src/hooks/useWallet.tsx`)

- `defaultNetwork: NetworkId.MAINNET`
- `options: { resetNetwork: true }` — overrides any cached testnet session in localStorage
- Both MAINNET and TESTNET algod entries kept in `networks` to prevent session-resume crashes
- Supported wallets: Pera, Defly, Lute, Kibisis, Exodus

---

## Design System

**Theme:** Electric purple neon (`#a855f7`) on near-black background (`#08000f`) with radial purple vignette. Tailwind custom color `magnet-*` maps to purple-500 range.

**Landing page:** Full-bleed background image (`magnet-bg.png`), Times New Roman title, white divider, social icons (X + Discord), About modal button, stat cards, action cards with hover lift effect, "A Bazooka Labs Product" link (bazookalabs.xyz) at bottom.

**DAO app:** Navbar with gradient magnet icon + "Magnet Strategies" brand. "A Bazooka Labs Product" link below hero subheader. Action cards use `shadow-xl` + `hover:-translate-y-0.5` for depth. Token info cards use `magnet-500/30` borders with inner glow.

**SEO:** Full OpenGraph + Twitter Card metadata on root layout (`/`) and DAO layout (`/dao/*`). Primary share image: `og-banner.png` (landscape, 1902×1056). Square fallback: `og-image.jpg`. Title: "Magnet Strategies" / "MagnetDAO | Magnet Strategies". Description: tagline.

---

## Social & Community

- **X / Twitter:** https://x.com/Bazooka_Labs
- **Discord:** https://discord.gg/naqFXmfM

---

## Repository Structure

```
MagnetDAO/
├── OVERVIEW.md             # This file
├── GOVERNANCE.md           # Governance rules and quarterly cycle detail
├── PROPOSAL.md             # Proposal template and requirements
├── TOKENOMICS.md           # Token dual role, distribution, fee model
├── TREASURY.md             # Treasury funding and deployment mechanics
├── TODO.md                 # Pending work items
├── README.md               # Quick-start and links
├── contracts/
│   ├── requirements.txt    # pyteal==0.27.0, py-algorand-sdk
│   ├── deploy_voting.py    # Active deploy script for voting.py (requires FUNDER_MNEMONIC)
│   └── voting/
│       └── voting.py       # Active — deployed to mainnet App ID 3554779766
└── web/
    ├── public/
    │   ├── magnet-bg.png           # Landing page full-bleed background
    │   ├── magnet-logo.png         # Floating animated logo (landing page hero)
    │   ├── vestige.png             # Vestige action card image
    │   ├── tinyman.png             # TinyMan action card image
    │   ├── og-banner.png           # OG/Twitter landscape banner (1902×1056) — primary share image
    │   └── og-image.jpg            # OG square fallback (1351×1248)
    └── src/
        ├── app/
        │   ├── icon.jpg            # Browser favicon (Magnet ASA image)
        │   ├── layout.tsx          # Root layout — WalletProvider, Toaster, full OG/Twitter metadata
        │   ├── page.tsx            # Landing page (/)
        │   └── dao/
        │       ├── layout.tsx      # DAO layout — Navbar + Footer + OG metadata for /dao/*
        │       ├── page.tsx        # DAO home + governance (/dao)
        │       ├── proposals/
        │       │   └── page.tsx    # Proposals page (/dao/proposals)
        │       └── treasury/
        │           └── page.tsx    # Treasury page (/dao/treasury)
        ├── components/
        │   ├── AboutModal.tsx
        │   ├── Navbar.tsx
        │   ├── Footer.tsx
        │   ├── TreasuryChart.tsx
        │   ├── ApplyModal.tsx
        │   ├── ApplicationCard.tsx
        │   ├── CreateProposalModal.tsx
        │   ├── VotingProposalCard.tsx
        │   ├── VoteModal.tsx
        │   ├── ClaimFounderButton.tsx
        │   └── ui.tsx
        ├── hooks/
        │   └── useWallet.tsx
        └── lib/
            └── constants.ts
```
