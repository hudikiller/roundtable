#!/usr/bin/env bash
# Roundtable one-line installer: clone, install, build, then start the setup wizard.
#   curl -fsSL https://raw.githubusercontent.com/hudikiller/roundtable/main/install.sh | bash
# Options (env): ROUNDTABLE_DIR (default ./roundtable), ROUNDTABLE_REPO, ROUNDTABLE_REF (default main).
# Extra arguments are passed to the wizard, e.g. `bash -s -- --yes` with RT_* variables for unattended setup.
set -euo pipefail
DIR="${ROUNDTABLE_DIR:-$PWD/roundtable}"
REPO="${ROUNDTABLE_REPO:-https://github.com/hudikiller/roundtable.git}"
REF="${ROUNDTABLE_REF:-main}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "❌ Missing $1 — $2"; exit 1; }; }

say "Roundtable installer"
need git "install Git"
need node "install Node.js 24 (https://nodejs.org)"
need npm "install npm (bundled with Node.js)"
need docker "install Docker Engine (https://docs.docker.com/engine/install/)"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" = "24" ] || { echo "❌ Node.js 24 is required (found $(node -v))"; exit 1; }

if [ -d "$DIR/.git" ]; then
  say "Updating existing checkout in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR"
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi
cd "$DIR"
say "Installing dependencies"
npm ci --no-audit --no-fund
say "Building"
npm run build

say "Starting the setup wizard"
# When piped through curl, stdin is the script itself; read answers from the terminal instead.
if [ -t 0 ]; then exec npm run init -- "$@"
elif { : </dev/tty; } 2>/dev/null; then exec npm run init -- "$@" < /dev/tty
else exec npm run init -- "$@"
fi
