# VPL — operations

Deployment, key inventory, the redeploy loop, and the planned migration off the local
machine. Written before it is needed, because the migration is a known future step and
the key handling only works if it is planned rather than improvised.

---

## Key inventory

Three keys, three different things, three different risk profiles. They should never
share a machine long-term.

| Key | What it is | What it can do | What it cannot do |
|---|---|---|---|
| **Oracle signing key** | A raw ED25519 keypair. **Not an Algorand account** — no address, holds no funds, never signs a transaction | Sign the attestation preimage. Because `lock`/`resolve` are permissionless, whoever holds it can settle a round at a price of their choosing without needing any other credential | Nothing stops it. What bounds it is that a false settlement is permanent on-chain beside four checkable venue quotes |
| **Keeper wallet** | An Algorand account | Submit `lock`, `resolve`, `create_round`, payout batches. Holds a small ALGO float for fees | Fabricate a price. Without the oracle key it can only relay what was honestly signed |
| **Admin wallet** | An Algorand account | Set rake, band bounds, treasury, min stake; sweep rake and excess mUSD; withdraw operating ALGO to the floor; pause; void an empty or OPEN round | **Take user escrow — no code path exists.** It *can* repoint `oracle_pubkey`, which buys the oracle attack one round later. That is why admin must not live on a keeper host |

**Ranking: oracle key ≫ admin ≫ keeper wallet.**

Admin stays cold — desktop or hardware wallet, used rarely. A compromised keeper host
should yield the ability to sign prices, not the ability to also make that permanent
for every future round.

---

## Pre-flight

Run before touching mainnet.

1. **Venue reachability from the host that will run the keeper.** Execute
   `keeper/vplkeeper/prices.py`'s `read_all` against a recent completed minute and
   confirm **all four** venues return a candle. Three is the quorum floor — landing
   there with no margin means one venue hiccup voids a round.
2. **Confirm mainnet mUSD still satisfies bootstrap's asserts:** asset `3615600399`,
   6 decimals, unit name `mUSD`, and **clawback and freeze both the zero address**.
   Those last two are what make the MagnetFi isolation hold in both directions.
3. **Generate the oracle key on the host that will use it.** Back up only the *public*
   key — that is what `bootstrap` takes. Never copy the private key anywhere.
4. Fund the admin and keeper wallets.

---

## Deployment

`bootstrap` is **one-shot and irreversible**, and `MUSD_ASSET_ID` is substituted at
deploy. Getting either wrong bricks the deployment. Check this transaction twice.

```
1. create_application          from admin, extra_program_pages=2
2. fund the app account        see below
3. bootstrap(...)              deploy_time_params={"MUSD_ASSET_ID": 3615600399}
                               emits an inner opt-in to mUSD
4. create_round(...)           first round; checkpoints must be minute-aligned
```

**App account funding.** Minimum balance is roughly:

| | µALGO |
|---|---|
| App base | 100,000 |
| 2 extra program pages | 200,000 |
| 15 global uints | 427,500 |
| 6 global byte slices | 300,000 |
| mUSD opt-in | 100,000 |
| **Subtotal** | **~1,127,500** |
| Round box, per live round (up to 2) | 128,900 each |

Fund with **10 ALGO** to start. The floor in `withdraw_operating_algo` already reserves
position deposits, payout fees, round-box headroom and a bounty, so surplus above that
is withdrawable later.

---

## The redeploy loop

The contract is non-upgradeable **and non-deletable**. Every fix is a new deployment at
a new app ID, and the old one cannot be removed. Expect the first deployment to be
throwaway and plan for several during debugging.

**Draining before abandoning** — do not walk away from a contract holding mUSD:

```
1. stop creating rounds
2. OPEN round        -> admin_void_round (full refunds, no rake)
   LOCKED round      -> resolve normally, or let it void at the deadline
3. settle / close / refund every position
4. cleanup_round each round
5. sweep_rake, then sweep_excess_musd
6. withdraw_operating_algo down to the floor
```

**Each abandoned deployment permanently strands its minimum balance** — about 1.13
ALGO, unrecoverable because `DeleteApplication` is rejected unconditionally. Small, but
it is the price of the non-upgradeable guarantee and it is worth knowing before the
third redeploy rather than after.

Attestations do not carry across deployments: `app_id` is inside the signed preimage,
so an old attestation cannot be replayed against a new app. That is the domain
separation working as intended.

---

## Phase 1 — local (current)

The keeper runs on the local desktop alongside MagnetFi's LP oracle.

**Availability is fine.** VPL is built to tolerate a flaky host: the keeper has a full
hour to backfill `lock` and 72 hours for `resolve`, because attestations are pinned to
their checkpoint and candles are historical data. A reboot or a dropped connection does
not cost a round.

**The known exposure is co-location.** VPL is new code with a fresh dependency tree
making scheduled outbound calls to four exchange APIs — a larger unknown attack surface
than a mature oracle. While it shares a machine with MagnetFi's oracle key, a
compromise through VPL reaches the more valuable key. The contract-level separation
(separate oracle app, separate key, snapshotted per round) does not hold if the private
keys sit in one place.

Bound it:

- Run the VPL keeper as its **own Unix user**, own home directory, key file mode 600
- Keep the phase short — days to a couple of weeks, with a migration date
- Soft launch only: your own mUSD, nothing pointed at it publicly

---

## Phase 2 — migrate to a VPS

Before any public showcase. **The key is rotated, never copied.**

```
1. Provision the VPS. US datacenter. SSH keys only, no password auth,
   unattended security updates, nothing else installed.
2. Run the venue reachability check FROM THE VPS. All four must respond.
3. Generate a NEW oracle key on the VPS. Never move the old one.
4. Create a NEW keeper Algorand account on the VPS; fund it with ALGO.
5. Wait for the current round to RESOLVE. Do not rotate mid-round.
6. set_oracle_pubkey(new public key)   <- from admin, cold
   set_keeper(new keeper address)
7. create_round -> snapshots the new key
8. Start the VPS keeper. Stop the local one. Retire the old key.
```

Rounds snapshot `oracle_pubkey` at creation, so a rotation between rounds means no
round ever sees two keys. The snapshot exists to stop an admin changing a key
mid-round; it is also what makes a clean handoff possible.

**MagnetFi's oracle stays where it is.** Do not migrate a working production system to
accommodate a new one. If it should move to a hardened host, that is its own project
and its own box — not this one.

---

## Keeper obligations

Three things the contract structurally cannot enforce. Each is a defect if the keeper
gets it wrong. Full detail in [`keeper/README.md`](./keeper/README.md).

1. **Sign once per `(round_id, checkpoint)`.** Persist it. Resubmit identical bytes on
   retry — never re-sign. Two valid signatures for one checkpoint hand a permissionless
   relayer a choice of medians.
2. **Over-pay fees on `lock` and `resolve`.** Signature verification needs opup funded
   from group credit; the minimum fee fails. Budget ~5,000 µALGO.
3. **Pad batches to four app calls, using `noop`.** Readonly methods never reach the
   submitted group.
