# Multi-Version Browser Installer

Three files that work together to install pinned versions of official Chrome, Firefox, Edge, Opera, and Brave side-by-side, each isolated in its own folder. Edge and Opera use vendor versions aligned to the same Chromium major milestones.

## Files

- **`versions.json`** — your config. Edit this to change which versions get downloaded.
- **`download-browsers.ps1`** — Windows PowerShell installer.
- **`download-browsers.sh`** — macOS bash installer.

## Setup

1. Put all three files in the same folder.
2. Edit `versions.json` to list the browser versions you want.
3. Run the script for your OS (see below).

## Windows usage

Open PowerShell in the folder with the files:

```powershell
# Default: installs everything to C:\browsers
.\download-browsers.ps1

# Custom root
.\download-browsers.ps1 -Root "D:\testing\browsers"

# Only certain browsers
.\download-browsers.ps1 -Browsers chrome,firefox

# Different config file
.\download-browsers.ps1 -ConfigPath ".\versions-legacy.json"

# Skip updating ..\browser-paths.properties
.\download-browsers.ps1 -NoBrowserPaths
```

If PowerShell blocks the script, run once:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

**Recommended:** install 7-Zip first — it's needed for clean Edge MSI extraction and faster Firefox/Opera/Brave extraction.
```powershell
winget install 7zip.7zip
```

## macOS usage

Open Terminal in the folder with the files:

```bash
# Make executable (first time only)
chmod +x download-browsers.sh

# Default: installs everything to ~/browsers
./download-browsers.sh

# Custom root
./download-browsers.sh --root ~/work/browsers

# Only certain browsers
./download-browsers.sh --browsers chrome,firefox

# Different config file
./download-browsers.sh --config ./versions-legacy.json
```

**Required:** install `jq`:
```bash
brew install jq
```

The script auto-detects Apple Silicon vs Intel and pulls the right architecture.

## Editing `versions.json`

Only the `browsers` object matters — the `_comment` and `_format` keys are documentation. Add or remove versions freely:

```json
{
  "browsers": {
    "chrome":  ["140.0.7339.186", "141.0.7390.55"],
    "firefox": ["120.0", "125.0.3"],
    "edge":    [],
    "opera":   [],
    "brave":   ["1.66.115"]
  }
}
```

Empty arrays are fine — that browser just gets skipped.

## What gets installed where

```
<root>/
├── chrome/
│   └── 148.0.7778.97/     ← official Chrome for Testing
├── firefox/
│   ├── 115.0/
│   ├── 120.0/
│   └── 125.0.3/
├── edge/
│   └── ...
├── opera/
└── brave/
```

On macOS each version folder contains a `.app` bundle. On Windows each contains the unpacked browser binaries (`chrome.exe`, `firefox.exe`, etc.).

On Windows, the installer refreshes `..\browser-paths.properties` with executable paths found under the install root unless you pass `-NoBrowserPaths`.

## Wiring up to Playwright

Once installed, point Playwright at the binaries:

```javascript
// playwright.config.js
const path = require('path');
const versions = require('./versions.json').browsers;

const projects = [];
const root = process.platform === 'win32' ? 'C:\\browsers' : `${process.env.HOME}/browsers`;

for (const v of versions.chrome) {
  const exe = process.platform === 'win32'
    ? path.join(root, 'chrome', v, 'chrome.exe')
    : path.join(root, 'chrome', v, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  projects.push({
    name: `chrome-${v}`,
    use: { browserName: 'chromium', launchOptions: { executablePath: exe } }
  });
}

for (const v of versions.firefox) {
  const exe = process.platform === 'win32'
    ? path.join(root, 'firefox', v, 'firefox.exe')
    : path.join(root, 'firefox', v, 'Firefox.app', 'Contents', 'MacOS', 'firefox');
  projects.push({
    name: `firefox-${v}`,
    use: { browserName: 'firefox', launchOptions: { executablePath: exe } }
  });
}

module.exports = { projects };
```

Run all your tests against every version:
```bash
npx playwright test
```

Or just one:
```bash
npx playwright test --project=chromium-125.0.6422.112
```

## Caveats

- **Chrome, Edge, and Opera versioning differs.** The `chrome` key downloads official Chrome for Testing from Google. Edge and Opera do not use Chrome's exact full version numbers, so they are matched by Chromium major version.
- **Edge URL pattern can break.** Microsoft sometimes restructures their download mirrors. If the script can't find a version, the warning message tells you where to download manually.
- **Old versions may 404.** Vendors prune very old builds eventually. Opera typically keeps ~3 years; Firefox keeps everything; Brave keeps everything on GitHub.
- **First run is slow.** Each version is 100-200 MB compressed; expect 5-10 minutes for a full install of 15-20 versions on a decent connection.
- **Each install is self-contained.** Deleting a version folder fully removes that version. Nothing is registered with the OS.
