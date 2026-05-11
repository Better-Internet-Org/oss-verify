// Python ecosystem detector — detection-only stub.
//
// Detects common manifest/lock files at the repo root:
//   - pyproject.toml + poetry.lock (Poetry)
//   - pyproject.toml + uv.lock (uv)
//   - Pipfile.lock (Pipenv)
//   - requirements.txt (pip, no lockfile)
//
// Full implementation needs to:
//   1. Detect which package manager(s) are in use and pick the lockfile.
//   2. Parse it — TOML for poetry/uv, JSON for Pipfile.lock, plain text
//      for requirements.txt. Filter dev/test groups.
//   3. Look up each package's license via PyPI JSON API
//      (https://pypi.org/pypi/<pkg>/<ver>/json) — `info.license` is free-
//      form; `info.classifiers` carries "License :: OSI Approved :: ..."
//      which is more reliable. Many packages declare neither cleanly,
//      so a normaliser is needed.
//
// Tracked work; this stub fails the check with a clear "not yet implemented"
// rather than silently passing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckContext } from "../../types.js";
import type { DetectorResult } from "./types.js";

const PYTHON_MARKERS = [
	"pyproject.toml",
	"poetry.lock",
	"uv.lock",
	"Pipfile",
	"Pipfile.lock",
	"requirements.txt",
	"setup.py",
];

export async function detect(ctx: CheckContext): Promise<DetectorResult | null> {
	const found = PYTHON_MARKERS.filter((f) => existsSync(join(ctx.repoRoot, f)));
	if (found.length === 0) return null;
	return {
		ecosystem: "python",
		components: [],
		missing: [
			`Python detector not yet implemented (saw: ${found.join(", ")}). Track at github.com/better-internet-org/oss-verify — until then this fails closed by design (per SPEC §3.3).`,
		],
	};
}
