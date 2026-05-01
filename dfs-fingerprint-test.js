const fs = require('fs');
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');

const ROOT_DIR = __dirname;
const BROWSER_PATHS_FILE = path.join(ROOT_DIR, 'browser-paths.properties');
const DEFAULT_ENV_FILE = path.join(ROOT_DIR, '.env');
const REQUIRED_DFS_COOKIES = ['dfs_E_5', 'dfs_E_6', 'dfs_E_7', 'dfs_E_8', 'dfs_F_5', 'dfs_F_6', 'dfs_F_7'];
const FINGERPRINT_PREFIXES = ['dfs_B', 'dfs_D', 'dfs_I', 'dfs_M', 'dfs_N'];
const DFS_KEY_PATTERN_BY_PREFIX = {
  dfs_B: /^dfs_B_\d+$/,
  dfs_D: /^dfs_D_\d+$/,
  dfs_I: /^dfs_I_\d+$/,
  dfs_M: /^dfs_M_\d+$/,
  dfs_N: /^dfs_N_\d+$/,
};
const OS_CODES = {
  win32: '01',
  darwin: '07',
};
const BROWSER_CODES = {
  edge: '01',
  chrome: '02',
  opera: '02',
  duckduckgo: '02',
  safari: '03',
  webkit: '03',
  firefox: '04',
  comet: '06',
  atlas: '07',
};
const DFS_ERROR_PATTERNS = [
  /dfs/i,
  /FingerprintData/i,
  /clientEnvProps/i,
  /module is not defined/i,
];
const SPECIFIC_FORBIDDEN_ERRORS = [
  "SyntaxError: Identifier 'clientEnvProps' has already been declared",
  'ReferenceError: module is not defined',
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function expandWindowsEnv(value) {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
}

function parsePropertiesFile(filePath) {
  const properties = {};
  if (!fs.existsSync(filePath)) return properties;

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const separatorIndex = line.search(/[:=]/);
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    properties[key] = value;
  }

  return properties;
}

function discoverBrowserTargets() {
  const browserPaths = parsePropertiesFile(BROWSER_PATHS_FILE);
  const targets = [];

  for (const [browser, value] of Object.entries(browserPaths)) {
    for (const rawCandidate of value.split(';')) {
      const executablePath = expandWindowsEnv(rawCandidate.trim());
      if (!executablePath) continue;

      targets.push({
        browser,
        executablePath,
        exists: fs.existsSync(executablePath),
        configuredVersion: inferVersionFromPath(executablePath),
      });
    }
  }

  return targets;
}

function inferVersionFromPath(executablePath) {
  const parts = executablePath.split(/[\\/]+/);
  const versionLike = [...parts].reverse().find((part) => /^\d+\.\d+(?:\.\d+){0,3}$/.test(part));
  return versionLike || 'system';
}

