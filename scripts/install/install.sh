#!/bin/sh
# Installs the compiled Pi-Bolt runtime from the fork's pi-native-v* releases.
# Installs only pi-bolt: the original Node `pi` command and its files are never touched.
# Usage: sh install.sh [pi-native-v1.0.9-trial.2]
set -eu
REPO=saifymatteo/Pi-Bolt
ARCH=darwin-arm64   # the fork builds Apple Silicon and Windows x64 only
INSTALL=${PIBOLT_INSTALL_DIR:-"$HOME/.pi-bolt"}
BIN_DIR=${PIBOLT_BIN_DIR:-"$HOME/.local/bin"}

TAG=${1:-}
if [ -z "$TAG" ]; then
	TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" |
		sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(pi-native-v[^"]*\)".*/\1/p' | head -n 1)
fi
[ -n "$TAG" ] || { echo "no pi-native-v* release found in $REPO" >&2; exit 1; }
echo "Installing $TAG"

base="https://github.com/$REPO/releases/download/$TAG"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/pi.tar.gz" "$base/pi-native-$ARCH.tar.gz"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
# The combined file also lists other platforms; check only our archive's line.
grep "pi-native-$ARCH.tar.gz" "$tmp/SHA256SUMS" | (cd "$tmp" && shasum -a 256 -c -)

if [ -d "$INSTALL" ]; then
	old="$INSTALL.old-$(date +%Y%m%d%H%M%S)"
	mv "$INSTALL" "$old"
	echo "the previous install is in $old"
fi
mkdir -p "$INSTALL" "$BIN_DIR"
tar -xzf "$tmp/pi.tar.gz" -C "$INSTALL"

launcher="$INSTALL/pi-native/pi-bolt"
[ -f "$launcher" ] || { echo "extracted archive is missing pi-bolt" >&2; exit 1; }
# A shim, not a copy: updates replace the runtime, the shim keeps working.
printf '#!/bin/sh\nexec "%s" "$@"\n' "$launcher" > "$BIN_DIR/pi-bolt"
chmod 0755 "$BIN_DIR/pi-bolt"

case ":$PATH:" in *":$BIN_DIR:"*) ;; *)
	echo "note: $BIN_DIR is not on your PATH; add it to use plain \`pi-bolt\`" ;;
esac
"$launcher" --version
echo "Installed. Run: pi-bolt"
