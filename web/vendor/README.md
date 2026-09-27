# Vendored dependencies

## `pdex-sdk-0.6.4.tgz`

The PEX TypeScript SDK, packed from a reviewed commit and committed here rather
than resolved from a registry.

| | |
|---|---|
| Source | https://github.com/ultrade-org/pex-ts-pubsdk |
| Commit | `f54ebe3` ("Release 0.6.4: validate order time-in-force and document TP/SL") |
| Version | `@pdex/sdk` 0.6.4 |
| SHA-256 | `6f27a590feef2264fc11c9686797c7f54a220da4ade76510eac10fdc4660decc` |
| Built with | `npm pack --ignore-scripts` on a clean tree |

**Why a committed tarball and not a registry or git dependency.** The SDK is not
published to npm. Its README's supported install path is to check out a reviewed
commit, build, pack, and install that exact tarball with dependency lifecycle
scripts suppressed. A `github:` dependency would run the package's own build on
every install, which is the thing that path exists to avoid. Committing the
tarball keeps installs reproducible and offline, and keeps the reviewed artifact
identical to the audited one.

**Upgrading.** Do not bump this in isolation. `PEX_SDK_VERSION` in
`src/lib/perps.ts` is pinned to the same version, and the program hashes pinned
beside it are what make an SDK/contract mismatch visible. Re-run the solver
verification against the new SDK before relying on it — the closed form is
checked against `quoteV2OpenPosition`, so a change in that function is a change
in our ceiling.

**Licence.** PEX Builder License 1.0, source-available. Section 2 grants the
right to distribute the Software in source or compiled form for permitted
purposes; section 4 requires that the licence travel with any distribution,
including inside a browser bundle, with copyright and licence notices preserved.
`LICENSE` is inside the tarball and is preserved by every consumer of it. Nothing
here is relicensed.

**0.6.3 -> 0.6.4. This is the release that resolved B6.** Two source changes,
both additive: `assertV2OrderTimeInForce` on `buildV2SubmitOrderCall` and
`buildV2SubmitLinkedOrderCall`, and a new `INTEGRATION_GUIDE.md`. **No quote,
receipt, or call-site change** — `git diff fd046a8 f54ebe3 -- src/` touches
`src/transactions.ts` and nothing else.

Both halves of B6 were our bugs, and this release is what surfaced them:

- The guard now throws `timeInForce must be GTC (1), GTD (2), or IOC (3); zero
  is not valid` at build time. We had been sending 0. Verified: it throws.
- The guide states that a pair-market entry needs **two separately targeted
  oracle payloads** — entry to Trading, each attached child to OrderOps. We had
  been reusing the Trading payload, which is what failed at `pc=6359`.

The guide also documents `timeInForce` as defaulting to GTC when omitted, so
passing `0` explicitly is what overrode a correct default.

**Verification re-run on 0.6.4**, as this file requires, because a change to
`quoteV2OpenPosition` would be a change to our ceiling:

| Check | Result |
|---|---|
| SDK's own suite | 216 pass |
| Our suite | 197 pass |
| Program pins | no drift |
| Builder address | opted in, 310 ALGO spendable |
| Solver, 240 randomised cases (both markets, both sides, $5–$2,000) | **1 overstatement** |
| Open + take-profit, end to end | assertion 29 checks / 0 findings, simulation `ok=true` |

The single overstatement is `m1 short` at **$5.06** collateral — the solver
offers a ceiling the quote refuses with `collateral_too_small`, and
`confirmCeiling` lands ~35% lower. This is the documented floor imprecision (see
`strategy/perps/AUDIT.md`), **not a 0.6.4 regression**: the release changes no
quote logic at all, so the same case would fail identically on 0.6.3. It does not
reach users, because the card renders `confirmCeiling`'s value and never the raw
solved ceiling.

**0.6.2 -> 0.6.3.** Additive only: adds the `V2_ORDER_STATUS` and
`V2_ORDER_BRACKET_CLEANUP_REASON` registries and their documentation. No
call-site, receipt-format or contract change. The solver verification was re-run
against it regardless — zero overstatements across 240 randomised cases, same as
0.6.2 — because a change to `quoteV2OpenPosition` is a change to our ceiling, and
that is checked rather than assumed from a changelog.
