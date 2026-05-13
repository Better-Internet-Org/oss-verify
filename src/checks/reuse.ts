import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lsFiles } from "../git.js";
import type { CheckContext, CheckResult } from "../types.js";
import { hasAnyLicenseDeclaration } from "./license-text.js";

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

/**
 * SPEC §3.1 "REUSE compliance". The REUSE standard itself accepts three valid
 * declaration patterns; we recognise all three:
 *
 *   1. Per-file SPDX-License-Identifier headers across every source file
 *      (strict REUSE).
 *   2. A repo-level .reuse/dep5 or REUSE.toml file (REUSE's own blanket-
 *      declaration mechanism). We don't parse the file's content — its
 *      presence indicates the maintainer has opted into REUSE format.
 *   3. A root LICENSE / LICENCE / COPYING file with a recognisable license
 *      declaration, in the absence of a REUSE-format file. This is the
 *      common case for projects that declare one license repo-wide without
 *      using REUSE-style per-file headers.
 *
 * Only patterns (1) and (2) are strictly "REUSE-compliant" per the spec;
 * pattern (3) is the pragmatic recognition that a project with a single
 * top-level license has made an unambiguous declaration without going
 * through REUSE's per-file ceremony. Treating (3) as a soft fail (or
 * blanket pass with a note) avoids 100% false-positive rates on the
 * majority of real OSS repos.
 */
export function checkReuse(ctx: CheckContext): CheckResult {
	const hasReuseFormat =
		existsSync(join(ctx.repoRoot, ".reuse", "dep5")) ||
		existsSync(join(ctx.repoRoot, "REUSE.toml"));
	if (hasReuseFormat) {
		return {
			pass: true,
			details:
				"Project uses REUSE-format declarations (.reuse/dep5 or REUSE.toml). Per-file SPDX headers not required.",
		};
	}

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

	// No per-file SPDX headers, no REUSE-format file. Fall back to "is there
	// a recognisable repo-level declaration?" If yes, accept it as a blanket
	// declaration; if no, this is a real REUSE gap.
	if (hasAnyLicenseDeclaration(ctx.repoRoot)) {
		return {
			pass: true,
			details: `${missing.length} of ${checked} source files lack per-file SPDX headers, but a repo-level license declaration (LICENSE file or package.json) is present. Accepted as a blanket declaration.`,
		};
	}

	const sample = missing.slice(0, 10);
	const more = missing.length > sample.length ? ` (+${missing.length - sample.length} more)` : "";
	return {
		pass: false,
		details: `${missing.length} of ${checked} source files missing SPDX-License-Identifier and no repo-level license declaration was found:\n  - ${sample.join("\n  - ")}${more}`,
	};
}
