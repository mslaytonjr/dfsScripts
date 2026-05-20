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

To run multiple lines of business in one test pass, set `LOBS` and prefix LOB-specific settings with `LOB.PROPERTY`. Unprefixed settings are used as defaults.

```properties
LOBS=PUBLIC,SECURE

PUBLIC.TARGET_URL=https://www.chase.com
PUBLIC.USERNAME_SELECTOR=#userId-text-input-field
PUBLIC.PASSWORD_SELECTOR=#password-text-input-field
PUBLIC.SUBMIT_SELECTOR=#signin-button

SECURE.TARGET_URL=https://secure.chase.com
SECURE.LOGIN_FRAME_SELECTOR=iframe[name="logonbox"]
SECURE.LOGIN_FRAME_NAME=logonbox
SECURE.LOGIN_BEFORE_MOUSE=true
SECURE.LOGIN_BEFORE_RELOAD=true
SECURE.PERFORM_RELOAD_TEST=true
SECURE.USERNAME_SELECTOR=#userId-input-field-input
SECURE.PASSWORD_SELECTOR=#password-input-field-input
SECURE.SUBMIT_SELECTOR=#signin-button
```

Common options:

```properties
# Leave blank to run every browser key/path in browser-paths.properties.
BROWSERS=chrome,opera,firefox,edge

HEADLESS=true
PERFORM_MOUSE_MOVEMENT=true
DISCOVER_INPUTS_ONLY=false
SUBMIT_CREDENTIALS=false
FIREFOX_USE_PLAYWRIGHT_BUNDLED=true
EXPECTED_DFS_E7_BIT0=1
DFS_E7_BIT_SHUFFLE_ENABLED=false
DFS_E7_BIT_SHUFFLE_MAPPING=semantic-index-to-label-index
DFS_E7_CLIENT_HINTS_MISSING_BROWSERS=opera
POST_LOAD_WAIT_MS=2000
SCRIPT_OVERRIDE_MATCH=/aegis-binaries\/dfs\.js/i
SCRIPT_OVERRIDE_SOURCE=C:\GitRepo\dfsScripts\.ignore\dfs121beta.js
LEVO_SCRIPT_OVERRIDE_MATCH=/aegis-binaries\/levo\.js/i
LEVO_SCRIPT_OVERRIDE_SOURCE=C:\GitRepo\dfsScripts\.ignore\levo.js
```

Keep `HEADLESS=true` for request-capture flows where headed browser automation changes or blocks the requests being tested. Use headed mode only for visual debugging.

Use `SCRIPT_OVERRIDE_*` to replace `dfs.js` and `LEVO_SCRIPT_OVERRIDE_*` to replace `levo.js`. Each override needs both a match pattern and a source path or HTTPS URL.

Use `DFS_E7_CLIENT_HINTS_MISSING_BROWSERS` for browser keys that are expected not to provide client hints such as `sec-ch-ua` / `sec-ch-ua-full-version-list`. For those browsers, `dfs_E_7` bit 16 and bit 22 are both expected to be `1`. The older `DFS_E7_BIT22_EXPECTED_1_BROWSERS` and `CLIENT_HINTS_MISSING_BROWSERS` names are still accepted as aliases.

Set `DFS_E7_BIT_SHUFFLE_ENABLED=true` when `dfs_E_7` is emitted in shuffled order. The runner derives the shuffle seed from `parseInt(dfs_F_5.slice(0, 8), 16)`, uses Mulberry32 returning a raw uint32, applies descending Fisher-Yates with `rand() % (i + 1)` to `S001` through `S032`, and then evaluates semantic bit numbers against the shuffled positions. `DFS_E7_BIT_SHUFFLE_MAPPING=semantic-index-to-label-index` means semantic bit N reads from the position named by shuffled label N; use `find-label` if semantic bit N is stored where `S00N` landed.

Use `LOB.LOGIN_BEFORE_MOUSE=true` for pages like Secure where the login iframe is reliable on the first load but later becomes hidden or re-rendered. The runner will submit the login form before mouse telemetry and before reload, then still run the remaining checks.

To scan the loaded page and list candidate username, password, and submit selectors without running the full validation:

```powershell
$env:DISCOVER_INPUTS_ONLY='true'
npm run dfs:test
```

The runner writes `input-fields.json` under the browser evidence folder and prints visible controls to the console.

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
COOKIE_SETTLE_WAIT_MS=0
INITIAL_COOKIE_WAIT_MS=
POST_SUBMIT_COOKIE_WAIT_MS=
TYPE_DELAY_MS=50
BEFORE_SUBMIT_WAIT_MS=750
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

## Compare Chase Console Values

To compare console-accessible browser/page values between Comet and installed system Chrome:

```powershell
npm run console:diff
```

By default this visits:

```text
https://secure.chase.com
https://www.chase.com
```

For this runner, `chrome` defaults to your installed Chrome Stable executable, not Chrome for Testing entries from `browser-paths.properties`. On Windows the default lookup checks:

```text
C:\Program Files\Google\Chrome\Application\chrome.exe
C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
```

The console-diff runner also defaults to headed mode so the browser is not headless. Set `CONSOLE_DIFF_HEADLESS=true` only if you intentionally want headless diagnostics.
Before collecting signals, the runner waits for `networkidle` when possible and then waits 5 seconds by default. Override with `CONSOLE_DIFF_POST_LOAD_WAIT_MS` if a page needs more time.

