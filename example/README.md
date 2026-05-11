<!-- SPDX-License-Identifier: MIT -->

# oss-verified test fixture

A minimal example repository that should produce a green oss-verified badge:

- MIT license declared in `package.json` + `LICENSE`
- Every source/text file carries an SPDX-License-Identifier header
- No proprietary blobs

To use as your dummy repo:

1. Copy these files (plus `.github/workflows/oss-verify.yml`) into a fresh
   GitHub repository — e.g. `<you>/oss-verified-test-fixture`.
2. Set Settings → Actions → General → "Workflow permissions" to **Read and
   write permissions** so the bot can commit the attestation bundle back.
3. Add an `ANTHROPIC_API_KEY` repo secret (Settings → Secrets and variables
   → Actions). SPEC §4 makes the LLM audit mandatory; the workflow fails
   fast if the secret is missing.
4. Push to `main`. The workflow uses the published
   `better-internet-org/oss-verify@main` composite action, which runs the
   deterministic checks, signs the predicate via Sigstore keyless, and
   commits the bundle to `.oss-verified/attestation.bundle`.
5. Visit `https://oss-verified-staging.better-internet.org/badge/github/<you>/oss-verified-test-fixture`.
   The Worker fetches the bundle, verifies the Sigstore chain end-to-end,
   and renders the SVG. Should be green.
