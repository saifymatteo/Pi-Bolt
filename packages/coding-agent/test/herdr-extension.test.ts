import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createHerdrExtension, quietOtherHerdrReporters } from "../src/extensions/herdr/index.ts";
import { isHerdrPiIntegration } from "../src/extensions/herdr/integration-file.ts";
import { type HerdrRequest, herdrAnswer, herdrArguments, socketTransport } from "../src/extensions/herdr/transport.ts";

vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<object>()) }));

type Request = { id: string; method: string; params: Record<string, unknown> };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	delete (globalThis as { PIBOLT_BUILD?: string }).PIBOLT_BUILD;
	vi.restoreAllMocks();
	vi.resetModules();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "herdr-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A Herdr socket that can refuse requests or hold registration, keeping every request. */
async function fakeHerdr(
	answer: boolean | ((request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>) = () => ({
		result: {},
	}),
): Promise<{
	socketPath: string;
	requests: Request[];
	acknowledgeRegistration: () => void;
}> {
	const dir = tempDir();
	const socketPath = process.platform === "win32" ? basename(dir) : join(dir, "herdr.sock");
	const requests: Request[] = [];
	let acknowledgeRegistration: (() => void) | undefined;
	const server = net.createServer((socket) => {
		let buffered = "";
		socket.on("data", (chunk) => {
			buffered += chunk.toString();
			for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
				const request = JSON.parse(buffered.slice(0, newline)) as Request;
				buffered = buffered.slice(newline + 1);
				requests.push(request);
				const acknowledge = () => {
					void Promise.resolve(typeof answer === "function" ? answer(request) : { result: {} }).then((reply) =>
						socket.write(`${JSON.stringify({ id: request.id, ...reply })}\n`),
					);
				};
				if (answer === true && request.method === "pane.report_agent_session")
					acknowledgeRegistration = acknowledge;
				else acknowledge();
			}
		});
	});
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	await new Promise<void>((resolve) => server.listen(endpoint, resolve));
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { socketPath, requests, acknowledgeRegistration: () => acknowledgeRegistration?.() };
}

function fakePi() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: {
			on: (name: string, listener: (data: unknown) => void) => {
				listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			},
		},
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		handlers,
		fire: async (name: string, event: unknown, ctx?: unknown) => {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
		emit: (name: string, data: unknown) => {
			for (const listener of listeners.get(name) ?? []) listener(data);
		},
	};
}

function context(options: { mode?: string; idle?: () => boolean; sessionFile?: string } = {}) {
	return {
		mode: options.mode ?? "tui",
		isIdle: options.idle ?? (() => true),
		sessionManager: {
			getSessionFile: () => options.sessionFile,
			getSessionId: () => "session-id",
		},
	};
}

async function until(check: () => boolean) {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
}

