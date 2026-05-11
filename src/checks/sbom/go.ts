// Go modules ecosystem detector.
//
// Strategy:
//   1. Read go.mod to find the project's own `module` path (so we don't
//      flag self-references as missing).
//   2. Parse go.sum to enumerate every (module, version) pair Go's
//      resolver pinned. go.sum lists each dep twice (content hash and
//      go.mod hash); we dedupe.
//   3. Look up the license for each via deps.dev v3:
//        GET https://api.deps.dev/v3/systems/GO/packages/<urlencoded-name>/versions/<version>
//        -> { "licenses": ["MIT", "Apache-2.0"], ... }
//
// Lookups are concurrency-limited (DEPSDEV_CONCURRENCY) and memoised by
// (name, version) so re-runs are fast.
//
// Scope note: go.sum doesn't distinguish runtime vs test/build deps. The
// SPEC §3.3 requirement is runtime-only, but accurate filtering requires
// `go list -m -json all` or `go mod why` output that's not in the lockfile.
// We err conservative: audit all modules in go.sum. If a test-only dep
// has a non-OSI license, the criterion fails. The remedy for affected
// projects is to remove or replace the offending dep — strictly correct
// per the SPEC; mildly inconvenient in edge cases.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckContext } from "../../types.js";
import type { Component, DetectorResult } from "./types.js";

const DEPSDEV = "https://api.deps.dev/v3/systems/GO/packages";
const DEPSDEV_CONCURRENCY = 4;
const USER_AGENT = "oss-verify/0.1 (https://github.com/better-internet-org/oss-verify)";

export async function detect(ctx: CheckContext): Promise<DetectorResult | null> {
	const sumPath = join(ctx.repoRoot, "go.sum");
	const modPath = join(ctx.repoRoot, "go.mod");
	if (!existsSync(modPath)) return null;

	// Empty go.sum is legal if the project has no deps at all.
	if (!existsSync(sumPath)) {
		return { ecosystem: "go", components: [], missing: [], details: "no go.sum (no deps)" };
	}

	const selfModule = readGoMod(modPath);
	const sumText = readFileSync(sumPath, "utf8");
	const pairs = parseGoSum(sumText, selfModule);
	if (pairs.length === 0) {
		return { ecosystem: "go", components: [], missing: [], details: "no go.sum entries" };
	}

	const components: Component[] = [];
	const missing: string[] = [];
	const queue = [...pairs];
	const workers = Array.from({ length: DEPSDEV_CONCURRENCY }, async () => {
		while (queue.length > 0) {
			const p = queue.shift();
			if (!p) break;
			const license = await fetchGoLicense(p.name, p.version);
			if (license === undefined) {
				missing.push(`${p.name}@${p.version}`);
				continue;
			}
			components.push({
				name: p.name,
				version: p.version,
				license,
				purl: `pkg:golang/${p.name.replace(/^v\d+$/, "")}@${p.version}`,
			});
		}
	});
	await Promise.all(workers);

	components.sort((a, b) =>
		a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
	);
	return { ecosystem: "go", components, missing };
}

function readGoMod(modPath: string): string | null {
	try {
		const text = readFileSync(modPath, "utf8");
		const m = text.match(/^\s*module\s+(\S+)/m);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

type GoPackage = { name: string; version: string };

/**
 * Parse go.sum into a deduplicated (name, version) list. Format:
 *   <module>  <version>      h1:<base64-hash>
 *   <module>  <version>/go.mod  h1:<base64-hash>
 * Pre-release versions have suffixes like `-pre.0`, pseudo-versions look
 * like `v0.0.0-<timestamp>-<sha>`. We don't try to normalise — deps.dev
 * accepts the raw string back.
 */
function parseGoSum(text: string, selfModule: string | null): GoPackage[] {
	const seen = new Set<string>();
	const out: GoPackage[] = [];
	for (const line of text.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 3) continue;
		const name = parts[0];
		// Strip `/go.mod` suffix on version lines so we dedupe.
		const version = parts[1].endsWith("/go.mod") ? parts[1].slice(0, -7) : parts[1];
		if (selfModule && (name === selfModule || name.startsWith(`${selfModule}/`))) continue;
		const key = `${name}@${version}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name, version });
	}
	return out;
}

const licenseCache = new Map<string, string | undefined>();

async function fetchGoLicense(name: string, version: string): Promise<string | undefined> {
	const key = `${name}@${version}`;
	if (licenseCache.has(key)) return licenseCache.get(key);
	try {
		const url = `${DEPSDEV}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
		const res = await fetch(url, {
			headers: { accept: "application/json", "user-agent": USER_AGENT },
		});
		if (!res.ok) {
			licenseCache.set(key, undefined);
			return undefined;
		}
		const data = (await res.json()) as { licenses?: string[] };
		const licenses = (data.licenses ?? []).filter((s) => typeof s === "string" && s.length > 0);
		if (licenses.length === 0) {
			licenseCache.set(key, undefined);
			return undefined;
		}
		// Convert deps.dev's array to a SPDX expression. Most Go modules
		// declare a single license; multi-license entries get joined with OR
		// since Go has no metadata to express AND-style co-licensing.
		const result = licenses.length === 1 ? licenses[0] : `(${licenses.join(" OR ")})`;
		licenseCache.set(key, result);
		return result;
	} catch {
		licenseCache.set(key, undefined);
		return undefined;
	}
}
