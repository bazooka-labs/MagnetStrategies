# Magnet Strategies — TODO

Last updated: 2026-05-22

---

## Mainnet Launch ✅

- [x] Deploy `voting.py` to mainnet — App ID 3554779766
- [x] Update `VOTING_APP_ID` and `VOTING_NETWORK` in `constants.ts`
- [x] Call `optin_asa` on mainnet voting contract
- [x] 2-step founder transfer — throwaway deployer → real founder via `accept_founder` (2026-05-15)
- [x] Proposal created (founder wallet, 2026-05-15)
- [x] Vote cast (second wallet, 2026-05-15)
- [x] **claim_tokens** — vote window closed 2026-05-22; tokens retrieved successfully, full end-to-end cycle verified

---

## Landing Page (magnetstrategies.io)

- [x] Full-bleed background, Times New Roman title, white divider, subtitle
- [x] Live stat cards — price, holders, TVL
- [x] Action cards — Vestige (chart), TinyMan (swap), MagnetDAO (DAO)
- [x] Social icons — X and Discord
- [x] About Magnet Strategies modal with full copy
- [x] Browser favicon set (Magnet ASA image)
- [x] Custom domain pointed (magnetstrategies.io → Vercel)
- [x] SEO — per-page `<title>` and Open Graph metadata (`og:image`, `og:description`)
- [x] Mobile responsive audit on landing page

---

## DAO App (magnetstrategies.io/dao)

- [x] All routes migrated to `/dao/*`
- [x] Navbar — "Magnet Strategies" brand, gradient magnet icon, links to `/`
- [x] Footer — "Magnet Strategies" / Bazooka Labs, X and Discord links
- [x] DAO home merged with governance page (hero + token info cards + quarterly cycle)
- [x] Token info cards — Magnet Token ($U), Community (holders), Liquidity Deployed (TVL)
- [x] Treasury chart — anchored balance reconstruction fix, 30D/90D/6M/All range selector
- [x] Add toast notifications for transaction success/failure
- [x] Mobile responsive audit across all DAO pages
- [x] Add AlgoExplorer/Lora links on: voting contract, governance vote results, application transactions
- [x] SEO — Open Graph metadata for `/dao/*` routes
- [ ] "Share result" link on completed vote epoch cards (treasury page)
- [ ] "No wallet" state message on vote modal
- [ ] "Copy ASA ID" button on ApplicationCards

---

## Smart Contracts

- [ ] Decide fate of legacy `governance.py` and `treasury.py` — archive or delete
- [ ] Consider migrating `voting.py` from PyTeal 0.27 to PuyaPy for long-term maintainability
- [ ] Add `cancel_proposal` function (founder-only emergency removal)
- [ ] Evaluate future-dated `start_time` support in `create_proposal`

### v2 Contract — Security Fixes (priority order)

> Full audit completed 2026-05-22. Current exposure is low — community is small and known,
> wallet UIs surface transaction details, and no fix requires immediate redeployment.
> Address before significant token volume flows through voting.

- [ ] **[Medium — token theft]** Add `Assert(Gtxn[1].sender() == Txn.sender())` in `cast_vote`
      — without this, a co-signer can be tricked into funding a vote that credits a different wallet,
      which can then claim the co-signer's locked tokens after the window closes
- [ ] **[Medium — tally integrity]** Validate that the chosen option is non-empty in `cast_vote`
      — `choice <= 3` is currently accepted even for 2-choice proposals; votes for empty choice slots
      corrupt the tally (tokens can still be claimed, no theft)
- [ ] **[Low — griefing]** Consider capping concurrent active proposals (e.g. one at a time)
      — founder can stack overlapping 7-day windows, locking voter token circulation for extended periods
- [ ] **[Low — operational]** Monitor contract ALGO balance relative to vote box MBR (~0.027 ALGO/voter)
      — if depleted during an active window, new `cast_vote` calls fail until balance is topped up
- [ ] **[Future]** Add founder emergency token rescue function
      — for recovering tokens from wallets that voted but lost ASA opt-in or wallet access;
      note: introduces trust risk (founder could sweep active votes) — design carefully

---

## Infrastructure

- [x] Vercel deployment configured (deploys from `/Users/kc/MagnetDAO` root, `web/` resolved correctly)
- [x] Custom domain magnetstrategies.io live on Vercel
- [ ] Set up GitHub repo and push codebase
- [ ] Enable Vercel GitHub integration for auto-deploy on `git push main`
- [ ] Add environment variable support for sensitive constants
