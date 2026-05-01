# dfsScripts

Browser download and DFS fingerprint evidence testing scripts.

## Supported Workflow

This repo currently has two primary jobs:

1. Download version-managed browsers into a local browser folder.
2. Run DFS fingerprint validation tests against every executable listed in `browser-paths.properties`.

The current tested Windows download path is official Chrome for Testing and Opera. Firefox and Edge can be run from system-installed paths in `browser-paths.properties`. Edge version mapping exists, but Microsoft's MSI packaging does not currently provide a clean side-by-side browser folder for the mapped versions.

## Requirements

- Node.js 18 or newer
- npm dependencies installed with `npm install`
- Windows PowerShell for `download-browsers.ps1`
- 7-Zip recommended for browser extraction:

```powershell
winget install 7zip.7zip
```

For macOS browser download testing:

```bash
brew install jq
```

## Install Node Dependencies

```powershell
npm install
```

## Configure Browser Versions

Edit:

```text
browser-installer/versions.json
```

The `chrome` list is the source list of Chrome/Chromium versions to test. Opera versions are derived from the Chrome major version through `_chromium_alignment.opera`.

## Download Browsers

Windows:

```powershell
cd C:\GitRepo\dfsScripts\browser-installer
powershell -ExecutionPolicy Bypass -File .\download-browsers.ps1 -Browsers chrome,opera
```

The default install root is:

```text
C:\browsers
```

The downloader refreshes:

```text
browser-paths.properties
```

with any managed browser executable paths it finds under the install root. To skip that update:

```powershell
powershell -ExecutionPolicy Bypass -File .\download-browsers.ps1 -Browsers chrome,opera -NoBrowserPaths
```

macOS, unverified smoke-test path:

```bash
cd browser-installer
chmod +x download-browsers.sh
./download-browsers.sh --browsers chrome,opera --root ~/browsers-test
```

## Browser Paths

The DFS test runner reads every executable listed in:

```text
browser-paths.properties
```

Multiple paths for the same browser are separated with semicolons:

```properties
chrome=C:\browsers\chrome\140.0.7339.186\chrome.exe;C:\browsers\chrome\141.0.7390.55\chrome.exe
opera=C:\browsers\opera\124.0.5705.65\opera.exe
firefox=C:\Program Files\Mozilla Firefox\firefox.exe
edge=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

Spaces in paths are fine. Do not URL-encode local filesystem paths.

`atlas` refers to OpenAI ChatGPT Atlas and is currently macOS-only.

## Configure DFS Test

Create a local `.env` file:

```powershell
copy .env.example .env
```

Minimum required values:

```properties
TARGET_URL=https://your-login-page.example
RELEASE_VERSION=expected_dfs_E_8_value
```

Common options:

```properties
# Leave blank to run every browser key/path in browser-paths.properties.
BROWSERS=chrome,opera,firefox,edge

HEADLESS=false
PERFORM_MOUSE_MOVEMENT=true
SUBMIT_CREDENTIALS=false
FIREFOX_USE_PLAYWRIGHT_BUNDLED=true
EXPECTED_DFS_E7_BIT0=1
POST_LOAD_WAIT_MS=2000
```

Playwright cannot reliably drive stock system Firefox with the protocol it uses. Keep a `firefox=` entry in `browser-paths.properties` to include Firefox in the run, but leave `FIREFOX_USE_PLAYWRIGHT_BUNDLED=true` so the runner launches Playwright's bundled Firefox. Set it to `false` only if you intentionally want to try a system Firefox executable.

If form submission should run:

```properties
SUBMIT_CREDENTIALS=true
LOGIN_USERNAME=
LOGIN_PASSWORD=
USERNAME_SELECTOR=#userId-input-field-input
PASSWORD_SELECTOR=#password-input-field-input
SUBMIT_SELECTOR=#signin-button
LOGIN_REQUEST_MATCHER=/login|auth|signin/i
```

## Run DFS Test

```powershell
cd C:\GitRepo\dfsScripts
npm run dfs:test
```

Inline PowerShell example:

```powershell
$env:TARGET_URL='https://your-login-page.example'
$env:RELEASE_VERSION='expected_dfs_E_8_value'
$env:BROWSERS='chrome,opera'
npm run dfs:test
```

## Evidence Output

Evidence is written to:

```text
evidence/<releaseversion>/<browser>/<browserversion>/
```

Each browser/version run may include:

- `console-log.json`
- `fingerprint-initial.json`
- `fingerprint-after-mouse.json`
- `fingerprint-after-reload.json`
- `cookies-initial.json`
- `cookies-after-submit.json`
- `network-login-request.json`
- `fingerprint-values.txt`
- `summary-report.json`
- `screenshots/*.png`

An aggregate summary is also written to:

```text
evidence/<releaseversion>/summary-report.json
```

## Test Coverage

`dfs-fingerprint-test.js` currently validates:

- Page load and DFS console errors
- `window.FingerprintData.getFingerPrint()` or `getFingerprint()`
- Required DFS cookies on page load
- Cookie-to-fingerprint comparisons
- `dfs_E_6` browser detection format and consistency
- `dfs_E_7` SCAR bit expectations
  - bit 0 defaults to `1` for Playwright-launched webdriver sessions
  - bits 1, 16, 22, 25, 26, and 27 default to `0`
- `dfs_E_1` non-incognito expectation
- `dfs_B*`, `dfs_D*`, `dfs_I*`, `dfs_M*`, and `dfs_N*` payload availability
- Optional mouse movement and `dfs_F_2` comparison
- `dfs_F_1` stability across reload
- Optional login request capture and header/payload comparisons
- `dfs_E_8` comparison to `RELEASE_VERSION` or `EXPECTED_DFS_E_8`

The runner continues through all tests and all configured browser paths even when a test fails. Each result includes:

- `testName`
- `status`
- `details`
- `evidenceFilePaths`
- `errors`

## Validation

Run syntax checks:

```powershell
npm run check
```

## Current File Roles

Required for the current workflow:

```text
package.json
package-lock.json
dfs-fingerprint-test.js
.env.example
browser-paths.properties
browser-paths.properties.example
browser-installer/download-browsers.ps1
browser-installer/download-browsers.sh
browser-installer/versions.json
browser-installer/README.md
```

Legacy files from the old workflow, if still present, are not required for the DFS evidence runner:

```text
index.js
run-all-browsers.ps1
run-all-browsers.sh
```