function sanitizeSegment(value) {
  return String(value || 'unknown').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function getBrowserType(browser) {
  if (browser === 'firefox') return firefox;
  if (browser === 'webkit' || browser === 'safari') return webkit;
  return chromium;
}

function getLaunchOptions(target) {
  const options = {
    headless: readBoolean('HEADLESS', false),
  };

  if (target.browser === 'firefox' && readBoolean('FIREFOX_USE_PLAYWRIGHT_BUNDLED', true)) {
    return options;
  }

  options.executablePath = target.executablePath;
  return options;
}

function usesBundledFirefox(target) {
  return target.browser === 'firefox' && readBoolean('FIREFOX_USE_PLAYWRIGHT_BUNDLED', true);
}

function isUnsupportedAutomationTarget(target) {
  return target.browser === 'duckduckgo';
}

async function closeWithTimeout(label, closeFn) {
  const timeoutMs = Number(process.env.BROWSER_CLOSE_TIMEOUT_MS || 5000);
  let timeout;

  try {
    await Promise.race([
      closeFn(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} close timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(`Warning: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function getFingerprint(page) {
  return page.evaluate(() => {
    const data = window.FingerprintData;
    if (!data) {
      return { __error: 'window.FingerprintData is not defined' };
    }

    const getter =
      typeof data.getFingerPrint === 'function'
        ? data.getFingerPrint
        : typeof data.getFingerprint === 'function'
          ? data.getFingerprint
          : null;

    if (!getter) {
      return { __error: 'FingerprintData getter function is not available' };
    }

    return getter.call(data);
  });
}

async function getDfsCookies(page) {
  return page.evaluate(() => document.cookie.split(';').map((cookie) => cookie.trim()).filter((cookie) => cookie.startsWith('dfs_')));
}

function parseCookieArray(cookieArray) {
  const cookieMap = {};
  for (const cookie of cookieArray || []) {
    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex === -1) continue;
    cookieMap[cookie.slice(0, separatorIndex).trim()] = cookie.slice(separatorIndex + 1);
  }
  return cookieMap;
}

function compareCookieToFingerprint(cookieMap, fingerprint) {
  const comparisons = {};
  for (const [key, cookieValue] of Object.entries(cookieMap)) {
    const fingerprintValue = getFingerprintValue(fingerprint, key);
    comparisons[key] = {
      cookieValue,
      fingerprintValue,
      comparable: fingerprintValue !== undefined && fingerprintValue !== null,
      matches: fingerprintValue === undefined || fingerprintValue === null ? null : String(fingerprintValue) === String(cookieValue),
    };
  }
  return comparisons;
}

function getBitValue(bitString, bitNumber) {
  if (bitString === undefined || bitString === null) return null;
  const text = String(bitString);
  const index = Number(bitNumber);
  if (index < 0 || index >= text.length) return null;
  return text[index];
}

function getFingerprintValue(fingerprint, key) {
  if (!fingerprint || typeof fingerprint !== 'object') return undefined;
  const stack = [fingerprint];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    if (Object.prototype.hasOwnProperty.call(current, key)) {
      return current[key];
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }

  return undefined;
}

function collectFingerprintEntries(fingerprint) {
  const entries = [];
  const stack = [fingerprint];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    for (const [key, value] of Object.entries(current)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      } else {
        entries.push([key, value]);
      }
    }
  }

  return entries;
}

function getExpectedDfsE6(browser) {
  const osCode = OS_CODES[process.platform];
  const browserCode = BROWSER_CODES[browser];
  if (!osCode || !browserCode) return undefined;
  return `${osCode} - ${browserCode}`;
}

function matcherFromConfig(value) {
  if (!value) return () => false;
  if (value.startsWith('/') && value.lastIndexOf('/') > 0) {
    const lastSlash = value.lastIndexOf('/');
    const pattern = value.slice(1, lastSlash);
    const flags = value.slice(lastSlash + 1);
    const regex = new RegExp(pattern, flags);
    return (url) => regex.test(url);
  }
  return (url) => url.includes(value);
}

async function waitForLoginRequest(page, matcher) {
  const matches = matcherFromConfig(matcher);
  return page.waitForRequest((request) => matches(request.url()), {
    timeout: Number(process.env.LOGIN_REQUEST_TIMEOUT_MS || 30000),
  });
}

function saveJson(fileName, data) {
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return fileName;
}

async function saveScreenshot(page, name) {
  const fileName = path.join(currentRun.outputDir, 'screenshots', `${name}.png`);
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  await page.screenshot({ path: fileName, fullPage: true });
  return fileName;
}

function saveText(fileName, text) {
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, text, 'utf8');
  return fileName;
}

function addResult(results, testName, status, details, evidenceFilePaths = [], errors = []) {
  results.push({
    testName,
    status,
    details,
    evidenceFilePaths,
    errors: errors.map((error) => error && error.message ? error.message : String(error)),
  });
}

function requiredCookieFailures(cookieMap) {
  return REQUIRED_DFS_COOKIES.filter((key) => !cookieMap[key]);
}

function extractFingerprintValues(fingerprint) {
  const values = {};
  if (!fingerprint || typeof fingerprint !== 'object') return values;

  for (const [key, value] of collectFingerprintEntries(fingerprint)) {
    const matchesPrefixPattern = FINGERPRINT_PREFIXES.some((prefix) => DFS_KEY_PATTERN_BY_PREFIX[prefix].test(key));
    if (matchesPrefixPattern && value !== undefined && value !== null && value !== '') {
      values[key] = value;
    }
  }
  return values;
}

function flattenDfsBValues(fingerprint) {
  if (!fingerprint || typeof fingerprint !== 'object') return '';
  return collectFingerprintEntries(fingerprint)
    .filter(([key]) => /^dfs_B_\d+$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([, value]) => value)
    .filter((value) => value !== undefined && value !== null && value !== '')
    .join('');
}

function findAuthTelemetry(payload) {
  if (!payload) return undefined;
  if (typeof payload === 'string') {
    try {
      return findAuthTelemetry(JSON.parse(payload));
    } catch {
      const params = new URLSearchParams(payload);
      return params.get('auth_fingerprintTelemetry') || undefined;
    }
  }
  if (typeof payload !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(payload, 'auth_fingerprintTelemetry')) {
    return payload.auth_fingerprintTelemetry;
  }
  for (const value of Object.values(payload)) {
    const found = findAuthTelemetry(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

function readBoolean(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

function readString(name, defaultValue = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? defaultValue : value;
}

async function maybeMoveMouse(page) {
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const points = [
    [Math.floor(viewport.width * 0.2), Math.floor(viewport.height * 0.3)],
    [Math.floor(viewport.width * 0.8), Math.floor(viewport.height * 0.4)],
    [Math.floor(viewport.width * 0.5), Math.floor(viewport.height * 0.7)],
    [Math.floor(viewport.width * 0.3), Math.floor(viewport.height * 0.5)],
  ];

  for (const [x, y] of points) {
    await page.mouse.move(x, y, { steps: 20 });
    await page.waitForTimeout(250);
  }
}

async function fillAndSubmit(page) {
  const usernameSelector = process.env.USERNAME_SELECTOR;
  const passwordSelector = process.env.PASSWORD_SELECTOR;
  const submitSelector = process.env.SUBMIT_SELECTOR;
  const username = process.env.LOGIN_USERNAME;
  const password = process.env.LOGIN_PASSWORD;

  if (!usernameSelector || !passwordSelector || !username || !password) {
    throw new Error('SUBMIT_CREDENTIALS requires USERNAME_SELECTOR, PASSWORD_SELECTOR, LOGIN_USERNAME, and LOGIN_PASSWORD.');
  }

  await page.locator(usernameSelector).waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await page.locator(usernameSelector).fill(username);
  await page.locator(passwordSelector).waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await page.locator(passwordSelector).fill(password);

  if (submitSelector) {
    await page.locator(submitSelector).click();
  } else {
    await page.locator(passwordSelector).press('Enter');
  }
}

function getReleaseVersion() {
  return process.env.RELEASE_VERSION || process.env.RELEASEVERSION || process.env.EXPECTED_DFS_E_8 || 'unversioned';
}

let currentRun = { outputDir: ROOT_DIR };

async function runTarget(target, config) {
  const results = [];
  const consoleMessages = [];
  const releaseVersion = getReleaseVersion();
  const browserVersion = target.configuredVersion;
  const outputDir = path.join(ROOT_DIR, 'evidence', sanitizeSegment(releaseVersion), sanitizeSegment(target.browser), sanitizeSegment(browserVersion));
  currentRun = { outputDir };
  fs.mkdirSync(path.join(outputDir, 'screenshots'), { recursive: true });

  const metadata = {
    browser: target.browser,
    configuredVersion: target.configuredVersion,
    executablePath: target.executablePath,
    launchMode: usesBundledFirefox(target) ? 'playwright-bundled-firefox' : 'configured-executable',
    targetUrl: config.targetUrl,
    releaseVersion,
    startedAt: new Date().toISOString(),
  };

  if (isUnsupportedAutomationTarget(target)) {
    metadata.launchMode = 'manual-validation-required';
    metadata.finishedAt = new Date().toISOString();
    metadata.actualBrowserVersion = null;
    addResult(
      results,
      'Browser Automation Support',
      'SKIP',
      {
        browser: target.browser,
        executablePath: target.executablePath,
        reason: 'DuckDuckGo for Windows is packaged as a Windows app and does not expose a Playwright-controllable Chromium launch surface.',
        recommendation: 'Run DuckDuckGo validation separately as a manual evidence pass.',
      },
      [],
      ['DuckDuckGo automation is handled outside Playwright.']
    );
    saveJson(path.join(outputDir, 'summary-report.json'), {
      metadata,
      totals: {
        passed: 0,
        failed: 0,
        skipped: results.length,
        total: results.length,
      },
      results,
    });
    return { metadata, results };
  }

  if (!target.exists) {
    addResult(results, 'Browser Executable Exists', 'FAIL', metadata, [], [`Missing executable: ${target.executablePath}`]);
    saveJson(path.join(outputDir, 'summary-report.json'), { metadata, results });
    return { metadata, results };
  }

  const browserType = getBrowserType(target.browser);
  let browser;

  let context;
  let page;
  let initialFingerprint = null;
  let initialCookieMap = {};
  let initialDfsF1 = undefined;
  let initialDfsF2 = undefined;

  try {
    browser = await browserType.launch(getLaunchOptions(target));

    context = await browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    });
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        consoleMessages.push({
          type: message.type(),
          text: message.text(),
          location: message.location(),
          timestamp: new Date().toISOString(),
        });
      }
    });
    page.on('pageerror', (error) => {
      consoleMessages.push({
        type: 'pageerror',
        text: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      });
    });

    await page.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000));

    const screenshotInitial = await saveScreenshot(page, 'initial-page');
    initialFingerprint = await getFingerprint(page);
    const initialCookies = await getDfsCookies(page);
    initialCookieMap = parseCookieArray(initialCookies);
    initialDfsF1 = getFingerprintValue(initialFingerprint, 'dfs_F_1');
    initialDfsF2 = getFingerprintValue(initialFingerprint, 'dfs_F_2');

    const consoleFile = saveJson(path.join(outputDir, 'console-log.json'), consoleMessages);
    const fingerprintFile = saveJson(path.join(outputDir, 'fingerprint-initial.json'), initialFingerprint);
    const dfsRelatedMessages = consoleMessages.filter((entry) => DFS_ERROR_PATTERNS.some((pattern) => pattern.test(entry.text)));
    const forbiddenMessages = consoleMessages.filter((entry) => SPECIFIC_FORBIDDEN_ERRORS.some((text) => entry.text.includes(text)));
    const fingerprintAvailable = initialFingerprint && typeof initialFingerprint === 'object' && !initialFingerprint.__error;
    addResult(
      results,
      'Script Initialization and Page Load',
      dfsRelatedMessages.length === 0 && forbiddenMessages.length === 0 && fingerprintAvailable ? 'PASS' : 'FAIL',
      {
        dfsRelatedMessages,
        forbiddenMessages,
        fingerprintAvailable,
      },
      [screenshotInitial, consoleFile, fingerprintFile],
      fingerprintAvailable ? [] : [initialFingerprint && initialFingerprint.__error ? initialFingerprint.__error : 'FingerprintData unavailable']
    );

    const cookiesFile = saveJson(path.join(outputDir, 'cookies-initial.json'), initialCookieMap);
    const cookieComparison = compareCookieToFingerprint(initialCookieMap, initialFingerprint);
    const cookieComparisonFile = saveJson(path.join(outputDir, 'cookie-fingerprint-comparison-initial.json'), cookieComparison);
    const missingCookies = requiredCookieFailures(initialCookieMap);
    addResult(
      results,
      'Cookie Presence on Page Load',
      missingCookies.length === 0 ? 'PASS' : 'FAIL',
      { missingCookies, cookieComparison },
      [cookiesFile, cookieComparisonFile],
      missingCookies.map((key) => `Missing or empty cookie: ${key}`)
    );

    const browserDetection = {
      browser: target.browser,
      userAgent: await page.evaluate(() => navigator.userAgent),
      dfs_E_6_cookie: initialCookieMap.dfs_E_6,
      dfs_E_6_fingerprint: getFingerprintValue(initialFingerprint, 'dfs_E_6'),
      expectedValue: getExpectedDfsE6(target.browser),
      expectedFormat: 'dd - dd',
    };
    const browserDetectionFile = saveJson(path.join(outputDir, 'browser-detection.json'), browserDetection);
    const e6FormatOk = /^\d{2}\s-\s\d{2}$/.test(String(browserDetection.dfs_E_6_cookie || ''));
    const e6Matches = browserDetection.dfs_E_6_fingerprint === undefined || String(browserDetection.dfs_E_6_cookie) === String(browserDetection.dfs_E_6_fingerprint);
    const e6ExpectedMatches = !browserDetection.expectedValue || String(browserDetection.dfs_E_6_cookie) === browserDetection.expectedValue;
    addResult(
      results,
      'Browser Detection',
      e6FormatOk && e6Matches && e6ExpectedMatches ? 'PASS' : 'FAIL',
      browserDetection,
      [browserDetectionFile],
      [
        ...(e6FormatOk ? [] : ['dfs_E_6 does not match expected format dd - dd']),
        ...(e6Matches ? [] : ['dfs_E_6 cookie does not match fingerprint value']),
        ...(e6ExpectedMatches ? [] : [`dfs_E_6 expected ${browserDetection.expectedValue} for ${process.platform}/${target.browser}, got ${browserDetection.dfs_E_6_cookie}`]),
      ]
    );

    const e7 = String(initialCookieMap.dfs_E_7 || getFingerprintValue(initialFingerprint, 'dfs_E_7') || '');
    const expectedWebdriverBit0 = readString('EXPECTED_DFS_E7_BIT0', '1');
    const scarBits = {
      dfs_E_7: e7,
      indexing: 'zero-based; bit 0 is the first character',
      expectations: {
        bit0: expectedWebdriverBit0,
        bit1: '0',
        bit16: '0',
        bit22: '0',
        bit25: '0',
        bit26: '0',
        bit27: '0',
      },
      bit0: getBitValue(e7, 0),
      bit1: getBitValue(e7, 1),
      bit16: getBitValue(e7, 16),
      bit22: getBitValue(e7, 22),
      bit25: getBitValue(e7, 25),
      bit26: getBitValue(e7, 26),
      bit27: getBitValue(e7, 27),
    };
    const scarFile = saveJson(path.join(outputDir, 'scar-bit-evaluation.json'), scarBits);
    const scarFailures = Object.entries(scarBits.expectations)
      .filter(([key, expectedValue]) => scarBits[key] !== expectedValue)
      .map(([key, expectedValue]) => `${key} expected ${expectedValue}, got ${scarBits[key]}`);
    addResult(results, 'AI Score / SCAR Testing', scarFailures.length === 0 ? 'PASS' : 'FAIL', scarBits, [scarFile], scarFailures);

    const privateMode = { dfs_E_1: getFingerprintValue(initialFingerprint, 'dfs_E_1') };
    const privateModeFile = saveJson(path.join(outputDir, 'private-mode.json'), privateMode);
    addResult(
      results,
      'Private / Incognito Mode Detection',
      String(privateMode.dfs_E_1) === '0' ? 'PASS' : 'FAIL',
      privateMode,
      [privateModeFile],
      String(privateMode.dfs_E_1) === '0' ? [] : [`dfs_E_1 expected 0, got ${privateMode.dfs_E_1}`]
    );

    const fingerprintValues = extractFingerprintValues(initialFingerprint);
    const fingerprintValuesText = Object.keys(fingerprintValues).sort().map((key) => `${key}=${fingerprintValues[key]}`).join('\n');
    const fingerprintValuesFile = saveText(path.join(outputDir, 'fingerprint-values.txt'), `${fingerprintValuesText}\n`);
    const missingPrefixes = FINGERPRINT_PREFIXES.filter((prefix) => !Object.keys(fingerprintValues).some((key) => DFS_KEY_PATTERN_BY_PREFIX[prefix].test(key)));
    addResult(
      results,
      'Fingerprint Payload Availability',
      missingPrefixes.length === 0 ? 'PASS' : 'FAIL',
      { foundKeys: Object.keys(fingerprintValues).sort(), missingPrefixes },
      [fingerprintValuesFile, fingerprintFile],
      missingPrefixes.map((prefix) => `No non-empty key found for ${prefix}*`)
    );

    if (readBoolean('PERFORM_MOUSE_MOVEMENT', true)) {
      await page.waitForTimeout(Number(process.env.MOUSE_WAIT_BEFORE_MS || 15000));
      await maybeMoveMouse(page);
      await page.waitForTimeout(Number(process.env.MOUSE_WAIT_AFTER_MS || 1000));
      const afterMouseScreenshot = await saveScreenshot(page, 'after-mouse');
      const fingerprintAfterMouse = await getFingerprint(page);
      const afterMouseDfsF2 = getFingerprintValue(fingerprintAfterMouse, 'dfs_F_2');
      const afterMouseFile = saveJson(path.join(outputDir, 'fingerprint-after-mouse.json'), fingerprintAfterMouse);
      const mouseComparison = {
        before: initialDfsF2,
        after: afterMouseDfsF2,
        changed: initialDfsF2 !== undefined && afterMouseDfsF2 !== undefined && String(initialDfsF2) !== String(afterMouseDfsF2),
      };
      const mouseFile = saveJson(path.join(outputDir, 'mouse-telemetry-comparison.json'), mouseComparison);
      addResult(
        results,
        'Mouse Telemetry Updates with Movement',
        mouseComparison.changed ? 'PASS' : 'FAIL',
        mouseComparison,
        [afterMouseScreenshot, afterMouseFile, mouseFile],
        mouseComparison.changed ? [] : ['dfs_F_2 did not change after mouse movement']
      );
    }

    await page.reload({ waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded', timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000) });
    await page.waitForTimeout(Number(process.env.POST_RELOAD_WAIT_MS || 5000));
    const fingerprintAfterReload = await getFingerprint(page);
    const afterReloadDfsF1 = getFingerprintValue(fingerprintAfterReload, 'dfs_F_1');
    const afterReloadFile = saveJson(path.join(outputDir, 'fingerprint-after-reload.json'), fingerprintAfterReload);
    const reloadComparison = {
      before: initialDfsF1,
      after: afterReloadDfsF1,
      stable: initialDfsF1 !== undefined && afterReloadDfsF1 !== undefined && String(initialDfsF1) === String(afterReloadDfsF1),
    };
    const reloadFile = saveJson(path.join(outputDir, 'session-stability.json'), reloadComparison);
    addResult(
      results,
      'Session Stability',
      reloadComparison.stable ? 'PASS' : 'FAIL',
      reloadComparison,
      [afterReloadFile, reloadFile],
      reloadComparison.stable ? [] : ['dfs_F_1 changed after reload']
    );

    if (readBoolean('SUBMIT_CREDENTIALS', false)) {
      const matcher = process.env.LOGIN_REQUEST_MATCHER || '';
      const requestPromise = matcher ? waitForLoginRequest(page, matcher).catch((error) => ({ __error: error.message })) : Promise.resolve({ __error: 'LOGIN_REQUEST_MATCHER is not configured' });
      await fillAndSubmit(page);
      const loginRequest = await requestPromise;
      await page.waitForLoadState(process.env.POST_SUBMIT_LOAD_STATE || 'networkidle', { timeout: Number(process.env.POST_SUBMIT_TIMEOUT_MS || 30000) }).catch(() => {});
      const afterSubmitScreenshot = await saveScreenshot(page, 'after-submit');
      const afterSubmitCookies = parseCookieArray(await getDfsCookies(page));
      const afterSubmitFingerprint = await getFingerprint(page);
      const requestDetails = loginRequest.__error
        ? { error: loginRequest.__error }
        : {
            url: loginRequest.url(),
            method: loginRequest.method(),
            headers: loginRequest.headers(),
            postData: loginRequest.postData(),
            postDataJSON: loginRequest.postDataJSON ? tryPostDataJson(loginRequest) : null,
          };
      const requestFile = saveJson(path.join(outputDir, 'network-login-request.json'), requestDetails);
      const afterSubmitCookiesFile = saveJson(path.join(outputDir, 'cookies-after-submit.json'), afterSubmitCookies);
      const afterSubmitFingerprintFile = saveJson(path.join(outputDir, 'fingerprint-after-submit.json'), afterSubmitFingerprint);
      const afterSubmitComparison = compareCookieToFingerprint(afterSubmitCookies, afterSubmitFingerprint);
      const expectedTelemetry = flattenDfsBValues(afterSubmitFingerprint);
      const actualTelemetry = findAuthTelemetry(requestDetails.postDataJSON || requestDetails.postData);
      const headers = requestDetails.headers || {};
      const submitValidation = {
        missingCookies: requiredCookieFailures(afterSubmitCookies),
        cookieComparison: afterSubmitComparison,
        auth_fingerprintTelemetry: {
          actual: actualTelemetry,
          expectedConcatenatedDfsB: expectedTelemetry,
          matches: actualTelemetry === undefined || !expectedTelemetry ? null : String(actualTelemetry) === String(expectedTelemetry),
        },
        headers: {
          dfsosbrowser: headers.dfsosbrowser,
          expectedDfsOsBrowser: afterSubmitCookies.dfs_E_6,
          dfsagenticscore: headers.dfsagenticscore,
          expectedDfsAgenticScore: afterSubmitCookies.dfs_E_5,
        },
      };
      const submitComparisonFile = saveJson(path.join(outputDir, 'submit-request-comparison.json'), submitValidation);
      const submitFailures = [
        ...submitValidation.missingCookies.map((key) => `Missing or empty cookie after submit: ${key}`),
        ...(submitValidation.auth_fingerprintTelemetry.matches === false ? ['auth_fingerprintTelemetry does not match concatenated dfs_B* value'] : []),
        ...(headers.dfsosbrowser && afterSubmitCookies.dfs_E_6 && headers.dfsosbrowser !== afterSubmitCookies.dfs_E_6 ? ['dfsosbrowser header does not match dfs_E_6'] : []),
        ...(headers.dfsagenticscore && afterSubmitCookies.dfs_E_5 && headers.dfsagenticscore !== afterSubmitCookies.dfs_E_5 ? ['dfsagenticscore header does not match dfs_E_5'] : []),
        ...(requestDetails.error ? [requestDetails.error] : []),
      ];
      addResult(
        results,
        'Cookies and Payload After Form Submission',
        submitFailures.length === 0 ? 'PASS' : 'FAIL',
        submitValidation,
        [afterSubmitScreenshot, requestFile, afterSubmitCookiesFile, afterSubmitFingerprintFile, submitComparisonFile],
        submitFailures
      );
    }

    const expectedDfsE8 = process.env.EXPECTED_DFS_E_8 || process.env.RELEASE_VERSION;
    if (expectedDfsE8) {
      const actual = initialCookieMap.dfs_E_8 || getFingerprintValue(initialFingerprint, 'dfs_E_8');
      const releaseComparison = { expected: expectedDfsE8, actual, matches: String(actual) === String(expectedDfsE8) };
      const releaseFile = saveJson(path.join(outputDir, 'release-version-comparison.json'), releaseComparison);
      addResult(
        results,
        'Release Version Compared To dfs_E_8',
        releaseComparison.matches ? 'PASS' : 'FAIL',
        releaseComparison,
        [releaseFile],
        releaseComparison.matches ? [] : [`dfs_E_8 expected ${expectedDfsE8}, got ${actual}`]
      );
    }
  } catch (error) {
    addResult(results, 'Unhandled Browser Run Error', 'FAIL', metadata, [], [error]);
  } finally {
    const consoleFile = saveJson(path.join(outputDir, 'console-log.json'), consoleMessages);
    metadata.finishedAt = new Date().toISOString();
    metadata.actualBrowserVersion = browser ? browser.version() : null;
    const summary = {
      metadata,
      totals: {
        passed: results.filter((result) => result.status === 'PASS').length,
        failed: results.filter((result) => result.status === 'FAIL').length,
        skipped: results.filter((result) => result.status === 'SKIP').length,
        total: results.length,
      },
      results,
    };
    saveJson(path.join(outputDir, 'summary-report.json'), summary);
    if (page && !page.isClosed()) await closeWithTimeout('Page', () => page.close());
    if (context) await closeWithTimeout('Browser context', () => context.close());
    if (browser) await closeWithTimeout('Browser', () => browser.close());
    return { metadata, results, consoleFile };
  }
}

function tryPostDataJson(request) {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relativeLink(fromDir, toPath) {
  return path.relative(fromDir, toPath).replace(/\\/g, '/');
}

function writeCoverReport(releaseDir, aggregate, aggregateJsonPath, context) {
  const allTestNames = [...new Set(aggregate.flatMap((item) => item.results.map((result) => result.testName)))];
  const totals = {
    browsers: aggregate.length,
    tests: aggregate.reduce((sum, item) => sum + item.results.length, 0),
    passed: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'PASS').length, 0),
    failed: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'FAIL').length, 0),
    skipped: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'SKIP').length, 0),
  };
  const generatedAt = new Date().toISOString();

  const rows = aggregate.map((item) => {
    const resultByName = new Map(item.results.map((result) => [result.testName, result]));
    const runDir = path.join(
      releaseDir,
      sanitizeSegment(item.metadata.browser),
      sanitizeSegment(item.metadata.configuredVersion)
    );
    const summaryLink = relativeLink(releaseDir, path.join(runDir, 'summary-report.json'));
    const evidenceLink = relativeLink(releaseDir, runDir);
    const cells = allTestNames.map((testName) => {
      const result = resultByName.get(testName);
      if (!result) return '<td class="skip">N/A</td>';
      const statusClass = result.status === 'PASS' ? 'pass' : result.status === 'FAIL' ? 'fail' : 'skip';
      const title = result.errors && result.errors.length > 0 ? ` title="${escapeHtml(result.errors.join('; '))}"` : '';
      return `<td class="${statusClass}"${title}>${escapeHtml(result.status)}</td>`;
    }).join('');

    return `
      <tr>
        <td>${escapeHtml(item.metadata.browser)}</td>
        <td>${escapeHtml(item.metadata.configuredVersion)}</td>
        <td>${escapeHtml(item.metadata.actualBrowserVersion || '')}</td>
        <td>${escapeHtml(item.metadata.launchMode || '')}</td>
        <td><a href="${escapeHtml(evidenceLink)}">folder</a> | <a href="${escapeHtml(summaryLink)}">summary</a></td>
        ${cells}
      </tr>`;
  }).join('\n');

  const headers = allTestNames.map((testName) => `<th>${escapeHtml(testName)}</th>`).join('');
  const reportPath = path.join(releaseDir, 'cover-report.html');
  const aggregateLink = relativeLink(releaseDir, aggregateJsonPath);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>DFS Evidence Report ${escapeHtml(context.releaseVersion)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #1f2933; }
    h1 { margin-bottom: 4px; }
    .meta { color: #52616b; margin: 4px 0; }
    .totals { display: flex; gap: 16px; margin: 20px 0; }
    .total { border: 1px solid #d9e2ec; padding: 10px 12px; border-radius: 4px; min-width: 110px; }
    .total strong { display: block; font-size: 20px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #d9e2ec; padding: 8px; vertical-align: top; }
    th { background: #f0f4f8; text-align: left; position: sticky; top: 0; }
    .pass { background: #e3fcef; color: #0f5132; font-weight: bold; }
    .fail { background: #ffe3e3; color: #842029; font-weight: bold; }
    .skip { background: #f7f7f7; color: #697386; font-weight: bold; }
    a { color: #0b5cab; }
  </style>
</head>
<body>
  <h1>DFS Evidence Report</h1>
  <p class="meta">Release: ${escapeHtml(context.releaseVersion)}</p>
  <p class="meta">Target URL: ${escapeHtml(context.targetUrl)}</p>
  <p class="meta">Generated: ${escapeHtml(generatedAt)}</p>
  <p class="meta">Aggregate JSON: <a href="${escapeHtml(aggregateLink)}">${escapeHtml(aggregateLink)}</a></p>
  <div class="totals">
    <div class="total"><strong>${totals.browsers}</strong> Browser Runs</div>
    <div class="total"><strong>${totals.tests}</strong> Tests</div>
    <div class="total"><strong>${totals.passed}</strong> Passed</div>
    <div class="total"><strong>${totals.failed}</strong> Failed</div>
    <div class="total"><strong>${totals.skipped}</strong> Skipped</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Browser</th>
        <th>Configured Version</th>
        <th>Actual Version</th>
        <th>Launch Mode</th>
        <th>Evidence</th>
        ${headers}
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>
`;
  fs.writeFileSync(reportPath, html, 'utf8');
  return reportPath;
}

async function main() {
  loadEnvFile(process.env.DFS_ENV_FILE || DEFAULT_ENV_FILE);
  const targetUrl = process.env.TARGET_URL;
  if (!targetUrl) {
    throw new Error('TARGET_URL is required. Set it in .env or the environment.');
  }

  const selectedBrowsers = (process.env.BROWSERS || '')
    .split(',')
    .map((browser) => browser.trim())
    .filter(Boolean);
  const targets = discoverBrowserTargets()
    .filter((target) => selectedBrowsers.length === 0 || selectedBrowsers.includes(target.browser));

  if (targets.length === 0) {
    throw new Error(`No browser executable paths found in ${BROWSER_PATHS_FILE}.`);
  }

  const aggregate = [];
  for (const target of targets) {
    const launchNote = usesBundledFirefox(target) ? ' using Playwright bundled Firefox' : '';
    console.log(`Running ${target.browser} ${target.configuredVersion}: ${target.executablePath}${launchNote}`);
    const result = await runTarget(target, { targetUrl });
    const failed = result.results.filter((test) => test.status === 'FAIL').length;
    const passed = result.results.filter((test) => test.status === 'PASS').length;
    const skipped = result.results.filter((test) => test.status === 'SKIP').length;
    console.log(`  ${passed}/${result.results.length} passed, ${failed} failed, ${skipped} skipped`);
    aggregate.push(result);
  }

  const releaseVersion = getReleaseVersion();
  const releaseDir = path.join(ROOT_DIR, 'evidence', sanitizeSegment(releaseVersion));
  const aggregatePath = path.join(releaseDir, 'summary-report.json');
  saveJson(aggregatePath, {
    releaseVersion,
    targetUrl,
    totals: {
      browsers: aggregate.length,
      tests: aggregate.reduce((sum, item) => sum + item.results.length, 0),
      passed: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'PASS').length, 0),
      failed: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'FAIL').length, 0),
      skipped: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'SKIP').length, 0),
    },
    runs: aggregate.map((item) => ({
      metadata: item.metadata,
      results: item.results,
    })),
  });
  const coverReportPath = writeCoverReport(releaseDir, aggregate, aggregatePath, { releaseVersion, targetUrl });

  console.log(`Summary: ${aggregatePath}`);
  console.log(`Cover report: ${coverReportPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
