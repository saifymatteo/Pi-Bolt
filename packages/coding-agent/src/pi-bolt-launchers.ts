// Read-only launcher diagnostics and explicit, offline repair of installer-owned launchers.
import {
	accessSync,
	chmodSync,
	constants,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PIBOLT, piBoltInstallDir, piBoltInstalledByInstaller, piBoltInstallMethod } from "./pi-bolt.ts";

export interface PiBoltLauncher {
	name: "pi" | "pi-bolt";
	path: string;
	status: "ok" | "missing" | "broken" | "preserved" | "error";
	detail: string;
}

export interface PiBoltLauncherInspection {
	supported: boolean;
	reason?: string;
	binDir: string;
	runtime: string;
	onPath: boolean;
	launchers: PiBoltLauncher[];
}

export interface PiBoltLauncherOutcome {
	name: PiBoltLauncher["name"];
	path: string;
	status: "created" | "repaired" | "unchanged" | "preserved" | "error";
	detail: string;
}

export interface PiBoltLauncherRepair extends Omit<PiBoltLauncherInspection, "launchers"> {
	launchers: PiBoltLauncherOutcome[];
}

/** Inspect this installed build's launchers without executing PATH commands or changing files. */
export function inspectPiBoltLaunchers(): PiBoltLauncherInspection {
	const installDir = piBoltInstallDir();
	const folder = dirname(process.execPath);
	const runtime = join(folder, process.platform === "win32" ? "pi.exe" : "pi");
	const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
	const publicName = process.platform === "win32" ? "pi-bolt.cmd" : "pi-bolt";
	const binDir = resolve(
		process.env.PIBOLT_BIN_DIR ||
			pathDirs.find((dir) => pointsToRuntime(join(dir, publicName), runtime)) ||
			join(homedir(), ".local", "bin"),
	);
	let reason: string | undefined;
	const method = piBoltInstallMethod();
	if (method !== "installer") reason = `Managed by ${method}; its package manager owns the launchers.`;
	else if (!PIBOLT || !installDir) reason = "Not an installed Pi-Bolt build; unpacked builds are not repaired.";
	else if (
		!piBoltInstalledByInstaller(installDir, folder) &&
		!(process.env.PIBOLT_INSTALL_DIR && samePath(installDir, process.env.PIBOLT_INSTALL_DIR)) &&
		!pathDirs.some((dir) => pointsToRuntime(join(dir, publicName), runtime))
	)
		reason = "This is an unpacked archive, not an installer-owned installation.";
	else if (!executable(runtime))
		reason = `The installed public runtime launcher is missing or not executable: ${runtime}`;
	const context = {
		supported: reason === undefined,
		reason,
		binDir,
		runtime,
		onPath: pathDirs.some((dir) => samePath(dir, binDir)),
	};
	return {
		...context,
		launchers: (["pi-bolt", "pi"] as const).map((name) => inspectLauncher(name, binDir, runtime, installDir)),
	};
}

/** Repair only missing or confidently owned launchers; never download, reinstall, or change PATH. */
export function repairPiBoltLaunchers(): PiBoltLauncherRepair {
	const inspection = inspectPiBoltLaunchers();
	const launchers = inspection.launchers.map((launcher): PiBoltLauncherOutcome => {
		const { name, path, status, detail } = launcher;
		if (!inspection.supported) return { name, path, status: "preserved", detail: inspection.reason ?? detail };
		if (status === "ok") return { name, path, status: "unchanged", detail };
		if (status === "preserved" || status === "error") return { name, path, status, detail };
		let temporary: string | undefined;
		try {
			mkdirSync(inspection.binDir, { recursive: true });
			const before = fileIdentity(path);
			const current = inspectLauncher(name, inspection.binDir, inspection.runtime, piBoltInstallDir());
			if (current.status !== status) throw new Error("Launcher changed during repair; inspect it and retry.");
			temporary = join(inspection.binDir, `.pi-bolt-repair-${process.getBuiltinModule("node:crypto").randomUUID()}`);
			writeFileSync(temporary, launcherText(name, inspection.runtime), { flag: "wx", mode: 0o755 });
			chmodSync(temporary, 0o755);
			if (fileIdentity(path) !== before) throw new Error("Launcher changed during repair; inspect it and retry.");
			if (status === "missing") {
				// link fails rather than overwriting a file created after inspection.
				linkSync(temporary, path);
			} else {
				// Rename replaces the directory entry, never the target of a broken symlink.
				renameSync(temporary, path);
				temporary = undefined;
			}
			return {
				name,
				path,
				status: status === "missing" ? "created" : "repaired",
				detail: "Launcher is ready.",
			};
		} catch (error) {
			return { name, path, status: "error", detail: `Could not repair ${path}: ${errorMessage(error)}` };
		} finally {
			if (temporary) {
				try {
					unlinkSync(temporary);
				} catch {
					// The reported write error remains the useful diagnostic if cleanup also fails.
				}
			}
		}
	});
	return { ...inspection, launchers };
}

