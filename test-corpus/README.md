<!-- SPDX-License-Identifier: MIT -->

# Adversarial test corpus (SPEC §7.4 exit criterion)

Each subdirectory is a minimal synthetic "repository" that:

1. **Passes all four deterministic checks** (REUSE, OSI-approved declared license, OSI dependency tree, no proprietary blobs).
2. **Carries a hidden licensing or integrity violation** that only the SPEC §7 LLM audit should catch.

The runner [`tools/adversarial-test.mjs`](../tools/adversarial-test.mjs) invokes the CLI in `--report-json` mode against each fixture and asserts:

- `deterministic_pass === true` — the trick actually slipped past the deterministic stages (i.e. the fixture is well-formed enough that the corpus is testing the LLM, not the deterministic checks)
- `llm_verdict.verdict === "block"` — the LLM caught the hidden violation

Per SPEC §7.4, the LLM step must catch **≥3 of 4** of these patterns. The runner exits 0 iff that threshold is met. Patterns the deterministic stages would catch on their own (no SPDX header, declared license not OSI-approved, .exe in tree, etc.) belong in unit tests on the individual check functions, **not** in this corpus.

## Fixtures

| Dir | Hidden pattern |
|---|---|
| `adv-01-notice-conflict/` | NOTICE.txt declares "internal use only / no redistribution" while LICENSE + package.json claim MIT |
| `adv-02-obfuscated-payload/` | Source file with SPDX header, but body is `eval(atob(...))` with a base64-encoded payload |
| `adv-03-vendored-proprietary/` | Source file with SPDX header acknowledges incorporating code from a commercial product |
| `adv-04-license-contradiction-readme/` | README contradicts the LICENSE — "commercial use prohibited" alongside an MIT LICENSE |

## Running locally

```bash
ANTHROPIC_API_KEY=... node tools/adversarial-test.mjs
```

Each fixture costs ~3 Anthropic API calls (three-pass voting). Full run: ~12 calls at the default `claude-sonnet-4-6`. The script reports per-fixture verdict + a summary.

## Adding fixtures

Each must:

- Have a `LICENSE` file with an SPDX header (otherwise REUSE catches it)
- Have a `package.json` declaring an OSI license (otherwise §3.2 catches it)
- Contain at least one source file with an SPDX-License-Identifier header
- Pass `--skip-sbom` cleanly **without** that flag (so the SBOM detector also gives a green light — either no `dependencies` declared, or all-OSI deps installed)

Document the hidden pattern in this README's table and rely on the runner to enforce the LLM-catch rate.
