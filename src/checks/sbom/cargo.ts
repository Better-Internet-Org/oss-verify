// Cargo (Rust) ecosystem detector.
//
// Cargo.lock is the source of truth for the resolved dependency graph. It's
// a TOML file with `[[package]]` entries. We parse the minimal subset we
// need (name + version + dependencies) without pulling in a TOML library.
//
// Per-crate license metadata isn't in Cargo.lock — we have to look it up
// from the crates.io API:
//   GET https://crates.io/api/v1/crates/<name>/<version>
//   -> { "version": { "license": "MIT OR Apache-2.0", ... } }
//
// Lookups are concurrency-limited (CRATESIO_CONCURRENCY) and memoised by
// (name, version) so re-runs are fast and crates.io stays happy.
//
// Scope: includes ALL packages from Cargo.lock — Rust's dev-dependency
// distinction lives in Cargo.toml not Cargo.lock, and parsing the dep tree
// to filter would require a real resolver. SPEC §3.3 says runtime deps only,
// so this is conservative: we may include a few dev/build deps in the
// audited set. Fixing it requires shipping cargo-metadata output alongside,
// which is out of scope for the MVP detector.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckContext } from "../../types.js";
import type { Component, DetectorResult } from "./types.js";

const CRATESIO = "https://crates.io/api/v1/crates";
const CRATESIO_CONCURRENCY = 4;
const USER_AGENT = "oss-verify/0.1 (https://github.com/better-internet-org/oss-verify)";

export async function detect(ctx: CheckContext): Promise<DetectorResult | null> {
	const lockPath = join(ctx.repoRoot, "Cargo.lock");
	if (!existsSync(lockPath)) return null;

	let lockText: string;
	try {
		lockText = readFileSync(lockPath, "utf8");
	} catch (e) {
		return {
			ecosystem: "cargo",
			components: [],
			missing: [`Cargo.lock read failed: ${(e as Error).message}`],
		};
	}

	const packages = parseCargoLock(lockText);
	if (packages.length === 0) {
		return { ecosystem: "cargo", components: [], missing: [], details: "no Cargo.lock packages" };
	}

	// Filter out the root package — Cargo.lock includes the project itself.
	// Best signal: entries that have no `source` line are local (the workspace
	// root or path-deps). Drop them so the SBOM is about EXTERNAL deps only.
	const external = packages.filter((p) => p.source !== null);

	const components: Component[] = [];
	const missing: string[] = [];

	// Fetch licenses with a small concurrency limit.
	const queue = [...external];
	const workers = Array.from({ length: CRATESIO_CONCURRENCY }, async () => {
		while (queue.length > 0) {
			const p = queue.shift();
			if (!p) break;
			const license = await fetchCrateLicense(p.name, p.version);
			if (license === undefined) {
				missing.push(`${p.name}@${p.version}`);
				continue;
			}
			components.push({
				name: p.name,
				version: p.version,
				license,
				purl: `pkg:cargo/${p.name}@${p.version}`,
			});
		}
	});
	await Promise.all(workers);

	components.sort((a, b) =>
		a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
	);

	return { ecosystem: "cargo", components, missing };
}

type CargoLockPackage = { name: string; version: string; source: string | null };

/**
 * Minimal Cargo.lock parser. The format is TOML v3 with one top-level
 * `[[package]]` array. We only need name/version/source. Lock files are
 * machine-generated and the format is stable, so we lean on a simple
 * regex rather than depending on a TOML library.
 */
function parseCargoLock(text: string): CargoLockPackage[] {
	const packages: CargoLockPackage[] = [];
	const blocks = text.split(/^\[\[package\]\]\s*$/m);
	for (let i = 1; i < blocks.length; i++) {
		const block = blocks[i];
		const name = matchField(block, "name");
		const version = matchField(block, "version");
		const source = matchField(block, "source");
		if (name && version) packages.push({ name, version, source });
	}
	return packages;
}

function matchField(block: string, field: string): string | null {
	const re = new RegExp(`^${field}\\s*=\\s*"([^"]+)"`, "m");
	const m = block.match(re);
	return m ? m[1] : null;
}

const licenseCache = new Map<string, string | undefined>();

async function fetchCrateLicense(name: string, version: string): Promise<string | undefined> {
	const key = `${name}@${version}`;
	if (licenseCache.has(key)) return licenseCache.get(key);
	try {
		const url = `${CRATESIO}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
		const res = await fetch(url, {
			headers: { accept: "application/json", "user-agent": USER_AGENT },
		});
		if (!res.ok) {
			licenseCache.set(key, undefined);
			return undefined;
		}
		const data = (await res.json()) as { version?: { license?: string | null } };
		const license = data.version?.license?.trim();
		const result = license && license.length > 0 ? license : null;
		// crates.io returns a SPDX expression in `version.license` (since 2020).
		licenseCache.set(key, result ?? undefined);
		return result ?? undefined;
	} catch {
		licenseCache.set(key, undefined);
		return undefined;
	}
}
