// Authenticate a privately built macOS archive without claiming GitHub Actions provenance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateRuntimeStamp } from "./pi-native-runtime.mjs";

/** Authenticate the local archive against the release source and write its fixed-name checksums. */
export function verifyLocalMacosBuild(stage, expected, allowedSigners) {
	const bytes = readFileSync(resolve(stage, "build-metadata.json"));
	// Downloaded bytes are untrusted: authenticate the same bytes we subsequently parse.
	execFileSync(
		"ssh-keygen",
		[
			"-Y", "verify", "-f", allowedSigners, "-I", "pi-bolt-local-builder",
			"-n", "pi-bolt-native-build", "-s", resolve(stage, "build-metadata.json.sig"),
		],
		{ input: bytes, stdio: ["pipe", "pipe", "pipe"] },
	);
	const record = JSON.parse(bytes.toString("utf8"));
	for (const [field, value] of Object.entries({
		schemaVersion: 1,
		buildType: "ssh-local",
		repository: expected.repository,
		sourceCommit: expected.sha,
		sourceTree: expected.tree,
		platform: "darwin-arm64",
		boltVersion: expected.version,
		jit: "on",
		runtimeRepository: "opensec-git/Pi-Bolt",
		runtimeTag: expected.runtimeTag,
	})) {
		assert.equal(record[field], value, `Local macOS: ${field} mismatch`);
	}
	for (const field of ["runId", "runAttempt", "ref", "sha"]) {
		assert.equal(record[field], undefined, `Local macOS must not claim CI ${field}`);
	}
	validateRuntimeStamp(record.runtimeStamp, expected.runtimeStamp);
	for (const field of ["sourceArchiveSha256", "runtimeSha256", "archiveSha256"]) {
		assert.match(record[field], /^[0-9a-f]{64}$/, `Local macOS: invalid ${field}`);
	}
	const requiredChecks = [
		"signed runtime stamp gate",
		"offline source build",
		"workflow and packaging contracts",
		"focused source regressions",
		"terminal submission regressions",
		"native Pi regressions",
		"canonical identity, compiled image, argv, and image worker smoke",
		"offline launcher repair, idempotence, deletion recovery, upstream preference, and doctor diagnostics",
	];
	assert.ok(Array.isArray(record.checksPassed), "Local macOS: checksPassed must be an array");
	for (const check of requiredChecks) {
		assert.ok(record.checksPassed.includes(check), `Local macOS: missing check ${check}`);
	}
	const archive = readFileSync(resolve(stage, "pi-bolt-darwin-arm64-jit.tar.gz"));
	assert.equal(createHash("sha256").update(archive).digest("hex"), record.archiveSha256, "Local macOS archive SHA-256 mismatch");
	// Never execute checksum paths from a downloaded file; generate our own after authentication.
	const sums = [
		`${record.archiveSha256}  pi-bolt-darwin-arm64-jit.tar.gz`,
		...["build-metadata.json", "build-metadata.json.sig"].map((name) =>
			`${createHash("sha256").update(readFileSync(resolve(stage, name))).digest("hex")}  ${name}`),
	];
	writeFileSync(resolve(stage, "SHA256SUMS"), `${sums.join("\n")}\n`);
	return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [stage, source, allowedSigners] = process.argv.slice(2);
	const expected = {
		repository: process.env.GITHUB_REPOSITORY,
		runtimeTag: process.env.PI_NATIVE_RUNTIME_TAG,
		sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(),
		tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: source, encoding: "utf8" }).trim(),
		version: readFileSync(resolve(source, "VERSION"), "utf8").trim(),
		runtimeStamp: execFileSync("bash", ["scripts/runtime-stamp.sh"], { cwd: source, encoding: "utf8" }).trim(),
	};
	verifyLocalMacosBuild(stage, expected, allowedSigners);
	console.log(`Verified SSH-local macOS build for ${expected.sha}; no CI builder identity claimed`);
}
