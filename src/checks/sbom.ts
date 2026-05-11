// SBOM dependency-license check.
//
// Per SPEC §3.3:
//   - SBOM in SPDX 2.3 or CycloneDX 1.5+ format covering all direct and
//     transitive RUNTIME dependencies (dev/build deps excluded).
//   - Every package MUST declare at least one OSI-approved license.
//   - SBOM hash recorded in predicate.evidence.sbom_hash.
//   - Reviewers MUST be able to reproduce the SBOM from the same SHA
//     + cli_version — output is deterministic (canonical JSON, sorted).
//
// Scope of this slice: JavaScript/Node ecosystem. Detects a JS project by
// `package.json` presence and walks `node_modules` for license info. Other
// ecosystems (Cargo, Go modules, Python, …) are tracked as follow-up work
// — until then, a repo with no `package.json` fails this check by design
// rather than silently passing.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import parseSpdx from "spdx-expression-parse";
import { sha256Hex } from "../hash.js";
import type { CheckContext, CheckResult } from "../types.js";
import { fetchOsiApprovedIds, leafIdentifiers } from "./osi-license.js";

type Component = {
	name: string;
	version: string;
	license: string | null;
};

export type SbomResult = {
	result: CheckResult;
	sbomHash: string;
	sbomFormat: "cyclonedx-1.5";
	sbomUri: string | null;
};

const MAX_LICENSE_LEN = 256;

export async function checkSbom(ctx: CheckContext): Promise<SbomResult> {
	const rootPkgPath = join(ctx.repoRoot, "package.json");
	if (!existsSync(rootPkgPath)) {
		return fail(
			"No package.json at repo root. Only the JavaScript/Node ecosystem is " +
				"supported in this CLI version; SBOM checks for Cargo/Go/Python/etc. are " +
				"planned but not yet shipped.",
			{ name: ctx.repoUrl, version: "0.0.0" },
			[],
		);
	}

	let rootPkg: { name?: string; version?: string; dependencies?: Record<string, string> };
	try {
		rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
	} catch (e) {
		return fail(
			`package.json parse failed: ${(e as Error).message}`,
			{ name: ctx.repoUrl, version: "0.0.0" },
			[],
		);
	}

	const directDeps = Object.keys(rootPkg.dependencies ?? {});
	const meta = {
		name: rootPkg.name ?? ctx.repoUrl,
		version: rootPkg.version ?? "0.0.0",
	};

	if (directDeps.length === 0) {
		// No runtime deps. Trivially passes with an empty SBOM.
		const sbom = buildCycloneDx(ctx, meta, []);
		const sbomHash = sha256Hex(canonicalJson(sbom));
		return {
			result: { pass: true, details: "no runtime dependencies declared" },
			sbomHash,
			sbomFormat: "cyclonedx-1.5",
			sbomUri: null,
		};
	}

	// BFS over the runtime dependency graph rooted at the project's
	// `dependencies` (NOT `devDependencies`). Each visited package adds its
	// own `dependencies` to the queue. devDeps of transitives are NOT
	// followed — only runtime edges.
	//
	// Each queue entry carries `requestedFrom` — the dir we should resolve
	// from, walking up node_modules per Node's algorithm. Direct deps
	// resolve from repoRoot; transitives from the realpath dir of their
	// parent (so pnpm's strict `.pnpm/<name>@<ver>/node_modules` layout
	// resolves correctly).
	type QueueEntry = { name: string; requestedFrom: string };
	const visited = new Map<string, Component>();
	const missing: string[] = [];
	const queue: QueueEntry[] = directDeps.map((name) => ({ name, requestedFrom: ctx.repoRoot }));

	while (queue.length > 0) {
		const entry = queue.shift();
		if (entry === undefined) break;
		const { name, requestedFrom } = entry;

		const pkgJsonPath = resolvePackageJson(requestedFrom, name);
		if (!pkgJsonPath) {
			if (!missing.includes(name)) missing.push(name);
			continue;
		}

		let pkg: {
			version?: string;
			license?: unknown;
			licenses?: unknown;
			dependencies?: Record<string, string>;
		};
		try {
			pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
		} catch {
			if (!missing.includes(name)) missing.push(name);
			continue;
		}

		const version = pkg.version ?? "0.0.0";
		const key = `${name}@${version}`;
		if (visited.has(key)) continue;

		visited.set(key, {
			name,
			version,
			license: normaliseLicense(pkg.license ?? pkg.licenses),
		});

		const ownDir = dirname(pkgJsonPath);
		for (const dep of Object.keys(pkg.dependencies ?? {})) {
			queue.push({ name: dep, requestedFrom: ownDir });
		}
	}

	const components = [...visited.values()].sort(componentCmp);
	const sbom = buildCycloneDx(ctx, meta, components);
	const sbomHash = sha256Hex(canonicalJson(sbom));

	if (missing.length > 0) {
		return {
			result: {
				pass: false,
				details: `${missing.length} runtime deps not installed (run pnpm/npm install first): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? `, +${missing.length - 10} more` : ""}`,
			},
			sbomHash,
			sbomFormat: "cyclonedx-1.5",
			sbomUri: null,
		};
	}

	const osi = await fetchOsiApprovedIds();
	const violations: string[] = [];
	const noLicense: string[] = [];

	for (const c of components) {
		if (!c.license) {
			noLicense.push(`${c.name}@${c.version}`);
			continue;
		}
		const verdict = checkLicenseExpression(c.license, osi.ids);
		if (!verdict.ok) violations.push(`${c.name}@${c.version}: ${verdict.reason}`);
	}

	if (noLicense.length > 0 || violations.length > 0) {
		const details = [
			noLicense.length > 0
				? `${noLicense.length} packages declare no license: ${noLicense.slice(0, 5).join(", ")}${noLicense.length > 5 ? `, +${noLicense.length - 5} more` : ""}`
				: null,
			violations.length > 0
				? `${violations.length} packages with non-OSI licenses:\n  ${violations.slice(0, 10).join("\n  ")}`
				: null,
		]
			.filter(Boolean)
			.join("\n");
		return {
			result: { pass: false, details },
			sbomHash,
			sbomFormat: "cyclonedx-1.5",
			sbomUri: null,
		};
	}

	return {
		result: {
			pass: true,
			details: `${components.length} runtime deps, all OSI-approved`,
		},
		sbomHash,
		sbomFormat: "cyclonedx-1.5",
		sbomUri: null,
	};
}

