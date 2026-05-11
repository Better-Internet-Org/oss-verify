#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Builds the npm-distributable form of the CLI:
//   - src/cli.ts + transitive imports compiled to dist/cli.mjs (single file,
//     keeps `import.meta` and Node-builtins external)
//   - dist/spec/ mirrors the vendored spec data the CLI reads at runtime
//
// We don't use a separate bundler: tsx + Node 22's stripping handle TS at
// runtime fine for `node dist/cli.mjs` consumers. The mjs is just the TS
// source with type annotations stripped + a shebang. Keeps bundle size
// low and audit easy — npm consumers can read the dist/ tree directly.

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist");

console.log("→ Clean dist/");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log("→ Strip TS via tsc to dist/");
execSync(
	"npx tsc --outDir dist --module esnext --target es2022 --moduleResolution bundler --resolveJsonModule --strict --skipLibCheck --declaration false --noEmit false",
	{ stdio: "inherit", cwd: ROOT },
);

// tsc emits into dist/src/ preserving the source layout. Keep that layout so
// the relative `../../spec/models.json` import in checks/llm-audit.ts still
// resolves at runtime (spec/ sits at dist/spec/, depth matches the source).
const tscCliJs = join(DIST, "src/cli.js");
if (!existsSync(tscCliJs)) {
	console.error("error: tsc did not emit dist/src/cli.js — check tsconfig + src/cli.ts");
	process.exit(1);
}

// Rename src/cli.js -> src/cli.mjs with a shebang so the npm bin entry works
// directly under any installed prefix.
const cliMjs = join(DIST, "src/cli.mjs");
const { readFileSync } = await import("node:fs");
const src = readFileSync(tscCliJs, "utf8");
writeFileSync(cliMjs, src.startsWith("#!") ? src : `#!/usr/bin/env node\n${src}`);
rmSync(tscCliJs);

console.log("→ Mirror spec/ into dist/");
cpSync(join(ROOT, "spec"), join(DIST, "spec"), { recursive: true });

console.log("→ Make cli.mjs executable");
execSync(`chmod +x ${cliMjs}`);

// Update the bin path reference: package.json `bin` points at dist/cli.mjs
// but the file is at dist/src/cli.mjs after flatten-skip. Drop a tiny
// shim at dist/cli.mjs that re-exports + invokes the real entry. Keeps
// the published package.json `bin` working.
const SHIM = "#!/usr/bin/env node\nawait import('./src/cli.mjs');\n";
writeFileSync(join(DIST, "cli.mjs"), SHIM);
execSync(`chmod +x ${join(DIST, "cli.mjs")}`);

console.log("✓ dist/ built");
