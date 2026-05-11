// SBOM ecosystem detector contract.
//
// Each detector inspects the repo root for ecosystem-specific manifest files
// and returns either:
//   - `null` if no ecosystem-specific manifests are present
//   - a `DetectorResult` describing what was found + the component list
//
// The orchestrator (../sbom.ts) runs detectors in order and combines results.
// If multiple detectors match, the SBOM is multi-ecosystem.

import type { CheckContext } from "../../types.js";

export type Component = {
	name: string;
	version: string;
	license: string | null;
	/** Package URL (purl spec) — e.g. `pkg:cargo/serde@1.0.180`. */
	purl: string;
};

export type DetectorResult = {
	ecosystem: "javascript" | "cargo" | "go" | "python";
	components: Component[];
	missing: string[];
	/** Optional context-specific diagnostic string for the badge details. */
	details?: string;
};

export type Detector = (ctx: CheckContext) => Promise<DetectorResult | null>;
