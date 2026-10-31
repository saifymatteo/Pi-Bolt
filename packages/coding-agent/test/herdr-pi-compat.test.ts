import { ChildProcess, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import {
	HERDR_PI_COMPAT_FLAG,
	isHerdrPiCompatibilityProcess,
	launchHerdrPiCompatibility,
	prepareHerdrPiRuntime,
} from "../src/herdr-pi-compat.ts";
import { spawnProcess, waitForChildProcess } from "../src/utils/child-process.ts";

vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<object>()) }));
const runtime = vi.hoisted(() => ({ piBolt: true, binary: true, packageDir: "" }));
vi.mock("../src/pi-bolt.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get PIBOLT() {
		return runtime.piBolt ? { version: "1.0.7", variant: "x64-jit", jit: true } : undefined;
	},
}));
vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get isBunBinary() {
		return runtime.binary;
	},
	getPackageDir: () => runtime.packageDir,
}));
vi.mock("../src/utils/child-process.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	spawnProcess: vi.fn(),
	waitForChildProcess: vi.fn(),
}));

const originalExecPath = process.execPath;
let root: string;
let source: string;
let temporary: string;
let original: string;

beforeEach(() => {
	root = fs.mkdtempSync(join(tmpdir(), "pi-herdr-test-"));
	source = join(root, "runtime with spaces");
	temporary = join(root, "temporary");
	fs.mkdirSync(join(source, "native"), { recursive: true });
	fs.mkdirSync(temporary);
	original = join(source, "pi-bolt.exe");
	fs.writeFileSync(original, "native fixture");
	fs.writeFileSync(join(source, "native", "helper.node"), "native helper");
	fs.writeFileSync(join(source, "photon_rs_bg.wasm"), "photon fixture");
	runtime.packageDir = source;
	runtime.piBolt = true;
	runtime.binary = true;
	vi.stubEnv("PIBOLT_HERDR_PI_EXECUTABLE", undefined);
});

