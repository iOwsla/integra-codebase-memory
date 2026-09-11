#!/bin/sh
set -eu
server_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' 'Bun is required. Install Bun, then rerun this installer.' >&2
  exit 1
fi
if [ ! -d "$server_dir/node_modules" ]; then
  printf 'Install server dependencies first: cd "%s" && bun install --frozen-lockfile\n' "$server_dir" >&2
  exit 1
fi
exec bun "$server_dir/scripts/install-project.ts" "$@"
