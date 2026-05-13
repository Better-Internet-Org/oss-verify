#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Runs the CLI against each fixture in test-corpus/ and reports whether
// the LLM step caught the hidden malicious pattern. SPEC §7.4 exit
// criterion: ≥3 of N fixtures must end in `llm_verdict.verdict === "block"`
// while `deterministic_pass === true` (the deterministic stages
// intentionally pass — the corpus is testing the LLM, not the
// static checks).
//
// Requires ANTHROPIC_API_KEY in the environment. Costs ~3 Anthropic
// calls per fixture (three-pass voting); full run ≈ N×3 calls.
//
// Exit codes:
//   0  ≥3 LLM blocks (SPEC §7.4 met)
//   1  threshold not met; corpus needs strengthening or model regressed
//   2  invocation error (missing API key, broken fixture, etc.)

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CORPUS = join(ROOT, "test-corpus");

if (!process.env.ANTHROPIC_API_KEY) {
	console.error("ANTHROPIC_API_KEY is required to run the adversarial corpus.");
	process.exit(2);
}

const fixtures = readdirSync(CORPUS, { withFileTypes: true })
	.filter((e) => e.isDirectory() && e.name.startsWith("adv-"))
	.map((e) => e.name)
	.sort();

if (fixtures.length === 0) {
	console.error("No fixtures found in test-corpus/.");
	process.exit(2);
}

const THRESHOLD = 3;
let blocked = 0;
let deterministicWrong = 0;
const results = [];

for (const name of fixtures) {
	const dir = join(CORPUS, name);
	console.log(`\n→ ${name}`);

	// Each fixture needs a git repo for the CLI's git-derived metadata to work.
	// Use a throwaway clone in /tmp so we never dirty the corpus directory.
	const tmp = mkdtempSync(join(ROOT, ".tmp-adv-"));
	try {
		execFileSync("cp", ["-r", `${dir}/.`, tmp]);
		execFileSync("git", ["init", "-q"], { cwd: tmp });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: tmp });
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
			{ cwd: tmp },
		);
		execFileSync("git", ["remote", "add", "origin", `https://example.invalid/${name}.git`], {
			cwd: tmp,
		});

		const run = spawnSync(
			"node",
			[
				// Node 22's auto type-stripping is gated when the entry point
				// uses non-erasable syntax (type-only imports, const enums,
				// etc.); the explicit flag matches the `dev` script in
				// package.json and works across all 22.x minors.
				"--experimental-strip-types",
				join(ROOT, "src/cli.ts"),
				"--repo",
				tmp,
				"--report-json",
			],
			{ env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8" },
		);

		if (run.status !== 0) {
			// Print the full stderr (was previously trimmed to the last 2
			// lines, which often hid the real error and left only the Node
			// version line visible).
			console.warn(`  CLI exited ${run.status}:\n${run.stderr.trim()}`);
			results.push({ name, status: "error" });
			continue;
		}

		const report = JSON.parse(run.stdout);
		const detOk = report.deterministic_pass === true;
		const llmBlocked = report.llm_verdict?.verdict === "block";

		if (!detOk) {
			deterministicWrong++;
			console.warn(
				"  ✗ deterministic FAIL (fixture is broken — it should pass deterministic checks)",
			);
			results.push({ name, status: "deterministic-fail", rationale: report });
			continue;
		}

		if (llmBlocked) {
			blocked++;
			console.log(`  ✓ blocked  rationale=${(report.llm_verdict.rationale ?? "").slice(0, 100)}`);
			results.push({ name, status: "blocked", rationale: report.llm_verdict.rationale });
		} else {
			console.warn(`  ✗ missed  verdict=${report.llm_verdict?.verdict}`);
			results.push({ name, status: "missed", rationale: report.llm_verdict?.rationale });
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

console.log(
	`\nSummary: ${blocked}/${fixtures.length} blocked; ${deterministicWrong} fixture(s) failed deterministic stages (corpus bug).`,
);

if (deterministicWrong > 0) {
	console.error("Corpus integrity bug: at least one fixture failed deterministic checks.");
	process.exit(2);
}

if (blocked >= THRESHOLD) {
	console.log(`✓ SPEC §7.4 exit criterion met (>=${THRESHOLD} caught).`);
	process.exit(0);
}

console.error(`✗ SPEC §7.4 exit criterion NOT met (need >=${THRESHOLD}, got ${blocked}).`);
process.exit(1);
