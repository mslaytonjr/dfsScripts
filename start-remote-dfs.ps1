param(
    [string]$Browsers = "",
    [string]$Lobs = "",
    [string]$ReleaseVersion = "",
    [string]$ExpectedDfsE8 = "",
    [string]$PublicTargetUrl = "",
    [string]$SecureTargetUrl = "",
    [string]$ChromeVersions = "150.0.7871.115,151.0.7922.47,151.0.7922.76,152.0.7977.65,152.0.7977.76,152.0.7977.83,152.0.7977.199,153.0.8010.37",
    [string]$InstallBrowserTargets = "chrome",
    [switch]$Sync,
    [switch]$Autostash,
    [switch]$InstallBrowsers,
    [switch]$UpdateChromeVersions,
    [switch]$UpdateEnv,
    [switch]$Qa2Defaults,
    [switch]$SkipInteractionScenarios,
    [switch]$Headless,
    [switch]$Help,
    [string]$LogRoot = "logs\remote-runs"
)

$ErrorActionPreference = 'Stop'

if ($Help) {
    @"
Usage:
  .\start-remote-dfs.ps1 -Qa2Defaults -Sync -Autostash -Browsers chrome,comet -Lobs PUBLIC,SECURE -SkipInteractionScenarios

Options:
  -Qa2Defaults              Set QA2 release/env defaults, update Chrome versions, install Chrome first.
  -Browsers <list>          Browser keys to run in dfs-fingerprint-test.js, such as chrome,comet.
  -Lobs <list>              LOB list to run, such as PUBLIC,SECURE.
  -InstallBrowserTargets    Downloadable browser targets for browser-installer, default chrome.
  -UpdateEnv                Persist selected values into .env.
  -UpdateChromeVersions     Merge the configured Chromium version list into versions.json.
  -Sync -Autostash          Pull latest git changes before the run.
"@
    exit 0
}

$repoRoot = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) {
    throw "This script must be run from inside the dfsScripts Git repository."
}

Set-Location $repoRoot

