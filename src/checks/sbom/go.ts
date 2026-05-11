// Go modules ecosystem detector — detection-only stub.
//
// Detects `go.mod` at the repo root. Full implementation needs to:
//   1. Parse go.mod direct deps + go.sum transitive list.
//   2. Look up each module's license — Go has no central license registry,
//      but `deps.dev` (https://deps.dev/_/s/golang/p/<pkg>/v/<ver>/license)
//      and pkg.go.dev expose declared licenses.
//   3. Filter test-only / build-only deps (go.sum doesn't distinguish them
//      directly — need `go list -m -json all` or careful go.mod parsing).
//
// Tracked work; this stub fails the check with a clear "not yet implemented"
// rather than silently passing.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckContext } from "../../types.js";
import type { DetectorResult } from "./types.js";

export async function detect(ctx: CheckContext): Promise<DetectorResult | null> {
	if (!existsSync(join(ctx.repoRoot, "go.mod"))) return null;
	return {
		ecosystem: "go",
		components: [],
		missing: [
			"Go modules detector not yet implemented. Track at github.com/better-internet-org/oss-verify — until then this fails closed by design (per SPEC §3.3).",
		],
	};
}
