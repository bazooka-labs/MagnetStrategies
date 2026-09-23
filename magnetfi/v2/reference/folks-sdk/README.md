# Folks Finance SDK — reference extracts

Four source files from the Folks Finance Algorand SDK, kept because they are the
**derivation basis for [FOLKS_ADAPTER.md](../../FOLKS_ADAPTER.md)**.

That spec states byte offsets, scaling factors and an ABI that were reverse-engineered
from these files and then verified against live mainnet state. Without them, the only
way to re-check the derivation is to find the right upstream commit again — and the
adapter's whole trust argument rests on `recoverable_value()` being a non-manipulable
on-chain read, which is exactly the kind of claim a future reviewer will want to verify
from source rather than take on trust.

| | |
|---|---|
| Upstream | https://github.com/Folks-Finance/algorand-js-sdk |
| Licence | **MIT** — permissive, redistribution allowed with the notice below |
| Corresponds to | `src/lend/v2/{types,formulae,utils,deposit}.ts` |
| Captured | ~2026-06, per FOLKS_ADAPTER.md; files dated 2026-07-12 |

## These are not buildable, and are not meant to be

They are **extracts, not a package**. Their imports (`../math-lib`, `../utils`) point at
SDK-internal paths that do not exist here, so nothing compiles or runs. They are read,
not executed. Nothing in this repo imports them, and nothing should.

## Provenance, stated honestly

**The exact upstream commit is not pinned.** These bytes match no published release —
checked against `folks-finance-js-sdk@0.16.3` and `@folks-finance/algorand-sdk@0.2.6`,
neither of which matches — so they came from an unreleased commit. Closest published
comparison, against `folks-finance-js-sdk@0.16.3` `src/lend/v2/`:

| File | Ours | 0.16.3 | Differing lines |
|---|---|---|---|
| `formulae.ts` | 368 | 367 | 5 — effectively the same |
| `types.ts` | 427 | 405 | 48 |
| `deposit.ts` | 644 | 616 | 74 |
| `utils.ts` | 539 | 503 | 312 — substantially evolved |

So the SHA-256 of each file is recorded instead, and it is what a reviewer should check
these against:

```
6f92cd216018d90e4f14c11a3d4a37aae19494bd1f8d41de522a0be62a89c4cc  deposit.ts
9c76a2a86efa46feb0ad60a8d789b10cb3cdafa6f186ed8809e90178b1f6735c  formulae.ts
098e4be73a2fcf07fe3dc2b1e8a66fb53678a722c0f2a0e168bb08a3d9cc80a6  types.ts
ae58822d9d5c0d15dc5bd3279ea696360c4da906e41f0a36635918105270a428  utils.ts
```

**Do not refresh these from upstream casually.** They document what the adapter was
built against, not what Folks ships today. If they are updated, FOLKS_ADAPTER.md's
offsets and constants have to be re-verified against the new copies in the same change —
and per that spec, a mainnet-fork deposit→read→harvest→recall cycle plus the dedicated
adapter audit still gate the adapter regardless.

## Licence notice

Copyright (c) Folks Finance. Licensed under the MIT Licence. These files are reproduced
unmodified for reference; the full licence text travels with the upstream repository.
Nothing here is relicensed, and the Magnet Strategies code that consumes the *findings*
stays under its own terms.