Evidence is written to:

```text
evidence/console-diff/<timestamp>/
```

Each run writes raw `console-values.json` files plus:

- `console-diff-report.json`
- `console-diff-report.md`

The Markdown report starts with a `Calls And Browser-Only Signals` table for each URL, showing normalized Chase/Akamai/resource calls and other signals found only in Comet or only in Chrome.
Values that exist in both browsers but change across requests, such as hash cookies, session IDs, timing data, or resource query strings, are documented as volatile and are not treated as browser attribution evidence.
The raw JSON includes broad signal inventories across navigator, window, document, screen, location, history, performance, crypto, CSS, Intl, Chrome globals, DOM prototypes, WebGL/WebGPU, media, permissions, storage, fonts, and Chase/DFS globals. The Markdown report summarizes the most useful browser-only differences.

Current console-diff signal list:

```text
location.href
document.title
document.readyState
navigator.userAgent
navigator.webdriver
navigator.platform
navigator.vendor
navigator.language
navigator.languages
navigator.cookieEnabled
navigator.hardwareConcurrency
navigator.deviceMemory
navigator.maxTouchPoints
navigator.pdfViewerEnabled
navigator.doNotTrack
navigator.globalPrivacyControl
navigator.connection
navigator.brave
navigator.plugins
navigator.mimeTypes
navigator.userAgentData
navigator.userAgentData.highEntropy
navigator.permissions.states
navigator.mediaDevices.enumerateDevices
navigator.storage.estimate
navigator.storage.persisted
screen
window.devicePixelRatio
window.chrome
window.browserGlobals
window.featureSupport
browser.capabilityMatrix
window.objectInventories
window.prototypeInventories
document.policyAndSecurity
document.dimensions
css.supports
css.mediaQueries
Intl.DateTimeFormat.timeZone
Intl.DateTimeFormat.locale
Intl.supportedValues
performance.memory
permissions.notifications
mediaCapabilities.decodingInfo
audioContext.sampleRate
webrtc.rtcConfiguration
webgpu.adapter
battery.status
fonts.checks
fonts.measurements
speechSynthesis.voices
speechSynthesis.state
media.support
navigator.keyboard
navigator.gamepads
navigator.maxTouchPoints.detail
credential.payment.shareCapabilities
locale.formatSamples
headers.clientHintsMeta
document.cookie.dfs
localStorage.keys
sessionStorage.keys
webgl
webgl2
canvas.sample
performance.navigation
performance.chaseResources
window.probedKeys
window.FingerprintData.getFingerPrint
```

Optional overrides:

```powershell
$env:CONSOLE_DIFF_URLS='https://secure.chase.com,https://www.chase.com'
$env:CONSOLE_DIFF_BROWSERS='comet,chrome'
$env:CONSOLE_DIFF_CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:CONSOLE_DIFF_HEADLESS='false'
$env:CONSOLE_DIFF_POST_LOAD_WAIT_MS='5000'
npm run console:diff
```

To intentionally use the latest configured Chrome path from `browser-paths.properties` instead of installed Chrome Stable:

```powershell
$env:CONSOLE_DIFF_CHROME_SOURCE='browser-paths'
npm run console:diff
```

## Evidence Output

Evidence is written to:

```text
evidence/<releaseversion>/<browser>/<browserversion>/
```

The aggregate files below are written when the run starts, refreshed after each browser finishes, and finalized at completion. You can refresh `cover-report.html` while the test is running to watch progress.

```text
evidence/<releaseversion>/summary-report.json
evidence/<releaseversion>/cover-report.html
evidence/<releaseversion>/portable-evidence.txt
```

`portable-evidence.txt` is a compact single-file text report with browser/version, fingerprint values, DFS cookies, and each test's pass/fail status.

Each browser/version run may include:

- `console-log.json`
- `fingerprint-initial.json`
- `fingerprint-after-mouse.json`
- `fingerprint-after-reload.json`
- `cookies-initial.json`
- `cookies-after-submit.json`
- `network-login-request.json`
- `fingerprint-values.txt`
- `scar-bit16-failure-signals.json`
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
- Required DFS cookies on page load, including `dfs_E_4`
- Cookie-to-fingerprint comparisons
- `dfs_E_6` browser detection format and consistency
- `dfs_E_7` SCAR bit expectations
  - shuffled bit strings can be decoded with `DFS_E7_BIT_SHUFFLE_ENABLED=true`
  - bit 0 defaults to `1` for Playwright-launched webdriver sessions
  - bit 16 and bit 22 default to `0`, unless the browser key is listed in `DFS_E7_CLIENT_HINTS_MISSING_BROWSERS`
  - bits 1, 25, 26, and 27 default to `0`
- `dfs_E_1` non-incognito expectation, unless `PERFORM_PRIVATE_MODE_DETECTION_TEST=false`
- Optional private/incognito browser launch expectation, unless `PERFORM_PRIVATE_MODE_BROWSER_TEST=false`
- Interaction SCAR bit expectations; set `IGNORE_INTERACTION_SCAR_BITS=21,31` to ignore specific behavior bits while still collecting evidence
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