function inspectLauncher(
	name: PiBoltLauncher["name"],
	binDir: string,
	runtime: string,
	installDir: string | undefined,
): PiBoltLauncher {
	const path = join(binDir, `${name}${process.platform === "win32" ? ".cmd" : ""}`);
	const result = (status: PiBoltLauncher["status"], detail: string): PiBoltLauncher => ({
		name,
		path,
		status,
		detail,
	});
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) {
			const target = resolve(dirname(path), readlinkSync(path));
			if (samePath(target, runtime) && executable(path))
				return result("ok", "Existing link to this runtime; left untouched.");
			if (ownTarget(target, runtime, installDir) && !statTargetExists(path))
				return result("broken", "Broken link to an installed Pi-Bolt runtime.");
			return executable(path)
				? result("preserved", "Existing symlink; left untouched.")
				: result("error", "Broken or non-executable unrecognized symlink; preserved. Fix its target manually.");
		}
		if (!stats.isFile())
			return result("error", "Existing path is not a regular launcher; preserved. Fix it manually.");
		if (stats.size > 64 * 1024)
			return executable(path)
				? result("preserved", "Unrecognized file; left untouched.")
				: result("error", "Unrecognized non-executable file; preserved. Fix it manually.");
		const text = readFileSync(path, "utf8");
		if (!ownedText(text, runtime, installDir))
			return executable(path)
				? result("preserved", "Existing command is not our launcher; left untouched.")
				: result(
						"error",
						"Existing command is not executable and is not our launcher; preserved. Fix it manually.",
					);
		const completeLegacy =
			process.platform === "win32" ? /\r?\nexit \/b 0\s*$/.test(text) : text.endsWith('exec "$fallback" "$@"\n');
		if (
			executable(path) &&
			(text === launcherText(name, runtime) || (completeLegacy && ownedText(text, runtime, undefined)))
		)
			return result("ok", "Launcher is ready.");
		return result("broken", "Own launcher needs content or executable permissions restored.");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result("missing", "Launcher is missing.");
		return result("error", `Cannot inspect ${path}: ${errorMessage(error)}`);
	}
}

