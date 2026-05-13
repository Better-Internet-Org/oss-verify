// SPDX-License-Identifier: MIT
//
// Heuristic license detection from LICENSE / LICENCE / COPYING body text.
// Used as a fallback when a project declares its license via the file content
// alone (no SPDX-License-Identifier header, no package.json license field).
//
// Order matters: more specific patterns must come first (AGPL contains the
// GPL phrase, BSD-3-Clause includes the BSD-2 boilerplate, etc.).
//
// This isn't a replacement for full license-scanning tooling (licensee,
// ScanCode). It catches the ~10 most common OSI licenses with high precision
// — enough to keep checkOsiLicense and checkReuse from emitting false
// negatives against the majority of real-world OSS repos.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];

type Detector = {
	spdx: string;
	matches: (body: string) => boolean;
};

const DETECTORS: Detector[] = [
	// AGPL must beat the GPL detector below (AGPL text contains "GNU GENERAL
	// PUBLIC LICENSE" as a referenced phrase).
	{
		spdx: "AGPL-3.0-only",
		matches: (b) => /GNU AFFERO GENERAL PUBLIC LICENSE/i.test(b) && /Version 3/i.test(b),
	},
	{
		spdx: "GPL-3.0-only",
		matches: (b) =>
			/GNU GENERAL PUBLIC LICENSE/i.test(b) &&
			/Version 3/i.test(b) &&
			!/AFFERO/i.test(b) &&
			!/LESSER/i.test(b),
	},
	{
		spdx: "GPL-2.0-only",
		matches: (b) =>
			/GNU GENERAL PUBLIC LICENSE/i.test(b) && /Version 2/i.test(b) && !/LESSER/i.test(b),
	},
	{
		spdx: "LGPL-3.0-only",
		matches: (b) => /GNU LESSER GENERAL PUBLIC LICENSE/i.test(b) && /Version 3/i.test(b),
	},
	{
		spdx: "LGPL-2.1-only",
		matches: (b) => /GNU LESSER GENERAL PUBLIC LICENSE/i.test(b) && /Version 2\.1/i.test(b),
	},
	{
		spdx: "Apache-2.0",
		matches: (b) => /Apache License/i.test(b) && /Version 2\.0/i.test(b),
	},
	{
		spdx: "MPL-2.0",
		matches: (b) => /Mozilla Public License/i.test(b) && /Version 2\.0/i.test(b),
	},
	{
		spdx: "BSD-3-Clause",
		matches: (b) => /Redistribution and use/i.test(b) && /Neither the name/i.test(b),
	},
	{
		spdx: "BSD-2-Clause",
		matches: (b) => /Redistribution and use/i.test(b) && !/Neither the name/i.test(b),
	},
	{
		spdx: "MIT",
		matches: (b) =>
			/Permission is hereby granted, free of charge/i.test(b) && /MERCHANTABILITY/i.test(b),
	},
	{
		spdx: "ISC",
		matches: (b) => /Permission to use, copy, modify, and\/or distribute/i.test(b),
	},
	{
		spdx: "Unlicense",
		matches: (b) =>
			/This is free and unencumbered software released into the public domain/i.test(b),
	},
];

/**
 * Returns the SPDX identifier of the first detector that matches the LICENSE
 * body, or null when nothing recognisable is present.
 */
export function detectLicenseFromText(body: string): string | null {
	for (const d of DETECTORS) {
		if (d.matches(body)) return d.spdx;
	}
	return null;
}

/**
 * Returns the SPDX identifier detected from the repo's root LICENSE file (or
 * its common variants), or null if no LICENSE file exists or its content
 * doesn't match any known license.
 */
export function detectRootLicense(repoRoot: string): string | null {
	for (const name of LICENSE_FILES) {
		const p = join(repoRoot, name);
		if (!existsSync(p)) continue;
		try {
			const body = readFileSync(p, "utf8").slice(0, 16384);
			const id = detectLicenseFromText(body);
			if (id) return id;
		} catch {}
	}
	return null;
}

/**
 * True iff the repo has *any* license declaration our checks can recognise:
 * a root LICENSE we can text-detect, an SPDX-License-Identifier in a root
 * license file, or a package.json license field. Used by checkReuse to
 * decide whether a missing per-file SPDX header is a real problem.
 */
export function hasAnyLicenseDeclaration(repoRoot: string): boolean {
	if (detectRootLicense(repoRoot)) return true;
	// SPDX header in a root LICENSE file
	for (const name of LICENSE_FILES) {
		const p = join(repoRoot, name);
		if (!existsSync(p)) continue;
		try {
			const head = readFileSync(p, "utf8").slice(0, 8192);
			if (/SPDX-License-Identifier:/i.test(head)) return true;
		} catch {}
	}
	// package.json license field
	const pkgPath = join(repoRoot, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { license?: string };
			if (pkg.license && pkg.license !== "UNLICENSED") return true;
		} catch {}
	}
	return false;
}