afterEach(() => {
	Object.defineProperty(process, "execPath", { value: originalExecPath });
	vi.restoreAllMocks();
	vi.clearAllMocks();
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("Herdr compatibility flag", () => {
	test("is opt-in and does not swallow the initial prompt", () => {
		expect(parseArgs([]).herdrAsPi).toBeUndefined();
		expect(parseArgs([HERDR_PI_COMPAT_FLAG, "hello"])).toMatchObject({
			herdrAsPi: true,
			messages: ["hello"],
		});
		expect(parseArgs([HERDR_PI_COMPAT_FLAG, "--session", original]).unknownFlags.size).toBe(0);
	});

	test("respects option values and end of options", () => {
		expect(parseArgs(["--", HERDR_PI_COMPAT_FLAG]).herdrAsPi).toBeUndefined();
		expect(parseArgs(["--system-prompt", HERDR_PI_COMPAT_FLAG]).herdrAsPi).toBeUndefined();
		expect(parseArgs(["--name", HERDR_PI_COMPAT_FLAG]).herdrAsPi).toBeUndefined();
	});

	test("rejects a value on the boolean flag", () => {
		expect(parseArgs([`${HERDR_PI_COMPAT_FLAG}=false`]).diagnostics).toEqual([
			{ type: "error", message: `${HERDR_PI_COMPAT_FLAG} does not take a value` },
		]);
	});
});

describe("private runtime identity", () => {
	test("requires both the private native image name and its matching absolute marker", () => {
		const privateImage = join(temporary, "pi.exe");
		expect(isHerdrPiCompatibilityProcess({}, privateImage)).toBe(false);
		expect(isHerdrPiCompatibilityProcess({ PIBOLT_HERDR_PI_EXECUTABLE: privateImage }, privateImage)).toBe(true);
		expect(isHerdrPiCompatibilityProcess({ PIBOLT_HERDR_PI_EXECUTABLE: privateImage }, original)).toBe(false);
		expect(isHerdrPiCompatibilityProcess({ PIBOLT_HERDR_PI_EXECUTABLE: original }, original)).toBe(false);
		expect(isHerdrPiCompatibilityProcess({ PIBOLT_HERDR_PI_EXECUTABLE: "pi.exe" }, privateImage)).toBe(false);
	});

	test("inherited mode markers cannot affect an unrelated native executable", () => {
		const privateImage = join(temporary, "pi.exe");
		const otherImage = join(source, "pi.exe");
		expect(isHerdrPiCompatibilityProcess({ PIBOLT_HERDR_PI_EXECUTABLE: privateImage }, otherImage)).toBe(false);
	});
});

describe("runtime snapshots", () => {
	test("copies the executable and assets without changing the installation", () => {
		const directory = prepareHerdrPiRuntime(original, source, temporary);
		expect(fs.readFileSync(join(directory, "pi.exe"), "utf8")).toBe("native fixture");
		expect(fs.readFileSync(join(directory, "native", "helper.node"), "utf8")).toBe("native helper");
		expect(fs.readFileSync(join(directory, "photon_rs_bg.wasm"), "utf8")).toBe("photon fixture");
		expect(fs.existsSync(join(source, "pi.exe"))).toBe(false);
		expect(fs.readFileSync(original, "utf8")).toBe("native fixture");
	});

	test("takes fresh bytes on each launch, including after update or rollback", () => {
		const first = prepareHerdrPiRuntime(original, source, temporary);
		fs.writeFileSync(original, "updated executable");
		fs.writeFileSync(join(source, "native", "helper.node"), "updated helper");
		const second = prepareHerdrPiRuntime(original, source, temporary);
		expect(second).not.toBe(first);
		expect(fs.readFileSync(join(first, "pi.exe"), "utf8")).toBe("native fixture");
		expect(fs.readFileSync(join(first, "native", "helper.node"), "utf8")).toBe("native helper");
		expect(fs.readFileSync(join(second, "pi.exe"), "utf8")).toBe("updated executable");
		fs.writeFileSync(original, "native fixture");
		const rollback = prepareHerdrPiRuntime(original, source, temporary);
		expect(fs.readFileSync(join(rollback, "pi.exe"), "utf8")).toBe("native fixture");
	});

	test("rejects a separate asset override instead of starting with missing native helpers", () => {
		expect(() => prepareHerdrPiRuntime(original, temporary, temporary)).toThrow("assets beside the executable");
		expect(fs.readdirSync(temporary)).toEqual([]);
	});

	test.each(["", "nested", "..not-a-parent"])("rejects a temporary root inside the source: %s", (name) => {
		const nested = join(source, name);
		fs.mkdirSync(nested, { recursive: true });
		expect(() => prepareHerdrPiRuntime(original, source, nested)).toThrow("outside the source");
	});

	test("rejects a temporary junction or symlink into the source", () => {
		const nested = join(source, "nested");
		const link = join(root, "temporary-link");
		fs.mkdirSync(nested);
		fs.symlinkSync(nested, link, process.platform === "win32" ? "junction" : "dir");
		expect(() => prepareHerdrPiRuntime(original, source, link)).toThrow("outside the source");
	});

	test("removes a partial snapshot if copying fails", () => {
		vi.spyOn(fs, "cpSync").mockImplementation(() => {
			throw new Error("disk full");
		});
		expect(() => prepareHerdrPiRuntime(original, source, temporary)).toThrow("disk full");
		expect(fs.readdirSync(temporary)).toEqual([]);
	});

	test("refuses a changed source executable and cleans the snapshot", () => {
		const copy = fs.cpSync;
		vi.spyOn(fs, "cpSync").mockImplementation((src, dest, options) => {
			copy(src, dest, options);
			fs.writeFileSync(original, "a newer executable with a different size");
		});
		expect(() => prepareHerdrPiRuntime(original, source, temporary)).toThrow("changed while preparing");
		expect(fs.readdirSync(temporary)).toEqual([]);
	});
});

describe.skipIf(process.platform !== "win32")("Windows native image", () => {
	test("runs as a real pi.exe with adjacent assets, not a shell alias", () => {
		fs.copyFileSync(process.execPath, original);
		fs.writeFileSync(
			join(source, "probe.cjs"),
			`const { execFileSync } = require("node:child_process");
const { join, dirname } = require("node:path");
const { readFileSync } = require("node:fs");
const image = execFileSync(join(process.env.SystemRoot || "C:\\\\Windows", "System32", "tasklist.exe"),
  ["/fi", "PID eq " + process.pid, "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 10000 });
console.log(JSON.stringify({ executable: process.execPath, image,
  asset: readFileSync(join(dirname(process.execPath), "native", "helper.node"), "utf8") }));
`,
		);
		const directory = prepareHerdrPiRuntime(original, source, temporary);
		// Node is a local native fixture, not Pi-Bolt: this proves OS image naming and adjacency, not Herdr delivery.
		const result = spawnSync(join(directory, "pi.exe"), [join(directory, "probe.cjs")], {
			encoding: "utf8",
			cwd: root,
			env: { ...process.env, NODE_OPTIONS: "" },
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		const probe = JSON.parse(result.stdout) as { executable: string; image: string; asset: string };
		expect(basename(probe.executable)).toBe("pi.exe");
		expect(probe.executable.toLowerCase()).toBe(join(directory, "pi.exe").toLowerCase());
		expect(probe.image.toLowerCase()).toMatch(/^"pi\.exe",/m);
		expect(probe.asset).toBe("native helper");
	});
});

describe.skipIf(process.platform !== "win32")("Windows launcher", () => {
	beforeEach(() => {
		// Default parameters still use the real process executable, but all staging stays inside our fixture.
		Object.defineProperty(process, "execPath", { value: original });
		const child = new ChildProcess();
		vi.mocked(spawnProcess).mockReturnValue(child);
		vi.mocked(waitForChildProcess).mockResolvedValue(17);
	});

	test("inherits input and PATH, propagates exit status, and removes the runtime", async () => {
		const listeners = process.listenerCount("SIGINT");
		expect(await launchHerdrPiCompatibility([HERDR_PI_COMPAT_FLAG, "--session", "file with spaces.jsonl"])).toBe(17);
		const [executable, args, options] = vi.mocked(spawnProcess).mock.calls[0];
		expect(basename(executable)).toBe("pi.exe");
		expect(args).toEqual([HERDR_PI_COMPAT_FLAG, "--session", "file with spaces.jsonl"]);
		expect(options.stdio).toBe("inherit");
		expect(options.env?.PIBOLT_HERDR_PI_EXECUTABLE).toBe(executable);
		expect(options.env?.PATH).toBe(process.env.PATH);
		expect(options.env?.PI_PACKAGE_DIR).toBeUndefined();
		expect(fs.existsSync(executable)).toBe(false);
		expect(process.listenerCount("SIGINT")).toBe(listeners);
	});

	test.each(["PI_PACKAGE_DIR", "pi_package_dir"])(
		"an original executable can launch again without inheriting %s",
		async (key) => {
			vi.stubEnv(key, source);
			vi.stubEnv("pibolt_herdr_pi_executable", join(source, "old", "pi.exe"));
			await launchHerdrPiCompatibility([HERDR_PI_COMPAT_FLAG]);
			const [first, , options] = vi.mocked(spawnProcess).mock.calls[0];
			expect(Object.keys(options.env ?? {}).filter((name) => name.toUpperCase() === "PI_PACKAGE_DIR")).toEqual([]);
			expect(
				Object.keys(options.env ?? {}).filter((name) => name.toUpperCase() === "PIBOLT_HERDR_PI_EXECUTABLE"),
			).toEqual(["PIBOLT_HERDR_PI_EXECUTABLE"]);
			vi.stubEnv(key, undefined);
			vi.stubEnv("PIBOLT_HERDR_PI_EXECUTABLE", options.env?.PIBOLT_HERDR_PI_EXECUTABLE);
			expect(isHerdrPiCompatibilityProcess()).toBe(false);
			expect(await launchHerdrPiCompatibility([HERDR_PI_COMPAT_FLAG])).toBe(17);
			const [second] = vi.mocked(spawnProcess).mock.calls[1];
			expect(second).not.toBe(first);
		},
	);

	test("does not recursively relaunch the marked private process", async () => {
		const privateImage = join(source, "pi.exe");
		Object.defineProperty(process, "execPath", { value: privateImage });
		vi.stubEnv("PIBOLT_HERDR_PI_EXECUTABLE", privateImage);
		expect(await launchHerdrPiCompatibility([HERDR_PI_COMPAT_FLAG])).toBeUndefined();
		expect(spawnProcess).not.toHaveBeenCalled();
	});

	test("cleans up after spawn failure without masking the error", async () => {
		vi.mocked(waitForChildProcess).mockRejectedValue(new Error("spawn failed"));
		await expect(launchHerdrPiCompatibility([HERDR_PI_COMPAT_FLAG])).rejects.toThrow("spawn failed");
		const [executable] = vi.mocked(spawnProcess).mock.calls[0];
		expect(fs.existsSync(executable)).toBe(false);
	});

	test.each(["binary", "piBolt"] as const)("rejects non-native/non-Pi-Bolt entrypoints: %s", async (property) => {
		runtime[property] = false;
		await expect(launchHerdrPiCompatibility([HERDR_PI_COMPAT_FLAG])).rejects.toThrow("native Windows Pi-Bolt");
		expect(spawnProcess).not.toHaveBeenCalled();
	});
});
