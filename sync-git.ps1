param(
    [switch]$Autostash,
    [switch]$Push
)

$ErrorActionPreference = 'Stop'

function Run-Git {
    param([string[]]$Arguments)

    Write-Host "git $($Arguments -join ' ')"
    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

$repoRoot = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) {
    throw "This script must be run from inside a Git repository."
}

Set-Location $repoRoot

$branch = (& git branch --show-current).Trim()
if (-not $branch) {
    throw "Detached HEAD is not supported by this sync script."
}

$upstream = (& git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $upstream) {
    $candidate = "origin/$branch"
    & git show-ref --verify --quiet "refs/remotes/$candidate"
    if ($LASTEXITCODE -ne 0) {
        throw "No upstream is configured for '$branch', and '$candidate' does not exist."
    }
    Run-Git -Arguments @('branch', '--set-upstream-to', $candidate, $branch)
    $upstream = $candidate
}

$status = (& git status --porcelain)
if ($status -and -not $Autostash) {
    Write-Host "Local changes are present. Re-run with -Autostash to sync with git pull --rebase --autostash."
    & git status --short
    exit 1
}

Run-Git -Arguments @('fetch', '--prune')

$pullArgs = @('pull', '--rebase')
if ($Autostash) {
    $pullArgs += '--autostash'
}
Run-Git -Arguments $pullArgs

if ($Push) {
    Run-Git -Arguments @('push')
}

Run-Git -Arguments @('status', '--short', '--branch')
