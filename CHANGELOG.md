<!-- SPDX-License-Identifier: MIT -->

# Changelog

All notable changes to this CLI ship here. Versioning follows [SemVer](https://semver.org/), with the understanding that until `v1.0.0` the spec (and therefore the predicate shape + on-disk artefact format) may still change between minor versions.

Releases on npm: <https://www.npmjs.com/package/@better-internet/oss-verify>
Bun standalone binaries: GitHub Releases on this repo.
Container image: `ghcr.io/better-internet-org/oss-verify:<tag>`.

## [Unreleased]

### Notes

Anything merged to `main` between releases lands here. Tagging `v*` cuts a release; the workflow at `.github/workflows/release.yml` publishes npm + binaries + Docker on the tag.

## [0.1.3] — 2026-05-14

### Fixed

- **LLM audit no longer bursts the Anthropic rate limit.** SPEC §7.4 three-pass voting was firing all three calls with `Promise.all([...])` — a 3× spike against the 30k-tokens-per-minute default tier. Posthog-sized envelopes (~10k input tokens × 3) reliably tripped the ceiling, turning a content audit into a 429 "block" verdict. Calls are now sequential; ~20s slower per project (invisible for a watchlist run) and burst-safe.
- **`callAnthropic` retries transient failures with backoff.** 429 (rate-limit) and 5xx (gateway / server) are now retried up to 3 times. Honors `Retry-After` and `Retry-After-Ms` headers when Anthropic sends them; otherwise exponential backoff with full jitter (1s → 2s → 4s → 8s, capped at 30s). 4xx-except-429 (auth, bad request) remain non-retryable. The blocking-on-failure rationale now suffixes `… after N attempts: …` so debugging distinguishes a single-shot failure from a giving-up retry.

### Operational note

Together these changes turn a typical watchlist-of-three run from "1 of 3 fixtures got past the rate limit" into "all 3 finish cleanly" at the cost of ~60s extra wallclock. Prompt caching (deferred to a later release) would reclaim that time and reduce token spend ~70-90% on the second and third pass per project.

## [0.1.2] — 2026-05-13

### Fixed

Three high-false-positive heuristics, all surfaced by running the CLI against AlistGo/alist (real-world AGPL-3.0 repo with conventional LICENSE file). The criteria reported `3 of 4 failed` when really only one criterion failed.

- **REUSE compliance** (`src/checks/reuse.ts`) now recognises the three valid declaration patterns the REUSE standard itself permits, not only per-file SPDX headers:
  - Per-file `SPDX-License-Identifier` headers (strict REUSE) — existing behaviour.
  - `.reuse/dep5` or `REUSE.toml` repo-level declaration — new; passes without inspecting per-file headers.
  - Root `LICENSE` / `LICENCE` / `COPYING` file with a recognisable license, in the absence of REUSE-format files — new; accepted as a blanket declaration. Resolves the 100% false-positive rate against projects that declare one license repo-wide without REUSE per-file ceremony.
- **OSI license detection** (`src/checks/osi-license.ts`) now falls back to text-pattern detection against the LICENSE body when neither `package.json#license` nor an `SPDX-License-Identifier:` header is present. Catches the ~12 most common OSI licenses (MIT, Apache-2.0, GPL-{2,3}, AGPL-3.0, LGPL-{2.1,3.0}, MPL-2.0, BSD-{2,3}-Clause, ISC, Unlicense) via the distinctive preamble of each license body. Result includes a "(detected via LICENSE text match)" note when this path was used.
- **SBOM unresolved entries** (`src/checks/sbom.ts`) now distinguish "registry lookup failed" from "non-OSI license confirmed" in the details text. Still fails the check (SPEC §3.3 requires verifiable licenses), but is labelled "retry-eligible — these may be OSI-licensed but we can't confirm." Avoids conflating a deps.dev resolution gap with a proprietary-license finding in the reader's mind.

### Added

- `src/checks/license-text.ts`: shared license-text detector used by both `reuse.ts` and `osi-license.ts`. Heuristic regex panel ordered most-specific-first (AGPL before GPL, BSD-3 before BSD-2, etc.).

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
