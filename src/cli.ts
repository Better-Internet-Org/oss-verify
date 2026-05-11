#!/usr/bin/env node
import { resolve } from "node:path";
import { checkNoProprietaryBlobs } from "./checks/blobs.js";
import { runLlmAudit } from "./checks/llm-audit.js";
import { checkOsiLicense } from "./checks/osi-license.js";
import { checkReuse } from "./checks/reuse.js";
import { checkSbom } from "./checks/sbom.js";
import { commitSha, defaultBranch, repoUrlFromRemote } from "./git.js";
import { buildPredicate } from "./predicate.js";
import type { CheckContext, Predicate } from "./types.js";

type Args = {
	repoRoot: string;
	repoUrl?: string;
	output: "predicate" | "report" | "both";
	skipSbom: boolean;
	deterministicOnly: boolean;
};

function parseArgs(argv: string[]): Args {
	const args: Args = {
		repoRoot: process.cwd(),
		output: "report",
		skipSbom: false,
		deterministicOnly: false,
	};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--repo") args.repoRoot = resolve(argv[++i] ?? ".");
		else if (a === "--repo-url") args.repoUrl = argv[++i];
		else if (a === "--output") args.output = argv[++i] as Args["output"];
		else if (a === "--skip-sbom") args.skipSbom = true;
		else if (a === "--deterministic-only") args.deterministicOnly = true;
		else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		} else {
			console.error(`unknown flag: ${a}`);
			printHelp();
			process.exit(2);
		}
	}
	return args;
}

function printHelp(): void {
	console.log(`oss-verify — deterministic OSS-compliance attestation CLI

Usage:
  oss-verify [options]

Options:
  --repo <path>        Repository root (default: cwd)
  --repo-url <url>     Override repo URL (default: derived from git remote)
  --output <mode>      'report' (human, default) | 'predicate' (in-toto JSON) | 'both'
  --skip-sbom          Pass the SBOM check (use only for non-JS projects until
                       other-ecosystem detectors ship)
  --deterministic-only INTERNAL/preview mode. Runs the 4 deterministic checks
                       only, emits the result as JSON, skips the LLM audit,
                       and does NOT gate output on pass/fail. NOT a substitute
                       for the conformant attestation flow — output is not a
                       valid predicate and MUST NOT be signed and published as
                       one. Used by the oss-verified watchlist for monthly
                       monitoring of candidate projects.
  -h, --help           Show this help

Required environment (unless --deterministic-only):
  ANTHROPIC_API_KEY    SPEC §7 LLM audit. The CLI exits 1 if missing —
                       per SPEC §4 the LLM step is mandatory and there
                       is no opt-out.

Exit codes:
  0  all checks pass; predicate would be signed in CI
  1  one or more checks fail; no predicate
  2  CLI invocation error
`);
}

function pad(label: string, width = 22): string {
	return label.padEnd(width);
}

