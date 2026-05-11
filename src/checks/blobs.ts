import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { lsFiles } from "../git.js";
import type { CheckContext, CheckResult } from "../types.js";

const LARGE_FILE_BYTES = 100 * 1024;
const ENTROPY_THRESHOLD = 7.5; // bits/byte
const MIN_LINE_LEN_FOR_MINIFIED = 500;
const MINIFIED_SIZE_BYTES = 10 * 1024;

const PROPRIETARY_BINARY_EXTS = new Set([
	".dll",
	".so",
	".dylib",
	".exe",
	".o",
	".a",
	".lib",
	".jar",
	".class",
	".pyc",
]);

const MINIFIED_NAME_RE = /\.min\.(js|css)$/i;
const SOURCE_MAP_NAME_RE = /\.map$/i;

function shannonEntropy(buf: Buffer): number {
	const max = Math.min(buf.length, 64 * 1024);
	const counts = new Array<number>(256).fill(0);
	for (let i = 0; i < max; i++) counts[buf[i]]++;
	let h = 0;
	for (const c of counts) {
		if (c === 0) continue;
		const p = c / max;
		h -= p * Math.log2(p);
	}
	return h;
}

function avgLineLength(buf: Buffer): number {
	const text = buf.toString("utf8", 0, Math.min(buf.length, 32 * 1024));
	const lines = text.split("\n");
	if (lines.length === 0) return 0;
	const total = lines.reduce((acc, l) => acc + l.length, 0);
	return total / lines.length;
}

function looksBinary(buf: Buffer): boolean {
	const max = Math.min(buf.length, 4096);
	for (let i = 0; i < max; i++) if (buf[i] === 0) return true;
	return false;
}

export function checkNoProprietaryBlobs(ctx: CheckContext): CheckResult {
	const files = lsFiles(ctx.repoRoot);
	const sourceMapsByBase = new Set(
		files.filter((f) => SOURCE_MAP_NAME_RE.test(f)).map((f) => f.replace(SOURCE_MAP_NAME_RE, "")),
	);
	const flagged: string[] = [];

	for (const rel of files) {
		const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")) : "";
		if (PROPRIETARY_BINARY_EXTS.has(ext.toLowerCase())) {
			flagged.push(`${rel}  (proprietary binary extension)`);
			continue;
		}

		const abs = join(ctx.repoRoot, rel);
		let size: number;
		try {
			size = statSync(abs).size;
		} catch {
			continue;
		}

		// Minified-without-sourcemap: <name>.min.{js,css} with size>10KB and no <name> sibling
		if (MINIFIED_NAME_RE.test(rel) && size > MINIFIED_SIZE_BYTES) {
			const baseNoMin = rel.replace(/\.min(\.(js|css))$/i, "$1");
			if (!files.includes(baseNoMin) && !sourceMapsByBase.has(rel)) {
				flagged.push(`${rel}  (minified, no source / sourcemap counterpart)`);
				continue;
			}
		}

		// High-entropy large binary blob (non-text)
		if (size > LARGE_FILE_BYTES) {
			let buf: Buffer;
			try {
				buf = readFileSync(abs);
			} catch {
				continue;
			}
			if (looksBinary(buf)) {
				const h = shannonEntropy(buf);
				if (h >= ENTROPY_THRESHOLD) {
					flagged.push(`${rel}  (binary, ${size} bytes, entropy ${h.toFixed(2)} bits/byte)`);
					continue;
				}
			}
			// Long-line minified text not caught by name pattern
			if (!looksBinary(buf) && size > MINIFIED_SIZE_BYTES) {
				const avg = avgLineLength(buf);
				if (avg > MIN_LINE_LEN_FOR_MINIFIED) {
					flagged.push(
						`${rel}  (avg line length ${Math.round(avg)} chars — minified-without-source?)`,
					);
				}
			}
		}
	}

	if (flagged.length === 0) {
		return {
			pass: true,
			details: `${files.length} tracked files inspected; no proprietary blobs found`,
		};
	}
	return {
		pass: false,
		details: `Found ${flagged.length} suspect file(s):\n  - ${flagged.slice(0, 20).join("\n  - ")}\nMaintainers may exempt files via .oss-verified.toml (not yet wired in this MVP).`,
	};
}
