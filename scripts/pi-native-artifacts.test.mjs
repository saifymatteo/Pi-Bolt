import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { validateRuntimeStamp } from "./pi-native-runtime.mjs";

const source = readFileSync(new URL("../.github/workflows/pi-native-artifacts.yml", import.meta.url), "utf8");
const workflow = parse(source);
const job = workflow.jobs.artifacts;
const steps = job.steps;
const scripts = steps.map((step) => step.run ?? "").join("\n");

test("artifact workflow is restricted to the fork branch with read-only permissions", () => {
	assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
	assert.deepEqual(workflow.on.push, { branches: ["feat/pi-native-identity"], tags: ["pi-native-v*"] });
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.equal(job.if, "github.repository == 'saifymatteo/Pi-Bolt' && (github.ref == 'refs/heads/feat/pi-native-identity' || startsWith(github.ref, 'refs/tags/pi-native-v'))");
	assert.deepEqual(Object.keys(workflow.jobs), ["artifacts", "release"]);
	assert.equal(job.permissions, undefined);
	assert.doesNotMatch(source, /secrets\.|write-all|id-token:|GITHUB_PATH|\$env:PATH\s*=|export PATH=|npm publish|install\.ps1|install\.sh/);
});

test("only Windows x64 and native macOS ARM64 build, with the repository's pinned actions", () => {
	assert.deepEqual(job.strategy.matrix.include, [
		{ runner: "windows-2025", platform: "win32-x64" },
		{ runner: "macos-15", platform: "darwin-arm64" },
	]);
	assert.equal(job.strategy["fail-fast"], false);
	assert.match(scripts, /process\.platform.*process\.arch/);
	const pins = {
		"actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
		"actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1",
		"actions/upload-artifact": "cf430e030ddbb5b0abf93d22962f4752f3646cd9",
	};
	for (const step of steps.filter((step) => step.uses)) {
		const [action, sha] = step.uses.split("@");
		assert.equal(sha, pins[action]);
	}
	assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["persist-credentials"], false);
});

test("upstream signed runtime is pinned and its original adjacent stamp gates every build", () => {
	assert.equal(workflow.env.PI_NATIVE_RUNTIME_TAG, "bolt-v1.0.9");
	assert.match(scripts, /bash scripts\/fetch-runtime\.sh --version "\$PI_NATIVE_RUNTIME_TAG"/);
	assert.match(scripts, /https:\/\/github\.com\/opensec-git\/Pi-Bolt\/releases\/download/);
	assert.match(scripts, /pkeyutl -verify -pubin -inkey keys\\release\.pub/);
	assert.match(scripts, /foreach \(\$name in 'pi-bolt-runtime-win32-x64.zip', 'RUNTIME_STAMP'\)/);
	const gate = steps.findIndex((step) => step.run === "node scripts/pi-native-runtime.mjs .work/runtime/RUNTIME_STAMP");
	assert.ok(gate > 0);
	assert.equal(steps[gate].if, undefined);
	assert.equal(steps[gate]["continue-on-error"], undefined);
	for (const step of steps.filter((step) => /prepare-pi|npm ci|build-pi/.test(step.run ?? ""))) {
		assert.ok(steps.indexOf(step) > gate);
	}
	assert.doesNotMatch(scripts, /PIBOLT_RUNTIME_OLDER|PIBOLT_RUNTIME_STAMP=|build-runtime|releases\/latest/);
});

