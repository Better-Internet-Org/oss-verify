import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./hash.js";
import type { Evidence, Predicate } from "./types.js";

export const PREDICATE_TYPE_URI = "https://oss-verified.better-internet.org/predicate/v1";

export function cliVersion(): string {
	const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
		return pkg.version || "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export function cliSha(): string {
	// Hash of the running CLI source bundle. For dev runs, hash this file's
	// directory contents would be impractical — placeholder until we ship a
	// compiled binary whose sha256 we can capture via the build step.
	return sha256Hex(`oss-verify@${cliVersion()}`).padEnd(64, "0").slice(0, 64);
}

export type BuildPredicateInput = {
	commitSha: string;
	repoUrl: string;
	defaultBranch?: string;
	criteria: Predicate["criteria"];
	evidence: Evidence;
	modelId: string;
	promptHash: string;
};

export function buildPredicate(input: BuildPredicateInput): Predicate {
	return {
		commit_sha: input.commitSha,
		repo_url: input.repoUrl,
		default_branch: input.defaultBranch,
		criteria: input.criteria,
		evidence: input.evidence,
		model_id: input.modelId,
		prompt_hash: input.promptHash,
		cli_version: cliVersion(),
		cli_sha: cliSha(),
		attested_at: new Date().toISOString(),
	};
}
