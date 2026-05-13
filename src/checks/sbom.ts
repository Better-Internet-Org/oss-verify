// SBOM dependency-license check (SPEC §3.3).
//
// Orchestrates per-ecosystem detectors:
//   - sbom/javascript.ts — node_modules walk via Node resolution
//   - sbom/cargo.ts      — Cargo.lock + crates.io license lookup
//   - sbom/go.ts         — go.mod (detection-only stub)
//   - sbom/python.ts     — pyproject.toml/poetry/uv/pip (detection-only stub)
//
// Per SPEC §3.3 the SBOM MUST cover direct + transitive runtime dependencies,
// every package MUST declare at least one OSI-approved license, and the
// output MUST be reproducible from (SHA, cli_version). The CycloneDX 1.5
// output here is canonical-JSON serialised (no serialNumber, sorted keys
// + components).
//
// Multi-ecosystem repos (e.g. JS + Rust in the same root) produce a single
// SBOM merging components from all detectors that matched. Repos with no
// detected ecosystem fail closed — silently passing would hide a real gap.

import parseSpdx from "spdx-expression-parse";
import { sha256Hex } from "../hash.js";
import type { CheckContext, CheckResult } from "../types.js";
import { fetchOsiApprovedIds, leafIdentifiers } from "./osi-license.js";
import { detect as detectCargo } from "./sbom/cargo.js";
import { detect as detectGo } from "./sbom/go.js";
import { detect as detectJavascript } from "./sbom/javascript.js";
import { detect as detectPython } from "./sbom/python.js";
import type { Component, Detector, DetectorResult } from "./sbom/types.js";

const DETECTORS: Detector[] = [detectJavascript, detectCargo, detectGo, detectPython];

export type SbomResult = {
	result: CheckResult;
	sbomHash: string;
	sbomFormat: "cyclonedx-1.5";
	sbomUri: string | null;
};

export async function checkSbom(ctx: CheckContext): Promise<SbomResult> {
	const detections: DetectorResult[] = [];
	for (const d of DETECTORS) {
		const r = await d(ctx);
		if (r) detections.push(r);
	}

	const meta = { name: ctx.repoUrl, version: "0.0.0" };

	if (detections.length === 0) {
		return fail(
			"No supported ecosystem detected at the repo root. Supported today: JavaScript/Node " +
				"(package.json) and Cargo (Cargo.lock). Go and Python are tracked as follow-up work " +
				"and currently fail closed.",
			ctx,
			meta,
			[],
		);
	}

	const allMissing: string[] = [];
	const allComponents: Component[] = [];
	for (const det of detections) {
		allMissing.push(...det.missing);
		allComponents.push(...det.components);
	}

	// Sort by (purl) so output is deterministic across detector orderings.
	allComponents.sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));

	const sbom = buildCycloneDx(ctx, meta, allComponents);
	const sbomHash = sha256Hex(canonicalJson(sbom));

	if (allMissing.length > 0) {
		// "Unresolved" = the registry/index lookup failed for this dependency
		// (e.g. unpublished Go module on deps.dev, custom forked package, or
		// transient network failure). Distinct from "found a non-OSI license":
		// these may well be OSI-licensed but we can't confirm. SPEC §3.3
		// requires us to be able to verify *every* dependency's license, so
		// this still fails the check — but the details now make it clear this
		// is a resolution gap, not a confirmed violation, and re-running may
		// succeed (registry mirror, package republished, etc.).
		const detName = (s: string) => s.split("@")[0];
		const ecosystems = detections.map((d) => d.ecosystem).join("+");
		return {
			result: {
				pass: false,
				details: `${allMissing.length} dependenc${allMissing.length === 1 ? "y" : "ies"} (${ecosystems}) had no resolvable license — registry lookup failed (retry-eligible; these may be OSI-licensed but we can't confirm):\n  - ${allMissing.slice(0, 10).map(detName).join("\n  - ")}${allMissing.length > 10 ? `\n  +${allMissing.length - 10} more` : ""}`,
			},
			sbomHash,
			sbomFormat: "cyclonedx-1.5",
			sbomUri: null,
		};
	}

	if (allComponents.length === 0) {
		return {
			result: {
				pass: true,
				details: `${detections.map((d) => d.ecosystem).join("+")}: no runtime deps`,
			},
			sbomHash,
			sbomFormat: "cyclonedx-1.5",
			sbomUri: null,
		};
	}

	const osi = await fetchOsiApprovedIds();
	const violations: string[] = [];
	const noLicense: string[] = [];

	for (const c of allComponents) {
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
			details: `${allComponents.length} runtime deps (${detections.map((d) => d.ecosystem).join("+")}), all OSI-approved`,
		},
		sbomHash,
		sbomFormat: "cyclonedx-1.5",
		sbomUri: null,
	};
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

function buildCycloneDx(
	ctx: CheckContext,
	meta: { name: string; version: string },
	components: Component[],
): unknown {
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
			purl: c.purl,
			...(c.license ? { licenses: [{ expression: c.license }] } : { licenses: [] }),
		})),
	};
}

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
	ctx: CheckContext,
	meta: { name: string; version: string },
	components: Component[],
): SbomResult {
	const sbom = buildCycloneDx(ctx, meta, components);
	return {
		result: { pass: false, details },
		sbomHash: sha256Hex(canonicalJson(sbom)),
		sbomFormat: "cyclonedx-1.5",
		sbomUri: null,
	};
}
