#!/usr/bin/env bash
# Prints the runtime's stamp: a hash of what the runtime is built from, the engine entries of sources.json (webkit, bun), the
# patches, the runtime build scripts and the linker-order hints they link with (profiles/runtime-*.hints). A release whose
# stamp is the previous release's uses that release's runtime again.
set -euo pipefail
cd "$(dirname "$0")/.."
sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }
{
	# Binary output keeps this header LF-only on Windows too; text-mode print would change the engine's stamp.
	python3 -c 'import json, sys; s = json.load(open("sources.json")); sys.stdout.buffer.write((json.dumps({"webkit": s["webkit"], "bun": s["bun"]}, sort_keys=True) + "\n").encode("utf-8"))'
	cat patches/webkit.patch patches/bun.patch scripts/build-runtime.sh scripts/build-runtime.ps1 scripts/toolchain/*.sh profiles/runtime-*.hints
} | sum | cut -c1-16