/**
 * Walk up from `fromDir` looking for `node_modules/<name>/package.json`,
 * matching Node's own resolution algorithm. Handles pnpm strict mode
 * (where each package only sees its declared deps via local node_modules)
 * and npm's hoisted flat tree (deps live near the root).
 *
 * `realpathSync` is applied at the end so the returned path is the actual
 * install location even when pnpm symlinks `node_modules/foo` into
 * `.pnpm/foo@<ver>/node_modules/foo`.
 */
function resolvePackageJson(fromDir: string, name: string): string | null {
	let dir = fromDir;
	while (true) {
		const candidate = join(dir, "node_modules", name, "package.json");
		if (existsSync(candidate)) {
			try {
				return realpathSync(candidate);
			} catch {
				return candidate;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Normalise package.json `license` into a SPDX expression string. Old
 * packages use shapes that aren't SPDX expressions; we accept the
 * canonical ones and fail closed on the rest.
 *
 * Per SPEC §3.3, "Packages with no license declaration MUST cause the
 * criterion to fail" — so anything we can't recognise as a license
 * returns null and gets surfaced as "no license declared" downstream.
 */
function normaliseLicense(raw: unknown): string | null {
	if (typeof raw === "string") {
		const s = raw.trim();
		if (!s || s.length > MAX_LICENSE_LEN) return null;
		if (s.toUpperCase() === "UNLICENSED") return null;
		if (s.toUpperCase().startsWith("SEE LICENSE IN")) return null;
		return s;
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const t = (raw as { type?: unknown }).type;
		if (typeof t === "string") return normaliseLicense(t);
	}
	if (Array.isArray(raw)) {
		// Legacy `licenses: [{ type, url }, …]` — combine with OR.
		const parts = raw
			.map((r) => normaliseLicense((r as { type?: unknown }).type))
			.filter((v): v is string => Boolean(v));
		if (parts.length === 0) return null;
		return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
	}
	return null;
}

function checkLicenseExpression(
	expr: string,
	osiIds: Set<string>,
): { ok: true } | { ok: false; reason: string } {
	let parsed: ReturnType<typeof parseSpdx>;
	try {
		parsed = parseSpdx(expr);
	} catch (e) {
		return {
			ok: false,
			reason: `'${expr}' is not a valid SPDX expression: ${(e as Error).message}`,
		};
	}
	const leaves = leafIdentifiers(parsed);
	if (leaves.length === 0) return { ok: false, reason: `no SPDX identifiers in '${expr}'` };
	const nonOsi = leaves.filter((id) => !osiIds.has(id));
	if (nonOsi.length > 0) return { ok: false, reason: `non-OSI leaves: ${nonOsi.join(", ")}` };
	return { ok: true };
}

function componentCmp(a: Component, b: Component): number {
	if (a.name !== b.name) return a.name < b.name ? -1 : 1;
	return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

function buildCycloneDx(
	ctx: CheckContext,
	meta: { name: string; version: string },
	components: Component[],
): unknown {
	// Minimal CycloneDX 1.5 — covers the subject + every runtime component
	// with name/version/PURL/license. `serialNumber` is omitted on purpose
	// so the SBOM is reproducible from (SHA, cli_version) alone, per SPEC §3.3.
	return {
		bomFormat: "CycloneDX",
		specVersion: "1.5",
		version: 1,
		metadata: {
			component: {
				type: "application",
				name: meta.name,
				version: meta.version,
				purl: `pkg:generic/${encodeURIComponent(meta.name)}@${meta.version}`,
				externalReferences: [{ type: "vcs", url: ctx.repoUrl }],
			},
		},
		components: components.map((c) => ({
			type: "library",
			name: c.name,
			version: c.version,
			purl: `pkg:npm/${c.name.replace(/^@/, "%40")}@${c.version}`,
			...(c.license ? { licenses: [{ expression: c.license }] } : { licenses: [] }),
		})),
	};
}

/** Deterministic JSON: keys sorted recursively, no extra whitespace. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_k, v) => {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const keys = Object.keys(v as Record<string, unknown>).sort();
			const sorted: Record<string, unknown> = {};
			for (const k of keys) sorted[k] = (v as Record<string, unknown>)[k];
			return sorted;
		}
		return v;
	});
}

function fail(
	details: string,
	meta: { name: string; version: string },
	components: Component[],
): SbomResult {
	// Provide a placeholder SBOM even on failure so the predicate's
	// sbom_hash field always has a real value (verifiers must be able
	// to round-trip even failure modes deterministically).
	const sbom = buildCycloneDx(
		{ repoRoot: "", commitSha: "", repoUrl: meta.name },
		meta,
		components,
	);
	return {
		result: { pass: false, details },
		sbomHash: sha256Hex(canonicalJson(sbom)),
		sbomFormat: "cyclonedx-1.5",
		sbomUri: null,
	};
}
