#!/usr/bin/env bash
set -euo pipefail

autostash=""
push_after=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --autostash)
            autostash=1
            shift
            ;;
        --push)
            push_after=1
            shift
            ;;
        -h|--help)
            sed -n '2,32p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

run_git() {
    echo "git $*"
    git "$@"
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "This script must be run from inside a Git repository." >&2
    exit 1
}
cd "$repo_root"

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
    echo "Detached HEAD is not supported by this sync script." >&2
    exit 1
fi

if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
    candidate="origin/$branch"
    if ! git show-ref --verify --quiet "refs/remotes/$candidate"; then
        echo "No upstream is configured for '$branch', and '$candidate' does not exist." >&2
        exit 1
    fi
    run_git branch --set-upstream-to "$candidate" "$branch"
    upstream="$candidate"
fi

if [[ -n "$(git status --porcelain)" && -z "$autostash" ]]; then
    echo "Local changes are present. Re-run with --autostash to sync with git pull --rebase --autostash." >&2
    git status --short
    exit 1
fi

run_git fetch --prune

pull_args=(pull --rebase)
if [[ -n "$autostash" ]]; then
    pull_args+=(--autostash)
fi
run_git "${pull_args[@]}"

if [[ -n "$push_after" ]]; then
    run_git push
fi

run_git status --short --branch
