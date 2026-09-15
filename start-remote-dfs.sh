#!/usr/bin/env bash
set -euo pipefail

browsers=""
lobs=""
release_version=""
sync_repo=""
autostash=""
install_browsers=""
skip_interactions=""
headless=""
log_root="logs/remote-runs"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --browsers)
            browsers="$2"
            shift 2
            ;;
        --lobs)
            lobs="$2"
            shift 2
            ;;
        --release-version)
            release_version="$2"
            shift 2
            ;;
        --sync)
            sync_repo=1
            shift
            ;;
        --autostash)
            autostash=1
            shift
            ;;
        --install-browsers)
            install_browsers=1
            shift
            ;;
        --skip-interactions)
            skip_interactions=1
            shift
            ;;
        --headless)
            headless=1
            shift
            ;;
        --log-root)
            log_root="$2"
            shift 2
            ;;
        -h|--help)
            sed -n '2,56p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "This script must be run from inside the dfsScripts Git repository." >&2
    exit 1
}
cd "$repo_root"

timestamp="$(date +%Y%m%d-%H%M%S)"
log_dir="$repo_root/$log_root"
mkdir -p "$log_dir"
log_path="$log_dir/dfs-$timestamp.log"
pid_path="$log_dir/dfs-$timestamp.pid"
run_script="$log_dir/dfs-$timestamp-run.sh"

{
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf 'cd %q\n' "$repo_root"

    if [[ -n "$sync_repo" ]]; then
        if [[ -n "$autostash" ]]; then
            echo './sync-git.sh --autostash'
        else
            echo './sync-git.sh'
        fi
    fi

    if [[ -n "$install_browsers" ]]; then
        installer_browsers="${browsers:-chrome,opera}"
        printf './browser-installer/download-browsers.sh --browsers %q\n' "$installer_browsers"
    fi

    [[ -n "$browsers" ]] && printf 'export BROWSERS=%q\n' "$browsers"
    [[ -n "$lobs" ]] && printf 'export LOBS=%q\n' "$lobs"
    [[ -n "$release_version" ]] && printf 'export RELEASE_VERSION=%q\n' "$release_version"
    [[ -n "$skip_interactions" ]] && echo 'export PERFORM_INTERACTION_SCENARIO_TESTS=false'
    [[ -n "$headless" ]] && echo 'export HEADLESS=true'

    echo 'npm run dfs:test'
} > "$run_script"

chmod +x "$run_script"
nohup "$run_script" > "$log_path" 2>&1 &
pid="$!"
echo "$pid" > "$pid_path"

echo "Started DFS remote run."
echo "PID: $pid"
echo "Log: $log_path"
echo "PID file: $pid_path"
echo "Watch log: tail -f '$log_path'"
