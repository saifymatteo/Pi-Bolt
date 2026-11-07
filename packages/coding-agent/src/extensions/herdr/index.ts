/**
 * Herdr support for Pi-Bolt's native Pi identity. Register canonical Pi session metadata and report idle,
 * working and blocked states. Trial builds retain Herdr's default `pi --session` plan; compiled restart is deferred.
 * Kept in the native heap independent of build-time environment; activates only when launched inside a Herdr pane.
 * Pi-Bolt skips Herdr's installed Pi integration file to avoid duplicate reporters (integration-file.ts).
 * Reports use Herdr's socket, or its executable on Windows (transport.ts). Disable with `-builtin:herdr`.
 * Only TUI sessions report: headless runs and subagents must not take over their parent's pane.
 */

import { isAbsolute } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { type HerdrRequest, type HerdrTransport, herdrFromEnvironment } from "./transport.ts";

type AgentState = "working" | "blocked" | "idle";

/**
 * pi-herdr (an extension that runs agents in Herdr panes) also reports this pane's state. Its reports can overwrite
 * this session's state or metadata. PI_HERDR_NO_SELF_REPORT turns that off; pi-herdr reads it when it loads, before
 * this extension runs, so this is called at startup.
 */
export function quietOtherHerdrReporters(env: NodeJS.ProcessEnv = process.env): void {
	if (herdrFromEnvironment(env)) env.PI_HERDR_NO_SELF_REPORT ??= "1";
}

/**
 * Two tries; true when Herdr took the report. Each try gets its own seq: Herdr may have applied a try whose answer was
 * lost, and would then refuse the same seq again. `request` returns undefined once the report is no longer wanted.
 */
async function send(transport: HerdrTransport, request: () => HerdrRequest | undefined): Promise<boolean> {
	for (const timeoutMs of [500, 1500]) {
		const next = request();
		if (!next) return false;
		if (await transport(next, timeoutMs)) return true;
	}
	return false;
}

