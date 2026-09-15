#!/usr/bin/env bash
set -euo pipefail

browsers=""
lobs=""
release_version=""
expected_dfs_e8=""
chrome_versions="150.0.7871.115,151.0.7922.47,151.0.7922.76,152.0.7977.65,152.0.7977.76,152.0.7977.83,152.0.7977.199,153.0.8010.37"
install_browser_targets="chrome"
sync_repo=""
autostash=""
install_browsers=""
update_chrome_versions=""
update_env=""
qa2_defaults=""
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
        --expected-dfs-e8)
            expected_dfs_e8="$2"
            shift 2
            ;;
        --chrome-versions)
            chrome_versions="$2"
            shift 2
            ;;
        --install-browser-targets)
            install_browser_targets="$2"
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
        --update-chrome-versions)
            update_chrome_versions=1
            shift
            ;;
        --update-env)
            update_env=1
            shift
            ;;
        --qa2-defaults)
            qa2_defaults=1
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

if [[ -n "$qa2_defaults" ]]; then
    [[ -z "$release_version" ]] && release_version="132.0.0-beta.1-QA-2"
    [[ -z "$expected_dfs_e8" ]] && expected_dfs_e8="11.0.0-beta.1,132.0.0-beta.1"
    update_chrome_versions=1
    update_env=1
    install_browsers=1
fi

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

    if [[ -n "$update_chrome_versions" ]]; then
        printf 'chrome_versions=%q\n' "$chrome_versions"
        cat <<'SCRIPT'
versions_path="browser-installer/versions.json"
tmp_versions="$(mktemp)"
jq --arg versions "$chrome_versions" '
  ($versions | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $newVersions
  | .browsers.chrome = reduce (.browsers.chrome + $newVersions)[] as $version ([]; if index($version) then . else . + [$version] end)
' "$versions_path" > "$tmp_versions"
mv "$tmp_versions" "$versions_path"
SCRIPT
    fi

    if [[ -n "$update_env" ]]; then
        cat <<'SCRIPT'
update_env_value() {
    local key="$1"
    local value="$2"
    local env_path=".env"
    touch "$env_path"
    local tmp_env
    tmp_env="$(mktemp)"
    if grep -Eq "^[[:space:]]*$key[[:space:]]*=" "$env_path"; then
        awk -v key="$key" -v value="$value" '
            $0 ~ "^[[:space:]]*" key "[[:space:]]*=" && !done {
                print key "=" value
                done=1
                next
            }
            { print }
        ' "$env_path" > "$tmp_env"
    else
        cat "$env_path" > "$tmp_env"
        printf '%s=%s\n' "$key" "$value" >> "$tmp_env"
    fi
    mv "$tmp_env" "$env_path"
}
SCRIPT
        [[ -n "$browsers" ]] && printf 'update_env_value BROWSERS %q\n' "$browsers"
        [[ -n "$lobs" ]] && printf 'update_env_value LOBS %q\n' "$lobs"
        [[ -n "$release_version" ]] && printf 'update_env_value RELEASE_VERSION %q\n' "$release_version"
        [[ -n "$expected_dfs_e8" ]] && printf 'update_env_value EXPECTED_DFS_E_8 %q\n' "$expected_dfs_e8"
        [[ -n "$skip_interactions" ]] && echo 'update_env_value PERFORM_INTERACTION_SCENARIO_TESTS false'
        [[ -n "$headless" ]] && echo 'update_env_value HEADLESS true'
    fi

    if [[ -n "$install_browsers" ]]; then
        installer_browsers="$install_browser_targets"
        printf './browser-installer/download-browsers.sh --browsers %q\n' "$installer_browsers"
    fi

    [[ -n "$browsers" ]] && printf 'export BROWSERS=%q\n' "$browsers"
    [[ -n "$lobs" ]] && printf 'export LOBS=%q\n' "$lobs"
    [[ -n "$release_version" ]] && printf 'export RELEASE_VERSION=%q\n' "$release_version"
    [[ -n "$expected_dfs_e8" ]] && printf 'export EXPECTED_DFS_E_8=%q\n' "$expected_dfs_e8"
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
