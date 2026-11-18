/** Restore the installed build's public launchers without loading settings, extensions, or network services. */
import { repairPiBoltLaunchers } from "../pi-bolt-launchers.ts";

const USAGE = "pi-bolt repair [--offline]";

/** Run explicit offline launcher repair; errors and unsupported installations exit nonzero. */
export function runRepair(args: readonly string[]): number {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: ${USAGE}

Restore missing or broken installer-owned pi-bolt and pi launchers using the installed runtime.
Works offline. Does not download a release, load extensions, replace real Pi commands, or edit PATH.
Set PIBOLT_BIN_DIR to restore a custom command directory. Package-manager installations are not changed.`);
		return 0;
	}
	const unknown = args.find((arg) => arg !== "--offline");
	if (unknown !== undefined) {
		console.error(`Unknown argument for repair: ${unknown}\nUsage: ${USAGE}`);
		return 1;
	}
	try {
		const result = repairPiBoltLaunchers();
		if (!result.supported) {
			console.error(`Cannot repair launchers: ${result.reason}`);
			return 1;
		}
		for (const launcher of result.launchers) {
			const line = `${launcher.status}: ${launcher.path} (${launcher.detail})`;
			if (launcher.status === "error") console.error(line);
			else console.log(line);
		}
		if (!result.onPath) {
			console.log(`Add ${result.binDir} to PATH to use these commands. Repair does not edit shell profiles.`);
		}
		return result.launchers.some((launcher) => launcher.status === "error") ? 1 : 0;
	} catch (error) {
		console.error(`Could not repair launchers: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
