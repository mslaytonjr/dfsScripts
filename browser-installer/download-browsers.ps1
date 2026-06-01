<#
.SYNOPSIS
  Downloads multiple versions of official Chrome, Chromium, Firefox, Edge, Opera, and Brave
  into a structured browsers/ directory tree on Windows.

.DESCRIPTION
  Reads versions.json (in the same folder as this script by default) and
  for each browser/version pair downloads the appropriate installer or
  archive into <Root>\<browser>\<version>\.

  Examples:
    .\download-browsers.ps1
    .\download-browsers.ps1 -Root "D:\browsers"
    .\download-browsers.ps1 -Browsers chrome,firefox
    .\download-browsers.ps1 -ConfigPath ".\versions-legacy.json"

.PARAMETER Root
  Root install directory. Defaults to C:\browsers.

.PARAMETER ConfigPath
  Path to the versions JSON config. Defaults to .\versions.json next to the script.

.PARAMETER Browsers
  Comma-separated list of browsers to install. Defaults to all five.
  Valid values: chrome, firefox, edge, opera, brave

.NOTES
  - "chrome" downloads official Chrome for Testing builds from Google.
  - Edge downloads the Enterprise MSI and extracts it without running the
    installer, so each version stays self-contained in its folder.
  - 7-Zip is recommended (used for MSI extraction). Install from 7-zip.org
    or via winget: winget install 7zip.7zip
#>

