import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lsFiles } from "../git.js";
import type { CheckContext, CheckResult } from "../types.js";

// Files that don't need a license header.
//   - License files themselves (the license declaration itself)
//   - Common config files that are factually un-copyrightable
//   - Generated / lock files
const SKIP_PATTERNS: RegExp[] = [
	/^LICENSE(\..+)?$/i,
	/^LICENCE(\..+)?$/i,
	/^COPYING(\..+)?$/i,
	/^NOTICE(\..+)?$/i,
	/^\.gitignore$/,
	/^\.gitattributes$/,
	/^\.editorconfig$/,
	/^\.npmrc$/,
	/^\.nvmrc$/,
	/^\.tool-versions$/,
	/(^|\/)pnpm-lock\.yaml$/,
	/(^|\/)package-lock\.json$/,
	/(^|\/)yarn\.lock$/,
	/(^|\/)bun\.lock(b)?$/,
	/(^|\/)Cargo\.lock$/,
	/(^|\/)go\.sum$/,
	/(^|\/)poetry\.lock$/,
	/\.terraform\.lock\.hcl$/,
	// JSON has no comment syntax — cannot carry an inline SPDX header. Real
	// REUSE-compliant projects register these via .reuse/dep5 or REUSE.toml;
	// MVP CLI doesn't yet parse those, so we skip JSON to avoid false negatives.
	/\.json$/,
	/\.jsonc$/,
];

const SPDX_HEADER_RE = /SPDX-License-Identifier:\s*([A-Za-z0-9.+\-\s()]+)/;

const looksBinary = (buf: Buffer): boolean => {
	const max = Math.min(buf.length, 4096);
	for (let i = 0; i < max; i++) if (buf[i] === 0) return true;
	return false;
};

const skip = (path: string): boolean => SKIP_PATTERNS.some((re) => re.test(path));

export function checkReuse(ctx: CheckContext): CheckResult {
	const files = lsFiles(ctx.repoRoot);
	const missing: string[] = [];
	let checked = 0;

	for (const rel of files) {
		if (skip(rel)) continue;
		const abs = join(ctx.repoRoot, rel);
		let buf: Buffer;
		try {
			buf = readFileSync(abs);
		} catch {
			continue; // symlink to non-file, etc.
		}
		if (looksBinary(buf)) continue;
		checked++;

		// Check the first ~30 lines (or 8 KB) for an SPDX header.
		const head = buf.subarray(0, 8192).toString("utf8");
		if (!SPDX_HEADER_RE.test(head)) {
			missing.push(rel);
		}
	}

	if (missing.length === 0) {
		return {
			pass: true,
			details: `${checked} text files all carry SPDX-License-Identifier headers`,
		};
	}

	const sample = missing.slice(0, 10);
	const more = missing.length > sample.length ? ` (+${missing.length - sample.length} more)` : "";
	return {
		pass: false,
		details: `${missing.length} of ${checked} text files missing SPDX-License-Identifier:\n  - ${sample.join("\n  - ")}${more}\n\nNote: this MVP doesn't yet honor .reuse/dep5 or REUSE.toml exemptions; that's a known limitation.`,
	};
}
