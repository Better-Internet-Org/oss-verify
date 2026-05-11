// Mirrors packages/spec/schemas/predicate.schema.json. Keep in sync.

export type CheckResult = {
	pass: boolean;
	details?: string;
};

export type Exemption = {
	path: string;
	justification: string;
};

export type LlmVerdict = {
	verdict: "pass" | "block";
	rationale?: string;
	passes?: number;
};

export type Evidence = {
	osi_response_hash: string;
	sbom_hash: string;
	sbom_format: "spdx-2.3" | "cyclonedx-1.5" | "cyclonedx-1.6";
	sbom_uri?: string | null;
	exemptions?: Exemption[];
	llm_verdict?: LlmVerdict;
};

export type Predicate = {
	commit_sha: string;
	repo_url: string;
	default_branch?: string;
	criteria: {
		reuse: CheckResult;
		osi_license: CheckResult;
		dependency_licenses: CheckResult;
		no_proprietary_blobs: CheckResult;
	};
	evidence: Evidence;
	model_id: string;
	prompt_hash: string;
	cli_version: string;
	cli_sha: string;
	attested_at: string;
};

export type CheckContext = {
	repoRoot: string;
	commitSha: string;
	repoUrl: string;
};
