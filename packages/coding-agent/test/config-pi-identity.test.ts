import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import {
	APP_NAME,
	COMMAND_NAME,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	getAgentDir,
	PRODUCT_NAME,
} from "../src/config.ts";
import { PIBOLT } from "../src/pi-bolt.ts";

vi.hoisted(() => {
	vi.stubGlobal("PIBOLT_BUILD", "1.0.8 x64-jit jit-on 0123456789abcdef");
	vi.stubEnv("PI_CODING_AGENT_DIR", "");
});

afterAll(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it("keeps the compiled pi-bolt command separate while retaining Pi's normal storage", () => {
	expect(COMMAND_NAME).toBe("pi-bolt");
	expect(APP_NAME).toBe("pi");
	expect(CONFIG_DIR_NAME).toBe(".pi");
	expect(ENV_AGENT_DIR).toBe("PI_CODING_AGENT_DIR");
	expect(ENV_SESSION_DIR).toBe("PI_CODING_AGENT_SESSION_DIR");
	expect(getAgentDir()).toBe(join(homedir(), ".pi", "agent"));
	expect(PRODUCT_NAME).toBe("Pi-Bolt");
	expect(PIBOLT).toEqual({
		version: "1.0.8",
		variant: "x64-jit",
		jit: true,
		runtimeStamp: "0123456789abcdef",
	});
});
