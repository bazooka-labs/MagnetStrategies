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

## Test / throwaway keys

Never hardcode a mnemonic — even a testnet burner — in a tracked file. Supply it at runtime via
an environment variable or a **gitignored** file (`.env*`, `*.mnemonic`, `tests/.env.testnet` are
ignored). Example: `export FOLKS_TEST_MNEMONIC="..."` before running the testnet integration test.

## Mainnet keys

Privileged mainnet actions are signed via the connected admin wallet (Pera handshake). No mainnet
seed phrases are ever placed in this repo, in chat, or in any script.
