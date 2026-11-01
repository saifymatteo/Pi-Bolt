"""Artifact-only CI helpers; no installer, publisher, real provider or interactive pane.

python scripts/pi-native-artifacts.py smoke out/pi-native
python scripts/pi-native-artifacts.py archive out/pi-native win32-x64
"""
import hashlib
import json
import os
import re
import shutil
import shlex
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bench"))
from harness import MODEL_ARGS, fake_model, pi_env, pi_home, workdir  # noqa: E402


def launchers(directory, platform):
    """Expose only pi-bolt; native Pi and its adjacent assets stay private."""
    if platform == "win32-x64":
        (directory / "pi-bolt.cmd").write_text(
            '@echo off\nsetlocal DisableDelayedExpansion\n"%~dp0runtime\\pi.exe" %*\nexit /b %errorlevel%\n',
            encoding="utf8", newline="\r\n")
    elif platform == "darwin-arm64":
        launcher = directory / "pi-bolt"
        launcher.write_text('#!/bin/sh\nexec "$(dirname "$0")/runtime/pi" "$@"\n', encoding="utf8", newline="\n")
        launcher.chmod(0o755)
    else:
        raise ValueError(f"Unsupported native platform: {platform}")


def launcher_command(directory, args):
    if os.name == "nt":
        # Pass a command string to CreateProcess: a list would backslash-escape
        # cmd.exe's required outer quotes as if cmd used the C argv parser.
        return (f'"{os.environ["COMSPEC"]}" /d /s /c '
                f'""{directory / "pi-bolt.cmd"}" {subprocess.list2cmdline(args)}"')
    return [str(directory / "pi-bolt"), *args]


def check_layout(directory, platform):
    launcher = "pi-bolt.cmd" if platform == "win32-x64" else "pi-bolt"
    allowed = {launcher, "runtime", "build-metadata.json", "SHA256SUMS", "pi-native-identity.json"}
    assert {p.name for p in directory.iterdir()} <= allowed, "Unexpected public output (native Pi must stay private)"
    assert (directory / launcher).is_file(), f"Missing public launcher: {launcher}"
    exe = directory / "runtime" / ("pi.exe" if platform == "win32-x64" else "pi")
    assert exe.is_file(), f"Missing private native Pi: {exe}"
    return exe


def smoke(directory):
    exe = check_layout(directory, "win32-x64" if os.name == "nt" else "darwin-arm64")
    runtime = directory / "runtime"
    if sys.platform == "darwin":
        for name in ("pi", "pi-bin", "pi-spawn"):
            assert os.access(runtime / name, os.X_OK), f"Missing executable/mode: {name}"
    for name in ("theme/dark.json", "theme/light.json", "assets", "export-html/template.html",
                 "photon_rs_bg.wasm", "native", "docs", "examples"):
        assert (runtime / name).exists(), f"Missing adjacent asset: {name}"

    with fake_model() as port, pi_home(port) as home, workdir() as cwd:
        env = pi_env(home)
        # The model configuration names localhost only; also withhold inherited provider credentials.
        env = {k: v for k, v in env.items()
               if not k.upper().endswith(("_KEY", "_TOKEN")) and not k.upper().startswith("AWS_")}

        def run(args, extra=None):
            result = subprocess.run(launcher_command(directory, args), cwd=cwd, env={**env, **(extra or {})},
                                    capture_output=True, text=True, timeout=300)
            output = result.stdout + result.stderr
            print(output, flush=True)
            assert result.returncode == 0, f"Pi failed ({result.returncode}): {output}"
            return output

        version = run(["--version"], {"BUN_STATIC_HEAP_VERBOSE": "1"})
        expected_version = json.loads((ROOT / "packages/coding-agent/package.json").read_text())["version"]
        assert re.search(rf"(?m)^{re.escape(expected_version)}(?:\s|$)", version), version
        assert "JIT on" in version, version
        assert "image registered: true" in version, version
        help_text = re.sub(r"\x1b\[[0-9;]*m", "", run(["--help"]))
        assert re.search(r"(?m)^pi-bolt - AI coding assistant", help_text), help_text
        assert "\n  pi-bolt [options]" in help_text, help_text
        assert "\n  pi [options]" not in help_text, help_text

        # Observe the live OS command line, not just Bun's normalized process.argv[0].
        # Darwin's launcher deliberately forwards argv unchanged to pi-bin: argv0 must remain pi.
        extension = cwd / "pi native identity.ts"
        extension.write_text('''import { execFileSync } from "node:child_process";
export default function () {
    const command = process.platform === "win32"
        ? execFileSync(process.env.SystemRoot + "\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe",
            ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").CommandLine`], { encoding: "utf8" })
        : execFileSync("/bin/ps", ["-ww", "-p", String(process.pid), "-o", "command="], { encoding: "utf8" });
    console.log("PI_NATIVE_IDENTITY=" + JSON.stringify({ argv0: process.argv0, argv: process.argv.slice(2),
        execPath: process.execPath, command: command.trim() }));
}
''', encoding="utf8")
        args = ["-ne", "-e", str(extension), "--offline", "--no-session", *MODEL_ARGS,
                "-p", "native identity probe with spaces"]
        output = run(args)
        match = re.search(r"(?m)^PI_NATIVE_IDENTITY=(.+)$", output)
        assert match, output
        identity = json.loads(match[1])
        assert Path(identity["argv0"]).name == exe.name, identity
        assert identity["argv"] == args, identity
        command0 = shlex.split(identity["command"], posix=os.name != "nt")[0].strip('"')
        assert Path(command0).name == exe.name, identity
        assert "Done:" in output, output
        (directory / "pi-native-identity.json").write_text(json.dumps(identity, indent=2) + "\n")

    # Existing fake-model check exercises the adjacent photon WASM and resize worker on both platforms.
    subprocess.run([sys.executable, str(ROOT / "tests/pi/image.py"), str(exe)], check=True, timeout=1000)
    print("PASS public pi-bolt, private Pi OS identity, argv forwarding, compiled image and image worker")


