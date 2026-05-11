// Python ecosystem detector.
//
// Lockfile precedence (first match wins; we don't merge across managers):
//   1. uv.lock                 — TOML, modern uv format
//   2. poetry.lock             — TOML, Poetry format
//   3. Pipfile.lock            — JSON, Pipenv
//   4. requirements.txt        — line-oriented, vanilla pip
//
// License lookup via PyPI's JSON API:
//   GET https://pypi.org/pypi/<name>/<version>/json
//   -> { info: { license: <string>, classifiers: [...] } }
//
// Many packages declare `info.license` as free-form ("MIT", "MIT License",
// "BSD-3-Clause" or worse, "see LICENSE file"). The Trove classifiers
// `License :: OSI Approved :: <name>` are far more reliable; we prefer
// them and fall back to the free-form field.
//
// Concurrency-limited + memoised, same pattern as cargo + go detectors.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckContext } from "../../types.js";
import type { Component, DetectorResult } from "./types.js";

const PYPI = "https://pypi.org/pypi";
const PYPI_CONCURRENCY = 4;
const USER_AGENT = "oss-verify/0.1 (https://github.com/better-internet-org/oss-verify)";

// SPDX identifiers for the classifiers PyPI lists. Sparse list — covers the
// common cases; falls through to free-form `info.license` parsing otherwise.
const CLASSIFIER_TO_SPDX: Record<string, string> = {
	"License :: OSI Approved :: MIT License": "MIT",
	"License :: OSI Approved :: BSD License": "BSD-3-Clause",
	"License :: OSI Approved :: Apache Software License": "Apache-2.0",
	"License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
	"License :: OSI Approved :: Mozilla Public License 1.1 (MPL 1.1)": "MPL-1.1",
	"License :: OSI Approved :: GNU General Public License v2 (GPLv2)": "GPL-2.0-only",
	"License :: OSI Approved :: GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
	"License :: OSI Approved :: GNU General Public License v2 or later (GPLv2+)": "GPL-2.0-or-later",
	"License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
	"License :: OSI Approved :: GNU Lesser General Public License v2 (LGPLv2)": "LGPL-2.0-only",
	"License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
	"License :: OSI Approved :: GNU Lesser General Public License v2 or later (LGPLv2+)":
		"LGPL-2.0-or-later",
	"License :: OSI Approved :: GNU Lesser General Public License v3 or later (LGPLv3+)":
		"LGPL-3.0-or-later",
	"License :: OSI Approved :: ISC License (ISCL)": "ISC",
	"License :: OSI Approved :: Python Software Foundation License": "PSF-2.0",
	"License :: OSI Approved :: GNU Affero General Public License v3": "AGPL-3.0-only",
	"License :: OSI Approved :: GNU Affero General Public License v3 or later (AGPLv3+)":
		"AGPL-3.0-or-later",
	"License :: OSI Approved :: Zope Public License": "ZPL-2.1",
	"License :: OSI Approved :: Common Public License": "CPL-1.0",
	"License :: OSI Approved :: Eclipse Public License 1.0 (EPL-1.0)": "EPL-1.0",
	"License :: OSI Approved :: Eclipse Public License 2.0 (EPL-2.0)": "EPL-2.0",
};

export async function detect(ctx: CheckContext): Promise<DetectorResult | null> {
	const detected = pickLockfile(ctx.repoRoot);
	if (!detected) {
		// We saw a marker file (pyproject.toml, etc.) but no parseable lockfile.
		// Fall back to "not implemented for this layout" rather than silently passing.
		if (anyPythonMarker(ctx.repoRoot)) {
			return {
				ecosystem: "python",
				components: [],
				missing: [
					"Python project detected but no supported lockfile found (uv.lock, poetry.lock, Pipfile.lock, requirements.txt). Run your package manager to materialise one before re-running.",
				],
			};
		}
		return null;
	}

	let pairs: PyPackage[];
	try {
		pairs = detected.parser(readFileSync(detected.path, "utf8"));
	} catch (e) {
		return {
			ecosystem: "python",
			components: [],
			missing: [`${detected.kind} parse failed: ${(e as Error).message}`],
		};
	}
	if (pairs.length === 0) {
		return {
			ecosystem: "python",
			components: [],
			missing: [],
			details: `${detected.kind}: no deps`,
		};
	}

	const components: Component[] = [];
	const missing: string[] = [];
	const queue = [...pairs];
	const workers = Array.from({ length: PYPI_CONCURRENCY }, async () => {
		while (queue.length > 0) {
			const p = queue.shift();
			if (!p) break;
			const license = await fetchPypiLicense(p.name, p.version);
			if (license === undefined) {
				missing.push(`${p.name}@${p.version}`);
				continue;
			}
			components.push({
				name: p.name,
				version: p.version,
				license,
				purl: `pkg:pypi/${p.name.toLowerCase()}@${p.version}`,
			});
		}
	});
	await Promise.all(workers);

	components.sort((a, b) =>
		a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
	);
	return { ecosystem: "python", components, missing };
}