function statusGlyph(pass: boolean): string {
	return pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	const ctx: CheckContext = {
		repoRoot: args.repoRoot,
		commitSha: commitSha(args.repoRoot),
		repoUrl: args.repoUrl ?? repoUrlFromRemote(args.repoRoot),
	};
	const branch = defaultBranch(args.repoRoot);

	if (args.output !== "predicate") {
		console.error(`oss-verify on ${ctx.repoUrl}@${ctx.commitSha.slice(0, 8)} (${branch})`);
		console.error("");
	}

	// Run deterministic checks
	const reuse = checkReuse(ctx);
	const { result: osi, osiResponseHash } = await checkOsiLicense(ctx);
	const blobs = checkNoProprietaryBlobs(ctx);
	const sbomRaw = await checkSbom(ctx);
	const sbom = args.skipSbom
		? { ...sbomRaw, result: { pass: true, details: "skipped via --skip-sbom" } }
		: sbomRaw;

	const criteria = {
		reuse,
		osi_license: osi,
		dependency_licenses: sbom.result,
		no_proprietary_blobs: blobs,
	};

	const deterministicPass = Object.values(criteria).every((c) => c.pass);

	if (args.output !== "predicate") {
		for (const [name, result] of Object.entries(criteria)) {
			console.error(
				`  ${statusGlyph(result.pass)} ${pad(name)}${result.details ? `  ${result.details.split("\n")[0]}` : ""}`,
			);
			if (result.details?.includes("\n")) {
				for (const line of result.details.split("\n").slice(1)) {
					console.error(`    ${line}`);
				}
			}
		}
		console.error("");
		console.error(
			deterministicPass
				? "\x1b[32mPASS\x1b[0m  all deterministic checks succeeded"
				: "\x1b[31mFAIL\x1b[0m  one or more deterministic checks failed",
		);
	}

	if (args.deterministicOnly) {
		// Internal/preview mode. Emit JSON of the 4 deterministic check results
		// + the same evidence fields a predicate would carry, then exit 0 even
		// on failure. NOT a conformant attestation; consumers MUST NOT sign or
		// publish this output as one.
		const report = {
			mode: "deterministic-only",
			repo_url: ctx.repoUrl,
			commit_sha: ctx.commitSha,
			default_branch: branch,
			checked_at: new Date().toISOString(),
			deterministic_pass: deterministicPass,
			criteria,
			evidence: {
				osi_response_hash: osiResponseHash,
				sbom_hash: sbom.sbomHash,
				sbom_format: sbom.sbomFormat,
			},
		};
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exit(0);
	}

	if (!deterministicPass) {
		// Per SPEC §4: CLI MUST refuse to produce a predicate if any deterministic stage fails.
		if (args.output !== "report") {
			console.error("predicate not emitted (deterministic checks failed)");
		}
		process.exit(1);
	}

	// LLM audit (SPEC §7). MAY block, MUST NOT grant.
	const audit = await runLlmAudit(ctx, {
		modelId: process.env.OSS_VERIFY_MODEL_ID || "claude-sonnet-4-6",
		apiKey: process.env.ANTHROPIC_API_KEY,
	});

	if (args.output !== "predicate") {
		const glyph = audit.verdict.verdict === "block" ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m";
		console.error("");
		console.error(`  ${glyph} ${pad("llm_audit")} ${audit.verdict.rationale ?? ""}`);
	}

	if (audit.verdict.verdict === "block") {
		if (args.output !== "report") {
			console.error(`predicate not emitted (LLM audit blocked: ${audit.verdict.rationale})`);
		}
		process.exit(1);
	}

	const predicate: Predicate = buildPredicate({
		commitSha: ctx.commitSha,
		repoUrl: ctx.repoUrl,
		defaultBranch: branch,
		criteria,
		evidence: {
			osi_response_hash: osiResponseHash,
			sbom_hash: sbom.sbomHash,
			sbom_format: sbom.sbomFormat,
			sbom_uri: sbom.sbomUri,
			exemptions: [],
			llm_verdict: audit.verdict,
		},
		modelId: audit.modelId,
		promptHash: audit.promptHash,
	});

	if (args.output === "predicate" || args.output === "both") {
		// Emit ONLY the predicate body. `cosign attest-blob --predicate` reads
		// this file as the predicate content and wraps it in its own in-toto
		// Statement using `--type` for predicateType and the input file for
		// the subject. Emitting a full Statement here would cause cosign to
		// nest our Statement inside another Statement, so verifiers see
		// `statement.predicate.predicate.criteria` and `predicateAllPass`
		// reads the wrong layer as undefined.
		process.stdout.write(`${JSON.stringify(predicate, null, 2)}\n`);
	}

	process.exit(0);
}

main().catch((err) => {
	console.error(`oss-verify error: ${err instanceof Error ? err.message : String(err)}`);
	if (err instanceof Error && err.stack) console.error(err.stack);
	process.exit(2);
});
