# Security

## Secret scanning (mnemonics / keys)

This repo is **public**. A real Algorand mnemonic or private key must never be committed.
Three layers guard against it:

1. **Pre-commit hook** (`.githooks/pre-commit`) — scans staged content on every commit.
   Enable it once per clone:
   ```
   git config core.hooksPath .githooks
   ```
2. **CI** (`.github/workflows/secret-scan.yml`) — re-scans every push/PR, so a commit made
   with `--no-verify` is still caught before merge.
3. **GitHub push protection** — enable in repo Settings → Code security (free on public repos)
   for known token formats (AWS/GitHub/etc.), a server-side net our custom check complements.

The scanner (`scripts/scan_secrets.py`) checksum-validates 25-word Algorand mnemonics with
algosdk (so random word runs are not flagged), and also flags PEM key blocks and hardcoded
`secret_key = "..."`-style assignments. Run it manually anytime:
```
python3 scripts/scan_secrets.py           # all tracked files
python3 scripts/scan_secrets.py --staged  # staged content only
```
False positive? Append `# pragma: allowlist secret` to the line.

## What does NOT belong in this repo (public-safe policy)

This is a **public** repo. The scanner above catches *secrets* (keys/mnemonics), but it does **not**
catch **operational-sensitive information that isn't a secret** — that's a human judgment call. Such
material is a map for an attacker even though no key is exposed, so it stays **out of the repo** and
lives in a private place (private notes, a password manager, a private repo).

**Keep OUT of the public repo:**
- **Infrastructure topology** — where/how the oracle bot (and any service) runs, hosting details,
  IPs, whether it's single-instance vs. redundant.
- **Weak-point inventories** — anything that catalogs what's least hardened or where the soft spots are.
- **Role-labeling of wallets** — don't publish "this address = admin/guardian/treasury/bot." The
  addresses are public on-chain, but a labeled roster hands an attacker the targeting map for free.
- **Incident / mistake logs & post-mortems** — operational history of what went wrong.
- **Runbooks with live specifics** — step-by-step ops procedures tied to the live deployment.

**Fine to keep IN the public repo:**
- Source code (contracts + frontend), and app/asset IDs the app needs to function (public anyway).
- Design docs: how it works, the invariant, the *threat model* (the classes of attack + defenses),
  and public-safe parameters.

Rule of thumb: **if it would help an attacker find or exploit a weakness — or is just operational
reality about the live system — it goes in a private note, not here.** The real fix for a weakness
is *fixing the weakness*, not hiding the note; but don't hand out the map either.

## Test / throwaway keys

Never hardcode a mnemonic — even a testnet burner — in a tracked file. Supply it at runtime via
an environment variable or a **gitignored** file (`.env*`, `*.mnemonic`, `tests/.env.testnet` are
ignored). Example: `export FOLKS_TEST_MNEMONIC="..."` before running the testnet integration test.

## Mainnet keys

Privileged mainnet actions are signed via the connected admin wallet (Pera handshake). No mainnet
seed phrases are ever placed in this repo, in chat, or in any script.
