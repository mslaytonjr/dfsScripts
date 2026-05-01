#!/usr/bin/env bash
#
# download-browsers.sh — Download multiple versions of official Chrome, Chromium,
# Firefox, Edge, Opera, and Brave into a structured browsers/ directory tree on macOS.
#
# Reads versions.json (in the same folder by default) and for each browser/
# version pair downloads the appropriate package into <root>/<browser>/<version>/.
#
# Usage:
#   ./download-browsers.sh
#   ./download-browsers.sh --root ~/work/browsers
#   ./download-browsers.sh --browsers chrome,firefox
#   ./download-browsers.sh --config ./versions-legacy.json
#
# Requirements:
#   - jq        (brew install jq)
#   - curl      (preinstalled)
#   - hdiutil   (preinstalled, used for .dmg)
#   - pkgutil   (preinstalled, used for Edge .pkg)
#
# Notes:
#   - "chrome" downloads official Chrome for Testing builds from Google.
#   - On Apple Silicon we grab arm64 builds where available; falls back to x64
#     under Rosetta where the vendor doesn't publish arm64 for that version.
#   - Each version is self-contained in its folder as a .app bundle, so they
#     won't conflict with each other or with system-installed browsers.

set -uo pipefail

# ---------- defaults ----------

ROOT="$HOME/browsers"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$SCRIPT_DIR/versions.json"
BROWSERS="chrome,firefox,edge,opera,brave"
NO_BROWSER_PATHS=""

# ---------- arg parsing ----------

while [[ $# -gt 0 ]]; do
    case "$1" in
        --root)              ROOT="$2"; shift 2 ;;
        --config)            CONFIG_PATH="$2"; shift 2 ;;
        --browsers)          BROWSERS="$2"; shift 2 ;;
        --no-browser-paths)  NO_BROWSER_PATHS=1; shift ;;
        -h|--help)
            sed -n '2,28p' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ---------- helpers ----------

c_cyan="\033[36m"; c_gray="\033[90m"; c_green="\033[32m"; c_yellow="\033[33m"; c_red="\033[31m"; c_reset="\033[0m"
step() { printf "${c_cyan}==> %s${c_reset}\n" "$*"; }
info() { printf "${c_gray}    %s${c_reset}\n" "$*"; }
ok()   { printf "${c_green}    OK: %s${c_reset}\n" "$*"; }
warn() { printf "${c_yellow}    WARN: %s${c_reset}\n" "$*"; }
err()  { printf "${c_red}    ERROR: %s${c_reset}\n" "$*"; }

require() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "Required tool not found: $1"
        [[ -n "${2:-}" ]] && info "Install with: $2"
        exit 1
    fi
}

download() {
    local url="$1" dest="$2"
    info "Downloading $url"
    if curl -fL --progress-bar -o "$dest" "$url"; then
        return 0
    else
        err "Download failed for $url"
        return 1
    fi
}

# ---------- preflight ----------

require jq "brew install jq"
require curl ""
require hdiutil ""

if [[ ! -f "$CONFIG_PATH" ]]; then
    err "Config not found: $CONFIG_PATH"
    exit 1
fi

step "Loading config from $CONFIG_PATH"
mkdir -p "$ROOT"
step "Installing to $ROOT"

ARCH="$(uname -m)"  # arm64 or x86_64
info "Detected architecture: $ARCH"

TEMP_DIR="$(mktemp -d -t browser-downloads)"
trap 'rm -rf "$TEMP_DIR"' EXIT

# Helper: read array of versions for a browser key
versions_for() {
    jq -r ".browsers.\"$1\"[]?" "$CONFIG_PATH"
}

# Helper: mount a dmg, copy the .app out, unmount
copy_app_from_dmg() {
    local dmg="$1" dest_dir="$2"
    local mount_point
    mount_point="$(mktemp -d -t dmg-mount)"
    if ! hdiutil attach -nobrowse -quiet -mountpoint "$mount_point" "$dmg"; then
        err "Failed to mount $dmg"
        return 1
    fi
    local app
    app="$(find "$mount_point" -maxdepth 2 -name "*.app" -type d | head -n 1)"
    if [[ -z "$app" ]]; then
        err "No .app found in $dmg"
        hdiutil detach -quiet "$mount_point" || true
        return 1
    fi
    info "Copying $(basename "$app") to $dest_dir"
    cp -R "$app" "$dest_dir/"
    hdiutil detach -quiet "$mount_point" || true
    return 0
}

# ---------- official Chrome ----------

