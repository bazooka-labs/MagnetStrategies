# Vendored dependencies

## `pdex-sdk-0.6.2.tgz`

The PEX TypeScript SDK, packed from a reviewed commit and committed here rather
than resolved from a registry.

| | |
|---|---|
| Source | https://github.com/ultrade-org/pex-ts-pubsdk |
| Commit | `4a55414ea14f9a57069ab68d19387e8c9376b536` ("Release 0.6.2 with safe order cleanup groups") |
| Version | `@pdex/sdk` 0.6.2 |
| SHA-256 | `9a6249c17e7122b81156dd3e7141ce2298da1c1687e86ff8593e9a8f257fa29e` |
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
