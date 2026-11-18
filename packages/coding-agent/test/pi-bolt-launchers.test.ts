import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PiBoltModule from "../src/pi-bolt.ts";
import { inspectPiBoltLaunchers, repairPiBoltLaunchers } from "../src/pi-bolt-launchers.ts";

vi.mock("../src/pi-bolt.ts", async (importOriginal) => ({
	...(await importOriginal<typeof PiBoltModule>()),
	PIBOLT: { version: "1.0.0", variant: "x64-jit", jit: true },
}));

let root: string;
let bin: string;
let runtime: string;
const execPath = process.execPath;
const platform = process.platform;

function fixture(windows = false): void {
	const install = join(root, "install with 'quotes'");
	runtime = join(install, `pi-bolt-${windows ? "win32" : "linux"}-x64-jit`, windows ? "pi.exe" : "pi");
	mkdirSync(dirname(runtime), { recursive: true });
	writeFileSync(
		join(dirname(runtime), "pi-bolt.txt"),
		`Pi-Bolt 1.0.0 (Pi 1.5.2), ${windows ? "win32" : "linux"}-x64-jit, JIT on\n`,
	);
	writeFileSync(runtime, `#!${execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, {
		mode: 0o755,
	});
	Object.defineProperty(process, "execPath", { value: runtime, configurable: true });
	vi.stubEnv("PIBOLT_INSTALL", install);
	vi.stubEnv("PIBOLT_BIN_DIR", bin);
	vi.stubEnv("PATH", `${bin}${delimiter}/usr/bin${delimiter}/bin`);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-bolt-launchers-"));
	bin = join(root, "bin with spaces");
	fixture();
});

afterEach(() => {
	Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function invoke(name: string, args: string[] = []): string {
	const result = spawnSync(join(bin, name), args, { encoding: "utf8", timeout: 3000 });
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	return result.stdout;
}

describe.skipIf(platform === "win32")("offline launcher repair", () => {
	it("inspects without writes, creates working launchers with exact arguments, and does not rewrite on re-repair", () => {
		expect(inspectPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["missing", "missing"]);
		expect(existsSync(bin)).toBe(false);
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["created", "created"]);
		const args = ["--session", "", "space here", "single'quote", 'double"quote', "back\\slash", "$HOME"];
		expect(JSON.parse(invoke("pi-bolt", args))).toEqual(args);
		expect(JSON.parse(invoke("pi", args))).toEqual(args);
		const before = statSync(join(bin, "pi"));
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["unchanged", "unchanged"]);
		expect(statSync(join(bin, "pi")).ino).toBe(before.ino);
		expect(statSync(join(bin, "pi")).mtimeMs).toBe(before.mtimeMs);
	});

	it("prefers a real upstream Pi after its own shim and skips other fallback and direct shims", () => {
		repairPiBoltLaunchers();
		const other = join(root, "other bin");
		const upstream = join(root, "upstream");
		mkdirSync(other);
		mkdirSync(upstream);
		writeFileSync(join(other, "pi"), readFileSync(join(bin, "pi")), { mode: 0o755 });
		writeFileSync(
			join(upstream, "pi"),
			'#!/bin/sh\n# PIBOLT_FALLBACK is mentioned by this real Pi wrapper\nprintf "upstream:%s" "$1"\n',
			{ mode: 0o755 },
		);
		vi.stubEnv("PATH", [bin, other, upstream, "/usr/bin", "/bin"].join(delimiter));
		expect(invoke("pi", ["yes"])).toBe("upstream:yes");
		writeFileSync(join(other, "pi"), readFileSync(join(bin, "pi-bolt")), { mode: 0o755 });
		expect(invoke("pi", ["yes"])).toBe("upstream:yes");
		rmSync(join(other, "pi"));
		symlinkSync(join(bin, "pi"), join(other, "pi"));
		expect(invoke("pi", ["yes"])).toBe("upstream:yes");
		rmSync(join(upstream, "pi"));
		expect(JSON.parse(invoke("pi", ["fallback"]))).toEqual(["fallback"]);
	});

	it("preserves a healthy installer shim, repairs its permissions, and skips loops without PATH tools", () => {
		mkdirSync(bin);
		const installer = readFileSync(new URL("../../../scripts/install/install.sh", import.meta.url), "utf8");
		const template = /cat > "\$BIN_DIR\/pi" <<'EOF'\n([\s\S]*?)\nEOF/.exec(installer)![1];
		writeFileSync(join(bin, "pi"), `${template.replace("__PIBOLT_FALLBACK__", runtime.replace(/'/g, "'\\''"))}\n`, {
			mode: 0o755,
		});
		expect(inspectPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["missing", "ok"]);
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["created", "unchanged"]);
		chmodSync(join(bin, "pi"), 0o644);
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["unchanged", "repaired"]);
		const other = join(root, "other");
		mkdirSync(other);
		writeFileSync(join(other, "pi"), readFileSync(join(bin, "pi")), { mode: 0o755 });
		vi.stubEnv("PATH", [bin, other].join(delimiter));
		expect(JSON.parse(invoke("pi", ["no external commands"]))).toEqual(["no external commands"]);
	});

	it("preserves real commands and all unrecognized files, including marker mentions", () => {
		mkdirSync(bin);
		const foreign = "#!/bin/sh\n# PIBOLT_FALLBACK is mentioned, not owned\necho real\n";
		for (const name of ["pi", "pi-bolt"]) writeFileSync(join(bin, name), foreign, { mode: 0o755 });
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["preserved", "preserved"]);
		for (const name of ["pi", "pi-bolt"]) expect(readFileSync(join(bin, name), "utf8")).toBe(foreign);
	});

	it("preserves foreign live and broken symlinks without writing through them", () => {
		mkdirSync(bin);
		const foreign = join(root, "foreign");
		writeFileSync(foreign, "untouched", { mode: 0o755 });
		symlinkSync(foreign, join(bin, "pi-bolt"));
		symlinkSync(join(root, "missing-foreign"), join(bin, "pi"));
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["preserved", "error"]);
		expect(readFileSync(foreign, "utf8")).toBe("untouched");
		expect(readlinkSync(join(bin, "pi"))).toBe(join(root, "missing-foreign"));
	});

	it("replaces own broken symlinks without creating their old target", () => {
		mkdirSync(bin);
		const old = join(dirname(dirname(runtime)), "pi-bolt-linux-old", "pi");
		mkdirSync(dirname(old));
		writeFileSync(join(dirname(old), "pi-bolt.txt"), "Pi-Bolt 1.0.0 (Pi 1.5.2), linux-old, JIT on\n");
		for (const name of ["pi", "pi-bolt"]) symlinkSync(old, join(bin, name));
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["repaired", "repaired"]);
		expect(existsSync(old)).toBe(false);
		expect(lstatSync(join(bin, "pi")).isSymbolicLink()).toBe(false);
	});

	it("does not infer ownership from a variant-shaped directory alone", () => {
		mkdirSync(bin);
		const foreign = join(dirname(dirname(runtime)), "pi-bolt-linux-personal", "pi");
		mkdirSync(dirname(foreign));
		writeFileSync(foreign, "#!/bin/sh\necho personal\n", { mode: 0o755 });
		const wrapper = `#!/bin/sh\nexec '${foreign.replace(/'/g, "'\\''")}' "$@"\n`;
		writeFileSync(join(bin, "pi-bolt"), wrapper, { mode: 0o755 });
		symlinkSync(foreign, join(bin, "pi"));
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["preserved", "preserved"]);
		expect(readFileSync(join(bin, "pi-bolt"), "utf8")).toBe(wrapper);
		expect(readlinkSync(join(bin, "pi"))).toBe(foreign);
	});

	it("restores non-executable own launchers", () => {
		repairPiBoltLaunchers();
		for (const name of ["pi", "pi-bolt"]) chmodSync(join(bin, name), 0o644);
		expect(inspectPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["broken", "broken"]);
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["repaired", "repaired"]);
		expect(JSON.parse(invoke("pi", ["permissions"]))).toEqual(["permissions"]);
	});

	it("finds only this runtime's public launcher on PATH, not an unrelated first pi-bolt", () => {
		repairPiBoltLaunchers();
		const foreign = join(root, "unrelated");
		mkdirSync(foreign);
		writeFileSync(join(foreign, "pi-bolt"), "foreign");
		vi.stubEnv("PIBOLT_BIN_DIR", "");
		vi.stubEnv("PATH", [foreign, bin].join(delimiter));
		expect(inspectPiBoltLaunchers().binDir).toBe(bin);
		expect(inspectPiBoltLaunchers().onPath).toBe(true);
		expect(readFileSync(join(foreign, "pi-bolt"), "utf8")).toBe("foreign");
	});

	it("falls back to the installer default rather than an unrelated first pi-bolt", () => {
		const home = join(root, "home");
		const foreign = join(root, "foreign-bin");
		mkdirSync(foreign);
		writeFileSync(join(foreign, "pi-bolt"), "foreign");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PIBOLT_BIN_DIR", "");
		vi.stubEnv("PATH", foreign);
		expect(inspectPiBoltLaunchers().binDir).toBe(join(home, ".local", "bin"));
		expect(existsSync(join(home, ".local"))).toBe(false);
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["created", "created"]);
		expect(readFileSync(join(foreign, "pi-bolt"), "utf8")).toBe("foreign");
	});

	it("distinguishes a missing PATH entry and never edits PATH", () => {
		vi.stubEnv("PATH", "/usr/bin");
		expect(inspectPiBoltLaunchers().onPath).toBe(false);
		expect(repairPiBoltLaunchers().onPath).toBe(false);
		expect(process.env.PATH).toBe("/usr/bin");
	});

	it.each(["npm", "homebrew", "scoop", "mise"] as const)("refuses %s installations", (method) => {
		if (method === "npm") vi.stubEnv("PIBOLT_NPM", "1");
		else {
			const managed = {
				homebrew: join(root, "Cellar", "pi-bolt", "1.0", "libexec", "pi"),
				scoop: join(root, "scoop", "apps", "pi-bolt", "1.0", "pi.exe"),
				mise: join(root, "mise", "installs", "pi-bolt", "1.0", "pi"),
			}[method];
			Object.defineProperty(process, "execPath", { value: managed, configurable: true });
		}
		expect(repairPiBoltLaunchers().supported).toBe(false);
		expect(existsSync(bin)).toBe(false);
	});

	it("refuses unpacked archives and uninstalled builds", () => {
		vi.stubEnv("PIBOLT_INSTALL", "");
		expect(repairPiBoltLaunchers().reason).toContain("unpacked archive");
		expect(existsSync(bin)).toBe(false);
		Object.defineProperty(process, "execPath", { value: join(root, "build", "pi"), configurable: true });
		expect(repairPiBoltLaunchers().reason).toContain("Not an installed");
	});

	it("uses the macOS public pi rather than the private pi-bin engine", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		Object.defineProperty(process, "execPath", { value: join(dirname(runtime), "pi-bin"), configurable: true });
		expect(repairPiBoltLaunchers().runtime).toBe(runtime);
		expect(readFileSync(join(bin, "pi-bolt"), "utf8")).toContain('/pi\' "$@"');
	});

	it("reports directory permission/write failures without replacing unrelated files", () => {
		writeFileSync(bin, "not a directory");
		const result = repairPiBoltLaunchers();
		expect(result.launchers.every((entry) => entry.status === "error")).toBe(true);
		expect(readFileSync(bin, "utf8")).toBe("not a directory");
	});
});

