<!-- SPDX-License-Identifier: MIT -->

# oss-verify

CLI + GitHub Action that produces the [`oss-verified`](https://oss-verified.better-internet.org) badge attestation: deterministic open-source-licensing checks + LLM audit + Sigstore keyless signature.

- **SPEC** (normative): [`spec/SPEC.md`](./spec/SPEC.md)
- **Badge URL**: `https://oss-verified.better-internet.org/badge/github/<owner>/<repo>`
- **Trust model**: Sigstore (bedrock) → W3C Verifiable Credential (portable wrapper). Detail in SPEC §6–§8.

## Use it as a GitHub Action

`.github/workflows/oss-verify.yml`:

```yaml
name: oss-verified
on:
  push:
    branches: [main]
    paths-ignore:
      - ".oss-verified/**"   # cuts the bundle-commit re-run loop

permissions:
  contents: write   # commit the attestation bundle back
  id-token: write   # OIDC for Sigstore keyless

jobs:
  attest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: better-internet-org/oss-verify@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Then visit `https://oss-verified.better-internet.org/badge/github/<your-owner>/<your-repo>` to see the SVG.

## Use it on GitLab CI

Include this template in your project's `.gitlab-ci.yml`:

```yaml
include:
  - remote: "https://raw.githubusercontent.com/better-internet-org/oss-verify/main/gitlab-ci/oss-verify.yml"
```

Required setup: add `ANTHROPIC_API_KEY` as a masked + protected CI/CD variable. The template uses GitLab's `id_tokens` feature for Sigstore keyless signing.

Status: written from the known-good GitHub flow; full end-to-end validation pending a GitLab dummy repo. Open an issue if you hit problems.

## What it checks

Per [SPEC §3](./spec/SPEC.md), the CLI must independently pass:

1. **REUSE compliance** — every source file carries a `SPDX-License-Identifier` header.
2. **OSI-approved declared license** — `package.json#license` or `LICENSE`'s SPDX header resolves to OSI-approved leaves only.
3. **OSI-only dependency tree** — all runtime deps in the SBOM declare OSI-approved licenses. JS ecosystem in this version; Cargo/Go/Python detectors planned.
4. **No proprietary blobs** — extension blocklist + minified-without-source + entropy ≥7.5 for >100KB files.

The LLM audit (SPEC §7) is a second-opinion pass that can BLOCK but not GRANT. Single-pass at temp=0 in this version; SPEC §7.4 three-pass voting is on the roadmap.

## Run the CLI directly

Three install paths:

```bash
# npm (recommended for Node 22+ environments)
npm install -g @better-internet-org/oss-verify
ANTHROPIC_API_KEY=... oss-verify

# Standalone binary (no Node required — downloads ~50 MB)
curl -L -o oss-verify \
  https://github.com/better-internet-org/oss-verify/releases/latest/download/oss-verify-linux-x64
chmod +x oss-verify && ANTHROPIC_API_KEY=... ./oss-verify

# Docker
docker run --rm \
  -v "$PWD:/work" -w /work \
  -e ANTHROPIC_API_KEY \
  ghcr.io/better-internet-org/oss-verify:latest --output predicate
```

Or run from source for development:

```bash
git clone https://github.com/better-internet-org/oss-verify
cd oss-verify
pnpm install
ANTHROPIC_API_KEY=... node --experimental-strip-types src/cli.ts
```

Flags:

| Flag | Behavior |
|---|---|
| `--repo <path>` | Repository root (default: cwd) |
| `--repo-url <url>` | Override repo URL (default: derived from git remote) |
| `--output report\|predicate\|both` | Output format (default: report) |
| `--skip-sbom` | Bypass the SBOM check (use only for non-JS projects until detectors ship) |

`ANTHROPIC_API_KEY` is required — the LLM audit step is mandatory per SPEC §4 and the CLI exits 1 if the key is missing. Override the default model via `OSS_VERIFY_MODEL_ID` (must be on the active allowlist in [`spec/models.json`](./spec/models.json)).

## Example test fixture

[`example/`](./example/) is a minimal MIT-licensed repo that should produce a green badge end-to-end. Copy its content into a fresh GitHub repository to validate the toolchain:

```bash
gh repo create <you>/oss-verified-test-fixture --public --clone
cd oss-verified-test-fixture
cp -r path/to/oss-verify/example/. .
git add . && git commit -m "init" && git push -u origin main
```

The fixture's workflow uses `uses: better-internet-org/oss-verify@main`. After the action runs, the badge at `https://oss-verified.better-internet.org/badge/github/<you>/oss-verified-test-fixture` should render `passing`.

## Trust + transparency

Every attestation is published in [Sigstore Rekor](https://rekor.sigstore.dev) with the Fulcio cert pinned to your CI's OIDC identity. The verify endpoint re-validates that chain on every request:

- Cert chains to a pinned Sigstore Fulcio root.
- DSSE PAE signature verified with the cert's public key.
- Rekor inclusion proof + signed-entry-timestamp verified.
- OIDC issuer pinned to [`ci-providers.json`](./spec/ci-providers.json) (today: GitHub Actions, GitLab CI).
- SAN bound to the specific repo so a cert from another repo can't satisfy this badge.

The full SPEC and the verifier source are public — that's load-bearing. Don't trust a badge program whose verifier you can't read.

## License

MIT. See [LICENSE](./LICENSE).
