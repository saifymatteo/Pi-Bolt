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
	assert.deepEqual(workflow.on.push, { branches: ["feat/pi-native-identity", "pi-bolt"], tags: ["pi-native-v*"] });
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.equal(job.needs, "validate-inputs");
	assert.equal(job.if, "github.repository == 'saifymatteo/Pi-Bolt' && !(github.event_name == 'workflow_dispatch' && inputs.source_run_id != '' && inputs.release_tag != '') && (github.ref == 'refs/heads/feat/pi-native-identity' || github.ref == 'refs/heads/pi-bolt' || startsWith(github.ref, 'refs/tags/pi-native-v'))");
	assert.deepEqual(Object.keys(workflow.jobs), ["validate-inputs", "artifacts", "release"]);
	assert.equal(job.permissions, undefined);
	// The build jobs get no credentials at all; only the release job may sign (its own key, write-scoped).
	assert.doesNotMatch(scripts, /secrets\.|write-all|id-token:|GITHUB_PATH|\$env:PATH\s*=|export PATH=|npm publish/);
	assert.match(source, /secrets\.PI_NATIVE_RELEASE_KEY/);
});

test("Windows x64, native macOS ARM64 and glibc Linux x64 build, with the repository's pinned actions", () => {
	assert.deepEqual(job.strategy.matrix.include, [
		{ runner: "windows-2025", platform: "win32-x64" },
		{ runner: "macos-15", platform: "darwin-arm64" },
		{ runner: "ubuntu-24.04", platform: "linux-x64" },
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
	assert.equal(workflow.env.PI_NATIVE_RUNTIME_TAG, "bolt-v1.1.7");
	const unixRuntime = steps.find((step) => step.name === "Signed upstream runtime (Unix)");
	assert.equal(unixRuntime.if, "runner.os != 'Windows'");
	assert.equal(unixRuntime.run, 'bash scripts/fetch-runtime.sh --version "$PI_NATIVE_RUNTIME_TAG"');
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
	for (const name of ["Prepare Pi offline (Unix)", "Build JIT-on Pi (Unix)", "Native Pi regression tests (Unix)"]) {
		const step = steps.find((step) => step.name === name);
		assert.equal(step.if, "runner.os != 'Windows'");
		assert.equal(step["continue-on-error"], undefined);
	}
	assert.match(scripts, /bash scripts\/prepare-pi\.sh/);
	assert.match(scripts, /npm ci --ignore-scripts/);
	assert.match(scripts, /npm run build:offline/);
	assert.match(scripts, /python scripts\/pi-native-installer\.test\.py/);
	assert.match(scripts, /node --test scripts\/pi-native-artifacts\.test\.mjs scripts\/pi-native-provenance\.test\.mjs/);
	const regressions = steps.find((step) => step.name === "Focused offline source regressions");
	assert.equal(regressions["working-directory"], "packages/coding-agent");
	for (const file of ["config-pi-identity", "herdr-extension", "pi-bolt-update-rollback", "pi-bolt-jit-hint", "pi-bolt-launchers", "pi-bolt-repair", "pi-bolt-doctor"]) {
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

test("a pi-native-v* tag publishes all three archives and metadata as a signed release", () => {
	const release = workflow.jobs.release;
	assert.deepEqual(release.needs, ["validate-inputs", "artifacts"]);
	assert.equal(release["runs-on"], "ubuntu-latest");
	assert.match(release.if, /!cancelled\(\)/);
	assert.deepEqual(release.permissions, { contents: "write", actions: "read" });
	const runs = release.steps.map((step) => step.run ?? "").join("\n");
	for (const platform of ["win32-x64", "darwin-arm64", "linux-x64"]) {
		assert.match(runs, new RegExp(`gh run download .*--name pi-native-${platform}`));
		assert.ok(runs.includes(`(cd stage/${platform} && sha256sum -c SHA256SUMS)`));
		assert.ok(runs.includes(`cp stage/${platform}/build-metadata.json out/release/build-metadata-${platform}.json`));
		assert.match(runs, new RegExp(`build-metadata-${platform}\\.json`));
	}
	// The updater reads the version from the first line and the installers and archives by name.
	assert.match(runs, /cp stage\/win32-x64\/pi-bolt-win32-x64-jit\.zip stage\/darwin-arm64\/pi-bolt-darwin-arm64-jit\.tar\.gz stage\/linux-x64\/pi-bolt-linux-x64-jit\.tar\.gz out\/release\//);
	assert.match(runs, /echo "# pi-bolt \$version"/);
	assert.match(runs, /sha256sum install\.ps1 install\.sh pi-bolt-win32-x64-jit\.zip pi-bolt-darwin-arm64-jit\.tar\.gz pi-bolt-linux-x64-jit\.tar\.gz build-metadata-\*\.json/);
	// Signed with the fork key (CI secret); the built-in public key must take the signature before publishing.
	assert.match(runs, /pkeyutl -sign -rawin -in out\/release\/SHA256SUMS -inkey out\/release-signing\.key -out out\/release\/SHA256SUMS\.sig/);
	assert.match(runs, /pkeyutl -verify -pubin -inkey release-source\/keys\/pi-native-release\.pub/);
	assert.match(runs, /rm out\/release-signing\.key/);
	// Trial tags stay prereleases; plain pi-native-v* tags publish as full releases marked Latest.
	assert.match(runs, /case "\$RELEASE_TAG" in \*-trial\*\) flags\+=\(--prerelease\) ;; esac/);
	assert.match(runs, /gh release create "\$RELEASE_TAG" out\/release\/\* --repo "\$GITHUB_REPOSITORY" "\$\{flags\[@\]\}"/);
	assert.match(runs, /cp release-source\/scripts\/install\/install\.ps1 release-source\/scripts\/install\/install\.sh out\/release\//);
	assert.doesNotMatch(runs, /npm publish|homebrew|crates|cargo publish/);
});

test("manual promotion validates paired inputs before downloads and isolates concurrency from branch builds", () => {
	assert.deepEqual(workflow.on.workflow_dispatch.inputs, {
		source_run_id: { description: "Successful run to promote (requires release_tag)", required: false, type: "string" },
		release_tag: { description: "Existing pi-native version tag to publish (requires source_run_id)", required: false, type: "string" },
	});
	const validation = workflow.jobs["validate-inputs"];
	assert.equal(validation.if, "github.repository == 'saifymatteo/Pi-Bolt'");
	const step = validation.steps[0];
	assert.deepEqual(step.env, {
		INPUT_SOURCE_RUN_ID: "${{ inputs.source_run_id }}",
		INPUT_RELEASE_TAG: "${{ inputs.release_tag }}",
	});
	for (const [run, tag, valid] of [
		["", "", true], ["43876196743", "pi-native-v1.2.3", true],
		["43876196743", "pi-native-v1.2.3-trial.1", true],
		["43876196743", "pi-native-v1.2.3-rc.1+build.7", true],
		["43876196743", "", false], ["", "pi-native-v1.2.3", false],
		["1; echo bad", "pi-native-v1.2.3", false], ["1.2", "pi-native-v1.2.3", false],
		["-1", "pi-native-v1.2.3", false], ["1", "refs/tags/pi-native-v1.2.3", false],
		["1", "pi-native-v01.2.3", false], ["1", "pi-native-v1.2.3-01", false],
		["1", "pi-native-v1.2.3; echo bad", false],
	]) {
		const execute = () => execFileSync("bash", ["-e", "-c", step.run], {
			env: { ...process.env, INPUT_SOURCE_RUN_ID: run, INPUT_RELEASE_TAG: tag }, stdio: "pipe",
		});
		if (valid) assert.doesNotThrow(execute, `${run} / ${tag}`);
		else assert.throws(execute, `${run} / ${tag}`);
	}
	assert.equal(workflow.concurrency["cancel-in-progress"], true);
	assert.equal(workflow.concurrency.group, "pi-native-artifacts-${{ github.event_name == 'workflow_dispatch' && (inputs.source_run_id != '' || inputs.release_tag != '') && format('promotion-{0}', inputs.release_tag) || github.ref }}");
});

test("promotion skips builders but permits release only after input validation, while tags require every builder", () => {
	// These conditions use the JS-compatible subset of GitHub expressions, with a hyphenated job key.
	const evaluate = (condition, github, inputs, needs, cancelled = false) => Function(
		"github", "inputs", "needs", "cancelled", "startsWith",
		`return (${condition.replaceAll("needs.validate-inputs", 'needs["validate-inputs"]')});`,
	)(github, inputs, needs, () => cancelled, (value, prefix) => value.startsWith(prefix));
	const branch = { repository: "saifymatteo/Pi-Bolt", event_name: "push", ref: "refs/heads/pi-bolt" };
	const manual = { ...branch, event_name: "workflow_dispatch" };
	const tag = { ...branch, ref: "refs/tags/pi-native-v1.2.3" };
	const noInputs = { source_run_id: "", release_tag: "" };
	const promotion = { source_run_id: "43876196743", release_tag: "pi-native-v1.2.3" };
	const successful = { "validate-inputs": { result: "success" }, artifacts: { result: "success" } };
	const skipped = { ...successful, artifacts: { result: "skipped" } };
	assert.equal(evaluate(job.if, manual, promotion, skipped), false);
	for (const event of [branch, manual, tag]) assert.equal(evaluate(job.if, event, noInputs, successful), true);
	const releaseIf = workflow.jobs.release.if;
	assert.equal(evaluate(releaseIf, manual, promotion, skipped), true);
	assert.equal(evaluate(releaseIf, manual, promotion, skipped, true), false);
	assert.equal(evaluate(releaseIf, tag, noInputs, successful), true);
	for (const result of ["failure", "cancelled", "skipped"]) {
		assert.equal(evaluate(releaseIf, tag, noInputs, { ...successful, artifacts: { result } }), false);
		assert.equal(evaluate(releaseIf, manual, promotion, { ...skipped, "validate-inputs": { result } }), false);
	}
	for (const inputs of [noInputs, { ...promotion, release_tag: "" }, { ...promotion, source_run_id: "" }]) {
		assert.equal(evaluate(releaseIf, manual, inputs, skipped), false);
	}
	assert.equal(evaluate(releaseIf, branch, promotion, successful), false);
	assert.equal(evaluate(releaseIf, { ...manual, repository: "other/fork" }, promotion, skipped), false);
});

test("publisher uses the target tree, source run metadata and provenance before signing or publishing", () => {
	const release = workflow.jobs.release;
	assert.deepEqual(release.env, {
		RELEASE_TAG: "${{ inputs.release_tag || github.ref_name }}",
		SOURCE_RUN_ID: "${{ inputs.source_run_id || github.run_id }}",
		RELEASE_MODE: "${{ github.event_name == 'workflow_dispatch' && inputs.source_run_id != '' && inputs.release_tag != '' && 'promotion' || 'tag' }}",
	});
	const checkouts = release.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
	assert.equal(checkouts.length, 2);
	assert.deepEqual(checkouts[0].with, { ref: "${{ github.workflow_sha }}", "persist-credentials": false });
	assert.deepEqual(checkouts[1].with, { ref: "${{ inputs.release_tag || github.ref }}", path: "release-source", "persist-credentials": false });
	const runs = release.steps.map((step) => step.run ?? "").join("\n");
	assert.match(runs, /RELEASE_SHA=\$\(git -C release-source rev-parse HEAD\)/);
	assert.match(runs, /gh api "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$SOURCE_RUN_ID" > stage\/source-run\.json/);
	for (const platform of ["win32-x64", "darwin-arm64", "linux-x64"]) {
		assert.ok(runs.includes(`gh run download "$SOURCE_RUN_ID" --repo "$GITHUB_REPOSITORY" --name pi-native-${platform} --dir stage/${platform}`));
	}
	const provenance = release.steps.findIndex((step) => step.run === 'node scripts/pi-native-provenance.mjs stage/source-run.json stage release-source "$RELEASE_MODE"');
	const regressions = release.steps.findIndex((step) => step.run === "node --test scripts/pi-native-provenance.test.mjs");
	assert.ok(regressions > 1 && regressions < provenance);
	const sign = release.steps.findIndex((step) => step.name === "Sign the checksums");
	const publish = release.steps.findIndex((step) => step.name === "Publish the release at this tag");
	assert.ok(provenance > release.steps.findIndex((step) => step.run?.includes("gh run download")));
	assert.ok(sign > provenance && publish > sign);
	for (const step of release.steps.slice(provenance)) {
		assert.equal(step.if, undefined);
		assert.equal(step["continue-on-error"], undefined);
	}
	assert.match(runs, /version="\$\{RELEASE_TAG#pi-native-v\}"/);
	assert.match(runs, /echo "Pi-Bolt \(\$RELEASE_TAG\):/);
	assert.match(runs, /echo "- Commit: \$RELEASE_SHA"/);
	assert.match(runs, /echo "- Source run: \$SOURCE_RUN_ID"/);
	assert.match(runs, /--verify-tag/);
	assert.doesNotMatch(runs, /GITHUB_REF_NAME|GITHUB_SHA|GITHUB_RUN_ID|git tag|git push/);
	for (const step of release.steps) {
		if (step.name !== "Sign the checksums") assert.doesNotMatch(JSON.stringify(step), /secrets\.|PI_NATIVE_RELEASE_KEY/);
	}
});

test("installers write the conditional pi takeover shim", () => {
	const ps1 = readFileSync("scripts/install/install.ps1", "utf8");
	assert.match(ps1, /Join-Path \$BinDir 'pi\.cmd'/);
	assert.match(ps1, /PIBOLT_FALLBACK/);
	assert.match(ps1, /where pi 2\^>nul/);
	assert.match(ps1, /pibolt_consider/);
	const sh = readFileSync("scripts/install/install.sh", "utf8");
	assert.match(sh, /"\$BIN_DIR\/pi"/);
	assert.match(sh, /PIBOLT_FALLBACK/);
	assert.match(sh, /case "\$d\/pi" in "\$fallback"\) continue/);
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
