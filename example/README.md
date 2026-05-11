<!-- SPDX-License-Identifier: MIT -->

# oss-verified test fixture

A minimal example repository that should produce a green oss-verified badge:

- MIT license declared in `package.json` + `LICENSE`
- Every source/text file carries an SPDX-License-Identifier header
- No proprietary blobs

To use as your dummy repo:

1. Copy these files (plus `.github/workflows/oss-verify.yml`) into a fresh
   GitHub repository — e.g. `<you>/oss-verified-test-fixture`.
2. Push to `main`. The workflow installs the `oss-verify` CLI from
   `gitlab.c9group.org/betterinternet/oss-verified`, runs the deterministic
   checks, signs the resulting predicate via Sigstore (cosign keyless), and
   commits the bundle to `.oss-verified/attestation.bundle`.
3. Visit `https://oss-verified-staging.better-internet.org/badge/github/<you>/oss-verified-test-fixture`.
   The Worker fetches the bundle, validates the predicate, and renders the
   SVG. Should be green.
