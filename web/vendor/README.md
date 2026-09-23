# Vendored dependencies

## `pdex-sdk-0.6.3.tgz`

The PEX TypeScript SDK, packed from a reviewed commit and committed here rather
than resolved from a registry.

| | |
|---|---|
| Source | https://github.com/ultrade-org/pex-ts-pubsdk |
| Commit | `fd046a8470cf818f0d195cdd2b9f8ae28628e044` ("Release 0.6.3 with order receipt codes and integration guidance") |
| Version | `@pdex/sdk` 0.6.3 |
| SHA-256 | `b8712663d7bef734a5b29bab38ac4add15d6b9e58122dcfd4b1044feeff2c240` |
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

**0.6.2 -> 0.6.3.** Additive only: adds the `V2_ORDER_STATUS` and
`V2_ORDER_BRACKET_CLEANUP_REASON` registries and their documentation. No
call-site, receipt-format or contract change. The solver verification was re-run
against it regardless — zero overstatements across 240 randomised cases, same as
0.6.2 — because a change to `quoteV2OpenPosition` is a change to our ceiling, and
that is checked rather than assumed from a changelog.
