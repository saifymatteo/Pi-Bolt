/** Windows-only Herdr prototype: a private native Pi image with its own runtime assets, never added to PATH. */
import { cpSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getPackageDir, isBunBinary } from "./config.ts";
import { PIBOLT } from "./pi-bolt.ts";
import { spawnProcess, waitForChildProcess } from "./utils/child-process.ts";

export const HERDR_PI_COMPAT_FLAG = "--herdr-as-pi";
const CHILD_EXECUTABLE = "PIBOLT_HERDR_PI_EXECUTABLE";

/** Inherited markers must not turn a normal Pi-Bolt, tool, or subagent executable into a Pi reporter. */
export function isHerdrPiCompatibilityProcess(
	env: NodeJS.ProcessEnv = process.env,
	execPath: string = process.execPath,
): boolean {
	const expected = env[CHILD_EXECUTABLE];
	return (
		!!expected &&
		isAbsolute(expected) &&
		basename(execPath).toLowerCase() === "pi.exe" &&
		(process.platform === "win32"
			? resolve(expected).toLowerCase() === resolve(execPath).toLowerCase()
			: resolve(expected) === resolve(execPath))
	);
}

function removeRuntime(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
	} catch {
		console.error(`Could not remove the temporary Herdr runtime: ${directory}`);
	}
}

/**
 * Copy the complete native runtime, not just its executable: Photon and native helpers also load beside the image.
 * Each launch gets a fresh directory, so updates/rollback cannot leave a persistent alias with mismatched assets.
 */
export function prepareHerdrPiRuntime(
	executable: string = process.execPath,
	packageDir: string = getPackageDir(),
	temporaryDir: string = tmpdir(),
): string {
	const source = realpathSync(packageDir);
	const original = realpathSync(executable);
	if (dirname(original) !== source) {
		throw new Error(`${HERDR_PI_COMPAT_FLAG} requires runtime assets beside the executable; unset PI_PACKAGE_DIR.`);
	}
	const destinationParent = realpathSync(temporaryDir);
	const insideSource = relative(source, destinationParent);
	if (insideSource.split(sep)[0] !== ".." && !isAbsolute(insideSource)) {
		throw new Error("The Herdr temporary runtime must be outside the source runtime directory.");
	}
	const before = statSync(original);
	const directory = mkdtempSync(join(destinationParent, "pi-bolt-herdr-"));
	try {
		cpSync(source, directory, { recursive: true, dereference: true });
		if (basename(original) !== "pi.exe") renameSync(join(directory, basename(original)), join(directory, "pi.exe"));
		const after = statSync(original);
		if (
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		) {
			throw new Error("Pi-Bolt changed while preparing Herdr compatibility mode; retry after the update finishes.");
		}
		return directory;
	} catch (error) {
		removeRuntime(directory);
		throw error;
	}
}

/** Return the child's exit code, or undefined when already running in the private native image. */
export async function launchHerdrPiCompatibility(args: string[]): Promise<number | undefined> {
	if (!PIBOLT || !isBunBinary || process.platform !== "win32") {
		throw new Error(`${HERDR_PI_COMPAT_FLAG} requires a native Windows Pi-Bolt build.`);
	}
	if (isHerdrPiCompatibilityProcess()) return undefined;

	const directory = prepareHerdrPiRuntime();
	const executable = join(directory, "pi.exe");
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Native assets resolve beside the image. Windows environment names are case-insensitive; do not leak an
	// asset override to tools or pass two spellings of an inherited child marker to the next process.
	for (const name of Object.keys(env)) {
		if (name.toUpperCase() === "PI_PACKAGE_DIR" || name.toUpperCase() === CHILD_EXECUTABLE) delete env[name];
	}
	env[CHILD_EXECUTABLE] = executable;
	// Both processes share the console. Let the child handle Ctrl+C without killing its waiting parent.
	const ignoreInterrupt = () => {};
	process.on("SIGINT", ignoreInterrupt);
	try {
		const child = spawnProcess(executable, args, {
			stdio: "inherit",
			env,
		});
		const terminate = () => child.kill();
		process.on("SIGTERM", terminate);
		try {
			return (await waitForChildProcess(child)) ?? 1;
		} finally {
			process.removeListener("SIGTERM", terminate);
		}
	} finally {
		process.removeListener("SIGINT", ignoreInterrupt);
		removeRuntime(directory);
	}
}