type PyPackage = { name: string; version: string };
type DetectedLockfile = {
	kind: "uv.lock" | "poetry.lock" | "Pipfile.lock" | "requirements.txt";
	path: string;
	parser: (text: string) => PyPackage[];
};

function pickLockfile(root: string): DetectedLockfile | null {
	const cands: Array<[DetectedLockfile["kind"], (text: string) => PyPackage[]]> = [
		["uv.lock", parseTomlLockPackages],
		["poetry.lock", parseTomlLockPackages],
		["Pipfile.lock", parsePipfileLock],
		["requirements.txt", parseRequirementsTxt],
	];
	for (const [kind, parser] of cands) {
		const p = join(root, kind);
		if (existsSync(p)) return { kind, path: p, parser };
	}
	return null;
}

function anyPythonMarker(root: string): boolean {
	for (const f of ["pyproject.toml", "setup.py", "Pipfile", "requirements.txt"]) {
		if (existsSync(join(root, f))) return true;
	}
	return false;
}

/**
 * Minimal TOML lock-package parser shared by uv.lock + poetry.lock. Both
 * use the same `[[package]] / name = "..." / version = "..."` shape. We
 * don't pull in a TOML library — the format is machine-generated and
 * stable, so a regex over `[[package]]` blocks is sufficient.
 *
 * Skips entries whose `category = "dev"` (poetry) when present. uv.lock
 * doesn't have a category field for the lockfile structure as of writing;
 * its dev-deps are still listed and we conservatively include them, same
 * as the cargo detector's runtime-vs-dev tradeoff.
 */
function parseTomlLockPackages(text: string): PyPackage[] {
	const out: PyPackage[] = [];
	const seen = new Set<string>();
	const blocks = text.split(/^\[\[package\]\]\s*$/m);
	for (let i = 1; i < blocks.length; i++) {
		const block = blocks[i];
		const name = matchField(block, "name");
		const version = matchField(block, "version");
		const category = matchField(block, "category");
		if (!name || !version) continue;
		if (category === "dev") continue;
		const key = `${name}@${version}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name, version });
	}
	return out;
}

function matchField(block: string, field: string): string | null {
	const m = block.match(new RegExp(`^${field}\\s*=\\s*"([^"]+)"`, "m"));
	return m ? m[1] : null;
}

function parsePipfileLock(text: string): PyPackage[] {
	const data = JSON.parse(text) as {
		default?: Record<string, { version?: string }>;
	};
	const out: PyPackage[] = [];
	for (const [name, entry] of Object.entries(data.default ?? {})) {
		// `version` is in the form `==1.2.3`. Strip the leading `==` if present.
		const v = (entry.version ?? "").replace(/^==/, "");
		if (v) out.push({ name, version: v });
	}
	return out;
}

function parseRequirementsTxt(text: string): PyPackage[] {
	const out: PyPackage[] = [];
	const seen = new Set<string>();
	for (const raw of text.split("\n")) {
		const line = raw.split("#", 1)[0].trim();
		if (!line || line.startsWith("-") || line.startsWith("--")) continue;
		// Accept `name==version`. `~=` and `>=` are ranges; pip doesn't pin them
		// without a lockfile — skip them rather than guessing.
		const m = line.match(/^([A-Za-z0-9_.\-]+)\s*==\s*([A-Za-z0-9_.\-+]+)/);
		if (!m) continue;
		const key = `${m[1]}@${m[2]}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name: m[1], version: m[2] });
	}
	return out;
}

const licenseCache = new Map<string, string | undefined>();

async function fetchPypiLicense(name: string, version: string): Promise<string | undefined> {
	const key = `${name.toLowerCase()}@${version}`;
	if (licenseCache.has(key)) return licenseCache.get(key);
	try {
		const url = `${PYPI}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
		const res = await fetch(url, {
			headers: { accept: "application/json", "user-agent": USER_AGENT },
		});
		if (!res.ok) {
			licenseCache.set(key, undefined);
			return undefined;
		}
		const data = (await res.json()) as {
			info?: { license?: string | null; classifiers?: string[] };
		};
		// Prefer Trove classifiers — more reliable + maps cleanly to SPDX.
		const classifiers = data.info?.classifiers ?? [];
		const spdxFromClassifiers = classifiers
			.map((c) => CLASSIFIER_TO_SPDX[c])
			.filter((v): v is string => Boolean(v));
		if (spdxFromClassifiers.length > 0) {
			const expr =
				spdxFromClassifiers.length === 1
					? spdxFromClassifiers[0]
					: `(${[...new Set(spdxFromClassifiers)].join(" OR ")})`;
			licenseCache.set(key, expr);
			return expr;
		}
		// Fall back to free-form `info.license`. Often this is a valid SPDX
		// expression already ("MIT", "Apache-2.0"); occasionally it's a sentence
		// ("see LICENSE"). The SPDX parser will reject the latter — which is
		// the right outcome per SPEC §3.3.
		const free = data.info?.license?.trim();
		if (free && free.length > 0 && !/\s{2,}|\.|see /i.test(free)) {
			licenseCache.set(key, free);
			return free;
		}
		licenseCache.set(key, undefined);
		return undefined;
	} catch {
		licenseCache.set(key, undefined);
		return undefined;
	}
}