param(
    [string]$Root = "C:\browsers",
    [string]$ConfigPath = "",
    [string[]]$Browsers = @('chrome','firefox','edge','opera','brave'),
    [switch]$NoBrowserPaths
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Browsers = @(
    foreach ($browserValue in $Browsers) {
        foreach ($browserName in ($browserValue -split ',')) {
            $trimmed = $browserName.Trim()
            if ($trimmed) { $trimmed }
        }
    }
)

# ---------- helpers ----------

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Info($m) { Write-Host "    $m" -ForegroundColor Gray }
function Write-Ok($m)   { Write-Host "    OK: $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "    WARN: $m" -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "    ERROR: $m" -ForegroundColor Red }

function ConvertTo-VersionOrNull {
    param([string]$Value)
    try {
        return [version]$Value
    } catch {
        return $null
    }
}

function Resolve-EdgeVersionForChromeMajor {
    param([string]$Major)

    try {
        if (-not $script:EdgeProductsCache) {
            $script:EdgeProductsCache = Invoke-RestMethod -Uri "https://edgeupdates.microsoft.com/api/products" -UseBasicParsing
        }

        $stable = $script:EdgeProductsCache | Where-Object { $_.Product -eq 'Stable' } | Select-Object -First 1
        if (-not $stable) { return $null }

        $release = $stable.Releases |
            Where-Object {
                $_.ProductVersion -like "$Major.*" -and
                $_.Platform -eq 'Windows' -and
                $_.Architecture -eq 'x64'
            } |
            Sort-Object { ConvertTo-VersionOrNull $_.ProductVersion } -Descending |
            Select-Object -First 1

        if ($release) { return [string]$release.ProductVersion }
    } catch {
        Write-Warn "Could not resolve Edge version for Chromium/Chrome major $Major from Microsoft update API: $_"
    }

    return $null
}

function Get-OperaChromiumMajorOffset {
    param($Map)

    if (-not $Map) { return $null }

    $offsetCounts = @{}
    foreach ($property in $Map.PSObject.Properties) {
        $chromeMajor = 0
        if (-not [int]::TryParse($property.Name, [ref]$chromeMajor)) { continue }

        $operaVersion = [string]$property.Value
        if ($operaVersion -notmatch '^(\d+)\.') { continue }

        $operaMajor = [int]$Matches[1]
        $offset = $chromeMajor - $operaMajor
        if ($offset -lt 5 -or $offset -gt 30) { continue }

        $key = [string]$offset
        if (-not $offsetCounts.ContainsKey($key)) { $offsetCounts[$key] = 0 }
        $offsetCounts[$key] += 1
    }

    if ($offsetCounts.Count -eq 0) { return $null }

    return [int](($offsetCounts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key)
}

function Resolve-OperaVersionForChromeMajor {
    param(
        [string]$Major,
        $Map
    )

    try {
        $offset = Get-OperaChromiumMajorOffset $Map
        if ($null -eq $offset) {
            Write-Warn "Could not infer Opera-to-Chromium major offset from existing alignment table"
            return $null
        }

        $operaMajor = [int]$Major - $offset
        if ($operaMajor -le 0) { return $null }

        if (-not $script:OperaDesktopIndexCache) {
            $script:OperaDesktopIndexCache = (Invoke-WebRequest -Uri "https://get.opera.com/pub/opera/desktop/" -UseBasicParsing).Content
        }

        $versions = [regex]::Matches($script:OperaDesktopIndexCache, 'href="(?<version>\d+\.\d+\.\d+\.\d+)/"') |
            ForEach-Object { $_.Groups['version'].Value } |
            Where-Object { $_ -like "$operaMajor.*" } |
            Sort-Object { ConvertTo-VersionOrNull $_ } -Descending

        return $versions | Select-Object -First 1
    } catch {
        Write-Warn "Could not resolve Opera version for Chromium/Chrome major $Major from Opera package index: $_"
    }

    return $null
}

function Resolve-AlignedBrowserVersion {
    param(
        [string]$Browser,
        [string]$ChromeMajor,
        $Map
    )

    switch ($Browser) {
        'edge'  { return Resolve-EdgeVersionForChromeMajor $ChromeMajor }
        'opera' { return Resolve-OperaVersionForChromeMajor -Major $ChromeMajor -Map $Map }
        default { return $null }
    }
}

function Get-ConfiguredVersions {
    param([string]$Browser)

    $alignment = $config._chromium_alignment
    $map = $null
    if ($alignment) {
        $map = $alignment.PSObject.Properties[$Browser]
    }

    if ($map) {
        $sourceVersions = @($versions.chrome)
        $mappedVersions = [System.Collections.Generic.List[string]]::new()
        $seen = [System.Collections.Generic.HashSet[string]]::new()

        foreach ($sourceVersion in $sourceVersions) {
            $major = ($sourceVersion -split '\.')[0]
            $mappedProperty = $map.Value.PSObject.Properties[$major]
            if (-not $mappedProperty -or -not $mappedProperty.Value) {
                $resolvedVersion = Resolve-AlignedBrowserVersion -Browser $Browser -ChromeMajor $major -Map $map.Value
                if (-not $resolvedVersion) {
                    Write-Warn "No $Browser mapping configured or resolved for Chromium/Chrome major $major from $sourceVersion"
                    continue
                }

                Write-Info "Resolved $Browser $resolvedVersion for Chromium/Chrome major $major"
                $mappedVersion = [string]$resolvedVersion
            } else {
                $mappedVersion = [string]$mappedProperty.Value
            }

            if ($seen.Add($mappedVersion)) {
                $mappedVersions.Add($mappedVersion)
            }
        }

        return $mappedVersions.ToArray()
    }

    return @($versions.$Browser)
}

function Download-File {
    param([string]$Url, [string]$Dest)
    Write-Info "Downloading $Url"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
        return $true
    } catch {
        Write-Err "Download failed: $_"
        return $false
    }
}

function Resolve-EdgeMsiUrl {
    param([string]$Version)

    try {
        $products = Invoke-RestMethod -Uri "https://edgeupdates.microsoft.com/api/products" -UseBasicParsing
        $stable = $products | Where-Object { $_.Product -eq 'Stable' } | Select-Object -First 1
        if (-not $stable) { return $null }

        foreach ($release in $stable.Releases) {
            if ($release.ProductVersion -ne $Version) { continue }
            if ($release.Platform -ne 'Windows') { continue }
            if ($release.Architecture -ne 'x64') { continue }

            $artifact = $release.Artifacts |
                Where-Object { $_.ArtifactName -eq 'msi' -and $_.Location -like '*MicrosoftEdgeEnterpriseX64.msi' } |
                Select-Object -First 1
            if ($artifact) { return $artifact.Location }
        }
    } catch {
        Write-Warn "Could not query Microsoft Edge update metadata: $_"
    }

    return $null
}

function Find-EdgeExecutableInExtractedMsi {
    param([string]$ExtractDir)

    $found = Get-ChildItem $ExtractDir -Recurse -Filter "msedge.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found }

    $cabFiles = Get-ChildItem $ExtractDir -Recurse -Filter "*.cab" -ErrorAction SilentlyContinue
    foreach ($cab in $cabFiles) {
        $cabExtractDir = Join-Path $cab.Directory.FullName "$($cab.BaseName)-cab"
        Remove-Item $cabExtractDir -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $cabExtractDir -Force | Out-Null

        Write-Info "Extracting nested CAB $($cab.Name)"
        & $sevenZip x $cab.FullName "-o$cabExtractDir" -y | Out-Null

        $found = Get-ChildItem $cabExtractDir -Recurse -Filter "msedge.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found }
    }

    return $null
}

function Copy-EdgePayload {
    param(
        [System.IO.FileInfo]$FoundExe,
        [string]$Destination
    )

    $sourceDir = $FoundExe.Directory.FullName
    Get-ChildItem $sourceDir | Move-Item -Destination $Destination -Force
}

function Get-7Zip {
    $candidates = @(
        "C:\Program Files\7-Zip\7z.exe",
        "C:\Program Files (x86)\7-Zip\7z.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Test-BrowserInstalled {
    param(
        [string]$ExePath,
        [string]$ExpectedVersion,
        [string]$Name
    )

    if (-not (Test-Path $ExePath)) { return $false }

    try {
        $item = Get-Item $ExePath
        $actualVersion = $item.VersionInfo.ProductVersion
        if (-not $actualVersion) { $actualVersion = $item.VersionInfo.FileVersion }
        if (-not $actualVersion) {
            Write-Ok "$Name $ExpectedVersion already installed"
            return $true
        }

        if ($actualVersion -like "$ExpectedVersion*") {
            Write-Ok "$Name $ExpectedVersion already installed"
            return $true
        }

        Write-Warn "$Name executable found at $ExePath but version is $actualVersion, expected $ExpectedVersion; reinstalling"
        return $false
    } catch {
        Write-Warn "$Name executable found at $ExePath but version could not be verified: $_"
        Write-Ok "$Name $ExpectedVersion already installed"
        return $true
    }
}

function Get-InstalledBrowserExecutables {
    $patterns = [ordered]@{
        chrome                  = 'chrome\*\chrome.exe'
        firefox                 = 'firefox\*\firefox.exe'
        edge                    = 'edge\*\msedge.exe'
        opera                   = 'opera\*\opera.exe'
        brave                   = 'brave\*\brave.exe'
    }

    $found = [ordered]@{}
    foreach ($key in $patterns.Keys) {
        $paths = Get-ChildItem -Path (Join-Path $Root $patterns[$key]) -ErrorAction SilentlyContinue |
            Sort-Object FullName |
            ForEach-Object { $_.FullName }
        if ($paths -and $paths.Count -gt 0) {
            $found[$key] = ($paths -join ';')
        }
    }
    return $found
}

function Update-BrowserPathsFile {
    if ($NoBrowserPaths) {
        Write-Info "Skipping browser-paths.properties update because -NoBrowserPaths was set"
        return
    }

    $repoRoot = Split-Path -Parent $scriptDir
    $pathsFile = Join-Path $repoRoot "browser-paths.properties"
    $managed = Get-InstalledBrowserExecutables
    if ($managed.Count -eq 0) {
        Write-Warn "No managed browser executables found under $Root; browser-paths.properties not updated"
        return
    }

    $existing = [ordered]@{}
    if (Test-Path $pathsFile) {
        foreach ($line in Get-Content $pathsFile) {
            $trimmed = $line.Trim()
            if (-not $trimmed -or $trimmed.StartsWith('#') -or $trimmed -notmatch '[:=]') { continue }
            $parts = $trimmed -split '[:=]', 2
            $existing[$parts[0].Trim()] = $parts[1].Trim()
        }
    }

    foreach ($key in $managed.Keys) {
        $existing[$key] = $managed[$key]
    }

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("# Browser executable paths used by index.js")
    $lines.Add("# Managed browser paths below are refreshed by browser-installer\download-browsers.ps1.")
    $lines.Add("# Multiple candidates per key are separated with semicolons.")
    $lines.Add("")
    foreach ($key in $existing.Keys) {
        $lines.Add("$key=$($existing[$key])")
    }

    $lines | Out-File $pathsFile -Encoding utf8
    Write-Ok "Updated $pathsFile"
}

# ---------- load config ----------

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ConfigPath) { $ConfigPath = Join-Path $scriptDir "versions.json" }
if (-not (Test-Path $ConfigPath)) {
    Write-Err "Config not found: $ConfigPath"
    exit 1
}

Write-Step "Loading config from $ConfigPath"
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$versions = $config.browsers
if (-not $versions) {
    Write-Err "Config missing 'browsers' object. See sample versions.json."
    exit 1
}

# ---------- prep ----------

New-Item -ItemType Directory -Path $Root -Force | Out-Null
Write-Step "Installing to $Root"

$sevenZip = Get-7Zip
if ($sevenZip) { Write-Info "7-Zip found: $sevenZip" }
else { Write-Warn "7-Zip not found. Edge MSI extraction will fail without it. Install: winget install 7zip.7zip" }

$tempDir = Join-Path $env:TEMP "browser-downloads"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

# ---------- official Chrome ----------

function Install-ChromeOfficial($version) {
    $dest = Join-Path $Root "chrome\$version"
    if (Test-BrowserInstalled (Join-Path $dest "chrome.exe") $version "Chrome") { return }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    $zipUrl = "https://storage.googleapis.com/chrome-for-testing-public/$version/win64/chrome-win64.zip"
    $zipPath = Join-Path $tempDir "chrome-$version.zip"
    if (-not (Download-File $zipUrl $zipPath)) {
        Write-Warn "Official Chrome for Testing $version is not available at the expected Google URL."
        Write-Warn "Check versions at https://googlechromelabs.github.io/chrome-for-testing/"
        return
    }

    Write-Info "Extracting to $dest"
    Expand-Archive -Path $zipPath -DestinationPath $dest -Force
    $inner = Join-Path $dest "chrome-win64"
    if (Test-Path $inner) {
        Get-ChildItem $inner | Move-Item -Destination $dest -Force
        Remove-Item $inner -Force -Recurse
    }
    Remove-Item $zipPath -Force

    if (Test-Path (Join-Path $dest "chrome.exe")) {
        Write-Ok "Chrome $version installed"
    } else {
        Write-Err "Chrome $version extraction failed"
    }
}

# ---------- Firefox ----------

function Install-Firefox($version) {
    $dest = Join-Path $Root "firefox\$version"
    if (Test-BrowserInstalled (Join-Path $dest "firefox.exe") $version "Firefox") { return }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    # Mozilla provides per-version installers; the "Setup" exe is a 7-Zip SFX
    $url = "https://ftp.mozilla.org/pub/firefox/releases/$version/win64/en-US/Firefox%20Setup%20$version.exe"
    $exePath = Join-Path $tempDir "firefox-$version.exe"
    if (-not (Download-File $url $exePath)) { return }

    Write-Info "Extracting Firefox installer"
    if ($sevenZip) {
        & $sevenZip x $exePath "-o$dest" -y | Out-Null
        # Firefox SFX puts files under "core/"
        $core = Join-Path $dest "core"
        if (Test-Path $core) {
            Get-ChildItem $core | Move-Item -Destination $dest -Force
            Remove-Item $core -Force -Recurse
        }
        # Cleanup other SFX artifacts
        foreach ($junk in 'setup.exe','setup.ini','optional','localization') {
            $p = Join-Path $dest $junk
            if (Test-Path $p) { Remove-Item $p -Recurse -Force }
        }
    } else {
        # Fallback: silent install with custom path
        Start-Process -FilePath $exePath -ArgumentList "/S","/InstallDirectoryPath=$dest" -Wait
    }

    Remove-Item $exePath -Force
    if (Test-Path (Join-Path $dest "firefox.exe")) {
        Write-Ok "Firefox $version installed"
    } else {
        Write-Err "Firefox $version extraction failed"
    }
}

# ---------- Edge ----------

function Install-Edge($version) {
    $dest = Join-Path $Root "edge\$version"
    if (Test-BrowserInstalled (Join-Path $dest "msedge.exe") $version "Edge") { return }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    if (-not $sevenZip) {
        Write-Err "Edge requires 7-Zip for MSI extraction. Install with: winget install 7zip.7zip"
        return
    }

    $url = Resolve-EdgeMsiUrl $version
    if (-not $url) {
        Write-Warn "No official Microsoft Edge Enterprise x64 MSI URL found for $version."
        Write-Warn "Microsoft may have expired the MSI for this exact version."
        Write-Warn "Check Microsoft Update Catalog for this version:"
        Write-Warn "https://www.catalog.update.microsoft.com/Search.aspx?q=Microsoft%20Edge%20Stable%20Channel%20Version%20$version%20x64"
        return
    }

    $msiPath = Join-Path $tempDir "edge-$version.msi"
    if (-not (Download-File $url $msiPath)) { return }

    $extractDir = Join-Path $tempDir "edge-extract-$version"
    Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

    Write-Info "Extracting MSI with Windows Installer"
    $adminExtractDir = Join-Path $extractDir "admin"
    New-Item -ItemType Directory -Path $adminExtractDir -Force | Out-Null
    $msiArgs = @('/a', $msiPath, '/qn', "TARGETDIR=$adminExtractDir")
    $msiProcess = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru -WindowStyle Hidden
    if ($msiProcess.ExitCode -ne 0) {
        Write-Warn "Windows Installer extraction exited with code $($msiProcess.ExitCode); falling back to 7-Zip"
    }

    $found = Get-ChildItem $adminExtractDir -Recurse -Filter "msedge.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) {
        Write-Info "Extracting MSI with 7-Zip fallback"
        $sevenZipExtractDir = Join-Path $extractDir "7zip"
        New-Item -ItemType Directory -Path $sevenZipExtractDir -Force | Out-Null
        & $sevenZip x $msiPath "-o$sevenZipExtractDir" -y | Out-Null
        $found = Find-EdgeExecutableInExtractedMsi $sevenZipExtractDir
    }

    if ($found) {
        Copy-EdgePayload $found $dest
        Write-Ok "Edge $version installed"
    } else {
        Write-Warn "Could not find msedge.exe in the Edge Enterprise MSI payload."
        Write-Warn "This MSI appears to contain Microsoft Edge Update setup resources, not a portable browser tree."
        Write-Warn "Skipping version-managed Edge $version; use system Edge via -SystemBrowsers edge or install from Microsoft Update Catalog manually."
    }

    Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $msiPath -Force
}

# ---------- Opera ----------

function Install-Opera($version) {
    $dest = Join-Path $Root "opera\$version"
    if (Test-BrowserInstalled (Join-Path $dest "opera.exe") $version "Opera") { return }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    # Opera publishes autoupdate packages as zip-like .exe; the "Opera_<ver>_Setup.exe"
    # is an installer, but the autoupdate-packed zip works for portable extraction.
    $url = "https://get.geo.opera.com/pub/opera/desktop/$version/win/Opera_${version}_Setup_x64.exe"
    $exePath = Join-Path $tempDir "opera-$version.exe"
    if (-not (Download-File $url $exePath)) { return }

    if ($sevenZip) {
        Write-Info "Extracting Opera installer"
        & $sevenZip x $exePath "-o$dest" -y | Out-Null
        # Opera installer contains opera.7z inside; extract that too if present
        $innerArchive = Get-ChildItem $dest -Filter "*.7z" -Recurse | Select-Object -First 1
        if ($innerArchive) {
            & $sevenZip x $innerArchive.FullName "-o$dest" -y | Out-Null
            Remove-Item $innerArchive.FullName -Force
        }
        Write-Ok "Opera $version installed"
    } else {
        Write-Warn "7-Zip not found; running Opera installer with custom path"
        Start-Process -FilePath $exePath -ArgumentList "/silent","/allusers=0","/launchopera=0","/setdefaultbrowser=0","/installfolder=$dest" -Wait
    }
    Remove-Item $exePath -Force
}

# ---------- Brave ----------

function Install-Brave($version) {
    $dest = Join-Path $Root "brave\$version"
    if (Test-BrowserInstalled (Join-Path $dest "brave.exe") $version "Brave") { return }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    # Brave publishes standalone installers on GitHub releases
    $url = "https://github.com/brave/brave-browser/releases/download/v$version/BraveBrowserStandaloneSilentSetup.exe"
    $exePath = Join-Path $tempDir "brave-$version.exe"
    if (-not (Download-File $url $exePath)) { return }

    if ($sevenZip) {
        Write-Info "Extracting Brave installer"
        $extractDir = Join-Path $tempDir "brave-extract-$version"
        Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        & $sevenZip x $exePath "-o$extractDir" -y | Out-Null
        # Look for chrome.7z or similar inside
        $inner = Get-ChildItem $extractDir -Filter "*.7z" -Recurse | Select-Object -First 1
        if ($inner) {
            & $sevenZip x $inner.FullName "-o$dest" -y | Out-Null
            # Brave inner archive extracts to "Chrome-bin\<version>\" structure
            $chromeBin = Join-Path $dest "Chrome-bin"
            if (Test-Path $chromeBin) {
                $verFolder = Get-ChildItem $chromeBin | Select-Object -First 1
                if ($verFolder) {
                    Get-ChildItem $verFolder.FullName | Move-Item -Destination $dest -Force
                    Remove-Item $chromeBin -Recurse -Force
                }
            }
        }
        Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok "Brave $version installed"
    } else {
        Write-Warn "7-Zip required for clean Brave extraction; skipping $version"
    }
    Remove-Item $exePath -Force
}

# ---------- main ----------

foreach ($browser in $Browsers) {
    Write-Step "Installing $browser"
    $list = Get-ConfiguredVersions $browser
    if (-not $list) {
        Write-Warn "No versions configured for $browser"
        continue
    }
    foreach ($v in $list) {
        switch ($browser) {
            'chrome'                { Install-ChromeOfficial $v }
            'firefox'               { Install-Firefox        $v }
            'edge'                  { Install-Edge           $v }
            'opera'                 { Install-Opera          $v }
            'brave'                 { Install-Brave          $v }
            default                 { Write-Warn "Unknown browser: $browser" }
        }
    }
}

Write-Step "Done. Browsers installed under $Root"
Write-Info "Verify with: Get-ChildItem $Root -Recurse -Include *.exe -Depth 3"
Update-BrowserPathsFile
