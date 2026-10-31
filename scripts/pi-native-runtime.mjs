import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateRuntimeStamp(downloaded, expected) {
	if (!/^[0-9a-f]{16}\n?$/.test(downloaded) || downloaded.length > 17) {
		throw new Error("Runtime blocker: missing or malformed downloaded adjacent RUNTIME_STAMP");
	}
	if (!/^[0-9a-f]{16}$/.test(expected) || downloaded.trim() !== expected) {
		throw new Error(`Runtime blocker: signed upstream stamp ${downloaded.trim()} != local engine ${expected}; build a compatible upstream runtime before producing artifacts`);
	}
	return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const downloaded = readFileSync(process.argv[2], "utf8");
	const expected = execFileSync("bash", ["scripts/runtime-stamp.sh"], { encoding: "utf8" }).trim();
	console.log(`Verified adjacent runtime stamp: ${validateRuntimeStamp(downloaded, expected)}`);
}
