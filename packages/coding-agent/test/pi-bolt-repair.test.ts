import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import { runRepair } from "../src/cli/repair.ts";
import { startsWithoutCompiledExtensions } from "../src/core/extensions/compiled.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { main } from "../src/main.ts";
import { type PiBoltLauncherRepair, repairPiBoltLaunchers } from "../src/pi-bolt-launchers.ts";

const build = vi.hoisted(() => ({ piBolt: true }));
vi.mock("../src/pi-bolt.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	get PIBOLT() {
		return build.piBolt ? { version: "1.2.3", variant: "x64-jit", jit: true } : undefined;
	},
}));
vi.mock("../src/pi-bolt-launchers.ts", () => ({ repairPiBoltLaunchers: vi.fn() }));

let exitCode: typeof process.exitCode;

beforeEach(() => {
	exitCode = process.exitCode;
	process.exitCode = undefined;
	build.piBolt = true;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(SettingsManager, "create").mockImplementation(() => {
		throw new Error("Repair must not access settings");
	});
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Repair must stay offline"));
	vi.mocked(repairPiBoltLaunchers).mockReset();
	vi.mocked(repairPiBoltLaunchers).mockReturnValue({
		supported: true,
		binDir: "/commands",
		runtime: "/installed/pi",
		onPath: true,
		launchers: [
			{ name: "pi-bolt", path: "/commands/pi-bolt", status: "unchanged", detail: "Ready" },
			{ name: "pi", path: "/commands/pi", status: "created", detail: "Ready" },
		],
	});
});

afterEach(() => {
	process.exitCode = exitCode;
	vi.restoreAllMocks();
});

describe("pi-bolt repair", () => {
	it.each([{ args: [] }, { args: ["--offline"] }])(
		"repairs before settings, network, or cwd access: $args",
		async ({ args }) => {
			vi.spyOn(process, "cwd").mockImplementation(() => {
				throw new Error("Working directory was removed");
			});
			await main(["repair", ...args]);
			expect(process.exitCode).toBe(0);
			expect(repairPiBoltLaunchers).toHaveBeenCalledOnce();
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("created: /commands/pi"));
			expect(SettingsManager.create).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["-h", "--help"])("prints %s without inspecting or writing launchers", async (flag) => {
		await main(["repair", flag]);
		expect(process.exitCode).toBe(0);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Usage: pi-bolt repair"));
		expect(repairPiBoltLaunchers).not.toHaveBeenCalled();
		expect(SettingsManager.create).not.toHaveBeenCalled();
	});

	it.each(["--force", "unknown"])("rejects %s without writing launchers", (arg) => {
		expect(runRepair([arg])).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`Unknown argument for repair: ${arg}`));
		expect(repairPiBoltLaunchers).not.toHaveBeenCalled();
	});

	it("prints why package-manager or unpacked installations cannot be repaired", () => {
		vi.mocked(repairPiBoltLaunchers).mockReturnValue({
			supported: false,
			reason: "Managed by npm; its package manager owns the launchers.",
			binDir: "/commands",
			runtime: "/installed/pi",
			onPath: true,
			launchers: [],
		});
		expect(runRepair([])).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Managed by npm"));
	});

	it("reports partial failures and a separate PATH warning", () => {
		const report: PiBoltLauncherRepair = {
			supported: true,
			binDir: "/custom commands",
			runtime: "/installed/pi",
			onPath: false,
			launchers: [
				{ name: "pi-bolt", path: "/custom commands/pi-bolt", status: "created", detail: "Ready" },
				{ name: "pi", path: "/custom commands/pi", status: "error", detail: "Permission denied" },
			],
		};
		vi.mocked(repairPiBoltLaunchers).mockReturnValue(report);
		expect(runRepair([])).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Permission denied"));
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Add /custom commands to PATH"));
	});

	it("reports preserved commands without claiming to have replaced them", () => {
		vi.mocked(repairPiBoltLaunchers).mockReturnValue({
			supported: true,
			binDir: "/commands",
			runtime: "/installed/pi",
			onPath: true,
			launchers: [{ name: "pi", path: "/commands/pi", status: "preserved", detail: "Real Pi" }],
		});
		expect(runRepair([])).toBe(0);
		expect(console.log).toHaveBeenCalledWith("preserved: /commands/pi (Real Pi)");
	});

	it("reports unexpected filesystem errors with a nonzero exit", () => {
		vi.mocked(repairPiBoltLaunchers).mockImplementation(() => {
			throw new Error("Cannot inspect destination");
		});
		expect(runRepair([])).toBe(1);
		expect(console.error).toHaveBeenCalledWith("Could not repair launchers: Cannot inspect destination");
	});

	it("does not import compiled extensions for the recovery command", () => {
		expect(startsWithoutCompiledExtensions(["repair"])).toBe(true);
		expect(startsWithoutCompiledExtensions(["repair", "--help"])).toBe(true);
		expect(startsWithoutCompiledExtensions(["--print", "repair"])).toBe(false);
	});

	it("advertises repair only in Pi-Bolt builds", () => {
		printHelp();
		expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining("Restore installer launchers offline"));
		build.piBolt = false;
		printHelp();
		expect(console.log).toHaveBeenLastCalledWith(expect.not.stringContaining("Restore installer launchers offline"));
	});
});
