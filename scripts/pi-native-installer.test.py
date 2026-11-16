"""Offline Unix installer checks: platform selection, checksums, shims and safe replacement.

Run with python3 scripts/pi-native-installer.test.py. Downloads and platform tools are local fixtures.
"""
import hashlib
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

INSTALLER = Path(__file__).resolve().parent / "install/install.sh"


@unittest.skipIf(os.name == "nt", "requires a POSIX shell")
class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-bolt installer '")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "tools"
        self.bin.mkdir()
        self.fixtures = self.root / "downloads"
        self.fixtures.mkdir()
        for tool in ("sh", "cat", "chmod", "cut", "dirname", "grep", "gzip", "head", "mkdir", "mktemp",
                     "mv", "rm", "sed", "tar"):
            target = shutil.which(tool)
            self.assertIsNotNone(target, f"Required test tool: {tool}")
            (self.bin / tool).symlink_to(target)
        self.script("uname", 'case "$1" in -s) echo "$TEST_OS" ;; -m) echo "$TEST_ARCH" ;; esac\n')
        self.script("ldd", 'echo "$TEST_LIBC"\n')
        self.script("curl", '''output=
while [ "$#" -gt 0 ]; do
    case "$1" in -o) output=$2; shift ;; https://*) url=$1 ;; esac
    shift
done
printf '%s\\n' "$url" >> "$TEST_REQUESTS"
case "$url" in
    */releases/latest) printf 'https://github.com/saifymatteo/Pi-Bolt/releases/tag/pi-native-v1.2.2' ;;
    *) cp_source="$TEST_FIXTURES/${url##*/}"
       cat "$cp_source" > "$output" ;;
esac
''')
        self.checksum("sha256sum")
        self.env = {
            **os.environ, "PATH": str(self.bin), "HOME": str(self.root), "TEST_OS": "Linux",
            "TEST_ARCH": "x86_64", "TEST_LIBC": "ldd (GNU libc) 2.44", "TEST_FIXTURES": str(self.fixtures),
            "TEST_REQUESTS": str(self.root / "requests"), "PIBOLT_INSTALL": str(self.root / "installed ' build"),
            "PIBOLT_BIN_DIR": str(self.root / "commands"), "PIBOLT_NO_PATH": "1",
        }
        for name in ("PIBOLT_VERSION", "PIBOLT_VARIANT", "PIBOLT_INSTALL_DIR"):
            self.env.pop(name, None)

    def script(self, name, source):
        path = self.bin / name
        path.write_text("#!/bin/sh\nset -eu\n" + source)
        path.chmod(0o755)

    def checksum(self, name):
        # Use real file hashes, with a controlled tool name to exercise both checksum routes on either host OS.
        path = self.bin / name
        path.write_text(f"#!{shutil.which('python3')}\n" + '''import hashlib, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
assert sys.argv[1:] == (["-c", "-"] if name == "sha256sum" else ["-a", "256", "-c", "-"])
Path(os.environ["TEST_CHECKSUM"]).write_text(name)
expected, filename = sys.stdin.read().strip().split("  ", 1)
sys.exit(0 if hashlib.sha256(Path(filename).read_bytes()).hexdigest() == expected else 1)
''')
        path.chmod(0o755)

    def release(self, platform="linux", variant="x64-jit", version="first", executable=True):
        name = f"pi-bolt-{platform}-{variant}"
        stage = self.root / "stage" / name
        stage.mkdir(parents=True, exist_ok=True)
        pi = stage / "pi"
        pi.write_text(f"#!/bin/sh\nprintf '%s\\n' '{version}' \"$@\"\n")
        pi.chmod(0o755 if executable else 0o644)
        asset = stage / "assets/theme.json"
        asset.parent.mkdir(exist_ok=True)
        asset.write_text("{}")
        archive = self.fixtures / f"{name}.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(stage, arcname=name)
        self.sums(archive)
        return name

    def sums(self, archive):
        checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.fixtures / "SHA256SUMS").write_text(f"# pi-bolt 1.2.2\n{checksum}  {archive.name}\n")

    def install(self, expected=0, **env):
        result = subprocess.run([str(self.bin / "sh"), str(INSTALLER)],
                                env={**self.env, "TEST_CHECKSUM": str(self.root / "checksum"), **env},
                                capture_output=True, text=True, timeout=30)
        if expected is None:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def run_command(self, name, *args, extra_path=""):
        commands = Path(self.env["PIBOLT_BIN_DIR"])
        return subprocess.run([str(commands / name), *args], env={**self.env,
                              "PATH": f"{commands}:{extra_path}:{self.bin}"},
                              capture_output=True, text=True, check=True, timeout=30).stdout.splitlines()

    def test_linux_defaults_to_x64_jit_and_works_without_shasum(self):
        name = self.release()
        self.install()
        self.assertEqual((self.root / "checksum").read_text(), "sha256sum")
        self.assertIn(f"/pi-native-v1.2.2/{name}.tar.gz", (self.root / "requests").read_text())
        self.assertTrue((Path(self.env["PIBOLT_INSTALL"]) / name / "assets/theme.json").is_file())
        self.assertEqual(self.run_command("pi-bolt", "two words", "", "quote's"), ["first", "two words", "", "quote's"])
        self.assertEqual(self.run_command("pi", "--session", "session path"), ["first", "--session", "session path"])

    def test_update_preserves_previous_build_and_real_pi_stays_in_charge(self):
        name = self.release()
        self.install(PIBOLT_VERSION="pi-native-v1.2.2", PIBOLT_VARIANT="x64-jit")
        self.release(version="second")
        self.install(PIBOLT_VERSION="pi-native-v1.2.3", PIBOLT_VARIANT="x64-jit")
        previous = Path(self.env["PIBOLT_INSTALL"]) / f"{name}.previous/pi"
        self.assertIn("first", previous.read_text())
        real_bin = self.root / "real-pi"
        real_bin.mkdir()
        real_pi = real_bin / "pi"
        source = '#!/bin/sh\nprintf "%s\\n" "real pi" "$@"\n'
        real_pi.write_text(source)
        real_pi.chmod(0o755)
        self.assertEqual(self.run_command("pi", "--version", extra_path=real_bin), ["real pi", "--version"])
        self.assertEqual(real_pi.read_text(), source)
        self.assertEqual(self.run_command("pi-bolt", "--version", extra_path=real_bin), ["second", "--version"])

    def test_real_pi_in_destination_bin_is_not_overwritten(self):
        self.release()
        commands = Path(self.env["PIBOLT_BIN_DIR"])
        commands.mkdir()
        original = self.root / "original-pi"
        source = '#!/bin/sh\nprintf "%s\\n" "original pi" "$@"\n'
        original.write_text(source)
        original.chmod(0o755)
        pi = commands / "pi"
        for kind in ("file", "symlink"):
            with self.subTest(kind=kind):
                if kind == "symlink":
                    pi.symlink_to(original)
                else:
                    shutil.copy2(original, pi)
                self.install()
                self.assertEqual(pi.read_text(), source)
                self.assertEqual(pi.is_symlink(), kind == "symlink")
                self.assertEqual(self.run_command("pi", "--version"), ["original pi", "--version"])
                self.assertEqual(self.run_command("pi-bolt", "--version"), ["first", "--version"])
                pi.unlink()

    def test_macos_keeps_arm64_default_and_shasum_fallback(self):
        self.release("darwin", "arm64-jit")
        (self.bin / "sha256sum").unlink()
        self.checksum("shasum")
        self.install(TEST_OS="Darwin", TEST_ARCH="arm64")
        self.assertEqual((self.root / "checksum").read_text(), "shasum")
        self.assertEqual(self.run_command("pi-bolt", "--version"), ["first", "--version"])
        self.assertIn("pi-bolt-darwin-arm64-jit.tar.gz", (self.root / "requests").read_text())

    def test_unsupported_platforms_and_variants_fail_before_download(self):
        for env in ({"TEST_ARCH": "aarch64"}, {"TEST_OS": "FreeBSD"}, {"TEST_OS": "Darwin"},
                    {"TEST_LIBC": "musl libc (x86_64)"}, {"PIBOLT_VARIANT": "arm64-jit"},
                    {"PIBOLT_VARIANT": "../bad"}):
            with self.subTest(env=env):
                self.install(expected=1, **env)
                self.assertFalse((self.root / "requests").exists())
                self.assertFalse(Path(self.env["PIBOLT_INSTALL"]).exists())

    def test_corrupt_or_invalid_release_does_not_replace_working_installation(self):
        name = self.release()
        self.install()
        archive = self.fixtures / f"{name}.tar.gz"
        archive.write_bytes(b"not the checksummed archive")
        self.install(expected=1)
        installed = Path(self.env["PIBOLT_INSTALL"]) / name
        self.assertFalse(installed.with_name(f"{name}.previous").exists())
        self.assertEqual(self.run_command("pi-bolt", "--version"), ["first", "--version"])
        self.sums(archive)
        self.install(expected=None)
        self.assertFalse(installed.with_name(f"{name}.previous").exists())
        self.release(executable=False)
        result = self.install(expected=1)
        self.assertIn(f"the archive does not have {name}/pi", result.stderr)
        self.assertEqual(self.run_command("pi-bolt", "--version"), ["first", "--version"])


if __name__ == "__main__":
    unittest.main()
