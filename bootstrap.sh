#!/bin/sh
# Standalone, stdin-safe bootstrap for a pinned CodeMemory release.
set -eu
version=v0.1.0-alpha.26
project=
client=
apply=false
upgrade=
services=--with-services
install_dir=${XDG_DATA_HOME:-"$HOME/.local/share"}/integra-code-memory/releases/$version
fail() { printf '%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--client|--install-dir)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in
        --project) project=$2 ;;
        --client) client=$2 ;;
        --install-dir) install_dir=$2 ;;
      esac
      shift 2 ;;
    --upgrade) upgrade=--upgrade; shift ;;
    --write) apply=true; shift ;;
    --skip-services) services=; shift ;;
    --help) printf '%s\n' 'Usage: sh bootstrap.sh --project /absolute/project --client codex|claude|both [--install-dir /absolute/runtime] [--write] [--upgrade] [--skip-services]'; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
case "$project" in /*) ;; *) fail 'An explicit absolute --project is required.' ;; esac
[ -d "$project" ] || fail 'Project directory does not exist.'
project=$(CDPATH= cd -- "$project" && pwd -P)
case "$client" in codex|claude|both) ;; *) fail 'Select --client codex, claude or both.' ;; esac
case "$install_dir" in /*) ;; *) fail '--install-dir must be absolute.' ;; esac
if [ "$apply" = false ]; then
  printf 'Preview: install %s in %s and configure %s for %s. Docker and managed PostgreSQL are prepared unless --skip-services is selected. Add --write to apply.\n' "$version" "$install_dir" "$client" "$project"
  exit 0
fi
for dependency in git bun; do
  command -v "$dependency" >/dev/null 2>&1 || fail "$dependency is required; install it and rerun."
done
# Reject redirected paths, including existing ancestor symlinks.
ancestor=$install_dir
while [ "$ancestor" != / ]; do
  [ ! -L "$ancestor" ] || fail 'Refusing a symbolic link in the runtime path.'
  ancestor=$(dirname -- "$ancestor")
done
if [ -e "$install_dir" ]; then
  [ -d "$install_dir/.git" ] || fail 'Runtime directory already exists and is not a managed checkout.'
  [ "$(git -C "$install_dir" remote get-url origin)" = https://github.com/iOwsla/integra-codebase-memory.git ] || fail 'Existing runtime has a different origin.'
  [ "$(git -C "$install_dir" describe --tags --exact-match HEAD)" = "$version" ] || fail 'Existing runtime has a different version.'
  [ -z "$(git -C "$install_dir" status --porcelain --untracked-files=normal)" ] || fail 'Existing runtime has local changes.'
  [ -d "$install_dir/node_modules" ] || fail 'Runtime dependencies are missing; use a fresh --install-dir.'
  exec sh "$install_dir/install.sh" --project "$project" --client "$client" --write ${services:+"$services"} ${upgrade:+"$upgrade"}
fi
parent=$(dirname -- "$install_dir")
mkdir -p -- "$parent"
temporary=$(mktemp -d "$parent/.codememory-download.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT HUP INT TERM
git clone --quiet --depth 1 --branch "$version" -- https://github.com/iOwsla/integra-codebase-memory.git "$temporary/runtime"
(cd -- "$temporary/runtime" && bun install --frozen-lockfile --ignore-scripts)
# No overwrite: another bootstrap may have completed while downloading.
[ ! -e "$install_dir" ] && [ ! -L "$install_dir" ] || fail 'Runtime destination appeared during download.'
mv -- "$temporary/runtime" "$install_dir"
printf 'Runtime installed: %s\n' "$install_dir"
sh "$install_dir/install.sh" --project "$project" --client "$client" --write ${services:+"$services"} ${upgrade:+"$upgrade"}