async function startedInHerdr(
	options: {
		mode?: string;
		sessionFile?: string;
		answer?: (request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>;
	} = {},
) {
	const herdr = await fakeHerdr(options.answer);
	const env = {
		HERDR_ENV: "1",
		HERDR_SOCKET_PATH: herdr.socketPath,
		HERDR_PANE_ID: "w1:p2",
	};
	const fake = fakePi();
	let idle = true;
	createHerdrExtension(env)(fake.pi);
	const ctx = context({ mode: options.mode, idle: () => idle, sessionFile: options.sessionFile ?? "/work/s.jsonl" });
	await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	const stateRequests = () => herdr.requests.filter((r) => r.method === "pane.report_agent");
	const states = () => stateRequests().map((r) => r.params.state);
	return {
		...fake,
		herdr,
		ctx,
		states,
		stateRequests,
		setIdle: (value: boolean) => {
			idle = value;
		},
	};
}

describe("Herdr extension", () => {
	test("does nothing outside Herdr", () => {
		const fake = fakePi();
		createHerdrExtension({})(fake.pi);
		expect(fake.handlers.size).toBe(0);
	});

	test("reports session and state changes", async () => {
		const run = await startedInHerdr();
		await until(() => run.states().length === 1);
		expect(run.stateRequests()[0].params).toMatchObject({
			pane_id: "w1:p2",
			source: "herdr:pi",
			agent: "pi",
			state: "idle",
			agent_session_path: "/work/s.jsonl",
		});

		run.setIdle(false);
		await run.fire("agent_start", { type: "agent_start" }, run.ctx);
		await until(() => run.states().length === 2);
		// A dialog in the middle of a run is the agent waiting for the user.
		await run.fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		await until(() => run.states().length === 3);
		await run.fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
		await until(() => run.states().length === 4);
		run.setIdle(true);
		await run.fire("agent_settled", { type: "agent_settled", aborted: false }, run.ctx);
		await until(() => run.states().length === 5);
		expect(run.states()).toEqual(["idle", "working", "blocked", "working", "idle"]);
		for (const request of run.herdr.requests) {
			expect(request.params).not.toHaveProperty("resume_argv");
			expect(request.params).toMatchObject({
				source: "herdr:pi",
				agent: "pi",
				agent_session_path: "/work/s.jsonl",
			});
			expect(request.params).not.toHaveProperty("agent_session_id");
		}

		const seqs = run.herdr.requests.map((r) => r.params.seq as number);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	test("registers the canonical Pi session before idle", async () => {
		const sessionFile = join(tempDir(), "session with spaces.jsonl");
		const run = await startedInHerdr({ sessionFile });
		await until(() => run.states().length === 1);
		expect(run.herdr.requests.map((request) => request.method)).toEqual([
			"pane.report_agent_session",
			"pane.report_agent",
		]);
		const registration = run.herdr.requests[0];
		expect(registration.params).toEqual({
			pane_id: "w1:p2",
			source: "herdr:pi",
			agent: "pi",
			seq: expect.any(Number),
			session_start_source: "startup",
			agent_session_path: sessionFile,
		});
		expect(registration.params).not.toHaveProperty("resume_argv");
		expect(run.stateRequests()[0].params.seq).toBe((registration.params.seq as number) + 1);
		expect(run.stateRequests()[0].params).toMatchObject({
			state: "idle",
			agent_session_path: sessionFile,
		});
	});

	test.each([undefined, "relative.jsonl"])(
		"registers the fallback session ID without an absolute path (%s)",
		async (sessionFile) => {
			const herdr = await fakeHerdr();
			const fake = fakePi();
			createHerdrExtension({
				HERDR_ENV: "1",
				HERDR_SOCKET_PATH: herdr.socketPath,
				HERDR_PANE_ID: "w1:p2",
			})(fake.pi);
			await fake.fire("session_start", { reason: "startup" }, context({ sessionFile }));
			await until(() => herdr.requests.some((request) => request.method === "pane.report_agent"));
			expect(herdr.requests.map((request) => request.method)).toEqual([
				"pane.report_agent_session",
				"pane.report_agent",
			]);
			expect(herdr.requests[0].params).toEqual({
				pane_id: "w1:p2",
				source: "herdr:pi",
				agent: "pi",
				seq: expect.any(Number),
				session_start_source: "startup",
				agent_session_id: "session-id",
			});
			expect(herdr.requests[0].params).not.toHaveProperty("resume_argv");
			expect(herdr.requests[1].params).toMatchObject({
				state: "idle",
				agent_session_id: "session-id",
				seq: (herdr.requests[0].params.seq as number) + 1,
			});
			expect(herdr.requests[1].params).not.toHaveProperty("agent_session_path");
		},
	);

	test("awaits canonical session registration before completing session_start or reporting idle", async () => {
		const herdr = await fakeHerdr(true);
		const fake = fakePi();
		createHerdrExtension({
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: herdr.socketPath,
			HERDR_PANE_ID: "w1:p2",
		})(fake.pi);
		let completed = false;
		const starting = fake
			.fire("session_start", { reason: "startup" }, context({ sessionFile: "/work/s.jsonl" }))
			.then(() => {
				completed = true;
			});
		await until(() => herdr.requests.length > 0);
		try {
			expect(herdr.requests.map((request) => request.method)).toEqual(["pane.report_agent_session"]);
			expect(completed).toBe(false);
		} finally {
			herdr.acknowledgeRegistration();
			await starting;
		}
		await until(() => herdr.requests.length === 2);
		expect(herdr.requests[1]).toMatchObject({ method: "pane.report_agent", params: { state: "idle" } });
	});

	test("a dialog opened at the prompt is not a block", async () => {
		const run = await startedInHerdr();
		await until(() => run.states().length === 1);
		await run.fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "select" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(run.states()).toEqual(["idle"]);
	});

	test("herdr:blocked and background subagents", async () => {
		const run = await startedInHerdr();
		await until(() => run.states().length === 1);
		run.emit("herdr:blocked", { active: true, label: "Question for you" });
		await until(() => run.states().length === 2);
		expect(run.stateRequests()[1].params).toMatchObject({ state: "blocked", message: "Question for you" });
		run.emit("herdr:blocked", { active: false });
		await until(() => run.states().length === 3);

		run.emit("subagents:started", { id: "a1" });
		await until(() => run.states().length === 4);
		run.emit("subagents:completed", { id: "a1" });
		await until(() => run.states().length === 5);
		expect(run.states()).toEqual(["idle", "blocked", "idle", "working", "idle"]);
	});

	// #201: pi-subagents (nicobailon) reports its background runs with herdr:busy only.
	test("herdr:busy keeps the pane working, under a block", async () => {
		const run = await startedInHerdr();
		await until(() => run.states().length === 1);
		run.emit("herdr:busy", { active: true, label: "⏳ 1 subagent (worker)" });
		await until(() => run.states().length === 2);
		// A relabel is false then true at once: no idle report in between.
		run.emit("herdr:busy", { active: false });
		run.emit("herdr:busy", { active: true, label: "⏳ 2 subagents (worker, reviewer)" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(run.states()).toEqual(["idle", "working"]);

		run.emit("herdr:blocked", { active: true, label: "Question for you" });
		await until(() => run.states().length === 3);
		run.emit("herdr:blocked", { active: false });
		await until(() => run.states().length === 4);
		run.emit("herdr:busy", { active: false });
		await until(() => run.states().length === 5);
		expect(run.states()).toEqual(["idle", "working", "blocked", "working", "idle"]);
	});

	// #201: herdr:busy and subagents:* about the same runs count once; the pane is idle when both say done.
	test("herdr:busy and subagents events together", async () => {
		const run = await startedInHerdr();
		await until(() => run.states().length === 1);
		run.emit("subagents:started", { id: "a1" });
		await until(() => run.states().length === 2);
		run.emit("herdr:busy", { active: true, label: "⏳ 1 subagent" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		run.emit("herdr:busy", { active: false });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(run.states()).toEqual(["idle", "working"]);
		run.emit("subagents:completed", { id: "a1" });
		await until(() => run.states().length === 3);

		run.emit("herdr:busy", { active: true, label: "⏳ 1 subagent" });
		await until(() => run.states().length === 4);
		run.emit("subagents:started", { id: "a2" });
		run.emit("subagents:completed", { id: "a2" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(run.states()).toEqual(["idle", "working", "idle", "working"]);
		run.emit("herdr:busy", { active: false });
		await until(() => run.states().length === 5);
		expect(run.states()).toEqual(["idle", "working", "idle", "working", "idle"]);
	});

	test("non-TUI sessions do not report", async () => {
		for (const mode of ["print", "json", "rpc", "subagent"]) {
			const run = await startedInHerdr({ mode });
			await run.fire("agent_start", { type: "agent_start" }, run.ctx);
			await run.fire("ui_prompt_start", {});
			run.emit("herdr:blocked", { active: true });
			run.emit("subagents:started", { id: "child" });
			await run.fire("agent_settled", {}, run.ctx);
			await run.fire("session_shutdown", { reason: "quit" });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(run.herdr.requests).toEqual([]);
		}
	});

	test("releases the pane on quit only", async () => {
		const run = await startedInHerdr();
		await until(() => run.states().length === 1);
		await run.fire("session_shutdown", { type: "session_shutdown", reason: "new" });
		expect(run.herdr.requests.map((r) => r.method)).toEqual(["pane.report_agent_session", "pane.report_agent"]);

		const quitting = await startedInHerdr();
		await until(() => quitting.states().length === 1);
		await quitting.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await until(() => quitting.herdr.requests.length === 3);
		expect(quitting.herdr.requests.map((r) => r.method)).toEqual([
			"pane.report_agent_session",
			"pane.report_agent",
			"pane.release_agent",
		]);
		expect(quitting.herdr.requests.at(-1)).toMatchObject({
			method: "pane.release_agent",
			params: {
				pane_id: "w1:p2",
				source: "herdr:pi",
				agent: "pi",
			},
		});
	});

	test("switches session metadata without releasing the pane", async () => {
		const run = await startedInHerdr({ sessionFile: "/work/first.jsonl" });
		await until(() => run.states().length === 1);
		for (const [index, reason] of ["new", "resume", "fork", "reload"].entries()) {
			await run.fire("session_shutdown", { reason });
			const sessionFile = `/work/${reason}.jsonl`;
			await run.fire("session_start", { reason }, context({ sessionFile }));
			await until(() => run.states().length === index + 2);
			expect(run.stateRequests()[index + 1]).toMatchObject({
				method: "pane.report_agent",
				params: {
					source: "herdr:pi",
					agent: "pi",
					agent_session_path: sessionFile,
				},
			});
		}
		expect(run.herdr.requests.map((request) => request.method)).toEqual(
			["startup", "new", "resume", "fork", "reload"].flatMap(() => [
				"pane.report_agent_session",
				"pane.report_agent",
			]),
		);
		const registrations = run.herdr.requests.filter((request) => request.method === "pane.report_agent_session");
		for (const [index, reason] of ["startup", "new", "resume", "fork", "reload"].entries()) {
			expect(registrations[index].params).toMatchObject({
				pane_id: "w1:p2",
				source: "herdr:pi",
				agent: "pi",
				session_start_source: reason,
				agent_session_path: `/work/${reason === "startup" ? "first" : reason}.jsonl`,
			});
			expect(registrations[index].params).not.toHaveProperty("resume_argv");
		}
		const seqs = run.herdr.requests.map((request) => request.params.seq as number);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	test("preserves session metadata without a custom resume command", async () => {
		const run = await startedInHerdr();
		await until(() => run.states().length === 1);
		for (const [index, sessionFile] of [undefined, "relative.jsonl", "/o'brien/s.jsonl", "/work/é.jsonl"].entries()) {
			await run.fire("session_shutdown", { reason: "resume" });
			await run.fire("session_start", { reason: "resume" }, context({ sessionFile }));
			await until(() => run.states().length === index + 2);
			const params = run.stateRequests()[index + 1].params;
			expect(params).toMatchObject({
				source: "herdr:pi",
				agent: "pi",
				state: "idle",
			});
			expect(params).not.toHaveProperty("resume_argv");
			if (sessionFile?.startsWith("/")) {
				expect(params.agent_session_path).toBe(sessionFile);
				expect(params).not.toHaveProperty("agent_session_id");
			} else {
				expect(params.agent_session_id).toBe("session-id");
				expect(params).not.toHaveProperty("agent_session_path");
			}
		}
	});

	test("a Herdr that is not there does not hold anything up", async () => {
		const fake = fakePi();
		const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(tempDir(), "gone.sock"), HERDR_PANE_ID: "w1:p1" };
		createHerdrExtension(env)(fake.pi);
		const ctx = context({ sessionFile: "/work/s.jsonl" });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const started = Date.now();
		await fake.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(Date.now() - started).toBeLessThan(400);
	});

	// #200: a report Herdr refused counted as delivered, so it was neither tried a second time nor sent again.
	test("a report Herdr refuses is tried twice, and sent again on the next publish", async () => {
		let refuse = true;
		const run = await startedInHerdr({
			answer: () =>
				refuse ? { error: { code: "resume_not_accepted", message: "report rejected" } } : { result: {} },
		});
		await until(() => run.states().length === 2);
		// Each try has its own seq, and nothing is retried until something publishes again.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(run.states()).toEqual(["idle", "idle"]);
		const [first, second] = run.stateRequests().map((r) => r.params.seq as number);
		expect(second).toBeGreaterThan(first);

		refuse = false;
		// A dialog at the prompt leaves the state as it was; the state Herdr refused is sent again.
		await run.fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "select" });
		await until(() => run.states().length === 3);
		// Once Herdr took it, the same state is not sent again.
		await run.fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "select" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(run.states()).toEqual(["idle", "idle", "idle"]);
	});

	// #200 (PR #214 review): a report refused after the release on quit was tried again with a seq above the release's,
	// which took the pane back.
	test("nothing is reported after the release on quit", async () => {
		let releaseArrived: (() => void) | undefined;
		const refused = { error: { code: "resume_not_accepted", message: "report rejected" } };
		const run = await startedInHerdr({
			// The first report is refused only once the release is in.
			answer: (request) => {
				if (request.method === "pane.report_agent_session") return { result: {} };
				if (request.method === "pane.release_agent") {
					setTimeout(() => releaseArrived?.(), 0);
					return { result: {} };
				}
				return new Promise((resolve) => {
					releaseArrived = () => resolve(refused);
				});
			},
		});
		await until(() => run.states().length === 1);
		await run.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(run.herdr.requests.map((r) => r.method)).toEqual([
			"pane.report_agent_session",
			"pane.report_agent",
			"pane.release_agent",
		]);
	});

	test("registration retries use fresh sequences before reporting state", async () => {
		let registrations = 0;
		const run = await startedInHerdr({
			answer: (request) => {
				if (request.method === "pane.report_agent_session" && ++registrations === 1) {
					return { error: { code: "not_ready" } };
				}
				return { result: {} };
			},
		});
		await until(() => run.states().length === 1);
		expect(run.herdr.requests.map((request) => request.method)).toEqual([
			"pane.report_agent_session",
			"pane.report_agent_session",
			"pane.report_agent",
		]);
		const seqs = run.herdr.requests.map((request) => request.params.seq as number);
		expect(seqs[1]).toBe(seqs[0] + 1);
		expect(seqs[2]).toBe(seqs[1] + 1);
	});

	test("a registration refused after quit cannot retry or report state", async () => {
		let refuseRegistration: (() => void) | undefined;
		const herdr = await fakeHerdr((request) => {
			if (request.method === "pane.release_agent") {
				refuseRegistration?.();
				return { result: {} };
			}
			return new Promise((resolve) => {
				refuseRegistration = () => resolve({ error: { code: "not_ready" } });
			});
		});
		const fake = fakePi();
		createHerdrExtension({ HERDR_ENV: "1", HERDR_SOCKET_PATH: herdr.socketPath, HERDR_PANE_ID: "w1:p2" })(fake.pi);
		const starting = fake.fire("session_start", { reason: "startup" }, context({ sessionFile: "/work/s.jsonl" }));
		await until(() => herdr.requests.length === 1);
		await fake.fire("session_shutdown", { reason: "quit" });
		await starting;
		expect(herdr.requests.map((request) => request.method)).toEqual([
			"pane.report_agent_session",
			"pane.release_agent",
		]);
		expect(herdr.requests[1].params.seq).toBe((herdr.requests[0].params.seq as number) + 1);
	});

	test("suppresses competing reporters only in Herdr", () => {
		const inHerdr: NodeJS.ProcessEnv = {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/tmp/h.sock",
			HERDR_PANE_ID: "w1:p1",
		};
		quietOtherHerdrReporters(inHerdr);
		expect(inHerdr.PI_HERDR_NO_SELF_REPORT).toBe("1");
		const outside: NodeJS.ProcessEnv = {};
		quietOtherHerdrReporters(outside);
		expect(outside.PI_HERDR_NO_SELF_REPORT).toBeUndefined();
	});
});

describe("Herdr socket", () => {
	/** A socket that answers the first request line with `reply(id)`, as raw chunks, then closes. */
	async function answering(reply: (id: string) => string[]): Promise<string> {
		const dir = tempDir();
		const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\${basename(dir)}` : join(dir, "herdr.sock");
		const server = net.createServer((socket) => {
			let buffered = "";
			socket.on("data", async (chunk) => {
				buffered += chunk.toString();
				const newline = buffered.indexOf("\n");
				if (newline < 0) return;
				const { id } = JSON.parse(buffered.slice(0, newline)) as Request;
				for (const part of reply(id)) {
					socket.write(part);
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				socket.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		return socketPath;
	}

	const report: HerdrRequest = {
		method: "pane.report_agent",
		params: { pane_id: "w1:p1", source: "herdr:pi", agent: "pi", state: "idle", seq: 1 },
	};

	// #200: an error answer counted as success.
	test("an error answer is not success", async () => {
		const endpoint = await answering((id) => [
			`${JSON.stringify({ id, error: { code: "resume_not_accepted", message: "report rejected" } })}\n`,
		]);
		expect(await socketTransport(endpoint)(report, 500)).toBe(false);
	});

	// #200: any data counted as success, before the answer was complete or even about this request.
	test("only the complete answer with this request's id counts", async () => {
		const taken = await answering((id) => {
			const answer = JSON.stringify({ id, result: {} });
			return [
				`${JSON.stringify({ id: "other", error: { code: "x" } })}\n`,
				answer.slice(0, 5),
				`${answer.slice(5)}\n`,
			];
		});
		expect(await socketTransport(taken)(report, 500)).toBe(true);
		const cut = await answering((id) => [JSON.stringify({ id, result: {} }).slice(0, 10)]);
		expect(await socketTransport(cut)(report, 500)).toBe(false);
		const unterminated = await answering((id) => [JSON.stringify({ id, result: {} })]);
		expect(await socketTransport(unterminated)(report, 500)).toBe(true);
	});

	test("answer lines", () => {
		expect(herdrAnswer("a", JSON.stringify({ id: "a", result: {} }))).toBe(true);
		expect(herdrAnswer("a", JSON.stringify({ id: "a", result: null }))).toBe(true);
		expect(herdrAnswer("a", JSON.stringify({ id: "a", error: { code: "x" } }))).toBe(false);
		expect(herdrAnswer("a", JSON.stringify({ id: "a" }))).toBe(false);
		expect(herdrAnswer("a", JSON.stringify({ id: "b", result: {} }))).toBeUndefined();
		expect(herdrAnswer("a", "not json")).toBeUndefined();
		expect(herdrAnswer("a", "null")).toBeUndefined();
	});
});

describe("Herdr platform environments", () => {
	test("normal Windows reports use HERDR_BIN_PATH without compatibility markers", async () => {
		const calls: string[][] = [];
		vi.spyOn(childProcess, "spawn").mockImplementation((_bin, args) => {
			calls.push([String(_bin), ...(args ?? [])]);
			const child = new childProcess.ChildProcess();
			queueMicrotask(() => child.emit("exit", 0));
			return child;
		});
		const fake = fakePi();
		createHerdrExtension(
			{ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_BIN_PATH: "C:\\Herdr\\herdr.exe" },
			"win32",
		)(fake.pi);
		const sessionFile = join(tempDir(), "session with spaces.jsonl");
		await fake.fire("session_start", { reason: "startup" }, context({ sessionFile }));
		await until(() => calls.length === 2);
		await fake.fire("session_shutdown", { reason: "quit" });
		expect(calls.map((args) => args.slice(0, 4))).toEqual([
			["C:\\Herdr\\herdr.exe", "pane", "report-agent-session", "w1:p2"],
			["C:\\Herdr\\herdr.exe", "pane", "report-agent", "w1:p2"],
			["C:\\Herdr\\herdr.exe", "pane", "release-agent", "w1:p2"],
		]);
		for (const args of calls) {
			expect(args.slice(4, 8)).toEqual(["--source", "herdr:pi", "--agent", "pi"]);
			expect(args).not.toContain("--");
		}
		expect(calls[0].slice(-4)).toEqual(["--agent-session-path", sessionFile, "--session-start-source", "startup"]);
	});

	test("normal macOS reports use HERDR_SOCKET_PATH even when HERDR_BIN_PATH is set", async () => {
		const herdr = await fakeHerdr();
		const fake = fakePi();
		const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${herdr.socketPath}` : herdr.socketPath;
		createHerdrExtension(
			{ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: endpoint, HERDR_BIN_PATH: "/unused/herdr" },
			"darwin",
		)(fake.pi);
		await fake.fire("session_start", { reason: "startup" }, context({ sessionFile: "/Users/me/s.jsonl" }));
		await until(() => herdr.requests.length === 2);
		await fake.fire("session_shutdown", { reason: "quit" });
		expect(herdr.requests.map((request) => request.method)).toEqual([
			"pane.report_agent_session",
			"pane.report_agent",
			"pane.release_agent",
		]);
		for (const request of herdr.requests) {
			expect(request.params).toMatchObject({ source: "herdr:pi", agent: "pi" });
			expect(request.params).not.toHaveProperty("resume_argv");
		}
	});
});

describe("Herdr executable (Windows)", () => {
	test.each(["startup", undefined])("session path registration arguments preserve spaces (reason=%s)", (reason) => {
		expect(
			herdrArguments({
				method: "pane.report_agent_session",
				params: {
					pane_id: "w1:p2",
					source: "herdr:pi",
					agent: "pi",
					seq: 7,
					agent_session_path: "C:\\Users\\Some User\\session files\\s.jsonl",
					...(reason ? { session_start_source: reason } : {}),
				},
			}),
		).toEqual([
			"pane",
			"report-agent-session",
			"w1:p2",
			"--source",
			"herdr:pi",
			"--agent",
			"pi",
			"--seq",
			"7",
			"--agent-session-path",
			"C:\\Users\\Some User\\session files\\s.jsonl",
			...(reason ? ["--session-start-source", reason] : []),
		]);
	});

	test.each(["resume", undefined])(
		"session ID registration arguments need no resume command (reason=%s)",
		(reason) => {
			expect(
				herdrArguments({
					method: "pane.report_agent_session",
					params: {
						pane_id: "w1:p2",
						source: "herdr:pi",
						agent: "pi",
						seq: 8,
						agent_session_id: "session-id",
						...(reason ? { session_start_source: reason } : {}),
					},
				}),
			).toEqual([
				"pane",
				"report-agent-session",
				"w1:p2",
				"--source",
				"herdr:pi",
				"--agent",
				"pi",
				"--seq",
				"8",
				"--agent-session-id",
				"session-id",
				...(reason ? ["--session-start-source", reason] : []),
			]);
		},
	);

	test("requests become `herdr pane` arguments", () => {
		expect(
			herdrArguments({
				method: "pane.report_agent",
				params: {
					pane_id: "w1:p2",
					source: "herdr:pi",
					agent: "pi",
					state: "blocked",
					message: "-y to continue?",
					seq: 7,
					agent_session_path: "C:\\Users\\me\\s.jsonl",
				},
			}),
		).toEqual([
			"pane",
			"report-agent",
			"w1:p2",
			"--source",
			"herdr:pi",
			"--agent",
			"pi",
			"--seq",
			"7",
			"--state",
			"blocked",
			"--message",
			"-y to continue?",
			"--agent-session-path",
			"C:\\Users\\me\\s.jsonl",
		]);
		expect(
			herdrArguments({
				method: "pane.release_agent",
				params: { pane_id: "w1:p2", source: "herdr:pi", agent: "pi", seq: 8 },
			}),
		).toEqual(["pane", "release-agent", "w1:p2", "--source", "herdr:pi", "--agent", "pi", "--seq", "8"]);
	});
});

const HERDR_PI_FILE = `// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=pi
// HERDR_INTEGRATION_VERSION=9
// @ts-nocheck
export default function (pi) {
	pi.registerCommand("herdr-file-loaded", { handler: async () => {} });
}
`;

describe("Herdr's own Pi integration file", () => {
	function extensionsDir() {
		const dir = join(tempDir(), "extensions");
		mkdirSync(dir);
		const herdrFile = join(dir, "herdr-agent-state.ts");
		writeFileSync(herdrFile, HERDR_PI_FILE);
		const other = join(dir, "other.ts");
		writeFileSync(
			other,
			`export default function (pi) { pi.registerCommand("other", { handler: async () => {} }); }\n`,
		);
		return { dir, herdrFile, other };
	}

	test("is recognized by its header", () => {
		const { dir, herdrFile, other } = extensionsDir();
		expect(isHerdrPiIntegration(herdrFile)).toBe(true);
		expect(isHerdrPiIntegration(other)).toBe(false);
		const lookalike = join(dir, "sub", "herdr-agent-state.ts");
		mkdirSync(join(dir, "sub"));
		writeFileSync(lookalike, "// my own herdr hook\nexport default function () {}\n");
		expect(isHerdrPiIntegration(lookalike)).toBe(false);
		expect(isHerdrPiIntegration(join(dir, "missing", "herdr-agent-state.ts"))).toBe(false);
	});

	async function loadedCommands(build: string | undefined, paths: string[], cwd: string) {
		vi.resetModules();
		(globalThis as { PIBOLT_BUILD?: string }).PIBOLT_BUILD = build;
		const { loadExtensions } = await import("../src/core/extensions/loader.ts");
		const result = await loadExtensions(paths, cwd);
		expect(result.errors).toEqual([]);
		return result.extensions.flatMap((extension) => [...extension.commands.keys()]);
	}

	test("Pi loads it as before", async () => {
		const { dir, herdrFile, other } = extensionsDir();
		expect(await loadedCommands(undefined, [herdrFile, other], dir)).toEqual(["herdr-file-loaded", "other"]);
	});

	test("Pi-Bolt leaves it out, and loads the rest", async () => {
		const { dir, herdrFile, other } = extensionsDir();
		expect(await loadedCommands("0.7.5 arm64 jit-off", [herdrFile, other], dir)).toEqual(["other"]);
	});

	test("only Pi-Bolt has the built-in Herdr extension, and only in a Herdr pane", async () => {
		const names = (list: { builtInExtensions: unknown[] }) =>
			list.builtInExtensions.map((e) => (typeof e === "function" ? "" : (e as { name: string }).name));
		vi.stubEnv("HERDR_ENV", "1");
		vi.stubEnv("HERDR_PANE_ID", "p1");
		vi.stubEnv("HERDR_SOCKET_PATH", "/tmp/herdr.sock");
		vi.resetModules();
		expect(names(await import("../src/extensions/index.ts"))).not.toContain("herdr");
		vi.resetModules();
		(globalThis as { PIBOLT_BUILD?: string }).PIBOLT_BUILD = "0.7.5 arm64 jit-off";
		expect(names(await import("../src/extensions/index.ts"))).toContain("herdr");
		vi.unstubAllEnvs();
		vi.stubEnv("HERDR_ENV", undefined);
		vi.resetModules();
		expect(names(await import("../src/extensions/index.ts"))).not.toContain("herdr");
		vi.unstubAllEnvs();
	});
});
