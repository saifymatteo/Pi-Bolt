import type { InlineExtension } from "../core/extensions/types.ts";
import { PIBOLT } from "../pi-bolt.ts";
import codemodeExtension from "./codemode/index.ts";
import herdrExtension from "./herdr/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import usageExtension from "./usage/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	{ name: "usage", factory: usageExtension, replaceable: true, builtin: true },
	// Native heaps may be prepared outside Herdr. Keep the factory in the snapshot; it checks the launch environment.
	...(PIBOLT ? [{ name: "herdr", factory: herdrExtension, builtin: true }] : []),
];