export function createHerdrExtension(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): ExtensionFactory {
	return (pi) => {
		const herdr = herdrFromEnvironment(env ?? process.env, platform ?? process.platform);
		if (!herdr) return;
		const { transport, paneId } = herdr;
		const source = "herdr:pi";
		const agent = "pi";

		// Herdr ignores a report whose number is not above the last one from this source, across restarts of Pi-Bolt too.
		let seq = Date.now() * 1000;
		const nextSeq = () => ++seq;

		let reporting = false;
		let sessionFile: string | undefined;
		let sessionId: string | undefined;
		let agentActive = false;
		const blockedLabels: string[] = [];
		const runningSubagents = new Set<string>();
		let backgroundBusy = false;
		let last: { state: AgentState; message?: string; sessionFile?: string } | undefined;

		function updateSession(ctx: ExtensionContext) {
			try {
				const file = ctx.sessionManager.getSessionFile();
				sessionFile = typeof file === "string" && isAbsolute(file) ? file : undefined;
			} catch {
				sessionFile = undefined;
			}
			try {
				const id = ctx.sessionManager.getSessionId();
				sessionId = typeof id === "string" && id.length > 0 ? id : undefined;
			} catch {
				sessionId = undefined;
			}
		}

		function desiredState(): { state: AgentState; message?: string } {
			// UI prompts are not a blocked signal: pi-atelier hosts its sidebar as a persistent ui.custom overlay for the
			// whole session, and stock Herdr's Pi integration never maps ui_prompt to blocked. Extensions that wait for the
			// user say so on the herdr:blocked channel instead.
			if (blockedLabels.length > 0) return { state: "blocked", message: blockedLabels[blockedLabels.length - 1] };
			if (agentActive || backgroundBusy || runningSubagents.size > 0) return { state: "working" };
			return { state: "idle" };
		}

		// One report in flight at a time; only the newest waiting one is sent. Retry a failed latest state even when
		// no more lifecycle events arrive, or a lost completion leaves Herdr working indefinitely.
		let inFlight = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let retryDelay = 1000;
		let queued: { report: typeof last; request: () => HerdrRequest | undefined } | undefined;
		async function drain() {
			if (inFlight) return;
			inFlight = true;
			try {
				while (queued) {
					const { report, request } = queued;
					queued = undefined;
					if (await send(transport, request)) {
						retryDelay = 1000;
					} else if (reporting && !queued && last === report) {
						last = undefined;
						retryTimer = setTimeout(() => {
							retryTimer = undefined;
							publish();
						}, retryDelay);
						retryTimer.unref?.();
						retryDelay = Math.min(retryDelay * 2, 30_000);
					}
				}
			} finally {
				inFlight = false;
			}
		}

		function publish(force = false) {
			if (!reporting) return;
			const next = { ...desiredState(), sessionFile };
			if (
				!force &&
				last &&
				last.state === next.state &&
				last.message === next.message &&
				last.sessionFile === next.sessionFile
			) {
				return;
			}
			clearTimeout(retryTimer);
			retryTimer = undefined;
			last = next;
			const params = {
				pane_id: paneId,
				source,
				agent,
				state: next.state,
				...(next.message ? { message: next.message } : {}),
				...(sessionFile ? { agent_session_path: sessionFile } : sessionId ? { agent_session_id: sessionId } : {}),
			};
			queued = {
				report: next,
				// Never retry a superseded report or take the pane back after session_shutdown.
				request: () =>
					reporting && last === next
						? { method: "pane.report_agent", params: { ...params, seq: nextSeq() } }
						: undefined,
			};
			void drain();
		}

		pi.on("session_start", async (event, ctx) => {
			if (ctx.mode !== "tui") return;
			reporting = true;
			updateSession(ctx);
			// Herdr's canonical Pi lifecycle ignores state until the selected session is explicitly registered.
			// Canonical metadata selects `pi --session` on restore; reliable `pi-bolt` restart is deferred.
			if (sessionFile || sessionId) {
				await send(transport, () =>
					reporting
						? {
								method: "pane.report_agent_session",
								params: {
									pane_id: paneId,
									source,
									agent,
									seq: nextSeq(),
									session_start_source: event.reason,
									...(sessionFile ? { agent_session_path: sessionFile } : { agent_session_id: sessionId }),
								},
							}
						: undefined,
				);
			}
			// A reload replaces this extension in the middle of a run without another agent_start.
			agentActive = ctx.isIdle() === false;
			publish(true);
		});

		pi.on("agent_start", (_event, ctx) => {
			if (!reporting) return;
			updateSession(ctx);
			agentActive = true;
			publish();
		});

		pi.on("agent_settled", (_event, ctx) => {
			if (!reporting || !ctx.isIdle()) return;
			agentActive = false;
			publish();
		});

		// Extensions that wait for the user outside a dialog (pi-ask-user, pi-subagents) say so on this channel, which
		// Herdr's own Pi integration also listens to: { active: boolean, label?: string }.
		pi.events.on("herdr:blocked", (data) => {
			const { active, label } = (data ?? {}) as { active?: unknown; label?: unknown };
			if (active) blockedLabels.push(typeof label === "string" ? label : "");
			else blockedLabels.pop();
			publish();
		});

		// Background subagents keep working after the run that started them settles.
		for (const [event, running] of [
			["subagents:started", true],
			["subagents:completed", false],
			["subagents:failed", false],
		] as const) {
			pi.events.on(event, (data) => {
				const id = (data as { id?: unknown } | undefined)?.id;
				if (typeof id !== "string") return;
				if (running) runningSubagents.add(id);
				else runningSubagents.delete(id);
				publish();
			});
		}

		// pi-subagents (nicobailon) says on this channel whether its background runs are going: { active: true, label }
		// while any is, { active: false } once none is. It may describe the same runs as subagents:*; either keeps the pane
		// working, and neither counts twice. It relabels by sending false and then true at once, so the report waits for
		// the end of this tick rather than showing idle in between.
		let busyPublishing = false;
		pi.events.on("herdr:busy", (data) => {
			backgroundBusy = Boolean((data as { active?: unknown } | undefined)?.active);
			if (busyPublishing) return;
			busyPublishing = true;
			queueMicrotask(() => {
				busyPublishing = false;
				publish();
			});
		});

		pi.on("session_shutdown", async (event) => {
			if (!reporting) return;
			reporting = false;
			clearTimeout(retryTimer);
			retryTimer = undefined;
			queued = undefined;
			last = undefined;
			// Another session in this process (new, resume, fork) or a reload reports again from its session_start.
			if (event.reason !== "quit") return;
			// One short try: Herdr also notices the exit once the pane is back at its shell prompt.
			await transport(
				{
					method: "pane.release_agent",
					params: { pane_id: paneId, source, agent, seq: nextSeq() },
				},
				500,
			);
		});
	};
}

export default createHerdrExtension();