describe("Windows launcher generation (platform mock)", () => {
	it("writes installer-style cmd launchers, skips other shims, and is idempotent", () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		fixture(true);
		mkdirSync(bin);
		const installer = readFileSync(new URL("../../../scripts/install/install.ps1", import.meta.url), "utf8");
		const template = /\$piShim = @'\r?\n([\s\S]*?)\r?\n'@/.exec(installer)![1];
		const legacy = template.replace("__PIBOLT_FALLBACK__", runtime);
		writeFileSync(join(bin, "pi.cmd"), legacy);
		expect(inspectPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["missing", "ok"]);
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["created", "unchanged"]);
		writeFileSync(join(bin, "pi.cmd"), legacy.replace(/\r?\nexit \/b 0\s*$/, ""));
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["unchanged", "repaired"]);
		const bolt = readFileSync(join(bin, "pi-bolt.cmd"), "utf8");
		const pi = readFileSync(join(bin, "pi.cmd"), "utf8");
		expect(bolt).toContain(`"${runtime}" %*`);
		expect(pi).toContain("DisableDelayedExpansion");
		expect(pi).toContain('"%SystemRoot%\\System32\\where.exe" $PATH:pi');
		expect(pi).toContain('"%SystemRoot%\\System32\\findstr.exe" /b /r /c:"set .PIBOLT_FALLBACK="');
		expect(pi).toContain('"%PIBOLT_RESOLVED%" %*');
		expect(pi).not.toContain('call "%PIBOLT_RESOLVED%"');
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["unchanged", "unchanged"]);
	});

	it("recognizes its generated compatibility shim after switching runtime variants", () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		fixture(true);
		repairPiBoltLaunchers();
		runtime = runtime.replace("x64-jit", "arm64-jit");
		mkdirSync(dirname(runtime));
		writeFileSync(runtime, "runtime");
		Object.defineProperty(process, "execPath", { value: runtime, configurable: true });
		expect(repairPiBoltLaunchers().launchers.map((entry) => entry.status)).toEqual(["repaired", "repaired"]);
		expect(readFileSync(join(bin, "pi.cmd"), "utf8")).toContain(runtime);
	});
});
