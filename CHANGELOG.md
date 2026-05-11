<!-- SPDX-License-Identifier: MIT -->

# Changelog

All notable changes to this CLI ship here. Versioning follows [SemVer](https://semver.org/), with the understanding that until `v1.0.0` the spec (and therefore the predicate shape + on-disk artefact format) may still change between minor versions.

Releases on npm: <https://www.npmjs.com/package/@better-internet/oss-verify>
Bun standalone binaries: GitHub Releases on this repo.
Container image: `ghcr.io/better-internet-org/oss-verify:<tag>`.

## [Unreleased]

### Notes

Anything merged to `main` between releases lands here. Tagging `v*` cuts a release; the workflow at `.github/workflows/release.yml` publishes npm + binaries + Docker on the tag.

## [0.1.1] — 2026-05-11

### Fixed

- `src/git.ts` bumps `execSync` `maxBuffer` from the 1 MiB default to 64 MiB.
  Previously `git ls-files --cached --exclude-standard` against any repo with
  more than ~15k files (e.g. posthog at 21k) threw `ENOBUFS` synchronously
  before `--report-json` could emit a JSON status report, so the watchlist
  runner saw a stack trace instead of `{ overall_pass: false, ... }`.

## [0.1.0-draft] — 2026-05-11

First public release. Everything below predates this tag — the changelog starts here.

### CLI

- Deterministic checks for the 4 SPEC §3 criteria:
  - REUSE compliance (every text file carries `SPDX-License-Identifier`, with skip patterns for license files, lockfiles, and JSON).
  - OSI-approved declared license — `package.json` or LICENSE file's SPDX header validated against `spdx.org/licenses/licenses.json` (filtered by `isOsiApproved`).
  - OSI-only dependency tree (SBOM). Per-ecosystem detectors at `src/checks/sbom/`:
    - JavaScript: walks `node_modules` from root `package.json#dependencies`, Node's resolution algorithm, handles pnpm strict mode.
    - Cargo: parses `Cargo.lock`, looks up licenses from crates.io.
    - Go modules: parses `go.mod` + `go.sum`, looks up licenses from deps.dev.
    - Python: detects `uv.lock` / `poetry.lock` / `Pipfile.lock` / `requirements.txt`; license lookup from PyPI, prefers Trove `License :: OSI Approved :: ...` classifiers.
  - No proprietary blobs — extension blocklist, minified-without-source detection, Shannon entropy ≥7.5 on >100KB files.
- LLM audit (SPEC §7) with three-pass majority voting at temperature=0, mandatory per SPEC §4. Validates `model_id` against `spec/models.json`. Anthropic Messages API.
- In-toto predicate emission with `cli_version` + `cli_sha` + `model_id` + `prompt_hash` for reproducibility.
- `--report-json` mode for the operator-side watchlist: full conformant pipeline, JSON status output, never gates exit on pass/fail.

### Distribution

- npm: `npm install -g @better-internet/oss-verify`. Published with Sigstore-attested provenance via GitHub Actions trusted-publisher path.
- Bun standalone binaries: linux-x64, linux-arm64, macos-arm64, windows-x64. Attached to GitHub Releases.
- Docker: `ghcr.io/better-internet-org/oss-verify`. Multi-arch (amd64 + arm64), node:22-alpine base.
- GitHub composite Action at the repo root: `uses: better-internet-org/oss-verify@v1`.
- GitLab CI include at `gitlab-ci/oss-verify.yml`.

### Spec

- Vendored normative SPEC + supporting files (`spec/`):
  - `SPEC.md`, `ci-providers.json`, `models.json`, `schemas/predicate.schema.json`, `contexts/v1/oss-verified.jsonld`.

### Adversarial corpus

- Four synthetic fixtures (`test-corpus/adv-*`) that pass deterministic checks but hide a licensing/integrity violation the LLM should catch (NOTICE conflict, obfuscated payload, vendored proprietary, README contradiction). Runner enforces SPEC §7.4 exit criterion (≥3/N caught).

### Third-party verifier

- `tools/verify-vc.mjs` — zero-dependency Node 22 script that validates an `OssVerifiedCredential` end-to-end (DID resolution, signature, JCS canonicalization, multibase decode, Ed25519 verify). Confirms a third-party verifier with no shared dependencies reaches the same verdict as the issuing Worker.
