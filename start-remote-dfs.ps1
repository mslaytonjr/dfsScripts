param(
    [string]$Browsers = "",
    [string]$Lobs = "",
    [string]$ReleaseVersion = "",
    [switch]$Sync,
    [switch]$Autostash,
    [switch]$InstallBrowsers,
    [switch]$SkipInteractionScenarios,
    [switch]$Headless,
    [string]$LogRoot = "logs\remote-runs"
)

$ErrorActionPreference = 'Stop'

$repoRoot = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) {
    throw "This script must be run from inside the dfsScripts Git repository."
}

Set-Location $repoRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logDir = Join-Path $repoRoot $LogRoot
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "dfs-$timestamp.log"
$pidPath = Join-Path $logDir "dfs-$timestamp.pid"

$envLines = [System.Collections.Generic.List[string]]::new()
if ($Browsers) { $envLines.Add("`$env:BROWSERS = '$($Browsers.Replace("'", "''"))'") }
if ($Lobs) { $envLines.Add("`$env:LOBS = '$($Lobs.Replace("'", "''"))'") }
if ($ReleaseVersion) { $envLines.Add("`$env:RELEASE_VERSION = '$($ReleaseVersion.Replace("'", "''"))'") }
if ($SkipInteractionScenarios) { $envLines.Add("`$env:PERFORM_INTERACTION_SCENARIO_TESTS = 'false'") }
if ($Headless) { $envLines.Add("`$env:HEADLESS = 'true'") }

$childScript = @"
`$ErrorActionPreference = 'Stop'
Set-Location '$($repoRoot.Replace("'", "''"))'
Start-Transcript -Path '$($logPath.Replace("'", "''"))' -Append
try {
"@

if ($Sync) {
    $autostashArg = if ($Autostash) { " -Autostash" } else { "" }
    $childScript += @"

    .\sync-git.ps1$autostashArg
"@
}

if ($InstallBrowsers) {
    $installerBrowsers = if ($Browsers) { $Browsers } else { "chrome,opera" }
    $childScript += @"

    powershell -NoProfile -ExecutionPolicy Bypass -File .\browser-installer\download-browsers.ps1 -Browsers '$($installerBrowsers.Replace("'", "''"))'
"@
}

if ($envLines.Count -gt 0) {
    $childScript += "`n    " + ($envLines -join "`n    ") + "`n"
}

$childScript += @"

    npm run dfs:test
} finally {
    Stop-Transcript
}
"@

$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
$process = Start-Process powershell `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encodedCommand) `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -PassThru

Set-Content -Path $pidPath -Value $process.Id

Write-Host "Started DFS remote run."
Write-Host "PID: $($process.Id)"
Write-Host "Log: $logPath"
Write-Host "PID file: $pidPath"
Write-Host "Watch log: Get-Content -Wait '$logPath'"
