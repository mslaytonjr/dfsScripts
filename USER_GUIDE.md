# dfsScripts User Guide

This guide explains how to set up dfsScripts, use its features, and read the results. You do not need to know JavaScript to follow it. Most examples use Windows PowerShell.

## Find what you need

- [What the tools do](#what-the-tools-do)
- [Set up and run your first test](#set-up-and-run-your-first-test)
- [Choose browsers and versions](#choose-browsers-and-versions)
- [Change settings](#change-settings)
- [Find login fields and test login](#find-login-fields-and-test-login)
- [Test more than one site](#test-more-than-one-site)
- [Understand the test features](#understand-the-test-features)
- [Try a replacement script](#try-a-replacement-script)
- [Read and share reports](#read-and-share-reports)
- [Compare browser signals](#compare-browser-signals)
- [Run in the background](#run-in-the-background)
- [Update the project with Git](#update-the-project-with-git)
- [Settings reference](#settings-reference)
- [Fix common problems](#fix-common-problems)
- [macOS commands](#macos-commands)

## What the tools do

dfsScripts checks whether a website's DFS fingerprint code works as expected in different browsers. A **fingerprint** is a collection of values that describes a browser and its activity. A **cookie** is a small value that a website saves in the browser.

The project can:

| Feature | What it helps you do |
| --- | --- |
| Browser downloader | Keep selected browser versions in separate folders. |
| DFS test runner | Check fingerprint values, cookies, browser detection, and behavior scores. |
| Input discovery | Find the login fields and buttons that the test needs. |
| Login testing | Fill a test login form and capture its login request. |
| Multiple-site testing | Run the same browser checks against several configured sites. |
| Script replacement | Test another copy of `dfs.js` or `levo.js` while loading the target page. |
| Evidence reports | Save results, screenshots, cookies, and other details for review. |
| Console comparison | Compare values that websites can read in Comet and Chrome. |
| Background launcher | Start a local test process and save its console output to a log. |
| Git sync helpers | Download project updates and optionally push committed changes. |

Use test accounts when testing login. Reports can contain cookies, request data, and account-related information, so review them before sharing.

## Set up and run your first test

### 1. Open the project folder

Open PowerShell and enter:

```powershell
cd C:\GitRepo\dfsScripts
```

The commands below assume this is your project folder. Replace the path if your copy is somewhere else.

### 2. Check Node.js and install the project tools

You need Node.js 18 or newer and npm. Check your installation:

```powershell
node --version
npm --version
npm install
```

`npm install` reads `package.json` and installs the required packages. The project uses Playwright to control browsers.

If you plan to test Firefox, also install Playwright's Firefox:

```powershell
npx playwright install firefox
```

### 3. Create your settings file

If `.env` does not already exist, copy the example:

```powershell
Copy-Item .env.example .env
notepad .env
```

If `.env` already exists, open it directly so you keep your saved settings.

Change these lines to match the page and release you need to test:

```properties
TARGET_URL=https://your-test-site.example/login
RELEASE_VERSION=your-expected-release
BROWSERS=chrome
HEADLESS=true
TEST_LOGON=false
```

The URL must use `https://`. The example address is a placeholder; replace it with your actual test page.

`RELEASE_VERSION` names the evidence folder. It is also the expected `dfs_E_8` value unless you set `EXPECTED_DFS_E_8` separately. Ask the person providing the DFS build for the expected value.

### 4. Give the runner a browser path

Open `browser-paths.properties`. For a first run, you can point Chrome to an existing installation:

```properties
chrome=C:\Program Files\Google\Chrome\Application\chrome.exe
```

Make sure that file exists on your computer. See [Choose browsers and versions](#choose-browsers-and-versions) if you need downloaded versions instead.

### 5. Run the checks

```powershell
npm run check
npm run dfs:test
```

`npm run check` checks the syntax of the two JavaScript runners. It does not test the website. `npm run dfs:test` runs the DFS tests. `npm start` starts the same DFS runner.

The browser normally runs without a visible window. The console prints results and report paths. Open the printed `cover-report.html` path to review the results.

The runner keeps testing after individual test failures. A finished command does not mean every test passed. Read the report, including its `FAIL` and `SKIP` results.

## Choose browsers and versions

### Download separate browser versions

The most established Windows download workflow uses Chrome for Testing and Opera. The installer also has Firefox, Edge, and Brave support, but not every download or package works equally well. Edge's MSI package currently limits clean side-by-side setup. You can use an installed Edge path instead. The macOS downloader is an unverified smoke-test path.

For extraction on Windows, 7-Zip is recommended:

```powershell
winget install 7zip.7zip
```

Open `browser-installer/versions.json`. Under `browsers`, edit the lists of version strings. Keep valid JSON: use double quotes and do not leave a comma after the last item.

The `chrome` list selects Chrome versions. Edge and Opera use different version numbers. Their `_chromium_alignment` maps connect them to the same Chromium major version. Chromium is the browser engine used by these browsers. The Windows downloader can try to resolve missing mappings and warns when a matching build is unavailable.

From the project folder, download Chrome and Opera:

```powershell
& .\browser-installer\download-browsers.ps1 -Browsers chrome,opera
```

If PowerShell blocks the script, use a policy override for that command:

```powershell
powershell -ExecutionPolicy Bypass -File .\browser-installer\download-browsers.ps1 -Browsers chrome,opera
```

The default download folder is `C:\browsers`. Downloads can be large, especially when you select several versions.

| Windows installer option | What it does |
| --- | --- |
| `-Browsers chrome,opera` | Download only the named browser families. Other supported names are `firefox`, `edge`, and `brave`. |
| `-Root "D:\testing\browsers"` | Use another download folder. |
| `-ConfigPath ".\browser-installer\versions-other.json"` | Read another version file. |
| `-NoBrowserPaths` | Leave `browser-paths.properties` unchanged. |

The Windows downloader normally refreshes `browser-paths.properties` with browser files found under its install folder. Review that file afterward, especially if you added system-installed browsers yourself.

### Select what the DFS runner uses

`browser-paths.properties` is the runner's browser list. You can include more than one version on the same line by separating paths with semicolons:

```properties
chrome=C:\browsers\chrome\VERSION-ONE\chrome.exe;C:\browsers\chrome\VERSION-TWO\chrome.exe
opera=C:\browsers\opera\OPERA-VERSION\opera.exe
firefox=C:\Program Files\Mozilla Firefox\firefox.exe
edge=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

Replace the version placeholders with real folders. Spaces in paths are fine. Do not replace spaces with `%20`.

In `.env`, choose browser keys:

```properties
BROWSERS=chrome,edge
```

This runs every configured path for Chrome and Edge. A blank `BROWSERS` value selects all configured browser keys and paths.

For Firefox, keep `FIREFOX_USE_PLAYWRIGHT_BUNDLED=true`. The `firefox=` entry includes Firefox in the run, but Playwright launches its bundled Firefox. Stock Firefox is not reliably compatible with Playwright's control protocol. This means the configured system Firefox path does not select the actual tested Firefox version in bundled mode.

Comet needs a valid installed path if you select it. `atlas` means ChatGPT Atlas and is currently macOS-only. The downloader does not install Comet or Atlas.

## Change settings

`.env` stores one setting per line: `NAME=value`. Lines starting with `#` are comments. Use `true` or `false` for switches. Timing names ending in `_MS` use milliseconds: `1000` means one second.

You can change a setting for a run through PowerShell:

```powershell
$env:BROWSERS='chrome'
$env:PERFORM_INTERACTION_SCENARIO_TESTS='false'
npm run dfs:test
```

These values stay in the current PowerShell session and take priority over `.env`. Remove an override when finished:

```powershell
Remove-Item Env:BROWSERS -ErrorAction SilentlyContinue
Remove-Item Env:PERFORM_INTERACTION_SCENARIO_TESTS -ErrorAction SilentlyContinue
```

Closing that PowerShell window also clears those session settings. Save changes in `.env` when you want to reuse them.

## Find login fields and test login

### Find the fields first

A **selector** tells Playwright which page element to use. For example, `#username` means the element whose ID is `username`.

Run input discovery:

```powershell
$env:DISCOVER_INPUTS_ONLY='true'
npm run dfs:test
Remove-Item Env:DISCOVER_INPUTS_ONLY
```

This mode loads the page and lists candidate controls instead of running the full validation. It prints visible controls and saves `input-fields.json` in the browser's evidence folder. Use those results to choose the username field, password field, and submit button.

### Enable login testing

Set these values in `.env`, using a test account and the page's actual selectors:

```properties
TEST_LOGON=true
LOGIN_USERNAME=your-test-username
LOGIN_PASSWORD=your-test-password
USERNAME_SELECTOR=#username
PASSWORD_SELECTOR=#password
SUBMIT_SELECTOR=#signin-button
LOGIN_REQUEST_MATCHER=/login|auth|signin/i
```

`TEST_LOGON` is the main login switch. `SUBMIT_CREDENTIALS` is an older fallback used only when `TEST_LOGON` is unset or blank. The example file has `TEST_LOGON=false`, so changing only `SUBMIT_CREDENTIALS` will not enable login.

The request matcher identifies the login request to capture. It can be a piece of the request URL or a regular expression such as `/login|auth|signin/i`. This example matches those words without regard to letter case. Capturing a request does not by itself prove the account successfully logged in.

### Handle login forms inside frames

An **iframe** is a smaller page placed inside another page. If the login fields are inside one, configure its selector, name, or URL matcher:

```properties
LOGIN_FRAME_SELECTOR=iframe[name="logonbox"]
LOGIN_FRAME_NAME=logonbox
LOGIN_FRAME_WAIT_TIMEOUT_MS=45000
```

`LOGIN_FRAME_URL_MATCHER` can identify a frame by URL. The runner waits for the configured frame and can fall back to the main page.

If the form disappears after mouse activity or a reload, set:

```properties
LOGIN_BEFORE_MOUSE=true
LOGIN_BEFORE_RELOAD=true
```

These settings change the test order; they do not turn login testing on.

## Test more than one site

`LOB` means **line of business**. Here it is a label for a group of site settings. You could use `PUBLIC` for a public site and `SECURE` for a secure site.

```properties
LOBS=PUBLIC,SECURE
PUBLIC.TARGET_URL=https://public-test.example/login
SECURE.TARGET_URL=https://secure-test.example/login
PUBLIC.USERNAME_SELECTOR=#public-user
SECURE.USERNAME_SELECTOR=#secure-user
SECURE.LOGIN_BEFORE_RELOAD=true
```

The runner tests the selected browsers for each LOB. A prefixed setting such as `SECURE.HEADLESS=false` overrides the shared setting for that LOB. Settings without a prefix remain the defaults. Remove unused LOBs from `LOBS` to avoid running them.

Evidence includes the LOB folder when this mode is enabled: `evidence/<release>/<lob>/<browser>/<version>/`.

## Understand the test features

### Main DFS checks

| Check | Plain-language meaning |
| --- | --- |
| Page and console checks | Can the page load, and does DFS report errors? |
| Fingerprint API | Can the runner read `FingerprintData.getFingerPrint()` or `getFingerprint()`? |
| Required cookies | Did the page create the required DFS cookies, including `dfs_E_4`? |
| Cookie comparisons | Do saved cookie values agree with the fingerprint data? |
| `dfs_E_6` | Is the browser-detection value correctly formed and consistent? |
| `dfs_E_7` | Do the behavior scores match the expected format and test actions? |
| `dfs_E_1` | Does a normal session avoid reporting private mode? An additional private-browser test is optional. |
| Payload groups | Are the expected `dfs_B*`, `dfs_D*`, `dfs_I*`, `dfs_M*`, and `dfs_N*` values available? |
| Mouse telemetry | Does `dfs_F_2` respond as expected after mouse activity? |
| Reload stability | Does `dfs_F_1` stay stable across a page reload? |
| Login request | When enabled, do captured request headers and payload values match expectations? |
| Release check | Does `dfs_E_8` exactly match the expected release string? Commas count as part of that string. |

Use `EXPECTED_DFS_E_8` when the release folder needs a different label from the actual DFS value:

```properties
RELEASE_VERSION=my-qa-run
EXPECTED_DFS_E_8=11.0.0-beta.1,132.0.0-beta.1
```

### Interaction scenarios

These tests perform specific actions to see whether DFS recognizes them. Each scenario uses a fresh browser context, which separates its cookies and state from other scenarios.

Choose scenarios by their short IDs or long names:

```properties
PERFORM_INTERACTION_SCENARIO_TESTS=true
INTERACTION_TEST_SCENARIOS=A1,A2,B1,B3
```

Blank or unset `INTERACTION_TEST_SCENARIOS` selects all stable built-in scenarios. Set `PERFORM_INTERACTION_SCENARIO_TESTS=false` to disable the group.

| ID | Scenario name | What it tests |
| --- | --- | --- |
| A1 | `value_injection` | Assign values directly across several fields. |
| A2 | `synthetic_events` | Send events made by code rather than ordinary user input. |
| A3 | `pointer_lock` | Click the exact center of several controls. |
| A4 | `pointer_travel` | Click separate targets without a normal mouse path. |
| A5 | `cold_focus` | Give credential fields focus through code. Focus means the field is selected to receive input. |
| B1 | `injected_text` | Insert text into the username field without normal typing. |
| B2 | `cadence_rigidity` | Type with an unusually fixed rhythm. |
| B3 | `human_like_cadence` | Type with varied delays and expect a low rigid-rhythm score. |
| B4 | `focus_anomaly` | Send input before the expected focus event. |
| B5 | `dwell_missing_keyups` | Send key-down events without matching key-up events. |
| B6 | `dwell_short_holds` | Release each key almost immediately. |
| B7 | `fill_speed` | Fill a field unusually fast. |
| B8 | `paste_fragmentation` | Insert several small paste-shaped text chunks. |
| B9 | `focus_no_pointer` | Focus and type without using the pointer to reach the field. |
| B10 | `key_input_mismatch_cdp` | Insert text through Chromium's debugging interface without key-down events. Chromium only. |
| B11 | `key_input_mismatch_paste_negative` | Check that paste-style insertion does not trigger the key/input mismatch score. |
| C1 | `human_baseline` | Investigate a normal human-input control. |
| C2 | `human_pause_baseline` | Investigate human input with pauses. |
| C3 | `human_mouse_path` | Investigate a human mouse path. |
| C4 | `browser_autofill_suppression` | Investigate autofill with a prepared browser profile. |

The C scenarios are skipped by default. They need manual or hardware-backed input, or a prepared profile. `RUN_PROCESS_LIMITED_INTERACTION_TESTS=true` lets you investigate them, but does not supply those requirements or make them stable automated checks.

### How scores work

Numeric `dfs_E_7` contains two-digit scores whose order has been shuffled. The runner uses the first eight hexadecimal characters of `dfs_F_5` to recover their order. Keep `DFS_E7_FORMAT=auto` and `DFS_E7_SCORE_SHUFFLE_MAPPING=canonical-index-to-shuffled-index` unless you are investigating another format.

The current code has eight global dimensions: value injection, synthetic events, pointer lock, pointer travel, cold focus, agentic browser, extension presence, and driver presence. Each scored field then has eight dimensions. Read named dimensions in `dfs-e7-score-token-evaluation.json` instead of guessing from a raw score's position. Some older README examples show earlier token positions.

Higher scores are expected for many deliberately abnormal actions. A high score is therefore often a passing result. For example, A1 expects roughly the percentage of inspected fields that received injected values, capped at 99. Human-like and paste-negative scenarios instead expect certain scores to stay low.

Many scenarios use hidden synthetic submit events to refresh scores without navigating away. This is separate from the real login test. The runner polls scores until expectations pass or the score timeout expires.

### Private-mode checks and retries

`PERFORM_PRIVATE_MODE_DETECTION_TEST=true` checks the normal session's private-mode value. `PERFORM_PRIVATE_MODE_BROWSER_TEST=true` requests an extra private/incognito launch where supported. The extra launch is disabled by default because it is an investigative check.

Page-readiness problems, such as missing selectors, detached frames, and timeouts, can be retried. The defaults are three attempts and a three-second delay. An incorrect asserted value fails immediately rather than being retried until it passes.

For Chase system-requirements redirects, the runner can skip unavailable-target checks instead of creating misleading downstream DFS failures. Secure sign-in recovery can first try the visible Sign in link. A skip still means the intended check was not completed.

## Try a replacement script

Use this feature to load a page but serve a test copy of DFS or LEVO in place of a matching script request. This changes what the automated browser receives during the run.

```properties
SCRIPT_OVERRIDE_MATCH=/aegis-binaries\/dfs\.js/i
SCRIPT_OVERRIDE_SOURCE=C:\test-builds\dfs.js
LEVO_SCRIPT_OVERRIDE_MATCH=/aegis-binaries\/levo\.js/i
LEVO_SCRIPT_OVERRIDE_SOURCE=C:\test-builds\levo.js
```

Each replacement needs both a match and a source. A match can be a URL substring or `/pattern/flags` regular expression. A source can be a local JavaScript file or an HTTPS URL. Use `SCRIPT_OVERRIDE_FETCH_TIMEOUT_MS` to control the source-download timeout. Clear both settings for a replacement when you want to use the site's original script again.

## Read and share reports

Start with `cover-report.html`. It is the browser-friendly overview. Reports update after each browser finishes, so you can refresh the page while a run continues.

| File | Use it for |
| --- | --- |
| `cover-report.html` | Browse the run's results and evidence links. |
| `summary-report.json` | Read structured results or use them in another tool. |
| `portable-evidence.txt` | Review a compact text report with fingerprint values, cookies, and results. |
| `latest-run.json` | Locate the latest run through the release folder's pointer data. |
| `console-log.json` | Investigate browser console messages. |
| `fingerprint-initial.json` | Review fingerprint data after loading. |
| `fingerprint-after-mouse.json` | Review fingerprint data after mouse activity. |
| `fingerprint-after-reload.json` | Review fingerprint data after a reload. |
| `cookies-initial.json` | Check cookies from the initial page load. |
| `cookies-after-submit.json` | Check cookies after login submission. |
| `network-login-request.json` | Inspect the captured login request. |
| `fingerprint-values.txt` | Read fingerprint values as text. |
| `dfs-e7-score-token-evaluation.json` | Inspect decoded behavior scores and expectations. |
| `input-fields.json` | Find candidate form controls from discovery mode. |
| `screenshots/*.png` | See saved browser screenshots. |

Some files appear only when the related test runs.

The first run uses `evidence/<release>/<browser>/<version>/`. Later runs for the same release use `evidence/<release>/test-N/<browser>/<version>/`. LOB runs add a LOB folder before the browser folder. The release folder's main reports point to the latest run, so use the specific run folder when reviewing an older run.

Each test result includes its name, status, details, evidence paths, and errors:

- **PASS:** the check matched its expectation.
- **FAIL:** the check failed or could not complete successfully. Read the details to learn which.
- **SKIP:** the check was not performed or did not apply. This is not proof that the feature passed.

Before sharing evidence, check for sensitive cookies, account details, and request contents. Keep related files together when sharing a report that links to other evidence.

## Compare browser signals

The console comparison runner shows differences in values that a website can read. It defaults to Comet and installed Chrome Stable, visiting `https://secure.chase.com` and `https://www.chase.com`.

Make sure Comet has a valid path in `browser-paths.properties`, then run:

```powershell
npm run console:diff
```

This tool defaults to visible browser windows. Unlike the DFS runner, it normally chooses system Chrome rather than downloaded Chrome for Testing. On Windows it checks the usual Chrome locations under `Program Files` and `Program Files (x86)`.

Example overrides:

```powershell
$env:CONSOLE_DIFF_URLS='https://your-test-site.example/login'
$env:CONSOLE_DIFF_BROWSERS='comet,chrome'
$env:CONSOLE_DIFF_CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:CONSOLE_DIFF_HEADLESS='false'
$env:CONSOLE_DIFF_POST_LOAD_WAIT_MS='5000'
npm run console:diff
```

To use the latest configured Chrome path from the properties file instead:

```powershell
$env:CONSOLE_DIFF_CHROME_SOURCE='browser-paths'
npm run console:diff
```

Results go in `evidence/console-diff/<timestamp>/`. Open `console-diff-report.md` for the readable report or `console-diff-report.json` for structured results. Raw `console-values.json` files contain the collected values.

The report's “Calls And Browser-Only Signals” table highlights normalized resource calls and signals found in only one browser. It also collects browser identity, automation flags, hardware hints, language, permissions, storage, screen settings, supported APIs, graphics, media, fonts, timing, and DFS data.

Some values naturally change between visits. Different session IDs, cookie hashes, and timings alone do not prove a browser-specific difference. Device and operating-system differences can also affect results.

## Run in the background

The background launcher starts a process on the computer where you run it. Its name includes “remote,” but it does not connect to another computer for you.

From the project folder:

```powershell
.\start-remote-dfs.ps1 -Browsers chrome -SkipInteractionScenarios -Headless
```

The launcher returns after starting the process. That message confirms a start, not a successful test. It prints a process ID, a log path, a PID file path, and a command for watching the log. Use the printed command to follow progress. Pressing Ctrl+C while watching the log stops the log viewer, not the background test.

Default log location: `logs/remote-runs/`. Review the final evidence report to determine the test outcome.

| PowerShell option | What it does |
| --- | --- |
| `-Browsers chrome,comet` | Select browser keys. |
| `-Lobs PUBLIC,SECURE` | Select LOBs. |
| `-ReleaseVersion "label"` | Set the release/folder label. |
| `-ExpectedDfsE8 "value"` | Set the exact expected DFS release value. |
| `-PublicTargetUrl "https://..."` | Set `PUBLIC.TARGET_URL`. |
| `-SecureTargetUrl "https://..."` | Set `SECURE.TARGET_URL`. |
| `-SkipInteractionScenarios` | Disable interaction scenarios for this launch. |
| `-Headless` | Request no visible browser window. |
| `-UpdateEnv` | Save selected settings in `.env`, in addition to applying them to the run. |
| `-UpdateChromeVersions` | Add versions to `versions.json`, keeping existing entries. |
| `-ChromeVersions "version1,version2"` | Choose the version list to add. Supply full real version numbers. |
| `-InstallBrowsers` | Run the browser downloader before testing. |
| `-InstallBrowserTargets "chrome,opera"` | Choose downloader browser targets; default is Chrome. |
| `-Sync` | Run the Git sync helper before testing. |
| `-Autostash` | Allow the sync helper to temporarily stash tracked edits during its pull. |
| `-LogRoot "logs\my-runs"` | Choose another log folder. |
| `-Qa2Defaults` | Apply the preset QA2 settings, save settings, add Chrome versions, and install browsers. |
| `-Help` | Print brief usage help without starting a run. |

`-Qa2Defaults` is a specific environment preset, not a general setup shortcut. Its built-in release label is `132.0.0-beta.1-QA-2`, expected DFS value is `11.0.0-beta.1,132.0.0-beta.1`, and target defaults are `https://wwwqa3.chase.com` and `https://qac2-secure01ea.chase.com`. Explicit values can replace those defaults. It does not automatically select your LOB list. Confirm the preset fits the environment you need.

The `.cmd` wrapper accepts the PowerShell options from Windows Command Prompt:

```bat
start-remote-dfs.cmd -Browsers chrome -Headless
```

## Update the project with Git

Git tracks project changes. These helpers fetch remote updates, then pull with rebase. A rebase places your local commits on top of the updated branch.

```powershell
.\sync-git.ps1
```

The helper stops if local changes exist unless you select `-Autostash`:

```powershell
.\sync-git.ps1 -Autostash
```

Autostash temporarily saves tracked edits and reapplies them after the pull. It does not guarantee a conflict-free update or protect every untracked file. If conflicts occur, read Git's message and resolve them before starting more syncs.

`-Push` also uploads committed changes after the pull. It does not create a commit. Use it only when you intend to publish those commits. The helper needs a named branch and an upstream, or a matching existing `origin/<branch>` reference. It does not support detached HEAD mode, where no branch is selected.

`sync-git.cmd` is the Command Prompt wrapper. macOS uses `./sync-git.sh`, with `--autostash` and `--push` for the same options.

## Settings reference

Use [.env.example](.env.example) as the complete starting template. The groups below explain its controls. Unless you are investigating a specific problem, leave advanced scenario controls at their template values.

### Page, browser, and test selection

| Settings | Purpose |
| --- | --- |
| `TARGET_URL`, `RELEASE_VERSION`, `EXPECTED_DFS_E_8` | Select the page, run label, and expected release value. |
| `LOBS`, `BROWSERS` | Choose site groups and browser keys. |
| `HEADLESS` | `true` hides the browser window; `false` helps with visual debugging. Keep headless enabled for request-capture flows that behave differently under visible automation. |
| `FIREFOX_USE_PLAYWRIGHT_BUNDLED` | Use Playwright's compatible Firefox. |
| `PERFORM_MOUSE_MOVEMENT`, `PERFORM_RELOAD_TEST` | Enable mouse and reload checks. |
| `LOGIN_BEFORE_MOUSE`, `LOGIN_BEFORE_RELOAD` | Move login earlier in the run. |
| `DISCOVER_INPUTS_ONLY` | Run input discovery instead of full validation. |
| `TEST_LOGON`, `SUBMIT_CREDENTIALS` | Control actual login testing; the first takes priority. |
| `PERFORM_PRIVATE_MODE_DETECTION_TEST`, `PERFORM_PRIVATE_MODE_BROWSER_TEST` | Control the normal-session private check and optional private-browser launch. |
| `IGNORE_REQUIRED_DFS_COOKIES` | List required-cookie names to exempt for a known environment difference. Exemptions reduce what the test verifies. |

### Login and script settings

| Settings | Purpose |
| --- | --- |
| `LOGIN_USERNAME`, `LOGIN_PASSWORD` | Credentials for the test account. |
| `USERNAME_SELECTOR`, `PASSWORD_SELECTOR`, `SUBMIT_SELECTOR` | Locate login controls. |
| `LOGIN_FRAME_SELECTOR`, `LOGIN_FRAME_NAME`, `LOGIN_FRAME_URL_MATCHER` | Locate an embedded login frame. |
| `LOGIN_REQUEST_MATCHER` | Identify the login network request. |
| `TYPE_DELAY_MS` | Shared delay between typed characters. |
| `USERNAME_TYPE_DELAY_MS`, `PASSWORD_TYPE_DELAY_MS` | Override typing delay for a single field. |
| `BEFORE_SUBMIT_WAIT_MS` | Pause after typing and before submitting. |
| `SCRIPT_OVERRIDE_MATCH`, `SCRIPT_OVERRIDE_SOURCE` | Select and replace the DFS script request. |
| `LEVO_SCRIPT_OVERRIDE_MATCH`, `LEVO_SCRIPT_OVERRIDE_SOURCE` | Select and replace the LEVO script request. |
| `SCRIPT_OVERRIDE_FETCH_TIMEOUT_MS` | Limit time spent fetching a replacement script. |
| `SECURE_SYSTEM_REQUIREMENTS_SIGNIN_RECOVERY` | Try Secure sign-in recovery after a system-requirements redirect. |
| `SECURE_SIGNIN_LINK_TIMEOUT_MS` | Limit the wait for the recovery Sign in link. |

### Waiting and diagnostics

| Settings | Purpose |
| --- | --- |
| `NAVIGATION_TIMEOUT_MS`, `POST_LOAD_WAIT_MS`, `POST_RELOAD_WAIT_MS` | Limit navigation time and pause after loading or reloading. |
| `FIELD_TIMEOUT_MS`, `LOGIN_FRAME_WAIT_TIMEOUT_MS` | Wait for form controls or the login frame. |
| `LOGIN_REQUEST_TIMEOUT_MS`, `POST_SUBMIT_TIMEOUT_MS`, `POST_SUBMIT_LOAD_STATE` | Control waits for the login request and page state after submit. |
| `COOKIE_SETTLE_WAIT_MS` | Pause before cookie reads in both phases. |
| `INITIAL_COOKIE_WAIT_MS`, `POST_SUBMIT_COOKIE_WAIT_MS` | Override that pause for one phase. |
| `FINGERPRINT_DATA_WAIT_TIMEOUT_MS`, `DFS_E7_WAIT_TIMEOUT_MS` | Wait for fingerprint data and behavior scores. |
| `MOUSE_WAIT_BEFORE_MS`, `MOUSE_WAIT_AFTER_MS` | Pause before and after mouse telemetry. |
| `TEST_RETRY_ATTEMPTS`, `TEST_RETRY_DELAY_MS` | Set readiness retry attempts and delay. |
| `BROWSER_CLOSE_TIMEOUT_MS`, `BROWSER_DIAGNOSTICS_TIMEOUT_MS` | Limit browser cleanup and diagnostics waits. |
| `TRACE_STEPS`, `STEP_STALL_LOG_MS`, `STEP_TIMEOUT_MS` | Log more step detail, report slow steps, and limit step duration. A zero stall-log interval disables that periodic logging. |

### Interaction controls

| Settings | Purpose |
| --- | --- |
| `DFS_E7_FORMAT`, `DFS_E7_SCORE_SHUFFLE_MAPPING` | Control score interpretation. Keep the defaults for current numeric scores. |
| `PERFORM_INTERACTION_SCENARIO_TESTS`, `INTERACTION_TEST_SCENARIOS` | Enable scenarios and choose which run. |
| `RUN_PROCESS_LIMITED_INTERACTION_TESTS` | Allow the investigative C scenarios. |
| `INTERACTION_TEST_VALUE` | Set general text used in interaction tests. |
| `INTERACTION_SCORE_WAIT_MS`, `INTERACTION_SCORE_POLL_TIMEOUT_MS`, `INTERACTION_SCORE_POLL_INTERVAL_MS` | Pause, then poll for updated scores. |
| `INTERACTION_SYNTHETIC_SUBMIT_COUNT`, `INTERACTION_SYNTHETIC_SUBMIT_GAP_MS` | Set how many hidden score-refresh submit events run and their spacing. |
| `VALUE_INJECTION_FIELD_COUNT`, `VALUE_INJECTION_ECHO_WINDOW_WAIT_MS` | Set the number of injection targets and wait before assigning values. |
| `VALUE_INJECTION_DISPATCH_EVENTS`, `VALUE_INJECTION_USE_NATIVE_SETTER`, `VALUE_INJECTION_FORCE_SYNTHETIC_SUBMIT` | Choose how A1 assigns values, sends events, and refreshes scores. |
| `SYNTHETIC_EVENTS_FIELD_COUNT` | Choose how many fields receive synthetic events in A2. |
| `POINTER_LOCK_CLICK_COUNT`, `POINTER_LOCK_USE_SCRATCH_TARGETS`, `POINTER_LOCK_USE_LOCATOR_CLICK`, `POINTER_LOCK_FORCE_SYNTHETIC_SUBMIT` | Control A3's clicks, temporary targets, click method, and score refresh. |
| `POINTER_TRAVEL_CLICK_COUNT`, `POINTER_TRAVEL_USE_MOUSE_TELEPORT`, `POINTER_TRAVEL_FORCE_SYNTHETIC_SUBMIT` | Control A4's clicks, pointer-jump probe, and score refresh. |
| `COLD_FOCUS_TYPE_DELAY_MS`, `FOCUS_NO_POINTER_TYPE_DELAY_MS` | Set typing delays for A5 and B9. |
| `INJECTED_TEXT_ECHO_WINDOW_WAIT_MS`, `INJECTED_TEXT_DISPATCH_EVENTS`, `INJECTED_TEXT_USE_NATIVE_SETTER`, `INJECTED_TEXT_FORCE_SYNTHETIC_SUBMIT` | Control B1's wait, value-setting method, events, and score refresh. |
| `ROBOTIC_TYPING_DELAY_MS`, `CADENCE_RIGIDITY_USE_MANUAL_EVENTS`, `CADENCE_RIGIDITY_FORCE_SYNTHETIC_SUBMIT` | Control B2's fixed timing, event method, and score refresh. |
| `HUMAN_TYPE_MIN_DELAY_MS`, `HUMAN_TYPE_MAX_DELAY_MS`, `HUMAN_LIKE_CADENCE_HIGH_VARIANCE`, `HUMAN_LIKE_CADENCE_FORCE_SYNTHETIC_SUBMIT` | Control B3's varied typing delays and score refresh. |
| `FOCUS_ANOMALY_FORCE_SYNTHETIC_SUBMIT`, `FOCUS_ANOMALY_USE_SCRATCH_FIELD` | Choose B4's score refresh and whether to use a temporary field. |
| `DWELL_ANOMALY_FORCE_SYNTHETIC_SUBMIT` | Control score refresh for B5 and B6. |
| `FILL_SPEED_SELECTOR`, `FILL_SPEED_TEXT`, `FILL_SPEED_TYPE_DELAY_MS`, `FILL_SPEED_FORCE_SYNTHETIC_SUBMIT` | Choose B7's field, text, speed, and score refresh. |
| `PASTE_FRAGMENTATION_CHUNKS`, `PASTE_FRAGMENTATION_FORCE_SYNTHETIC_SUBMIT` | Choose B8's comma-separated chunks and score refresh. |
| `KEY_INPUT_MISMATCH_VALUE`, `KEY_INPUT_MISMATCH_PASTE_VALUE` | Choose B10 and B11 text. |
| `HUMAN_BASELINE_TYPE_MIN_DELAY_MS`, `HUMAN_BASELINE_TYPE_MAX_DELAY_MS`, `HUMAN_PAUSE_MS`, `HUMAN_MOUSE_STEPS`, `HUMAN_BASELINE_CLICK_REAL_SUBMIT` | Tune the investigative human controls. The last switch allows a real submit action. |

### Console comparison controls

These settings are separate from normal DFS test selection.

| Settings | Purpose |
| --- | --- |
| `CONSOLE_DIFF_URLS`, `CONSOLE_DIFF_BROWSERS` | Choose comma-separated URLs and browser keys. |
| `CONSOLE_DIFF_CHROME_SOURCE`, `CONSOLE_DIFF_CHROME_PATH` | Choose system Chrome or the properties-file source, and optionally an explicit system Chrome path. |
| `CONSOLE_DIFF_HEADLESS` | Hide or show browser windows; default is `false`. |
| `CONSOLE_DIFF_POST_LOAD_WAIT_MS` | Pause before reading signals; default is five seconds when no shared override is set. |
| `CONSOLE_DIFF_VIEWPORT_WIDTH`, `CONSOLE_DIFF_VIEWPORT_HEIGHT` | Set the browser's content-area size in pixels. |
| `CONSOLE_DIFF_GOTO_WAIT_UNTIL`, `CONSOLE_DIFF_NAVIGATION_TIMEOUT_MS` | Choose initial load state and navigation timeout. |
| `CONSOLE_DIFF_NETWORK_IDLE_TIMEOUT_MS` | Limit the attempt to wait for quiet network activity. |
| `CONSOLE_DIFF_MARKDOWN_STRUCTURED_ITEM_LIMIT`, `CONSOLE_DIFF_MARKDOWN_VALUE_LIMIT`, `CONSOLE_DIFF_MARKDOWN_ITEM_LIMIT` | Limit how much detail appears in Markdown report entries. Use raw JSON for fuller captured details. |

## Fix common problems

| Problem | What to try |
| --- | --- |
| `node` or `npm` is not recognized | Install the required Node.js version and reopen PowerShell. |
| Playwright package is missing | Run `npm install` in the project folder. |
| Bundled Firefox cannot be found | Run `npx playwright install firefox`. |
| No browser paths are selected | Check `browser-paths.properties`, the actual executable files, and the keys in `BROWSERS`. |
| Browser download fails | Read the vendor/download warning. Confirm the full version exists. Try one browser/version at a time. |
| Edge extraction does not produce a usable browser | Use an installed Edge executable; side-by-side MSI extraction is a known limitation. |
| Nothing appears on screen | `HEADLESS=true` hides the window. Use `false` for visual debugging. |
| Login does not run | Set `TEST_LOGON=true`, disable discovery mode, and provide the required credentials and selectors. |
| Login field cannot be found | Run discovery, check the iframe settings, and verify the page is the expected page. |
| Form vanishes before login | Try `LOGIN_BEFORE_MOUSE=true` and `LOGIN_BEFORE_RELOAD=true`. |
| Release check fails | Compare `dfs_E_8` with the exact expected string. Check commas, spaces, and `EXPECTED_DFS_E_8`. |
| DFS values are missing | Check the page, script loading, redirects, console errors, and relevant waits. More waiting will not fix a script that never loads. |
| A scenario fails | Read its evidence and named score dimensions. Confirm the page has usable fields and the target DFS build supports the expected scores. |
| A check is skipped | Read the skip reason. Check browser support, C-scenario prerequisites, and system-requirements redirects. |
| Old results seem to appear | Check `latest-run.json` and the printed run path. Open the correct `test-N` folder. |
| A changed `.env` setting has no effect | Clear the same PowerShell environment variable and check for a LOB-specific override. |
| Background launcher says it started but no results appear | Read its log. Startup, setup, download, or Git steps may have failed before testing. |
| Git sync refuses to run | Review local changes and branch/upstream setup. Use autostash only when appropriate and resolve any conflicts. |

## macOS commands

The macOS downloader exists, but its download workflow has not been verified to the same level as Windows. Check the paths it produces before testing.

Install the downloader's `jq` requirement, then download selected browsers:

```bash
brew install jq
cd browser-installer
chmod +x download-browsers.sh
./download-browsers.sh --browsers chrome,opera --root ~/browsers-test
cd ..
```

The default root without `--root` is `~/browsers`. `--config` selects another version JSON file. The script detects Apple Silicon or Intel. Set the executable paths in `browser-paths.properties` to the files inside the downloaded `.app` bundles, rather than to the bundle folders themselves.

Project setup and testing use the same npm commands:

```bash
npm install
cp .env.example .env
npm run check
npm run dfs:test
```

Copy the example only if `.env` does not already exist. Edit its placeholders before testing.

A temporary setting can be applied to one command:

```bash
BROWSERS=chrome PERFORM_INTERACTION_SCENARIO_TESTS=false npm run dfs:test
```

For background runs and Git sync, make the helpers executable once:

```bash
chmod +x start-remote-dfs.sh sync-git.sh
./start-remote-dfs.sh --browsers chrome --skip-interactions --headless
```

The Bash launcher uses long options: `--browsers`, `--lobs`, `--release-version`, `--expected-dfs-e8`, `--public-target-url`, `--secure-target-url`, `--chrome-versions`, `--install-browser-targets`, `--sync`, `--autostash`, `--install-browsers`, `--update-chrome-versions`, `--update-env`, `--qa2-defaults`, `--skip-interactions`, `--headless`, and `--log-root`. These correspond to the Windows launcher options described above.

Use the printed `tail -f` command to watch the log. The Bash launcher also saves a generated `*-run.sh` file next to its log and PID file.