if ($Qa2Defaults) {
    if (-not $ReleaseVersion) { $ReleaseVersion = "132.0.0-beta.1-QA-2" }
    if (-not $ExpectedDfsE8) { $ExpectedDfsE8 = "11.0.0-beta.1,132.0.0-beta.1" }
    if (-not $PublicTargetUrl) { $PublicTargetUrl = "https://wwwqa3.chase.com" }
    if (-not $SecureTargetUrl) { $SecureTargetUrl = "https://qac2-secure01ea.chase.com" }
    $UpdateChromeVersions = $true
    $UpdateEnv = $true
    $InstallBrowsers = $true
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logDir = Join-Path $repoRoot $LogRoot
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "dfs-$timestamp.log"
$pidPath = Join-Path $logDir "dfs-$timestamp.pid"

$envLines = [System.Collections.Generic.List[string]]::new()
if ($Browsers) { $envLines.Add("`$env:BROWSERS = '$($Browsers.Replace("'", "''"))'") }
if ($Lobs) { $envLines.Add("`$env:LOBS = '$($Lobs.Replace("'", "''"))'") }
if ($ReleaseVersion) { $envLines.Add("`$env:RELEASE_VERSION = '$($ReleaseVersion.Replace("'", "''"))'") }
if ($ExpectedDfsE8) { $envLines.Add("`$env:EXPECTED_DFS_E_8 = '$($ExpectedDfsE8.Replace("'", "''"))'") }
if ($PublicTargetUrl) { $envLines.Add("[Environment]::SetEnvironmentVariable('PUBLIC.TARGET_URL', '$($PublicTargetUrl.Replace("'", "''"))', 'Process')") }
if ($SecureTargetUrl) { $envLines.Add("[Environment]::SetEnvironmentVariable('SECURE.TARGET_URL', '$($SecureTargetUrl.Replace("'", "''"))', 'Process')") }
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

if ($UpdateChromeVersions) {
    $escapedChromeVersions = $ChromeVersions.Replace("'", "''")
    $childScript += @"

    `$versionsPath = Join-Path `$PWD 'browser-installer\versions.json'
    `$config = Get-Content -Raw `$versionsPath | ConvertFrom-Json
    `$existing = @(`$config.browsers.chrome)
    `$merged = [System.Collections.Generic.List[string]]::new()
    foreach (`$version in `$existing) {
        if (`$merged -notcontains [string]`$version) { `$merged.Add([string]`$version) }
    }
    `$newVersions = '$escapedChromeVersions'.Split(',') | ForEach-Object { `$_.Trim() } | Where-Object { `$_ }
    foreach (`$version in `$newVersions) {
        if (`$merged -notcontains `$version) { `$merged.Add(`$version) }
    }
    `$config.browsers.chrome = `$merged.ToArray()
    `$config | ConvertTo-Json -Depth 20 | Set-Content -Path `$versionsPath -Encoding UTF8
"@
}

if ($UpdateEnv) {
    $envUpdates = [System.Collections.Generic.List[string]]::new()
    if ($Browsers) { $envUpdates.Add("@{ Key = 'BROWSERS'; Value = '$($Browsers.Replace("'", "''"))' }") }
    if ($Lobs) { $envUpdates.Add("@{ Key = 'LOBS'; Value = '$($Lobs.Replace("'", "''"))' }") }
    if ($ReleaseVersion) { $envUpdates.Add("@{ Key = 'RELEASE_VERSION'; Value = '$($ReleaseVersion.Replace("'", "''"))' }") }
    if ($ExpectedDfsE8) { $envUpdates.Add("@{ Key = 'EXPECTED_DFS_E_8'; Value = '$($ExpectedDfsE8.Replace("'", "''"))' }") }
    if ($PublicTargetUrl) { $envUpdates.Add("@{ Key = 'PUBLIC.TARGET_URL'; Value = '$($PublicTargetUrl.Replace("'", "''"))' }") }
    if ($SecureTargetUrl) { $envUpdates.Add("@{ Key = 'SECURE.TARGET_URL'; Value = '$($SecureTargetUrl.Replace("'", "''"))' }") }
    if ($SkipInteractionScenarios) { $envUpdates.Add("@{ Key = 'PERFORM_INTERACTION_SCENARIO_TESTS'; Value = 'false' }") }
    if ($Headless) { $envUpdates.Add("@{ Key = 'HEADLESS'; Value = 'true' }") }
    if ($envUpdates.Count -gt 0) {
        $childScript += @"

    `$envPath = Join-Path `$PWD '.env'
    `$updates = @(
        $($envUpdates -join ",`n        ")
    )
    `$lines = [System.Collections.Generic.List[string]]::new()
    if (Test-Path `$envPath) {
        foreach (`$line in Get-Content `$envPath) { [void]`$lines.Add(`$line) }
    }
    foreach (`$update in `$updates) {
        `$pattern = "^\s*`$([regex]::Escape(`$update.Key))\s*="
        `$found = `$false
        for (`$i = 0; `$i -lt `$lines.Count; `$i++) {
            if (`$lines[`$i] -match `$pattern) {
                `$lines[`$i] = "`$(`$update.Key)=`$(`$update.Value)"
                `$found = `$true
                break
            }
        }
        if (-not `$found) { `$lines.Add("`$(`$update.Key)=`$(`$update.Value)") }
    }
    Set-Content -Path `$envPath -Value `$lines -Encoding UTF8
"@
    }
}

if ($InstallBrowsers) {
    $installerBrowsers = $InstallBrowserTargets
    $childScript += @"

    `$installerBrowserTargets = '$($installerBrowsers.Replace("'", "''"))'.Split(',') | ForEach-Object { `$_.Trim() } | Where-Object { `$_ }
    powershell -NoProfile -ExecutionPolicy Bypass -File .\browser-installer\download-browsers.ps1 -Browsers `$installerBrowserTargets
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
