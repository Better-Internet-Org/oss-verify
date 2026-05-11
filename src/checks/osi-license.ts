import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import parseSpdx from "spdx-expression-parse";
import licenseIds from "spdx-license-ids" with { type: "json" };
import { sha256Hex } from "../hash.js";
import type { CheckContext, CheckResult } from "../types.js";

// OSI used to publish a JSON API at api.opensource.org/licenses; that's been
// deprecated. SPDX maintains the canonical list of licenses with an
// isOsiApproved field, refreshed when OSI approves new ones. Source of truth.
const SPDX_LICENSE_LIST = "https://spdx.org/licenses/licenses.json";

let osiCache: { hash: string; ids: Set<string> } | null = null;

export async function fetchOsiApprovedIds(): Promise<{ hash: string; ids: Set<string> }> {
	if (osiCache) return osiCache;
	const res = await fetch(SPDX_LICENSE_LIST);
	if (!res.ok) throw new Error(`SPDX license list ${res.status}: ${await res.text()}`);
	const text = await res.text();
	const data = JSON.parse(text) as {
		licenses: Array<{ licenseId: string; isOsiApproved: boolean; isDeprecatedLicenseId: boolean }>;
	};
	const ids = new Set<string>();
	for (const lic of data.licenses) {
		if (lic.isOsiApproved && !lic.isDeprecatedLicenseId) ids.add(lic.licenseId);
	}
	osiCache = { hash: sha256Hex(text), ids };
	return osiCache;
}

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];

function readDeclaredLicense(repoRoot: string): string | null {
	// 1. package.json `license` field (most common in this org's stack)
	const pkgPath = join(repoRoot, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { license?: string };
			if (pkg.license && pkg.license !== "UNLICENSED") return pkg.license;
		} catch {}
	}
	// 2. SPDX-License-Identifier header in the LICENSE file (REUSE-style)
	for (const name of LICENSE_FILES) {
		const p = join(repoRoot, name);
		if (existsSync(p)) {
			const head = readFileSync(p, "utf8").slice(0, 8192);
			const m = head.match(/SPDX-License-Identifier:\s*([A-Za-z0-9.+\-\s()]+)/);
			if (m) return m[1].trim();
		}
	}
	return null;
}

export function leafIdentifiers(expr: ReturnType<typeof parseSpdx>): string[] {
	if ("license" in expr) return [expr.license];
	if ("conjunction" in expr) return [...leafIdentifiers(expr.left), ...leafIdentifiers(expr.right)];
	return [];
}

export async function checkOsiLicense(
	ctx: CheckContext,
): Promise<{ result: CheckResult; osiResponseHash: string }> {
	const declared = readDeclaredLicense(ctx.repoRoot);
	if (!declared) {
		return {
			result: {
				pass: false,
				details:
					"No declared license found. Looked at package.json `license` field and SPDX-License-Identifier headers in LICENSE/LICENCE/COPYING.",
			},
			osiResponseHash: "",
		};
	}

	let parsed: ReturnType<typeof parseSpdx>;
	try {
		parsed = parseSpdx(declared);
	} catch (e) {
		return {
			result: {
				pass: false,
				details: `Declared license '${declared}' is not a valid SPDX expression: ${(e as Error).message}`,
			},
			osiResponseHash: "",
		};
	}

	const leaves = leafIdentifiers(parsed);
	if (leaves.length === 0) {
		return {
			result: { pass: false, details: `Could not extract any SPDX identifiers from '${declared}'` },
			osiResponseHash: "",
		};
	}

	let osi: { hash: string; ids: Set<string> };
	try {
		osi = await fetchOsiApprovedIds();
	} catch (e) {
		return {
			result: { pass: false, details: `OSI API call failed: ${(e as Error).message}` },
			osiResponseHash: "",
		};
	}

	const nonOsi = leaves.filter((id) => !osi.ids.has(id));
	// Sanity-check our leaves are real SPDX ids (filters typos vs. just-not-OSI)
	const unknownSpdx = leaves.filter((id) => !licenseIds.includes(id));

	if (nonOsi.length > 0) {
		const reason =
			unknownSpdx.length === leaves.length
				? `'${declared}' contains identifiers not in the SPDX license list: ${unknownSpdx.join(", ")}`
				: `'${declared}' contains non-OSI-approved identifiers: ${nonOsi.join(", ")}`;
		return { result: { pass: false, details: reason }, osiResponseHash: osi.hash };
	}

	return {
		result: {
			pass: true,
			details: `Declared '${declared}' resolves to OSI-approved leaves: ${leaves.join(", ")}`,
		},
		osiResponseHash: osi.hash,
	};
}
