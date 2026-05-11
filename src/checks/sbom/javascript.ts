// JavaScript / Node ecosystem detector.
//
// Walks node_modules from the root package.json's `dependencies` (runtime
// only) using Node's resolution algorithm. Pulls licenses out of each
// dep's installed package.json so no network calls or registry lookups
// are needed.
//
// Requires `pnpm install` / `npm install` to have run in the consumer
// project before the CLI runs — direct + transitive deps must be on disk.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheckContext } from "../../types.js";
import type { Component, DetectorResult } from "./types.js";

export async function detect(ctx: CheckContext): Promise<DetectorResult | null> {
	const rootPkgPath = join(ctx.repoRoot, "package.json");
	if (!existsSync(rootPkgPath)) return null;

	let rootPkg: { dependencies?: Record<string, string> };
	try {
		rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
	} catch (e) {
		return {
			ecosystem: "javascript",
			components: [],
			missing: [`package.json parse failed: ${(e as Error).message}`],
		};
	}

	const directDeps = Object.keys(rootPkg.dependencies ?? {});
	if (directDeps.length === 0) {
		return { ecosystem: "javascript", components: [], missing: [], details: "no runtime deps" };
	}

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
			purl: `pkg:npm/${name.replace(/^@/, "%40")}@${version}`,
		});

		const ownDir = dirname(pkgJsonPath);
		for (const dep of Object.keys(pkg.dependencies ?? {})) {
			queue.push({ name: dep, requestedFrom: ownDir });
		}
	}

	return {
		ecosystem: "javascript",
		components: [...visited.values()].sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		),
		missing,
	};
}

/**
 * Walk up from `fromDir` looking for `node_modules/<name>/package.json`,
 * matching Node's own resolution algorithm. Handles pnpm strict mode
 * (where each package only sees its declared deps via local node_modules)
 * and npm's hoisted flat tree.
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

const MAX_LICENSE_LEN = 256;

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
		const parts = raw
			.map((r) => normaliseLicense((r as { type?: unknown }).type))
			.filter((v): v is string => Boolean(v));
		if (parts.length === 0) return null;
		return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
	}
	return null;
}
