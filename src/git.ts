import { execSync } from "node:child_process";

// 64 MiB stdout — `git ls-files` on a 21k-file repo (posthog) exceeds the
// 1 MiB default and throws ENOBUFS before we can do anything with it; the
// other helpers here are small but inherit the same setting for consistency.
const MAX_BUFFER = 64 * 1024 * 1024;

const exec = (cmd: string, cwd: string): string =>
	execSync(cmd, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: MAX_BUFFER,
	}).trim();

export function commitSha(repoRoot: string): string {
	return exec("git rev-parse HEAD", repoRoot);
}

export function defaultBranch(repoRoot: string): string {
	// Prefer the symbolic ref of origin/HEAD; fall back to current branch.
	try {
		const ref = exec("git symbolic-ref --short refs/remotes/origin/HEAD", repoRoot);
		return ref.replace(/^origin\//, "");
	} catch {
		return exec("git branch --show-current", repoRoot) || "main";
	}
}

/** All files tracked by git at HEAD (working-tree paths, repo-relative, no submodules). */
export function lsFiles(repoRoot: string): string[] {
	return exec("git ls-files --cached --exclude-standard", repoRoot).split("\n").filter(Boolean);
}

export function repoUrlFromRemote(repoRoot: string): string {
	const url = exec("git config --get remote.origin.url", repoRoot);
	// Normalise: drop .git suffix, prefer https form
	return url
		.replace(/^git@([^:]+):/, "https://$1/")
		.replace(/\.git$/, "")
		.replace(/\/$/, "");
}
