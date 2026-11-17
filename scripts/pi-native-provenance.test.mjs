import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { validateReleaseProvenance } from "./pi-native-provenance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function fixture() {
	const expected = {
		mode: "promotion",
		sourceRunId: "17",
		repository: "saifymatteo/Pi-Bolt",
		sha: "a".repeat(40),
		tag: "pi-native-v1.2.3",
		version: "1.2.3",
		runtimeTag: "bolt-v1.1.7",
		runtimeStamp: "0123456789abcdef",
	};
	const run = {
		id: 17,
		repository: { full_name: expected.repository },
		head_repository: { full_name: expected.repository },
		head_sha: expected.sha,
		head_branch: "pi-bolt",
		path: ".github/workflows/pi-native-artifacts.yml",
		status: "completed",
		conclusion: "success",
	};
	const metadata = Object.fromEntries(
		["win32-x64", "darwin-arm64", "linux-x64"].map((platform) => [
			platform,
			{
				repository: expected.repository,
				sha: expected.sha,
				ref: "refs/heads/pi-bolt",
				runId: expected.sourceRunId,
				runAttempt: platform === "darwin-arm64" ? "5" : "1",
				platform,
				boltVersion: expected.version,
				jit: "on",
				runtimeRepository: "opensec-git/Pi-Bolt",
				runtimeTag: expected.runtimeTag,
				runtimeStamp: expected.runtimeStamp,
				runtimeSha256: "b".repeat(64),
			},
		]),
	);
	return { run, metadata, expected };
}

describe("native release provenance", () => {
	test("promotes all three artifacts from successful attempts of the same source run", () => {
		const { run, metadata, expected } = fixture();
		assert.doesNotThrow(() => validateReleaseProvenance(run, metadata, expected));
	});

	for (const [field, value, message] of [
		["id", 18, /Source run ID mismatch/],
		["repository", { full_name: "other/repo" }, /Source run repository mismatch/],
		["head_repository", { full_name: "other/repo" }, /Source run head repository mismatch/],
		["repository", null, /Source run repository mismatch/],
		["path", ".github/workflows/other.yml", /Source workflow mismatch/],
		["head_sha", "c".repeat(40), /commit does not match/],
		["status", "in_progress", /must be completed/],
		["conclusion", "failure", /must be successful/],
		["conclusion", "cancelled", /must be successful/],
	]) {
		test(`rejects source run ${field} = ${JSON.stringify(value)}`, () => {
			const { run, metadata, expected } = fixture();
			run[field] = value;
			assert.throws(() => validateReleaseProvenance(run, metadata, expected), message);
		});
	}

	for (const [field, value, message] of [
		["repository", "other/repo", /repository mismatch/],
		["sha", "c".repeat(40), /sha mismatch/],
		["runId", "18", /runId mismatch/],
		["platform", "linux-x64", /platform mismatch/],
		["boltVersion", "1.2.2", /boltVersion mismatch/],
		["jit", "off", /jit mismatch/],
		["runtimeRepository", "other/repo", /runtimeRepository mismatch/],
		["runtimeTag", "bolt-v0.0.1", /runtimeTag mismatch/],
		["runtimeStamp", "fedcba9876543210", /Runtime blocker/],
		["runtimeStamp", "invalid", /Runtime blocker/],
		["runtimeSha256", "invalid", /invalid runtime SHA-256/],
		["ref", "refs/heads/other", /source ref mismatch/],
	]) {
		test(`rejects macOS metadata ${field} = ${JSON.stringify(value)}`, () => {
			const { run, metadata, expected } = fixture();
			metadata["darwin-arm64"][field] = value;
			assert.throws(() => validateReleaseProvenance(run, metadata, expected), message);
		});
	}

	for (const platform of ["win32-x64", "darwin-arm64", "linux-x64"]) {
		test(`rejects missing ${platform}`, () => {
			const { run, metadata, expected } = fixture();
			delete metadata[platform];
			assert.throws(() => validateReleaseProvenance(run, metadata, expected), /Missing .* metadata/);
		});
	}

	test("rejects a release tag with another version", () => {
		const { run, metadata, expected } = fixture();
		expected.tag = "pi-native-v1.2.4";
		assert.throws(() => validateReleaseProvenance(run, metadata, expected), /Release tag version mismatch/);
	});

	for (const tag of ["pi-native-v1.2.3", "pi-native-v1.2.3-trial1", "pi-native-v1.2.3-rc.1+build.7"]) {
		test(`allows automatic publication of active tag run ${tag}`, () => {
			const { run, metadata, expected } = fixture();
			expected.mode = "tag";
			expected.tag = tag;
			run.status = "in_progress";
			run.conclusion = null;
			run.head_branch = tag;
			for (const entry of Object.values(metadata)) entry.ref = `refs/tags/${tag}`;
			assert.doesNotThrow(() => validateReleaseProvenance(run, metadata, expected));
			metadata["darwin-arm64"].ref = `refs/heads/${tag}`;
			assert.throws(() => validateReleaseProvenance(run, metadata, expected), /release tag ref mismatch/);
		});
	}

	test("CLI reads wire JSON and derives the expected commit, version and stamp from the checkout", () => {
		const { run, metadata, expected } = fixture();
		expected.sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		expected.version = readFileSync(join(root, "VERSION"), "utf8").trim();
		expected.tag = `pi-native-v${expected.version}`;
		expected.runtimeStamp = execFileSync("bash", ["scripts/runtime-stamp.sh"], { cwd: root, encoding: "utf8" }).trim();
		run.head_sha = expected.sha;
		for (const entry of Object.values(metadata)) {
			entry.sha = expected.sha;
			entry.boltVersion = expected.version;
			entry.runtimeStamp = expected.runtimeStamp;
		}
		const directory = mkdtempSync(join(tmpdir(), "pi-native-provenance-"));
		try {
			writeFileSync(join(directory, "run.json"), JSON.stringify(run));
			for (const [platform, entry] of Object.entries(metadata)) {
				mkdirSync(join(directory, platform));
				writeFileSync(join(directory, platform, "build-metadata.json"), JSON.stringify(entry));
			}
			const output = execFileSync(
				process.execPath,
				[join(root, "scripts/pi-native-provenance.mjs"), join(directory, "run.json"), directory, root, "promotion"],
				{
					cwd: directory,
					encoding: "utf8",
					env: {
						...process.env,
						SOURCE_RUN_ID: expected.sourceRunId,
						RELEASE_TAG: expected.tag,
						GITHUB_REPOSITORY: expected.repository,
						PI_NATIVE_RUNTIME_TAG: expected.runtimeTag,
					},
				},
			);
			assert.match(output, /Verified all three platforms from source run 17/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
