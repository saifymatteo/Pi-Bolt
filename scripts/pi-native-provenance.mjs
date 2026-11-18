// Validate CI provenance before signing native release artifacts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyLocalMacosBuild } from "./pi-native-local-build.mjs";
import { validateRuntimeStamp } from "./pi-native-runtime.mjs";

const platforms = ["win32-x64", "darwin-arm64", "linux-x64"];

/** Reject source-run or artifact metadata that does not match the checked-out release. */
export function validateReleaseProvenance(run, metadata, expected, jobPages) {
	// Run, job pages and metadata are downloaded JSON, not trusted same-host values.
	assert.ok(["promotion", "tag", "local-macos"].includes(expected.mode), "Unknown provenance mode");
	assert.equal(String(run.id), expected.sourceRunId, "Source run ID mismatch");
	assert.equal(run.repository?.full_name, expected.repository, "Source run repository mismatch");
	assert.equal(run.head_repository?.full_name, expected.repository, "Source run head repository mismatch");
	assert.equal(run.path, ".github/workflows/pi-native-artifacts.yml", "Source workflow mismatch");
	assert.equal(run.head_sha, expected.sha, "Source run commit does not match the release tag");
	if (expected.mode === "promotion") {
		assert.equal(run.status, "completed", "Promoted source run must be completed");
		assert.equal(run.conclusion, "success", "Promoted source run must be successful");
	} else if (expected.mode === "local-macos") {
		assert.equal(run.status, "completed", "Local promotion source run must be completed");
		assert.ok(["success", "failure", "cancelled"].includes(run.conclusion), "Invalid completed source run conclusion");
	} else {
		assert.equal(run.status, "in_progress", "Automatic publication must use its active tag run");
		assert.equal(run.conclusion, null, "Automatic source run already has a conclusion");
	}
	const prefix = `pi-native-v${expected.version}`;
	assert.ok(
		expected.tag === prefix || expected.tag.startsWith(`${prefix}-`) || expected.tag.startsWith(`${prefix}+`),
		"Release tag version mismatch",
	);
	for (const platform of platforms) {
		const entry = metadata[platform];
		assert.ok(entry, `Missing ${platform} metadata`);
		if (expected.mode === "local-macos" && platform === "darwin-arm64") {
			// Its signature, archive hash and full source binding are checked by pi-native-local-build.mjs first.
			assert.equal(entry.buildType, "ssh-local", "macOS must identify its local builder");
			assert.equal(entry.sourceCommit, expected.sha, "macOS source commit mismatch");
			continue;
		}
		for (const [key, value] of Object.entries({
			repository: expected.repository,
			sha: expected.sha,
			runId: expected.sourceRunId,
			platform,
			boltVersion: expected.version,
			jit: "on",
			runtimeRepository: "opensec-git/Pi-Bolt",
			runtimeTag: expected.runtimeTag,
		})) {
			assert.equal(entry[key], value, `${platform}: ${key} mismatch`);
		}
		assert.ok(
			entry.ref === `refs/heads/${run.head_branch}` || entry.ref === `refs/tags/${run.head_branch}`,
			`${platform}: source ref mismatch`,
		);
		if (expected.mode === "tag") {
			assert.equal(entry.ref, `refs/tags/${expected.tag}`, `${platform}: release tag ref mismatch`);
		}
		validateRuntimeStamp(entry.runtimeStamp, expected.runtimeStamp);
		assert.match(entry.runtimeSha256, /^[0-9a-f]{64}$/, `${platform}: invalid runtime SHA-256`);
		if (expected.mode === "local-macos") {
			assert.match(entry.runAttempt, /^[1-9][0-9]*$/, `${platform}: invalid run attempt`);
			const runner = platform === "win32-x64" ? "windows-2025" : "ubuntu-24.04";
			const jobs = jobPages.flatMap((page) => page.jobs).filter((job) =>
				job.name === `artifacts (${runner}, ${platform})` &&
				String(job.run_id) === expected.sourceRunId && String(job.run_attempt) === entry.runAttempt
			);
			assert.ok(jobs.length === 1 && jobs[0].head_sha === expected.sha &&
				jobs[0].status === "completed" && jobs[0].conclusion === "success",
				`${platform}: no successful matching CI job attempt (must be unique)`);
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [runFile, stage, source, mode] = process.argv.slice(2);
	assert.ok(["promotion", "tag", "local-macos"].includes(mode), "Expected provenance mode: promotion, tag or local-macos");
	const expected = {
		mode,
		sourceRunId: process.env.SOURCE_RUN_ID,
		tag: process.env.RELEASE_TAG,
		repository: process.env.GITHUB_REPOSITORY,
		runtimeTag: process.env.PI_NATIVE_RUNTIME_TAG,
		sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
		tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: source, encoding: "utf8" }).trim(),
		version: readFileSync(resolve(source, "VERSION"), "utf8").trim(),
		runtimeStamp: execFileSync("bash", ["scripts/runtime-stamp.sh"], { cwd: source, encoding: "utf8" }).trim(),
	};
	const run = JSON.parse(readFileSync(runFile, "utf8"));
	const metadata = Object.fromEntries(
		platforms.map((platform) => [platform,
			mode === "local-macos" && platform === "darwin-arm64"
				? verifyLocalMacosBuild(resolve(stage, platform), expected,
					fileURLToPath(new URL("../keys/pi-native-local-build.allowed-signers", import.meta.url)))
				: JSON.parse(readFileSync(resolve(stage, platform, "build-metadata.json"), "utf8")),
		]),
	);
	const jobPages = mode === "local-macos" ? JSON.parse(readFileSync(resolve(stage, "source-jobs.json"), "utf8")) : undefined;
	validateReleaseProvenance(run, metadata, expected, jobPages);
	console.log(mode === "local-macos"
		? `Verified Linux/Windows CI run ${expected.sourceRunId} and SSH-local macOS for ${expected.tag} (${expected.sha})`
		: `Verified all three platforms from source run ${expected.sourceRunId} for ${expected.tag} (${expected.sha})`);
}
