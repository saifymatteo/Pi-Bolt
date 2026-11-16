#!/bin/sh
# Installs the compiled Pi-Bolt runtime from this fork's pi-native-v* releases.
# Installs only pi-bolt: the original Node `pi` command and its files are never touched.
# Usage: sh install.sh [pi-native-v1.0.9]
# `pi-bolt update` runs this with PIBOLT_VERSION (the tag), PIBOLT_INSTALL, PIBOLT_VARIANT, PIBOLT_BIN_DIR,
# PIBOLT_NO_PATH and PIBOLT_YES set; all are honored here.
set -eu
REPO=saifymatteo/Pi-Bolt
case "$(uname -s)-$(uname -m)" in
Linux-x86_64 | Linux-amd64)
	PLATFORM=linux
	VARIANT=${PIBOLT_VARIANT:-x64-jit}
	case "$(ldd --version 2>&1 || true)" in
		*musl*) echo 'This fork requires glibc on Linux; musl builds are not published.' >&2; exit 1 ;;
	esac
	[ "$VARIANT" = x64-jit ] || { echo 'Linux supports PIBOLT_VARIANT=x64-jit only.' >&2; exit 1; }
	;;
Darwin-arm64 | Darwin-aarch64)
	PLATFORM=darwin
	VARIANT=${PIBOLT_VARIANT:-arm64-jit}
	case "$VARIANT" in arm64 | arm64-jit) ;; *) echo 'macOS requires an arm64 variant.' >&2; exit 1 ;; esac
	;;
*) echo 'This installer supports Linux x86-64 (glibc) and macOS Apple silicon only.' >&2; exit 1 ;;
esac
NAME="pi-bolt-$PLATFORM-$VARIANT"
ARCHIVE="$NAME.tar.gz"
INSTALL=${PIBOLT_INSTALL:-${PIBOLT_INSTALL_DIR:-"$HOME/.pi-bolt"}}
BIN_DIR=${PIBOLT_BIN_DIR:-"$HOME/.local/bin"}
DIR="$INSTALL/$NAME"

TAG=${PIBOLT_VERSION:-${1:-}}
if [ -z "$TAG" ]; then
	# The release marked Latest, from where the redirect lands: GitHub's API rate-limits shared addresses.
	TAG=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
	TAG=${TAG##*/}
fi
case $TAG in pi-native-v*) ;; *) echo "$TAG is not a pi-native-v* release of $REPO" >&2; exit 1 ;; esac
echo "Installing $TAG"

base="https://github.com/$REPO/releases/download/$TAG"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
line=$(grep "  $ARCHIVE\$" "$tmp/SHA256SUMS" | head -n 1 || true)
[ -n "$line" ] || { echo "$TAG does not list $ARCHIVE" >&2; exit 1; }
expected=$(printf '%s' "$line" | cut -d' ' -f1)
curl -fsSL -o "$tmp/$ARCHIVE" "$base/$ARCHIVE"
if command -v sha256sum >/dev/null 2>&1; then
	printf '%s  %s\n' "$expected" "$tmp/$ARCHIVE" | sha256sum -c - >/dev/null
else
	printf '%s  %s\n' "$expected" "$tmp/$ARCHIVE" | shasum -a 256 -c - >/dev/null
fi
# Check the extracted layout before moving a working installation out of the way.
tar -xzf "$tmp/$ARCHIVE" -C "$tmp"
[ -x "$tmp/$NAME/pi" ] || { echo "the archive does not have $NAME/pi" >&2; exit 1; }

# The build an install replaces is kept beside the new one as <folder>.previous (`pi-bolt update --rollback`).
if [ -d "$DIR" ]; then
	rm -rf "$DIR.previous"
	mv "$DIR" "$DIR.previous"
fi
mkdir -p "$INSTALL"
mv "$tmp/$NAME" "$DIR"

mkdir -p "$BIN_DIR"
# A shim, not a copy: updates replace the runtime, the shim keeps working.
quoted_pi=$(printf '%s' "$DIR/pi" | sed "s/'/'\\\\''/g")
printf '#!/bin/sh\nexec '\''%s'\'' "$@"\n' "$quoted_pi" > "$BIN_DIR/pi-bolt"
chmod 755 "$BIN_DIR/pi-bolt"
# Conditional takeover: a real pi on PATH stays in charge; without one, pi runs this compiled build. Herdr's
# restore runs `pi --session <transcript>`, so this also makes restart resume Pi-Bolt sessions when Node Pi is
# absent. Candidates carrying our own marker are skipped so two installs cannot forward to each other.
# A real pi in this same bin directory must not be overwritten; only replace our own shim.
if { [ ! -e "$BIN_DIR/pi" ] && [ ! -L "$BIN_DIR/pi" ]; } || grep -q 'PIBOLT_FALLBACK' "$BIN_DIR/pi" 2>/dev/null; then
	cat > "$BIN_DIR/pi" <<'EOF'
#!/bin/sh
# pi shim installed by pi-bolt: real pi on PATH wins, else the compiled build (PIBOLT_FALLBACK).
self_dir=$(CDPATH='' cd "$(dirname -- "$0")" 2>/dev/null && pwd -P) || self_dir=
fallback='__PIBOLT_FALLBACK__'
saved_IFS=$IFS
IFS=':'
for d in $PATH; do
	IFS=$saved_IFS
	case "$d" in ''|"${self_dir:-__none__}") continue ;; esac
	[ -x "$d/pi" ] && [ ! -d "$d/pi" ] || continue
	case "$d/pi" in "$fallback") continue ;; esac
	grep -q 'PIBOLT_FALLBACK' "$d/pi" 2>/dev/null && continue
	exec "$d/pi" "$@"
done
exec "$fallback" "$@"
EOF
	esc=$(printf '%s' "$quoted_pi" | sed 's/[\\&|]/\\&/g')
	sed -i.bak "s|__PIBOLT_FALLBACK__|$esc|" "$BIN_DIR/pi" && rm -f "$BIN_DIR/pi.bak"
	chmod 755 "$BIN_DIR/pi"
fi
case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) if [ -z "${PIBOLT_NO_PATH:-}" ]; then echo "note: $BIN_DIR is not on your PATH; add it to your shell profile" >&2; fi ;;
esac

"$DIR/pi" --version
echo "Installed. Run: pi-bolt (new terminal, or $BIN_DIR/pi-bolt)"
