# oss-verified — Specification

**Version:** 0.1.0-draft
**Status:** Draft for public comment. This is the public-vendored copy; the design plan that motivates it is held internally and not publicly published.
**Editor:** TBD
**Issuer DID (production):** `did:web:oss-verified.better-internet.org`
**Issuer DID (staging):** `did:web:oss-verified-staging.better-internet.org`
**Controller:** `did:web:better-internet.org`

This document specifies the criteria, evidence, and verification procedures for the `oss-verified` badge — a verifiable claim that, as of a specific commit SHA, a software project meets four narrowly-scoped open-source criteria.

**This document is normative.** The internal design plan is informative only and not publicly available; where any reference to it would matter, this document carries the binding text.

## Conformance

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) ([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and only when, they appear in all capitals, as shown here.

## 1. Scope

### 1.1 The claim

The badge asserts, as of commit SHA `S` of repository `R`, that **all four** of the following hold:

1. **REUSE compliance.** Every source file in the tree at `S` carries a machine-readable SPDX licensing record per [REUSE Specification v3.0](https://reuse.software/spec/) or later.
2. **OSI-approved declared license.** The project's primary declared license is on the [OSI-approved list](https://opensource.org/licenses) at the time of attestation. SPDX expression matches an OSI identifier exactly; aliasing or "OSI-equivalent" custom licenses are NOT accepted.
3. **OSI-only dependency tree.** The SBOM generated at `S` contains only OSI-approved licenses for direct and transitive runtime dependencies. Build-only and dev-only dependencies are out of scope (see §3.3).
4. **No proprietary blobs.** The working tree at `S` contains no proprietary binary blobs, minified-without-source bundles, or obfuscated build artifacts (see §3.4 for the precise tests).

### 1.2 Out of scope

The badge does **not** assert any of:

- Reproducible builds.
- Software security posture, vulnerability status, or code quality.
- Project governance, maintainership, funding, or community health.
- License *compatibility* across the SBOM (only that each license is OSI-approved).
- That the project is "good," "production-ready," or "fit for purpose."

Issuers, verifiers, and observers MUST NOT extend the meaning of the badge beyond §1.1.

## 2. Terminology

| Term | Meaning |
|---|---|
| **Issuer** | The program operator. The entity controlling the issuer DID. |
| **Maintainer** | A project owner running the CLI in their CI to attest their project. |
| **Verifier** | Anyone — typically a viewer of the badge — confirming the claim. |
| **Subject** | The repository + commit SHA being attested. |
| **CLI** | The `oss-verify` command-line tool. Lives at <https://github.com/better-internet-org/oss-verify> (public, MIT). |
| **Predicate** | The in-toto predicate JSON object (see §5) signed by Sigstore. |
| **Attestation** | A Sigstore in-toto attestation: predicate + DSSE envelope, recorded in Rekor. |
| **Credential / VC** | A W3C Verifiable Credential (Data Model 2.0) signed by the issuer DID, with custom type `OssVerifiedCredential`. |
| **Rekor** | The Sigstore public transparency log. |
| **Forge** | A git hosting provider — github.com, gitlab.com, codeberg.org, etc. |
| **Allowlist** | A program-published JSON document enumerating accepted CI providers ([`ci-providers.json`](./ci-providers.json)) or LLM models ([`models.json`](./models.json)). |

## 3. The four criteria

### 3.1 REUSE compliance

The CLI MUST run a REUSE lint at `S` against the v3.0 or later spec. Pass = `reuse lint` exits 0 with no `MISSING:` records and no `Bad licenses` records.

Files exempted from REUSE coverage MUST be enumerated in `.reuse/dep5` or `REUSE.toml`. Wholesale exemption (e.g. `*` glob) MUST cause the criterion to fail; reviewers MAY ignore narrow exemptions for fixtures, generated files, or third-party content provided each carries a separate SPDX record.

### 3.2 OSI-approved declared license

Pass = the SPDX expression in the project's primary license declaration, parsed per [SPDX 2.3](https://spdx.github.io/spdx-spec/v2.3/), resolves to one or more OSI-approved identifiers as listed at <https://api.opensource.org/licenses/>. The CLI MUST query the OSI API at attestation time and record the API response hash in the predicate's `evidence.osi_response_hash` field.

Compound expressions (`A OR B`, `A AND B`, `A WITH exception`) are accepted iff every leaf identifier is OSI-approved. License exceptions MUST be SPDX-recognised exception identifiers.

### 3.3 OSI-only dependency tree

The CLI MUST generate an SBOM in [SPDX 2.3](https://spdx.github.io/spdx-spec/v2.3/) or [CycloneDX 1.5+](https://cyclonedx.org/specification/overview/) format covering all direct and transitive **runtime** dependencies. Build-only and dev-only dependencies are out of scope and MUST be excluded from the SBOM scan.

The CLI MUST verify that every package in the SBOM declares at least one OSI-approved license. Packages with no license declaration MUST cause the criterion to fail; the maintainer's remedy is to upstream the license metadata or pin to a version that has it.

The hash of the SBOM SHALL be recorded in the predicate's `evidence.sbom_hash` field. Reviewers retrieving an attestation MUST be able to reproduce the SBOM by running the CLI on the same SHA with the same `cli_version`.

### 3.4 No proprietary blobs

The CLI MUST flag, and the criterion fails if any flagged file is present and not exempted, files matching:

- **Binary entropy ≥ 7.5 bits/byte** for files >100 KB and not declared in `.gitattributes` as `binary` with a SPDX licensing record.
- **Minified JavaScript/CSS** without an accompanying source file or sourcemap (heuristic: file size >10 KB AND average line length >500 chars).
- **Stripped/obfuscated build artifacts** detected via filename pattern (`*.min.js` without sourcemap, `vendor.js` without manifest, packed binaries, etc.).
- **Vendored proprietary archives** (filename or magic bytes of `.dll`, `.so`, `.dylib`, `.exe`, proprietary container formats) without OSI-licensed source counterparts in-tree.

Maintainers MAY exempt files via a top-level `.oss-verified.toml` listing path globs and a justification string per file. Exemptions are recorded verbatim in `predicate.evidence.exemptions` and surfaced on the verify page; reviewers and end users see and can challenge them.

## 4. Pipeline

The CLI runs the following stages in order. **All deterministic stages (§3.1–3.4) MUST pass independently.** The LLM stage (§7) MAY block but MUST NOT be relied on to grant.

```
1. Deterministic checks (§3.1 → §3.4)        ← MUST all pass
2. LLM audit pass (§7)                        ← MAY block, MUST NOT grant
3. Build in-toto predicate (§5)
4. cosign attest → Sigstore (§6)
5. Bundle published to Rekor
```

The CLI MUST refuse to produce a predicate if any deterministic stage fails. The CLI MUST refuse to produce a predicate if the LLM audit blocks. The CLI MUST NOT produce a predicate from any other code path; in particular, there is no `--force` flag, no `--skip-llm` flag, and no environment-variable override.

## 5. In-toto predicate

Schema: [`./schemas/predicate.schema.json`](./schemas/predicate.schema.json).

Predicate type URI: `https://oss-verified.better-internet.org/predicate/v1`.

Required fields:

| Field | Type | Source |
|---|---|---|
| `commit_sha` | string (40 hex chars) | git rev-parse HEAD |
| `repo_url` | string (URL) | CI's OIDC claims (cross-checked against `git remote`) |
| `criteria` | object — pass/fail per `reuse`, `osi_license`, `dependency_licenses`, `no_proprietary_blobs` | CLI |
| `evidence` | object — `osi_response_hash`, `sbom_hash`, `sbom_format`, `sbom_uri`, `exemptions[]` | CLI |
| `model_id` | string | from `models.json` allowlist |
| `prompt_hash` | string (sha256 hex) | hash of the audit prompt template+repo content envelope |
| `cli_version` | string (semver) | CLI's compiled-in version |
| `cli_sha` | string (sha256 hex) | hash of the CLI binary that produced the attestation |

The Sigstore attestation subject MUST be the commit SHA of the repository's default branch HEAD at attestation time, expressed per the [in-toto Statement format](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md):

```json
{
  "subject": [{
    "name": "git+https://github.com/<owner>/<repo>",
    "digest": { "gitCommit": "<S>" }
  }]
}
```

## 6. CI provider requirements

The CLI MUST sign the predicate via `cosign attest --type custom --predicate ...` against the public Sigstore production Fulcio instance, using OIDC keyless signing rooted in the surrounding CI's OIDC identity.

The accepted OIDC issuer set is published in [`./ci-providers.json`](./ci-providers.json). Every issuer in this list MUST be on Fulcio's public OIDC allowlist. The verify endpoint MUST reject any attestation whose Fulcio certificate's OIDC issuer is not in `ci-providers.json`.

There is no BYO-key path. There is no self-hosted Fulcio path. Maintainers who require either are not served by this badge.

Updates to `ci-providers.json` follow §12.2.

## 7. LLM audit requirements

### 7.1 Purpose

The LLM audit is a second-opinion pass against patterns the deterministic checks miss (e.g. `vendor.min.js` with no source counterpart, license conflicts hidden in NOTICE files, obfuscated payloads). It MAY block; it MUST NOT grant.

### 7.2 Allowlist

Accepted models are enumerated in [`./models.json`](./models.json). The CLI MUST refuse to run with a model that is not on the allowlist. Inclusion criteria, listed in `./models.json` itself:

1. Stable, versioned API with stable model identifiers.
2. Auditable model identity in API responses (e.g. `system_fingerprint`, signed response headers).
3. Vendor retention/availability commitment of ≥12 months for the listed model version.
4. Documented determinism at temperature=0.
5. Per-call cost reasonable for adoption (target: under ~$0.50 per typical-size repo audit).
6. Public capability documentation sufficient to judge whether the audit prompt is appropriate.

### 7.3 Prompt-injection defense

The CLI MUST frame repository content strictly as data, never as instructions. Concretely:

- Repo content is wrapped in a fixed, hash-recorded envelope (`<repo_data>...</repo_data>`).
- The system prompt explicitly states that any instructions appearing inside the envelope are content to be evaluated, not commands to be followed.
- The CLI MUST run the published adversarial test corpus before each release and SHOULD run it as part of CI for the CLI itself.

### 7.4 Multi-pass voting (Phase 2 hardening)

In Phase 2, the CLI MUST run three independent calls at temperature=0 against the chosen model and treat the audit as blocking iff a strict majority blocks. Single-pass operation is permitted in Phase 1; Phase 2 makes it mandatory.

### 7.5 Recording the LLM verdict

The predicate's `evidence.llm_verdict` field records `pass` or `block` plus a one-line rationale. Verifiers MAY ignore the verdict field; the binding fact is that the predicate was emitted at all (which implies the LLM did not block).

## 8. Verifiable Credential

### 8.1 Type

Credential type: `OssVerifiedCredential`. JSON-LD context: [`./contexts/v1/oss-verified.jsonld`](./contexts/v1/oss-verified.jsonld), served at `https://oss-verified.better-internet.org/contexts/v1/oss-verified.jsonld`.

VCs MUST conform to [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/) and use `@context` referring to both the VC v2 context and the oss-verified context.

### 8.2 Issuance

The verify endpoint, on confirming a valid Sigstore attestation, mints a VC signed by the issuer DID's current `assertionMethod` key. The VC's `evidence` field MUST link to the underlying attestation via:

```json
"evidence": [{
  "type": "SigstoreAttestation",
  "rekor_log_index": <integer>,
  "rekor_url": "https://rekor.sigstore.dev/api/v1/log/entries/<uuid>"
}]
```

The verify endpoint MUST NOT mint a VC without re-validating the Sigstore signature, the Rekor inclusion proof, the OIDC issuer (per §6), and the predicate-subject-to-repo binding for every issuance — including refreshes of an already-known repo.

### 8.3 No `validUntil`

VCs SHOULD NOT carry a `validUntil` field. Freshness is communicated via SHA-staleness on the verify page; an explicit expiry would create a redundant, less informative signal.

### 8.4 Subject

`credentialSubject` MUST include the canonical repo URL and the attested commit SHA. The credential ID MUST be a stable URL of the form `https://oss-verified.better-internet.org/credentials/{forge}/{owner}/{repo}#{commit_sha}`.

## 9. DID document

### 9.1 `did:web:` resolution

The DID document MUST be served at `https://<did-host>/.well-known/did.json` per [`did:web` v1.0](https://w3c-ccg.github.io/did-method-web/). For the production issuer, that is `https://oss-verified.better-internet.org/.well-known/did.json`.

The document MUST declare:
- `controller: did:web:better-internet.org`
- One or more `verificationMethod` entries (Ed25519 or P-256 RECOMMENDED).
- `assertionMethod` referencing the currently-active signing key.
- `service` entries for the credential endpoint and the JSON-LD context endpoint.

### 9.2 Key rotation

- **Cadence:** annual + on-incident.
- **Mechanism:** add the new key to `verificationMethod` first. Wait at least 24 hours so resolver caches refresh. Then begin signing new VCs with the new key. Move the new key to `assertionMethod`.
- **Retention:** retired keys MUST remain in `verificationMethod` indefinitely so historical VCs continue to verify. Retired keys MUST NOT appear in `assertionMethod`.
- **Compromise:** rotate immediately, publish an incident note at `/incidents/<date>`, re-issue currently-active VCs under the new key.

Key removal MUST NOT be used as a per-credential revocation mechanism. Per-credential revocation is §10.3.

## 10. Revocation

### 10.1 Auto-stale

The verify endpoint MUST report status `stale` when the attested SHA is not the current default-branch HEAD of the repo. Stale ≠ revoked. The maintainer's remedy is to re-run the CLI and produce a new attestation.

The verify endpoint SHOULD poll the forge for new HEAD SHAs no more often than once per 5 minutes per repo.

### 10.2 Auto-revoke

If the maintainer re-runs the CLI on a new SHA and the run **fails** the deterministic checks, the verify endpoint MUST:

1. Mark the previous VC's status as revoked via §10.3.
2. Render the badge SVG as red ("revoked").
3. Record the revocation reason as the failing criterion identifier.

Auto-revoke is irrevocable for the SHA that triggered it; future SHAs may pass and produce a new attestation, but the failing SHA's record remains.

### 10.3 BitstringStatusList

Per-credential revocation MUST use [W3C Bitstring Status List](https://www.w3.org/TR/vc-bitstring-status-list/). The status list is served at `https://<issuer>/status/v1/list.jsonld` and is itself a signed VC.

Each VC includes:

```json
"credentialStatus": {
  "id": "https://oss-verified.better-internet.org/status/v1/list.jsonld#<index>",
  "type": "BitstringStatusListEntry",
  "statusPurpose": "revocation",
  "statusListIndex": "<index>",
  "statusListCredential": "https://oss-verified.better-internet.org/status/v1/list.jsonld"
}
```

Revoking a VC means flipping its bit in the list and re-signing the list VC. The DID signing key is **not** removed; only the bit changes.

### 10.4 Manual revoke

Manual revocation is reviewer-gated and reserved for cases the automated pipeline cannot detect: trademark disputes, fraud, post-issuance license changes affecting earlier SHAs, etc. The reviewer process is defined in Phase 3 of the plan and is out of scope for this version of the SPEC.

## 11. Verification procedure

A verifier with only the credential URL `C = https://oss-verified.better-internet.org/credentials/{forge}/{owner}/{repo}.jsonld` MUST be able to:

1. **Fetch** `C` and parse it as a JSON-LD VC.
2. **Resolve** the issuer DID (`did:web:oss-verified.better-internet.org`) by fetching `https://oss-verified.better-internet.org/.well-known/did.json`.
3. **Verify** the VC signature against the DID document's currently-active `assertionMethod` key (or, for historical VCs, any key in `verificationMethod`).
4. **Fetch** the linked Sigstore attestation via the `evidence[0].rekor_url` field.
5. **Verify** the Sigstore signature, Rekor inclusion proof, and that the Fulcio certificate's OIDC issuer is in [`./ci-providers.json`](./ci-providers.json).
6. **Verify** the predicate's `repo_url` matches the credential's `credentialSubject.repository`.
7. **Check status** by fetching the BitstringStatusList VC referenced in `credentialStatus` and reading the bit at `statusListIndex`.

A reference verifier implementation will live at `./reference-verifier/`. Conformant third-party verifiers MUST perform all seven steps above.

## 12. Conformance

### 12.1 Conformant CLI

A CLI is conformant iff it:

- Implements §3, §4, §7, and §5 (predicate) without divergence.
- Refuses to operate against a model not in [`./models.json`](./models.json).
- Refuses to attest in a CI environment whose OIDC issuer is not in [`./ci-providers.json`](./ci-providers.json).
- Records its own `cli_version` and `cli_sha` in the predicate.

### 12.2 Conformant verifier

A verifier is conformant iff it performs all seven steps in §11 and refuses to display a "verified" status when any step fails.

### 12.3 Allowlist updates

Updates to `models.json` and `ci-providers.json` are public PRs against the spec repo with a **14-day comment window**. Removals (e.g., vendor deprecations, security incidents) are immediate; previously-issued attestations referencing a removed entry retain their original validity window but cannot be **refreshed** against the removed entry.

## 13. References

- BCP 14 / RFC 2119 / RFC 8174 — Key word interpretation.
- [REUSE Specification v3.0](https://reuse.software/spec/) — File-level licensing records.
- [SPDX 2.3](https://spdx.github.io/spdx-spec/v2.3/) — License expression and SBOM format.
- [CycloneDX 1.5](https://cyclonedx.org/specification/overview/) — Alternative SBOM format.
- [OSI License List API](https://api.opensource.org/licenses/) — OSI-approved identifiers.
- [in-toto Attestation Framework v1.0](https://github.com/in-toto/attestation/) — Predicate envelope.
- [Sigstore](https://www.sigstore.dev/) — Keyless signing and Rekor transparency log.
- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/).
- [W3C Bitstring Status List](https://www.w3.org/TR/vc-bitstring-status-list/) — Per-VC revocation.
- [`did:web` Method Specification v1.0](https://w3c-ccg.github.io/did-method-web/).

## Appendix A. Open items

These are tracked but not yet specified. Each MUST be resolved before Phase 1 ships.

- A.1 Initial CI allowlist scope (full Fulcio set vs. GitHub+GitLab only on day 1).
- A.2 Adversarial test corpus contents and where it lives.
- A.3 Reviewer process (manual revoke + challenge handling) — Phase 3.
- A.4 LLM audit prompt template (text + hash). Currently `prompt_hash` is required in the predicate but the canonical template has not been frozen.
- A.5 Multi-pass voting threshold for Phase 2 (strict majority, supermajority, unanimous?).
- A.6 Localisation of the badge SVG and verify page.

## Changelog

| Version | Date | Notes |
|---|---|---|
| 0.1.0-draft | 2026-05-08 | Initial draft for public comment. |