test("offline preparation, JIT on, native regressions and full-output archive are mandatory", () => {
	assert.match(scripts, /bash scripts\/prepare-pi\.sh/);
	assert.match(scripts, /npm ci --ignore-scripts/);
	assert.match(scripts, /npm run build:offline/);
	const regressions = steps.find((step) => step.name === "Focused offline source regressions");
	assert.equal(regressions["working-directory"], "packages/coding-agent");
	for (const file of ["config-pi-identity", "herdr-extension", "pi-bolt-update-rollback", "pi-bolt-jit-hint"]) {
		assert.ok(regressions.run.includes(`test/${file}.test.ts`));
	}
	assert.match(scripts, /node --test test\/terminal\.test\.ts/);
	assert.match(scripts, /build-pi\.sh --jit on --out out\/pi-native\/runtime(?:\n|$)/);
	assert.match(scripts, /build-pi\.ps1 -Jit on -Out out\\pi-native\\runtime(?:\n|$)/);
	assert.match(scripts, /tests\/pi\/run\.sh "\$PWD\/out\/pi-native\/runtime\/pi"/);
	assert.match(scripts, /tests\\pi\\run\.ps1 \(Resolve-Path out\\pi-native\\runtime\\pi\.exe\)\.Path/);
	const build = steps.findIndex((step) => /build-pi\.ps1/.test(step.run ?? ""));
	const launchers = steps.findIndex((step) => /pi-native-artifacts\.py launchers out\/pi-native/.test(step.run ?? ""));
	const smoke = steps.findIndex((step) => /pi-native-artifacts\.py smoke/.test(step.run ?? ""));
	assert.ok(launchers > build && smoke > launchers);
	assert.equal(steps[launchers].if, undefined);
	assert.match(scripts, /pi-native-artifacts\.py smoke out\/pi-native/);
	assert.match(scripts, /pi-native-artifacts\.py archive out\/pi-native/);
	assert.doesNotMatch(scripts, /pi-bolt\.exe|Rename-Item|mv .*pi-bin|--herdr-as-pi/);
	const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
	assert.equal(upload.with.name, "pi-native-${{ matrix.platform }}");
	assert.equal(upload.with["if-no-files-found"], "error");
	assert.match(upload.with.path, /\*\.tar\.gz/);
	assert.match(upload.with.path, /SHA256SUMS/);
	assert.match(upload.with.path, /build-metadata\.json/);
	assert.equal(upload.if, undefined);
});

test("a pi-native-v* tag publishes both archives as a verified prerelease", () => {
	const release = workflow.jobs.release;
	assert.equal(release.needs, "artifacts");
	assert.equal(release["runs-on"], "ubuntu-latest");
	assert.equal(release.if, "github.repository == 'saifymatteo/Pi-Bolt' && startsWith(github.ref, 'refs/tags/pi-native-v')");
	assert.deepEqual(release.permissions, { contents: "write" });
	const runs = release.steps.map((step) => step.run ?? "").join("\n");
	for (const platform of ["win32-x64", "darwin-arm64"]) {
		assert.match(runs, new RegExp(`gh run download .*--name pi-native-${platform}`));
		assert.match(runs, new RegExp(`sha256sum -c SHA256SUMS`));
		assert.match(runs, new RegExp(`build-metadata-${platform}\\.json`));
	}
	assert.match(runs, /gh release create "\$GITHUB_REF_NAME" out\/release\/\*.*--prerelease/s);
	assert.doesNotMatch(runs, /npm publish|install\.ps1|install\.sh|homebrew|crates|cargo publish/);
});

test("runtime stamp uses an LF header on Windows and Unix", () => {
	const header = execFileSync("python3", ["-c", 'import json, sys; s = json.load(open("sources.json")); sys.stdout.buffer.write((json.dumps({"webkit": s["webkit"], "bun": s["bun"]}, sort_keys=True) + "\\n").encode("utf-8"))']);
	const files = ["patches/webkit.patch", "patches/bun.patch", "scripts/build-runtime.sh", "scripts/build-runtime.ps1",
		...readdirSync("scripts/toolchain").filter((name) => name.endsWith(".sh")).sort().map((name) => `scripts/toolchain/${name}`),
		...readdirSync("profiles").filter((name) => /^runtime-.*\.hints$/.test(name)).sort().map((name) => `profiles/${name}`)];
	const hash = createHash("sha256").update(header);
	for (const file of files) hash.update(readFileSync(file));
	const actual = execFileSync("bash", ["scripts/runtime-stamp.sh"], { encoding: "utf8" }).trim();
	assert.equal(actual, hash.digest("hex").slice(0, 16));
});

test("runtime stamp rejects missing, malformed and mismatched downloaded data", () => {
	const stamp = "d615e931f06bb5a4";
	assert.equal(validateRuntimeStamp(stamp, stamp), stamp);
	assert.equal(validateRuntimeStamp(`${stamp}\n`, stamp), stamp);
	for (const bad of ["", "unknown", `${stamp}\n\n`, `${stamp}\r\n`, ` ${stamp}`, stamp.toUpperCase(), "0".repeat(16)]) {
		assert.throws(() => validateRuntimeStamp(bad, stamp), /Runtime blocker/);
	}
	assert.throws(() => validateRuntimeStamp(stamp, "99606714c61e2782"), /signed upstream stamp.*!= local engine/);
	assert.throws(() => validateRuntimeStamp(stamp, ""), /Runtime blocker/);
});
