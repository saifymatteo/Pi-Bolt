import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import { verifyLocalMacosBuild } from "./pi-native-local-build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const namespace = "pi-bolt-native-build";
const checksPassed = [
	"signed runtime stamp gate",
	"offline source build",
	"workflow and packaging contracts",
	"focused source regressions",
	"terminal submission regressions",
	"native Pi regressions",
	"canonical identity, compiled image, argv, and image worker smoke",
	"offline launcher repair, idempotence, deletion recovery, upstream preference, and doctor diagnostics",
];
const signingEnv = { ...process.env, SSH_AUTH_SOCK: "" };
let keyDirectory;
let trustedKey;
let untrustedKey;

before(() => {
	keyDirectory = mkdtempSync(join(tmpdir(), "pi-local-build-keys-"));
	trustedKey = join(keyDirectory, "trusted");
	untrustedKey = join(keyDirectory, "untrusted");
	for (const key of [trustedKey, untrustedKey]) {
		execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "dummy-test-key", "-f", key], {
			env: signingEnv,
		});
	}
});
after(() => {
	if (keyDirectory) rmSync(keyDirectory, { recursive: true, force: true });
});

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-local-build-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const archive = join(directory, "pi-bolt-darwin-arm64-jit.tar.gz");
	const metadata = join(directory, "build-metadata.json");
	const allowedSigners = join(directory, "allowed-signers");
	const archiveBytes = gzipSync(Buffer.alloc(1024));
	writeFileSync(archive, archiveBytes);
	writeFileSync(
		allowedSigners,
		`pi-bolt-local-builder namespaces="${namespace}" ${readFileSync(`${trustedKey}.pub`, "utf8").trim()}\n`,
	);
	const expected = {
		repository: "saifymatteo/Pi-Bolt",
		sha: "a".repeat(40),
		tree: "b".repeat(40),
		version: "1.2.3",
		runtimeTag: "bolt-v1.1.7",
		runtimeStamp: "0123456789abcdef",
	};
	const record = {
		schemaVersion: 1,
		buildType: "ssh-local",
		repository: expected.repository,
		sourceCommit: expected.sha,
		sourceTree: expected.tree,
		sourceArchiveSha256: "c".repeat(64),
		platform: "darwin-arm64",
		boltVersion: expected.version,
		jit: "on",
		runtimeRepository: "opensec-git/Pi-Bolt",
		runtimeTag: expected.runtimeTag,
		runtimeStamp: expected.runtimeStamp,
		runtimeSha256: "d".repeat(64),
		archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
		checksPassed: [...checksPassed],
	};
	return {
		directory, archive, metadata, allowedSigners, expected, record,
		sign(key = trustedKey, signingNamespace = namespace) {
			writeFileSync(metadata, JSON.stringify(record));
			rmSync(`${metadata}.sig`, { force: true });
			execFileSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", signingNamespace, metadata], {
				env: signingEnv,
				stdio: "pipe",
			});
		},
		verify() {
			return verifyLocalMacosBuild(directory, expected, allowedSigners);
		},
	};
}

describe("signed local macOS build", () => {
	test("returns the verified signed record", (t) => {
		const f = fixture(t);
		f.sign();
		assert.deepEqual(f.verify(), f.record);
		assert.equal(readFileSync(join(f.directory, "SHA256SUMS"), "utf8"), [
			`${f.record.archiveSha256}  pi-bolt-darwin-arm64-jit.tar.gz`,
			...["build-metadata.json", "build-metadata.json.sig"].map((name) =>
				`${createHash("sha256").update(readFileSync(join(f.directory, name))).digest("hex")}  ${name}`),
		].join("\n") + "\n");
	});

	for (const [label, change] of [
		["untrusted key", (f) => f.sign(untrustedKey)],
		["wrong signing namespace", (f) => f.sign(trustedKey, "other-namespace")],
		["wrong signing principal", (f) => writeFileSync(f.allowedSigners,
			`other-builder ${readFileSync(`${trustedKey}.pub`, "utf8").trim()}\n`)],
		["signed-data tampering", (f) => writeFileSync(f.metadata, `${JSON.stringify(f.record)}\n`)],
		["changed archive", (f) => writeFileSync(f.archive, gzipSync(Buffer.from("changed archive")))],
		["missing signature", (f) => rmSync(`${f.metadata}.sig`)],
	]) {
		test(`rejects ${label}`, (t) => {
			const f = fixture(t);
			f.sign();
			change(f);
			assert.throws(() => f.verify());
		});
	}

	for (const [field, value] of [
		["repository", "other/repo"],
		["sourceCommit", "e".repeat(40)],
		["sourceTree", "f".repeat(40)],
		["boltVersion", "1.2.2"],
		["platform", "linux-x64"],
		["jit", "off"],
		["runtimeStamp", "fedcba9876543210"],
		["runtimeStamp", "invalid"],
		["runtimeTag", "bolt-v0.0.1"],
		["runtimeRepository", "other/repo"],
		["sourceArchiveSha256", "invalid"],
		["runtimeSha256", "invalid"],
		["archiveSha256", "invalid"],
		["archiveSha256", "e".repeat(64)],
		["schemaVersion", 2],
		["buildType", "github-actions"],
		["checksPassed", checksPassed.join("; ")],
	]) {
		test(`rejects signed ${field} = ${JSON.stringify(value)}`, (t) => {
			const f = fixture(t);
			f.record[field] = value;
			f.sign();
			assert.throws(() => f.verify());
		});
	}

	for (const check of checksPassed) {
		test(`rejects omitted check: ${check}`, (t) => {
			const f = fixture(t);
			f.record.checksPassed = f.record.checksPassed.filter((entry) => entry !== check);
			f.sign();
			assert.throws(() => f.verify());
		});
	}

	for (const [field, value] of [["runId", "17"], ["runAttempt", "1"], ["ref", "refs/heads/main"], ["sha", "a".repeat(40)]]) {
		test(`rejects fake CI field ${field}`, (t) => {
			const f = fixture(t);
			f.record[field] = value;
			f.sign();
			assert.throws(() => f.verify());
		});
	}

	test("CLI derives commit, tree, version and runtime stamp from the checkout", (t) => {
		const f = fixture(t);
		f.record.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		f.record.sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
		f.record.boltVersion = readFileSync(join(root, "VERSION"), "utf8").trim();
		f.record.runtimeStamp = execFileSync("bash", ["scripts/runtime-stamp.sh"], { cwd: root, encoding: "utf8" }).trim();
		f.sign();
		execFileSync(process.execPath, [join(root, "scripts/pi-native-local-build.mjs"), f.directory, root, f.allowedSigners], {
			cwd: f.directory,
			encoding: "utf8",
			env: {
				...signingEnv,
				GITHUB_REPOSITORY: f.expected.repository,
				PI_NATIVE_RUNTIME_TAG: f.expected.runtimeTag,
			},
		});
	});
});
