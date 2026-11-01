"""Deterministic packaging check; no native binary or provider needed."""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("pi_native_artifacts", Path(__file__).with_name("pi-native-artifacts.py"))
ARTIFACTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARTIFACTS)


class ArchiveTests(unittest.TestCase):
    def test_public_launchers_target_private_pi_without_modes_or_overrides(self):
        with tempfile.TemporaryDirectory(prefix="pi native launcher ") as temp:
            root = Path(temp)
            ARTIFACTS.launchers(root, "win32-x64")
            self.assertEqual((root / "pi-bolt.cmd").read_bytes(),
                             b'@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0runtime\\pi.exe" %*\r\nexit /b %errorlevel%\r\n')
            (root / "pi-bolt.cmd").unlink()
            ARTIFACTS.launchers(root, "darwin-arm64")
            self.assertEqual((root / "pi-bolt").read_bytes(),
                             b'#!/bin/sh\nexec "$(dirname "$0")/runtime/pi" "$@"\n')
            if os.name != "nt":
                self.assertEqual((root / "pi-bolt").stat().st_mode & 0o777, 0o755)
            with self.assertRaises(ValueError):
                ARTIFACTS.launchers(root, "unknown")

    def test_public_launcher_forwards_arguments_and_exit_from_path_with_spaces(self):
        # A hard-linked Node stands in for native Pi; no agent build/copy or PATH edit.
        # Keep the fixture on the same filesystem as Node, as hard links require it.
        node = Path(subprocess.check_output([shutil.which("node"), "-p", "process.execPath"], text=True).strip())
        temp_parent = ARTIFACTS.ROOT if node.stat().st_dev == ARTIFACTS.ROOT.stat().st_dev else None
        with tempfile.TemporaryDirectory(prefix="pi native argv ", dir=temp_parent) as temp:
            root = Path(temp)
            runtime = root / "runtime"
            runtime.mkdir()
            exe = runtime / ("pi.exe" if os.name == "nt" else "pi")
            os.link(node, exe)
            platform = "win32-x64" if os.name == "nt" else "darwin-arm64"
            ARTIFACTS.launchers(root, platform)
            self.assertEqual(ARTIFACTS.check_layout(root, platform), exe)
            args = ["two words", "", "bang!", "space & separator", 'quoted "value"', "trailing slash \\"]
            probe = root / "argv probe.js"
            probe.write_text('console.log(JSON.stringify(process.argv.slice(2))); process.exit(37);', encoding="utf8")
            result = subprocess.run(ARTIFACTS.launcher_command(root, [str(probe), *args]),
                                    cwd=ARTIFACTS.ROOT, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 37, result.stderr)
            self.assertEqual(json.loads(result.stdout), args)
            probe.unlink()
            for name in ("pi", "pi.exe", "pi.cmd", "pi-bolt.exe"):
                (root / name).touch()
                with self.assertRaisesRegex(AssertionError, "Unexpected public output"):
                    ARTIFACTS.check_layout(root, platform)
                (root / name).unlink()

    def test_release_archive_carries_one_variant_folder_with_the_runtime(self):
        for platform in ("win32-x64", "darwin-arm64"):
            with self.subTest(platform=platform):
                self.check_archive(platform)

    def check_archive(self, platform):
        windows = platform == "win32-x64"
        launcher = "pi-bolt.cmd" if windows else "pi-bolt"
        executables = ("runtime/pi.exe",) if windows else ("runtime/pi", "runtime/pi-bin", "runtime/pi-spawn")
        with tempfile.TemporaryDirectory(prefix="pi-native-contract-") as temp:
            root = Path(temp)
            output = root / "out/pi-native"
            output.mkdir(parents=True)
            files = (*executables, "runtime/theme/dark.json", "runtime/photon_rs_bg.wasm", "runtime/native/SHA256SUMS")
            if not windows:
                files += ("runtime/pi-bin.hot", "runtime/libsystem/libSystem.B.dylib",
                          "runtime/native/darwin/prebuilds/darwin-arm64/helper")
            ARTIFACTS.launchers(output, platform)
            for name in files:
                path = output / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(name.encode())
                path.chmod(0o755 if name in executables or name.endswith("/helper") else 0o644)
            runtime = root / ".work/runtime"
            runtime.mkdir(parents=True)
            (runtime / ("bun.exe" if windows else "bun")).write_bytes(b"test engine")
            (runtime / "RUNTIME_STAMP").write_text("d615e931f06bb5a4\n")
            (root / "VERSION").write_text("1.0.8\n")
            env = {"GITHUB_REPOSITORY": "saifymatteo/Pi-Bolt", "GITHUB_SHA": "a" * 40,
                   "GITHUB_REF": "refs/heads/feat/pi-native-identity", "GITHUB_RUN_ID": "1",
                   "GITHUB_RUN_ATTEMPT": "1", "PI_NATIVE_RUNTIME_TAG": "bolt-v1.0.8"}
            with patch.object(ARTIFACTS, "ROOT", root), patch.dict(os.environ, env):
                ARTIFACTS.archive(output, platform)
            variant = ARTIFACTS.release_variant(platform)
            suffix = "zip" if windows else "tar.gz"
            archive = root / f"out/pi-native-artifacts/{variant}.{suffix}"
            # The local layout (launchers beside runtime/) never enters the release archive; the runtime does, under the
            # variant folder name the updater and installers expect.
            inner = [(name[len("runtime/"):], name.encode()) for name in files]
            if windows:
                with zipfile.ZipFile(archive) as zipped:
                    names = zipped.namelist()
                    self.assertEqual({name.split("/", 1)[0] for name in names if name.strip("/")}, {variant})
                    self.assertNotIn(f"{variant}/{launcher}", names)
                    for name, content in inner:
                        self.assertEqual(zipped.read(f"{variant}/{name}"), content)
                    self.assertEqual(zipped.read(f"{variant}/pi.exe"), b"runtime/pi.exe")
            else:
                with tarfile.open(archive, "r:gz") as tar:
                    names = tar.getnames()
                    self.assertEqual({name.split("/", 1)[0] for name in names if name.strip("/")}, {variant})
                    for name, content in inner:
                        member = tar.getmember(f"{variant}/{name}")
                        self.assertEqual(tar.extractfile(member).read(), content)
                        if os.name != "nt":
                            executable = name in ("pi", "pi.exe", "pi-bin", "pi-spawn") or name.endswith("/helper")
                            self.assertEqual(member.mode & 0o777, 0o755 if executable else 0o644)
            checksum = archive.with_name("SHA256SUMS").read_text().split("  ")[0]
            self.assertNotIn("\r", archive.with_name("SHA256SUMS").read_text())
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), checksum)
            metadata = json.loads(archive.with_name("build-metadata.json").read_text())
            self.assertEqual(metadata["platform"], platform)
            self.assertEqual(metadata["runtimeStamp"], "d615e931f06bb5a4")


if __name__ == "__main__":
    unittest.main()