install_chrome_official() {
    local version="$1"
    local dest="$ROOT/chrome/$version"
    if find "$dest" -maxdepth 4 -name "Google Chrome for Testing.app" -type d 2>/dev/null | grep -q .; then
        ok "Chrome $version already installed"
        return
    fi
    mkdir -p "$dest"

    local platform="mac-x64"
    [[ "$ARCH" == "arm64" ]] && platform="mac-arm64"

    local zip_url="https://storage.googleapis.com/chrome-for-testing-public/$version/$platform/chrome-$platform.zip"
    local zip_path="$TEMP_DIR/chrome-$version.zip"
    if ! download "$zip_url" "$zip_path"; then
        warn "Official Chrome for Testing $version is not available at the expected Google URL."
        warn "Check versions at https://googlechromelabs.github.io/chrome-for-testing/"
        return
    fi

    info "Extracting Chrome"
    unzip -q "$zip_path" -d "$dest"
    local inner="$dest/chrome-$platform"
    if [[ -d "$inner" ]]; then
        shopt -s dotglob nullglob
        mv "$inner"/* "$dest/"
        shopt -u dotglob nullglob
        rmdir "$inner" 2>/dev/null || true
    fi
    rm -f "$zip_path"
    ok "Chrome $version installed at $dest"
}

# ---------- Chromium ----------

# ---------- Firefox ----------

install_firefox() {
    local version="$1"
    local dest="$ROOT/firefox/$version"
    if [[ -d "$dest/Firefox.app" ]]; then
        ok "Firefox $version already installed"
        return
    fi
    mkdir -p "$dest"

    # Mozilla publishes universal .dmg per version
    local url="https://ftp.mozilla.org/pub/firefox/releases/$version/mac/en-US/Firefox%20$version.dmg"
    local dmg_path="$TEMP_DIR/firefox-$version.dmg"
    if ! download "$url" "$dmg_path"; then
        return
    fi

    if copy_app_from_dmg "$dmg_path" "$dest"; then
        ok "Firefox $version installed"
    fi
    rm -f "$dmg_path"
}

# ---------- Edge ----------

install_edge() {
    local version="$1"
    local dest="$ROOT/edge/$version"
    if [[ -d "$dest/Microsoft Edge.app" ]]; then
        ok "Edge $version already installed"
        return
    fi
    mkdir -p "$dest"

    # Microsoft publishes .pkg files via the Edge Enterprise download.
    # Direct per-version URLs aren't documented; the most reliable path is
    # the osdn mirror used by Edge auto-update.
    local pkg_url="https://msedge.sf.dl.osdn.net/msedge/$version/MicrosoftEdge-$version.pkg"
    local pkg_path="$TEMP_DIR/edge-$version.pkg"
    if ! download "$pkg_url" "$pkg_path"; then
        warn "Edge $version pkg not available at expected URL."
        warn "Download manually from https://www.microsoft.com/en-us/edge/business/download"
        warn "and place at $pkg_path then rerun, or extract a .pkg yourself with:"
        warn "  pkgutil --expand-full <pkg> <out>"
        return
    fi

    info "Expanding pkg"
    local expand_dir="$TEMP_DIR/edge-expand-$version"
    rm -rf "$expand_dir"
    if ! pkgutil --expand-full "$pkg_path" "$expand_dir" 2>/dev/null; then
        err "pkgutil --expand-full failed for Edge $version"
        return
    fi

    local app_path
    app_path="$(find "$expand_dir" -maxdepth 6 -name "Microsoft Edge.app" -type d | head -n 1)"
    if [[ -n "$app_path" ]]; then
        cp -R "$app_path" "$dest/"
        ok "Edge $version installed"
    else
        err "Could not locate Microsoft Edge.app inside expanded pkg"
    fi
    rm -rf "$expand_dir" "$pkg_path"
}

# ---------- Opera ----------

install_opera() {
    local version="$1"
    local dest="$ROOT/opera/$version"
    if [[ -d "$dest/Opera.app" ]]; then
        ok "Opera $version already installed"
        return
    fi
    mkdir -p "$dest"

    # Opera autoupdate dmg
    local url="https://get.geo.opera.com/pub/opera/desktop/$version/mac/Opera_${version}_Setup.dmg"
    local dmg_path="$TEMP_DIR/opera-$version.dmg"
    if ! download "$url" "$dmg_path"; then
        return
    fi

    if copy_app_from_dmg "$dmg_path" "$dest"; then
        ok "Opera $version installed"
    fi
    rm -f "$dmg_path"
}

# ---------- Brave ----------

install_brave() {
    local version="$1"
    local dest="$ROOT/brave/$version"
    if [[ -d "$dest/Brave Browser.app" ]]; then
        ok "Brave $version already installed"
        return
    fi
    mkdir -p "$dest"

    # Brave publishes universal .dmg on GitHub releases
    local arch_suffix="universal"
    # Older releases shipped per-arch; if universal fails, fall back
    local urls=(
        "https://github.com/brave/brave-browser/releases/download/v$version/Brave-Browser-$arch_suffix.dmg"
        "https://github.com/brave/brave-browser/releases/download/v$version/Brave-Browser.dmg"
    )
    [[ "$ARCH" == "arm64" ]] && urls+=("https://github.com/brave/brave-browser/releases/download/v$version/Brave-Browser-arm64.dmg")
    [[ "$ARCH" == "x86_64" ]] && urls+=("https://github.com/brave/brave-browser/releases/download/v$version/Brave-Browser-x64.dmg")

    local dmg_path="$TEMP_DIR/brave-$version.dmg"
    local downloaded=false
    for u in "${urls[@]}"; do
        if download "$u" "$dmg_path"; then downloaded=true; break; fi
    done
    if ! $downloaded; then
        err "Could not find a Brave $version .dmg matching this arch"
        return
    fi

    if copy_app_from_dmg "$dmg_path" "$dest"; then
        ok "Brave $version installed"
    fi
    rm -f "$dmg_path"
}

# ---------- main ----------

IFS=',' read -ra BROWSER_LIST <<< "$BROWSERS"
for browser in "${BROWSER_LIST[@]}"; do
    step "Installing $browser"
    mapfile -t vlist < <(versions_for "$browser")
    if [[ ${#vlist[@]} -eq 0 ]]; then
        warn "No versions configured for $browser"
        continue
    fi
    for v in "${vlist[@]}"; do
        case "$browser" in
            chrome)                install_chrome_official "$v" ;;
            firefox)               install_firefox         "$v" ;;
            edge)                  install_edge            "$v" ;;
            opera)                 install_opera           "$v" ;;
            brave)                 install_brave           "$v" ;;
            *)                     warn "Unknown browser: $browser" ;;
        esac
    done
done

step "Done. Browsers installed under $ROOT"
info "Verify with: find \"$ROOT\" -maxdepth 3 -name '*.app' -type d"