function executable(path: string): boolean {
	try {
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function samePath(left: string, right: string): boolean {
	const normalized = (path: string) => {
		let value = resolve(path);
		try {
			value = realpathSync(value);
		} catch {
			// Missing paths still have a lexical identity.
		}
		return process.platform === "win32" ? value.toLowerCase() : value;
	};
	return normalized(left) === normalized(right);
}

function pointsToRuntime(path: string, runtime: string): boolean {
	try {
		if (lstatSync(path).isSymbolicLink()) return samePath(resolve(dirname(path), readlinkSync(path)), runtime);
		return statSync(path).size < 64 * 1024 && ownedText(readFileSync(path, "utf8"), runtime, undefined);
	} catch {
		return false;
	}
}

function ownedText(text: string, runtime: string, installDir: string | undefined): boolean {
	if (text === launcherText("pi-bolt", runtime) || text === launcherText("pi", runtime)) return true;
	// Exact installer templates, not a bare occurrence of a marker in an unrelated script.
	if (text === `#!/bin/sh\nexec ${shellQuote(runtime)} "$@"\n`) return true;
	if (text.replace(/\r\n/g, "\n").trimEnd() === `@echo off\n"${runtime}" %*\nexit /b %errorlevel%`) return true;
	let target: string | undefined;
	if (
		text.startsWith(
			"#!/bin/sh\n# pi shim installed by pi-bolt: real pi on PATH wins, else the compiled build (PIBOLT_FALLBACK).\n",
		)
	) {
		const quoted = /^fallback='(.*)'$/m.exec(text)?.[1];
		target = quoted?.replace(/'\\''/g, "'");
	} else if (
		/^@echo off\r?\nsetlocal EnableExtensions(?: DisableDelayedExpansion)?\r?\nset "PIBOLT_FALLBACK=/.test(text)
	) {
		target = /^set "PIBOLT_FALLBACK=(.*)"\r?$/m.exec(text)?.[1].replace(/%%/g, "%");
	}
	if (!target) {
		const unix = /^#!\/bin\/sh\nexec '(.*)' "\$@"\n$/.exec(text)?.[1];
		target =
			unix?.replace(/'\\''/g, "'") ??
			/^@echo off\r?\n"([^"\r\n]+)" %\*\r?\nexit \/b %errorlevel%\s*$/.exec(text)?.[1];
	}
	return target !== undefined && ownTarget(target, runtime, installDir);
}

function statTargetExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function ownTarget(target: string, runtime: string, installDir: string | undefined): boolean {
	if (samePath(target, runtime)) return true;
	if (!installDir || !isAbsolute(target)) return false;
	const variant = /^pi-bolt-((?:linux|darwin|win32)-[^/\\]+)[/\\]pi(?:\.exe)?$/.exec(
		relative(installDir, target),
	)?.[1];
	if (!variant) return false;
	try {
		// A variant-shaped directory alone is not evidence that its launcher belongs to Pi-Bolt.
		const about = readFileSync(join(dirname(target), "pi-bolt.txt"), "utf8").split(/\r?\n/, 1)[0];
		return /^Pi-Bolt \d+\.\d+\.\d+/.test(about) && about.includes(`, ${variant},`);
	} catch {
		return false;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function launcherText(name: PiBoltLauncher["name"], runtime: string): string {
	if (process.platform === "win32") {
		const target = runtime.replace(/%/g, "%%");
		if (name === "pi-bolt") return `@echo off\r\n"${target}" %*\r\nexit /b %errorlevel%\r\n`;
		return windowsCompatibilityLauncher(target);
	}
	if (name === "pi-bolt") return `#!/bin/sh\nexec ${shellQuote(runtime)} "$@"\n`;
	return `#!/bin/sh
# pi shim installed by pi-bolt: real pi on PATH wins, else the compiled build (PIBOLT_FALLBACK).
fallback=${shellQuote(runtime)}
pibolt_own_launcher() {
    { IFS= read -r first; IFS= read -r second; } < "$1"
    [ "$first" = '#!/bin/sh' ] || return 1
    case "$second" in
        '# pi shim installed by pi-bolt: real pi on PATH wins, else the compiled build (PIBOLT_FALLBACK).') return 0 ;;
        'exec '*'/pi-bolt-'*'/pi'*' "$@"') return 0 ;;
    esac
    return 1
}
saved_IFS=$IFS
IFS=:
for d in $PATH; do
    IFS=$saved_IFS
    [ -n "$d" ] || continue
    candidate=$d/pi
    [ -x "$candidate" ] && [ ! -d "$candidate" ] || continue
    [ "$candidate" -ef "$0" ] && continue
    [ "$candidate" -ef "$fallback" ] && continue
    # Skip compatibility shims and direct launchers, including links to other installs.
    pibolt_own_launcher "$candidate" 2>/dev/null && continue
    exec "$candidate" "$@"
done
exec "$fallback" "$@"
`;
}

function windowsCompatibilityLauncher(target: string): string {
	return `@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "PIBOLT_FALLBACK=${target}"
set "PIBOLT_RESOLVED="
for /f "usebackq delims=" %%F in (\`"%SystemRoot%\\System32\\where.exe" $PATH:pi 2^>nul\`) do call :pibolt_consider "%%~fF"
if not defined PIBOLT_RESOLVED goto pibolt_fallback
rem CALL would reparse arguments and expand literal percent sequences.
"%PIBOLT_RESOLVED%" %*
exit /b %errorlevel%
:pibolt_fallback
"%PIBOLT_FALLBACK%" %*
exit /b %errorlevel%
:pibolt_consider
if /i "%~1"=="%~f0" exit /b 0
for %%P in ("%PIBOLT_FALLBACK%") do if /i "%~1"=="%%~fP" exit /b 0
"%SystemRoot%\\System32\\findstr.exe" /b /r /c:"set .PIBOLT_FALLBACK=" "%~1" >nul 2>&1
if not errorlevel 1 exit /b 0
if /i "%~x1"==".exe" if not defined PIBOLT_RESOLVED set "PIBOLT_RESOLVED=%~1"
if /i "%~x1"==".cmd" if not defined PIBOLT_RESOLVED set "PIBOLT_RESOLVED=%~1"
if /i "%~x1"==".bat" if not defined PIBOLT_RESOLVED set "PIBOLT_RESOLVED=%~1"
exit /b 0
`.replace(/\n/g, "\r\n");
}

function fileIdentity(path: string): string | undefined {
	try {
		const stats = lstatSync(path);
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.mode}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
