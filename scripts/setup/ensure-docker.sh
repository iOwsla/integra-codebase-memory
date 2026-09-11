#!/bin/sh
set -eu
# Called only by an explicitly applied managed installation.
case "$(uname -s)" in
  Darwin)
    if [ ! -d /Applications/Docker.app ]; then
      case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=amd64 ;; *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;; esac
      temp=$(mktemp -d)
      trap 'hdiutil detach "$temp/mount" >/dev/null 2>&1 || true; rm -rf "$temp"' EXIT HUP INT TERM
      mkdir "$temp/mount"
      curl -fL --retry 2 "https://desktop.docker.com/mac/main/$arch/Docker.dmg" -o "$temp/Docker.dmg"
      hdiutil attach "$temp/Docker.dmg" -mountpoint "$temp/mount" -nobrowse
      # Installer may request an administrator password. Terms remain in Docker's UI.
      sudo "$temp/mount/Docker.app/Contents/MacOS/install"
    fi
    open -a /Applications/Docker.app
    echo 'Complete Docker Desktop first-run prompts if displayed. Waiting for its engine...' >&2
    ;;
  Linux)
    if [ "$(id -u)" -ne 0 ]; then exec sudo sh "$0"; fi
    . /etc/os-release
    if ! command -v docker >/dev/null 2>&1; then
      case "$ID" in
        ubuntu|debian)
          # Do not remove/replace a host's existing container runtime packages.
          for package in docker.io podman-docker containerd runc; do
            if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
              echo "Existing $package requires manual Docker package reconciliation; nothing removed." >&2; exit 1
            fi
          done
          case "${VERSION_CODENAME:-}" in ''|*[!a-z0-9]*) echo 'Unsupported distribution codename.' >&2; exit 1 ;; esac
          apt-get update
          apt-get install -y ca-certificates curl
          install -m 0755 -d /etc/apt/keyrings
          curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/codememory-docker.asc
          chmod a+r /etc/apt/keyrings/codememory-docker.asc
          printf 'deb [arch=%s signed-by=/etc/apt/keyrings/codememory-docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/codememory-docker.list
          apt-get update
          apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
          ;;
        fedora)
          dnf install -y curl ca-certificates
          curl -fsSL https://download.docker.com/linux/fedora/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo
          dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
          ;;
        *) echo "Automatic Docker installation supports Ubuntu, Debian and Fedora. Install Docker Engine and Compose for $ID, then rerun." >&2; exit 1 ;;
      esac
    fi
    if ! docker compose version >/dev/null 2>&1; then
      case "$ID" in ubuntu|debian) apt-get install -y docker-compose-plugin ;; fedora) dnf install -y docker-compose-plugin ;; *) echo 'Install the Docker Compose plugin, then rerun.' >&2; exit 1 ;; esac
    fi
    systemctl enable --now docker
    ;;
  *) echo 'Unsupported operating system.' >&2; exit 1 ;;
esac