def release_variant(platform):
    """The variant folder name the updater and installers expect: pi-bolt-<platform>-<variant>, holding the runtime."""
    return "pi-bolt-win32-x64-jit" if platform == "win32-x64" else "pi-bolt-darwin-arm64-jit"


def archive(directory, platform):
    """Stage the release-form archive the updater chain expects.

    The local layout (launchers beside runtime/) is for smoke checks only. The release archive carries one variant folder
    (pi-bolt-<platform>-<variant>/ with the native Pi and its adjacent assets): `pi-bolt update` on Windows unpacks
    pi-bolt-win32-<variant>.zip and installs that folder in place; the installers lay the same folder into the install dir.
    """
    assert platform in ("win32-x64", "darwin-arm64"), platform
    check_layout(directory, platform)
    runtime = ROOT / ".work/runtime" / ("bun.exe" if platform == "win32-x64" else "bun")
    stamp = (runtime.parent / "RUNTIME_STAMP").read_text().strip()
    metadata = {
        "repository": os.environ["GITHUB_REPOSITORY"], "sha": os.environ["GITHUB_SHA"],
        "ref": os.environ["GITHUB_REF"], "runId": os.environ["GITHUB_RUN_ID"],
        "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"], "platform": platform, "jit": "on",
        "runtimeRepository": "opensec-git/Pi-Bolt", "runtimeTag": os.environ["PI_NATIVE_RUNTIME_TAG"],
        "runtimeStamp": stamp, "runtimeSha256": hashlib.sha256(runtime.read_bytes()).hexdigest(),
        "boltVersion": (ROOT / "VERSION").read_text().strip(),
    }
    (directory / "build-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")

    variant = release_variant(platform)
    stage = ROOT / ".work/pi-native-release"
    shutil.rmtree(stage, ignore_errors=True)
    inner = stage / variant
    shutil.copytree(directory / "runtime", inner)
    artifacts = ROOT / "out/pi-native-artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    if platform == "win32-x64":
        target = artifacts / f"{variant}.zip"
        with zipfile.ZipFile(target, "w") as zipped:
            for path in sorted(p for p in inner.rglob("*") if p.is_file()):
                arcname = path.relative_to(stage).as_posix()
                zipped.write(path, arcname)
                if path.suffix in (".exe", ".dll", ".node") or path.parent == inner:
                    zipped.getinfo(arcname).external_attr = 0o755 << 16
    else:
        target = artifacts / f"{variant}.tar.gz"
        # tar preserves the launcher/helper and native executable modes the install needs.
        subprocess.run(["tar", "-czf", str(target), "-C", str(stage), variant], check=True)
    shutil.rmtree(stage, ignore_errors=True)
    (artifacts / "SHA256SUMS").write_text(f"{hashlib.sha256(target.read_bytes()).hexdigest()}  {target.name}\n", newline="\n")
    (artifacts / "build-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Archived release output: {target}")


if __name__ == "__main__":
    action, path, *rest = sys.argv[1:]
    directory = Path(path).resolve(strict=True)
    if action == "launchers" and len(rest) == 1:
        launchers(directory, rest[0])
    elif action == "smoke" and not rest:
        smoke(directory)
    elif action == "archive" and len(rest) == 1:
        archive(directory, rest[0])
    else:
        raise SystemExit("Expected launchers DIRECTORY PLATFORM, smoke DIRECTORY or archive DIRECTORY PLATFORM")
