#!/bin/sh
# Installs the compiled Pi-Bolt runtime from this fork's pi-native-v* releases.
# Installs only pi-bolt: the original Node `pi` command and its files are never touched.
# Usage: sh install.sh [pi-native-v1.0.9]
# `pi-bolt update` runs this with PIBOLT_VERSION (the tag), PIBOLT_INSTALL, PIBOLT_VARIANT, PIBOLT_BIN_DIR,
# PIBOLT_NO_PATH and PIBOLT_YES set; all are honored here.
set -eu
REPO=saifymatteo/Pi-Bolt
VARIANT=${PIBOLT_VARIANT:-arm64-jit}
ARCHIVE="pi-bolt-darwin-$VARIANT.tar.gz"
INSTALL=${PIBOLT_INSTALL:-${PIBOLT_INSTALL_DIR:-"$HOME/.pi-bolt"}}
BIN_DIR=${PIBOLT_BIN_DIR:-"$HOME/.local/bin"}
DIR="$INSTALL/pi-bolt-darwin-$VARIANT"

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
echo "$expected  $tmp/$ARCHIVE" | shasum -a 256 -c - >/dev/null

# The build an install replaces is kept beside the new one as <folder>.previous (`pi-bolt update --rollback`).
if [ -d "$DIR" ]; then
	rm -rf "$DIR.previous"
	mv "$DIR" "$DIR.previous"
fi
mkdir -p "$INSTALL"
tar -xzf "$tmp/$ARCHIVE" -C "$INSTALL"
[ -x "$DIR/pi" ] || { echo "the archive does not have pi-bolt-darwin-$VARIANT/pi" >&2; exit 1; }

mkdir -p "$BIN_DIR"
# A shim, not a copy: updates replace the runtime, the shim keeps working.
printf '#!/bin/sh\nexec "%s/pi" "$@"\n' "$DIR" > "$BIN_DIR/pi-bolt"
chmod 755 "$BIN_DIR/pi-bolt"
# Conditional takeover: a real pi on PATH stays in charge; without one, pi runs this compiled build. Herdr's
# restore runs `pi --session <transcript>`, so this also makes restart resume Pi-Bolt sessions when Node Pi is
# absent. Candidates carrying our own marker are skipped so two installs cannot forward to each other.
cat > "$BIN_DIR/pi" <<'EOF'
#!/bin/sh
# pi shim installed by pi-bolt: real pi on PATH wins, else the compiled build (PIBOLT_FALLBACK).
self_dir=$(CDPATH='' cd "$(dirname -- "$0")" 2>/dev/null && pwd -P) || self_dir=
saved_IFS=$IFS
IFS=':'
for d in $PATH; do
	IFS=$saved_IFS
	case "$d" in ''|"${self_dir:-__none__}") continue ;; esac
	[ -x "$d/pi" ] && [ ! -d "$d/pi" ] || continue
	grep -q 'PIBOLT_FALLBACK' "$d/pi" 2>/dev/null && continue
	exec "$d/pi" "$@"
done
exec "__PIBOLT_FALLBACK__" "$@"
EOF
esc=$(printf '%s' "$DIR/pi" | sed 's/[\\&|]/\\&/g')
sed -i.bak "s|__PIBOLT_FALLBACK__|$esc|" "$BIN_DIR/pi" && rm -f "$BIN_DIR/pi.bak"
chmod 755 "$BIN_DIR/pi"
case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) if [ -z "${PIBOLT_NO_PATH:-}" ]; then echo "note: $BIN_DIR is not on your PATH; add it to your shell profile" >&2; fi ;;
esac

"$DIR/pi" --version
echo "Installed. Run: pi-bolt (new terminal, or $BIN_DIR/pi-bolt)"
