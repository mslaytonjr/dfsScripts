const fs = require('fs');
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');

const ROOT_DIR = __dirname;
const BROWSER_PATHS_FILE = path.join(ROOT_DIR, 'browser-paths.properties');
const DEFAULT_ENV_FILE = path.join(ROOT_DIR, '.env');
const REQUIRED_DFS_COOKIES = ['dfs_E_4', 'dfs_E_5', 'dfs_E_6', 'dfs_E_7', 'dfs_E_8', 'dfs_F_5', 'dfs_F_6', 'dfs_F_7'];
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
const DFS_E7_GLOBAL_TOKENS = 5;
const DFS_E7_PER_FIELD_TOKENS = 8;
const DFS_E7_MAX_FIELDS = 4;
const DFS_E7_MIN_DIGITS = DFS_E7_GLOBAL_TOKENS * 2;
const DFS_E7_MAX_DIGITS = (DFS_E7_GLOBAL_TOKENS + (DFS_E7_MAX_FIELDS * DFS_E7_PER_FIELD_TOKENS)) * 2;
const E7_POS = {
  VALUE_INJECTION: 0,
  SYNTHETIC_EVENTS: 1,
  POINTER_LOCK: 2,
  POINTER_TRAVEL: 3,
  COLD_FOCUS: 4,
};
const E7_FIELD = {
  INJECTED_TEXT: 0,
  PASTE_FRAGMENTATION: 1,
  CADENCE_RIGIDITY: 2,
  FOCUS_ANOMALY: 3,
  DWELL_ANOMALY: 4,
  FILL_SPEED: 5,
  FOCUS_NO_POINTER: 6,
  KEY_INPUT_MISMATCH: 7,
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
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
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
    headless: readBoolean('HEADLESS', true),
  };

  if (target.browser === 'firefox' && readBoolean('FIREFOX_USE_PLAYWRIGHT_BUNDLED', true)) {
    return options;
  }

  options.executablePath = target.executablePath;
  return options;
}

function getPrivateModeLaunchOptions(target) {
  const options = getLaunchOptions(target);
  if (target.browser === 'firefox') {
    return {
      ...options,
      firefoxUserPrefs: {
        ...(options.firefoxUserPrefs || {}),
        'browser.privatebrowsing.autostart': true,
      },
    };
  }
  if (['chrome', 'edge', 'opera', 'comet', 'atlas'].includes(target.browser)) {
    return {
      ...options,
      args: [...(options.args || []), '--incognito'],
    };
  }
  return null;
}

function usesBundledFirefox(target) {
  return target.browser === 'firefox' && readBoolean('FIREFOX_USE_PLAYWRIGHT_BUNDLED', true);
}

function isUnsupportedAutomationTarget(target) {
  return target.browser === 'duckduckgo';
}

async function closeWithTimeout(label, closeFn) {
  const timeoutMs = Number(process.env.BROWSER_CLOSE_TIMEOUT_MS || 5000);
  await runWithTimeout(`${label} close`, timeoutMs, closeFn).catch((error) => {
    console.warn(`Warning: ${error.message}`);
  });
}

async function runWithTimeout(label, timeoutMs, action) {
  let timeout;

  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function readFingerprintNow(page) {
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

async function waitForFingerprintData(page, timeout = Number(process.env.FINGERPRINT_DATA_WAIT_TIMEOUT_MS || 15000)) {
  try {
    await page.waitForFunction(
      () => {
        const data = window.FingerprintData;
        return Boolean(
          data &&
          (typeof data.getFingerPrint === 'function' || typeof data.getFingerprint === 'function')
        );
      },
      null,
      { timeout }
    );
    return { available: true, timeoutMs: timeout };
  } catch (error) {
    return { available: false, timeoutMs: timeout, error: error.message };
  }
}

async function getFingerprint(page, options = {}) {
  const wait = options.wait !== false;
  const waitResult = wait
    ? await waitForFingerprintData(page, options.timeout)
    : { available: true, timeoutMs: 0 };
  const fingerprint = await readFingerprintNow(page);
  if (fingerprint && typeof fingerprint === 'object' && fingerprint.__error) {
    return {
      ...fingerprint,
      __wait: waitResult,
    };
  }
  return fingerprint;
}

async function waitForDfsE7Value(page, context, timeout = Number(process.env.DFS_E7_WAIT_TIMEOUT_MS || 15000)) {
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt <= timeout) {
    const fingerprint = await readFingerprintNow(page).catch((error) => ({ __error: error.message }));
    const documentCookieList = await getDfsCookies(page).catch((error) => ({ __error: error.message }));
    const documentDfsCookies = Array.isArray(documentCookieList) ? parseCookieArray(documentCookieList) : {};
    const contextDfsCookies = await getDfsContextCookies(context).catch((error) => ({ __error: error.message }));
    const e7 = String(
      documentDfsCookies.dfs_E_7 ||
      contextDfsCookies.dfs_E_7 ||
      getFingerprintValue(fingerprint, 'dfs_E_7') ||
      ''
    );

    lastState = {
      fingerprint,
      documentCookieList,
      documentDfsCookies,
      contextDfsCookies,
      dfs_E_7: e7,
      waitedMs: Date.now() - startedAt,
    };

    if (e7) {
      return {
        found: true,
        timeoutMs: timeout,
        ...lastState,
      };
    }

    await page.waitForTimeout(250);
  }

  return {
    found: false,
    timeoutMs: timeout,
    ...(lastState || {}),
  };
}

async function getDfsCookies(page) {
  return page.evaluate(() => document.cookie.split(';').map((cookie) => cookie.trim()).filter((cookie) => cookie.startsWith('dfs_')));
}

async function waitForDfsCookie(page, cookieName, timeout = Number(process.env.COOKIE_WAIT_TIMEOUT_MS || 15000)) {
  await page.waitForFunction(
    (name) => document.cookie.split(';').map((cookie) => cookie.trim()).some((cookie) => cookie.startsWith(`${name}=`)),
    cookieName,
    { timeout }
  );
}

async function waitForDfsFingerprintValue(page, key, timeout = Number(process.env.FINGERPRINT_WAIT_TIMEOUT_MS || 15000)) {
  await page.waitForFunction(
    (fingerprintKey) => {
      const data = window.FingerprintData;
      const getter =
        data && typeof data.getFingerPrint === 'function'
          ? data.getFingerPrint
          : data && typeof data.getFingerprint === 'function'
            ? data.getFingerprint
            : null;
      if (!getter) return false;
      const fingerprint = getter.call(data);
      const stack = [fingerprint];
      const seen = new Set();
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        if (Object.prototype.hasOwnProperty.call(current, fingerprintKey)) {
          return current[fingerprintKey] !== undefined && current[fingerprintKey] !== null;
        }
        for (const value of Object.values(current)) {
          if (value && typeof value === 'object') stack.push(value);
        }
      }
      return false;
    },
    key,
    { timeout }
  );
}

async function getDfsContextCookies(context) {
  const cookies = await context.cookies();
  return Object.fromEntries(
    cookies
      .filter((cookie) => cookie.name && cookie.name.startsWith('dfs_'))
      .map((cookie) => [cookie.name, cookie.value])
  );
}

async function waitForDfsContextCookie(context, cookieName, timeout = Number(process.env.COOKIE_WAIT_TIMEOUT_MS || 15000)) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeout) {
    const cookies = await getDfsContextCookies(context);
    if (cookies[cookieName] !== undefined) return cookies;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${cookieName} in browser cookie jar after ${timeout}ms`);
}

async function getDfsE5DebugLog(page) {
  return page.evaluate(() => Array.isArray(window.__DFS_E5_DEBUG_LOG) ? window.__DFS_E5_DEBUG_LOG : []);
}

async function getBrowserDetectionFailureSignals(page) {
  return page.evaluate(async () => {
    function readWindowValue(name) {
      const present = Object.prototype.hasOwnProperty.call(window, name) || name in window;
      const value = present ? window[name] : undefined;
      return {
        present,
        type: typeof value,
        value: typeof value === 'function' ? `[function ${value.name || 'anonymous'}]` : value,
      };
    }

    function safeResourceEntries(pattern) {
      try {
        return performance.getEntriesByType('resource')
          .filter((entry) => pattern.test(entry.name))
          .map((entry) => ({
            name: entry.name,
            initiatorType: entry.initiatorType,
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize,
          }));
      } catch (error) {
        return [{ error: error.message }];
      }
    }

    const sentryWindowKeys = Object.keys(window)
      .filter((key) => /sentry/i.test(key))
      .sort()
      .map((key) => ({
        key,
        type: typeof window[key],
      }));

    const highEntropyUserAgentData = navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function'
      ? await navigator.userAgentData.getHighEntropyValues(['brands', 'fullVersionList', 'uaFullVersion', 'platform', 'platformVersion'])
        .catch((error) => ({ error: error.message }))
      : null;

    return {
      capturedAt: new Date().toISOString(),
      browserDetectionInputs: {
        expectedMissingGlobals: ['BOOMR_check_doc_domain'],
        BOOMR_check_doc_domain: readWindowValue('BOOMR_check_doc_domain'),
        BOOMR_check_domain: readWindowValue('BOOMR_check_domain'),
        _sentryDebugIdIdentifier: readWindowValue('_sentryDebugIdIdentifier'),
        globalPrivacyControlPresent: 'globalPrivacyControl' in navigator || navigator.globalPrivacyControl !== undefined,
        globalPrivacyControlValue: navigator.globalPrivacyControl,
        bmRM: readWindowValue('bmRM'),
      },
      userAgentData: {
        lowEntropy: navigator.userAgentData && typeof navigator.userAgentData.toJSON === 'function'
          ? navigator.userAgentData.toJSON()
          : null,
        highEntropy: highEntropyUserAgentData,
      },
      sentry: {
        Sentry: readWindowValue('Sentry'),
        __SENTRY__: readWindowValue('__SENTRY__'),
        _sentryDebugIdIdentifier: readWindowValue('_sentryDebugIdIdentifier'),
        sentryWindowKeys,
        resources: safeResourceEntries(/sentry/i),
      },
      boomrCheckDomain: readWindowValue('BOOMR_check_domain'),
      boomrCheckDocDomain: readWindowValue('BOOMR_check_doc_domain'),
      dfsJsResources: safeResourceEntries(/\/dfs\.js(?:[?#]|$)/i),
      boomrResources: safeResourceEntries(/boomr|boomerang|akamai/i),
    };
  });
}

async function getBrowserFailureDiagnostics(page) {
  return page.evaluate(async () => {
    async function readExpression(expression, getter) {
      try {
        return {
          expression,
          value: await getter(),
        };
      } catch (error) {
        return {
          expression,
          error: error.message,
        };
      }
    }

    const highEntropyHints = ['fullVersionList', 'platform', 'platformVersion', 'architecture', 'bitness', 'model'];

    return {
      capturedAt: new Date().toISOString(),
      values: [
        await readExpression(
          'navigator.userAgentData.getHighEntropyValues(["fullVersionList", "platform", "platformVersion", "architecture", "bitness", "model"])',
          () => navigator.userAgentData.getHighEntropyValues(highEntropyHints)
        ),
        await readExpression('navigator.userAgent', () => navigator.userAgent),
        await readExpression('navigator.language', () => navigator.language),
        await readExpression('Intl.DateTimeFormat().resolvedOptions().timeZone', () => Intl.DateTimeFormat().resolvedOptions().timeZone),
        await readExpression('navigator.platform', () => navigator.platform),
        await readExpression(
          "performance.getEntriesByType('resource').filter(r=> /sentry|boomr|akamai/i.test(r.name))",
          () => performance.getEntriesByType('resource')
            .filter((entry) => /sentry|boomr|akamai/i.test(entry.name))
            .map((entry) => entry.toJSON())
        ),
      ],
    };
  });
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

function isDfsE7ScoreString(value) {
  const text = String(value || '');
  return /^\d+$/.test(text) && text.length >= DFS_E7_MIN_DIGITS && text.length <= DFS_E7_MAX_DIGITS && text.length % 2 === 0;
}

function getDfsE7Format(value) {
  const configured = readString('DFS_E7_FORMAT', 'auto').toLowerCase();
  if (configured === 'score-tokens') return configured;
  const text = String(value || '');
  if (isDfsE7ScoreString(text)) return 'score-tokens';
  return text ? 'unknown' : 'missing';
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0);
  };
}

function splitDfsE7ScoreTokens(value) {
  const text = String(value || '');
  if (!isDfsE7ScoreString(text)) return [];
  const tokens = [];
  for (let index = 0; index < text.length; index += 2) {
    tokens.push(text.slice(index, index + 2));
  }
  return tokens;
}

function getDfsE7ScoreShuffle(seedHex, tokenCount) {
  const seedText = String(seedHex || '').slice(0, 8);
  if (!Number.isInteger(tokenCount) || tokenCount <= 0) return null;

  const seedSource = /^[0-9a-f]{8}$/i.test(seedText) ? seedText : '00000000';
  const seed = parseInt(seedSource, 16) >>> 0;
  const random = mulberry32(seed);
  const indexes = Array.from({ length: tokenCount }, (_, index) => index);
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    const nextIndex = random() % (index + 1);
    [indexes[index], indexes[nextIndex]] = [indexes[nextIndex], indexes[index]];
  }

  return {
    enabled: true,
    seedHex: seedSource,
    seedSource,
    seed,
    canonicalIndexToWireIndex: indexes,
    shuffledCanonicalIndexes: indexes,
    mapping: readString('DFS_E7_SCORE_SHUFFLE_MAPPING', 'canonical-index-to-shuffled-index'),
  };
}

function decodeDfsE7ScoreTokens(value, seedHex) {
  const rawTokens = splitDfsE7ScoreTokens(value);
  if (rawTokens.length === 0) {
    return {
      format: getDfsE7Format(value),
      raw: String(value || ''),
      rawTokens: [],
      canonicalTokens: [],
      scores: [],
      shuffle: null,
    };
  }

  const shuffle = getDfsE7ScoreShuffle(seedHex, rawTokens.length);
  const canonicalTokens = Array.from({ length: rawTokens.length }, () => '00');
  if (shuffle && shuffle.mapping !== 'canonical-index-to-shuffled-index') {
    shuffle.shuffledCanonicalIndexes.forEach((canonicalIndex, shuffledIndex) => {
      if (canonicalIndex >= 0 && canonicalIndex < canonicalTokens.length) {
        canonicalTokens[canonicalIndex] = rawTokens[shuffledIndex];
      }
    });
  } else if (shuffle) {
    shuffle.shuffledCanonicalIndexes.forEach((shuffledIndex, canonicalIndex) => {
      if (shuffledIndex >= 0 && shuffledIndex < rawTokens.length) {
        canonicalTokens[canonicalIndex] = rawTokens[shuffledIndex];
      }
    });
  } else {
    rawTokens.forEach((token, index) => {
      canonicalTokens[index] = token;
    });
  }

  return {
    format: 'score-tokens',
    raw: String(value || ''),
    rawTokens,
    canonicalTokens,
    scores: canonicalTokens.map((token) => Number(token)),
    shuffle,
    seedSource: seedHex || '',
    dimensions: getDfsE7ScoreDimensions(canonicalTokens.length),
  };
}

function getDfsE7ScoreDimensions(tokenCount) {
  const fieldDimensions = ['injectedText', 'pasteFragmentation', 'cadenceRigidity', 'focusAnomaly', 'dwellAnomaly', 'fillSpeed', 'focusNoPointer', 'keyInputMismatch'];
  const dimensions = ['valueInjection', 'syntheticEvents', 'pointerLock', 'pointerTravel', 'coldFocus'];
  for (let fieldIndex = 0; dimensions.length < tokenCount; fieldIndex += 1) {
    for (const dimension of fieldDimensions) {
      if (dimensions.length >= tokenCount) break;
      dimensions.push(`field${fieldIndex + 1}.${dimension}`);
    }
  }
  return dimensions;
}

function getDfsE7FieldTokenPosition(fieldIndex, fieldOffset) {
  return DFS_E7_GLOBAL_TOKENS + (Number(fieldIndex) * DFS_E7_PER_FIELD_TOKENS) + Number(fieldOffset);
}

function getDfsE7Score(scoreState, position) {
  if (!scoreState || !Array.isArray(scoreState.scores)) return null;
  const index = Number(position);
  if (index < 0 || index >= scoreState.scores.length) return null;
  return scoreState.scores[index];
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

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isDfsOrLevoJsUrl(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    return pathname.endsWith('dfs.js') || pathname.endsWith('levo.js');
  } catch {
    return false;
  }
}

async function loadScriptOverrideSource(context, source) {
  if (isHttpUrl(source)) {
    const response = await context.request.get(source, {
      timeout: Number(process.env.SCRIPT_OVERRIDE_FETCH_TIMEOUT_MS || 30000),
    });
    if (!response.ok()) {
      throw new Error(`Script override source returned HTTP ${response.status()}: ${source}`);
    }

    return {
      sourceType: 'url',
      source,
      body: await response.body(),
      contentType: response.headers()['content-type'] || 'application/javascript',
    };
  }

  const filePath = path.isAbsolute(source) ? source : path.join(ROOT_DIR, source);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Script override source file does not exist: ${filePath}`);
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(`Script override source must be a JavaScript file, but this path is not a file: ${filePath}`);
  }

  return {
    sourceType: 'file',
    source: filePath,
    body: fs.readFileSync(filePath),
    contentType: 'application/javascript',
  };
}

async function installScriptOverride(context, outputDir) {
  const configs = [
    {
      name: 'script',
      matchEnv: 'SCRIPT_OVERRIDE_MATCH',
      sourceEnv: 'SCRIPT_OVERRIDE_SOURCE',
      match: readString('SCRIPT_OVERRIDE_MATCH'),
      source: readString('SCRIPT_OVERRIDE_SOURCE'),
    },
    {
      name: 'levo',
      matchEnv: 'LEVO_SCRIPT_OVERRIDE_MATCH',
      sourceEnv: 'LEVO_SCRIPT_OVERRIDE_SOURCE',
      match: readString('LEVO_SCRIPT_OVERRIDE_MATCH'),
      source: readString('LEVO_SCRIPT_OVERRIDE_SOURCE'),
    },
  ];
  const enabledConfigs = configs.filter((config) => config.match || config.source);
  if (enabledConfigs.length === 0) return null;

  for (const config of enabledConfigs) {
    if (!config.match || !config.source) {
      throw new Error(`${config.matchEnv} and ${config.sourceEnv} must both be configured to override a script.`);
    }
  }

  const overrides = await Promise.all(enabledConfigs.map(async (config) => {
    const replacement = await loadScriptOverrideSource(context, config.source);
    return {
      ...config,
      matches: matcherFromConfig(config.match),
      replacement,
      found: false,
      matchedRequests: [],
    };
  }));
  const details = {
    enabled: true,
    overrides: overrides.map((override) => ({
      name: override.name,
      match: override.match,
      sourceType: override.replacement.sourceType,
      source: override.replacement.source,
      contentType: override.replacement.contentType,
      found: false,
      matchedRequests: [],
    })),
  };

  await context.route('**/*', async (route) => {
    const request = route.request();
    const overrideIndex = overrides.findIndex((override) => override.matches(request.url()));
    if (overrideIndex === -1) {
      await route.continue();
      return;
    }

    const override = overrides[overrideIndex];
    const detail = details.overrides[overrideIndex];
    const matchedRequest = {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      timestamp: new Date().toISOString(),
    };
    override.matchedRequests.push(matchedRequest);
    override.found = true;
    detail.matchedRequests.push(matchedRequest);
    detail.found = true;

    await route.fulfill({
      status: 200,
      contentType: override.replacement.contentType,
      body: override.replacement.body,
    });
  });

  saveJson(path.join(outputDir, 'script-override.json'), details);
  return details;
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

async function discoverInputFields(page) {
  const frames = [];

  for (const frame of page.frames()) {
    const frameResult = await frame.evaluate(() => {
      function describeElement(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = Boolean(
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity || 1) !== 0
        );

        return {
          tagName: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          id: el.id || '',
          name: el.getAttribute('name') || '',
          autocomplete: el.getAttribute('autocomplete') || '',
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          text: (el.innerText || el.value || '').trim().slice(0, 120),
          selectorHints: {
            id: el.id ? `#${CSS.escape(el.id)}` : '',
            name: el.getAttribute('name') ? `${el.tagName.toLowerCase()}[name="${CSS.escape(el.getAttribute('name'))}"]` : '',
          },
          visible,
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }

      return Array.from(document.querySelectorAll('input,textarea,select,button,a,[role="button"]'))
        .map(describeElement);
    }).catch((error) => ({ __error: error.message }));

    frames.push({
      name: frame.name(),
      url: frame.url(),
      fields: Array.isArray(frameResult) ? frameResult : [],
      error: frameResult && frameResult.__error ? frameResult.__error : undefined,
    });
  }

  const allFields = frames.flatMap((frame) => frame.fields.map((field) => ({
    ...field,
    frameName: frame.name,
    frameUrl: frame.url,
  })));
  const visibleFields = allFields.filter((field) => field.visible);

  return {
    capturedAt: new Date().toISOString(),
    frames,
    fields: allFields,
    totals: {
      frames: frames.length,
      fields: allFields.length,
      visibleFields: visibleFields.length,
      visibleInputs: visibleFields.filter((field) => ['input', 'textarea', 'select'].includes(field.tagName)).length,
      visibleButtons: visibleFields.filter((field) => field.tagName === 'button' || field.type === 'submit' || field.role === 'button').length,
      visibleLinks: visibleFields.filter((field) => field.tagName === 'a').length,
    },
  };
}

function logInputDiscovery(inputDiscovery) {
  const totals = inputDiscovery && inputDiscovery.totals ? inputDiscovery.totals : {};
  console.log(`  Input discovery: ${totals.visibleFields || 0} visible controls across ${totals.frames || 0} frame(s)`);
}

function createDfsScriptRequestLog(page) {
  const requests = [];
  page.on('request', (request) => {
    if (!/dfs\.js|levo\.js|pseaegis|aegis/i.test(request.url())) return;
    requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      timestamp: new Date().toISOString(),
    });
  });
  return requests;
}

async function collectDfsControlDiagnostics(page, context, outputDir, resultConfig, scriptOverride, dfsScriptRequests) {
  const fingerprintDataWait = await waitForFingerprintData(page);
  const e7Wait = await waitForDfsE7Value(page, context);
  const fingerprint = e7Wait.fingerprint || await getFingerprint(page).catch((error) => ({ __error: error.message }));
  const documentCookieList = e7Wait.documentCookieList || await getDfsCookies(page).catch((error) => ({ __error: error.message }));
  const documentDfsCookies = e7Wait.documentDfsCookies || (Array.isArray(documentCookieList) ? parseCookieArray(documentCookieList) : {});
  const contextDfsCookies = e7Wait.contextDfsCookies || await getDfsContextCookies(context).catch((error) => ({ __error: error.message }));
  const e7 = String(
    e7Wait.dfs_E_7 ||
      documentDfsCookies.dfs_E_7 ||
      contextDfsCookies.dfs_E_7 ||
      getFingerprintValue(fingerprint, 'dfs_E_7') ||
      ''
  );
  const e7ScoreSeed =
    documentDfsCookies.dfs_F_5 ||
    contextDfsCookies.dfs_F_5 ||
    getFingerprintValue(fingerprint, 'dfs_F_5');
  let missingDfsE7Screenshot = null;

  if (!e7) {
    missingDfsE7Screenshot = await saveScreenshot(page, `${sanitizeSegment(resultConfig.evidenceName || resultConfig.phase || 'control')}-missing-dfs-e7`)
      .catch((error) => ({ error: error.message }));
  }

  return {
    finalUrl: page.url(),
    isSystemRequirements: isChaseSystemRequirementsUrl(page.url()),
    frames: page.frames().map((frame) => ({
      name: frame.name(),
      url: frame.url(),
    })),
    documentReadyState: await page.evaluate(() => document.readyState).catch((error) => ({ error: error.message })),
    fingerprintDataWait,
    dfsE7Wait: {
      found: e7Wait.found,
      timeoutMs: e7Wait.timeoutMs,
      waitedMs: e7Wait.waitedMs,
    },
    dfsScriptRequests: dfsScriptRequests || [],
    scriptOverride,
    documentDfsCookies,
    contextDfsCookies,
    fingerprint,
    fingerprintError: fingerprint && fingerprint.__error ? fingerprint.__error : null,
    dfs_E_7: e7,
    dfs_E_7_format: getDfsE7Format(e7),
    dfs_E_7_score_tokens: decodeDfsE7ScoreTokens(e7, e7ScoreSeed),
    dfs_F_5_score_seed_source: e7ScoreSeed,
    missingDfsE7Screenshot,
  };
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

function isMissingDfsE7Evidence(evidence, bitKeys = []) {
  if (!evidence || typeof evidence !== 'object') return true;
  if (!String(evidence.dfs_E_7 || '').trim()) return true;
  return bitKeys.some((key) => evidence[key] === undefined || evidence[key] === null);
}

function classifyMissingDfsE7Evidence(evidence) {
  if (evidence && evidence.isSystemRequirements) {
    return {
      status: 'SKIP',
      reason: 'Control context redirected to the Chase system requirements page; DFS bit assertions are not available in this browser mode.',
    };
  }

  if (!evidence || !Array.isArray(evidence.dfsScriptRequests) || evidence.dfsScriptRequests.length === 0) {
    return {
      status: 'FAIL',
      reason: 'DFS script was not requested in this isolated control context, so dfs_E_7 could not be emitted.',
    };
  }

  if (evidence.fingerprintError) {
    return {
      status: 'FAIL',
      reason: `DFS script was requested, but FingerprintData was unavailable: ${evidence.fingerprintError}`,
    };
  }

  return {
    status: 'FAIL',
    reason: 'DFS script was requested, but dfs_E_7 was not present in document cookies, browser context cookies, or FingerprintData.',
  };
}

function requiredCookieFailures(cookieMap) {
  const ignoredCookies = new Set(
    readString('IGNORE_REQUIRED_DFS_COOKIES')
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean)
  );

  return REQUIRED_DFS_COOKIES.filter((key) => !ignoredCookies.has(key) && !cookieMap[key]);
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

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSet(value) {
  return new Set(parseList(value).map((item) => item.toLowerCase()));
}

function getLobs() {
  return parseList(process.env.LOBS);
}

function getReleaseVersion() {
  const releaseVersion = readString('RELEASE_VERSION', readString('EXPECTED_DFS_E_8', 'dfs_E_8'));
  return sanitizeSegment(releaseVersion || 'dfs_E_8');
}

function requireHttpsUrl(value) {
  const url = String(value || '').trim();
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`TARGET_URL must be an HTTPS URL, got: ${value}`);
  }
  return url;
}

function getNextEvidenceDir(releaseVersion) {
  const releaseRoot = path.join(ROOT_DIR, 'evidence', sanitizeSegment(releaseVersion));
  if (!fs.existsSync(releaseRoot)) return releaseRoot;

  for (let index = 1; index < 10000; index += 1) {
    const candidate = path.join(releaseRoot, `test-${index}`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Unable to allocate evidence directory under ${releaseRoot}`);
}

function isNumberedEvidenceRunDir(value) {
  return /^test-\d+$/i.test(path.basename(String(value || '')));
}

function getLobEnvPrefixes(lob) {
  const raw = String(lob || '').trim();
  const upper = raw.toUpperCase();
  return [`${raw}.`, `${upper}.`];
}

async function withLobEnvironment(lob, action) {
  if (!lob) return action();

  const originalEnv = { ...process.env };
  const prefixes = getLobEnvPrefixes(lob);

  try {
    for (const [key, value] of Object.entries(originalEnv)) {
      const prefix = prefixes.find((candidate) => key.startsWith(candidate));
      if (!prefix) continue;

      const unprefixedKey = key.slice(prefix.length);
      if (unprefixedKey) process.env[unprefixedKey] = value;
    }

    return await action();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  }
}

function shouldTestLogon() {
  if (process.env.TEST_LOGON !== undefined && process.env.TEST_LOGON !== '') {
    return readBoolean('TEST_LOGON', false);
  }
  return readBoolean('SUBMIT_CREDENTIALS', false);
}

function getLogonSkipReason() {
  if (!shouldTestLogon()) {
    return {
      reason: 'Logon validation is disabled.',
      errors: ['Set TEST_LOGON=true to run the logon submission validation.'],
    };
  }

  const missing = [
    ['LOGIN_USERNAME', process.env.LOGIN_USERNAME],
    ['LOGIN_PASSWORD', process.env.LOGIN_PASSWORD],
    ['USERNAME_SELECTOR', process.env.USERNAME_SELECTOR],
    ['PASSWORD_SELECTOR', process.env.PASSWORD_SELECTOR],
    ['SUBMIT_SELECTOR', process.env.SUBMIT_SELECTOR],
  ].filter(([, value]) => value === undefined || value.trim() === '');

  if (missing.length > 0) {
    const missingNames = missing.map(([name]) => name);
    return {
      reason: 'Logon validation is enabled, but required selector configuration is missing.',
      missing: missingNames,
      errors: [`Missing required logon selector(s): ${missingNames.join(', ')}`],
    };
  }

  return null;
}

async function clickLocatorWithoutNavigationWait(page, locator, timeout) {
  await locator.waitFor({ state: 'visible', timeout });
  await Promise.all([
    page.waitForLoadState(process.env.POST_SUBMIT_LOAD_STATE || 'networkidle', {
      timeout: Number(process.env.POST_SUBMIT_TIMEOUT_MS || 30000),
    }).catch(() => null),
    locator.click({ timeout, noWaitAfter: true }),
  ]);
}

function serializeRequest(request) {
  if (!request) return null;
  const headers = request.headers();
  const postData = request.postData();
  return {
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    headers,
    postData,
    postDataJson: (() => {
      if (!postData) return null;
      try {
        return JSON.parse(postData);
      } catch {
        return null;
      }
    })(),
  };
}

async function runLogonValidation(page, outputDir, results) {
  const skip = getLogonSkipReason();
  if (skip) {
    addResult(
      results,
      'Cookies and Payload After Form Submission',
      'SKIP',
      skip,
      [],
      []
    );
    return { skipped: true, ...skip };
  }

  const config = getInputInteractionConfig();
  const username = readString('LOGIN_USERNAME');
  const password = readString('LOGIN_PASSWORD');
  const evidenceFiles = [];

  try {
    const root = await getScenarioRoot(page);
    const usernameField = root.locator(config.usernameSelector);
    const passwordField = root.locator(config.passwordSelector);
    const submitButton = root.locator(config.submitSelector);

    await usernameField.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
    await passwordField.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
    await usernameField.fill(username);
    await passwordField.fill(password);

    const requestMatcher = readString('LOGIN_REQUEST_MATCHER');
    const requestPromise = requestMatcher
      ? waitForLoginRequest(page, requestMatcher).catch((error) => ({ __error: error.message }))
      : Promise.resolve(null);

    await clickLocatorWithoutNavigationWait(
      page,
      submitButton,
      Number(process.env.POST_SUBMIT_TIMEOUT_MS || process.env.FIELD_TIMEOUT_MS || 30000)
    );
    await waitForCookieSettle(page, 'post_submit');

    const loginRequestResult = await requestPromise;
    const loginRequest = loginRequestResult && !loginRequestResult.__error
      ? serializeRequest(loginRequestResult)
      : loginRequestResult;
    const cookies = parseCookieArray(await getDfsCookies(page));
    const fingerprint = await getFingerprint(page, { wait: false });

    const cookiesFile = saveJson(path.join(outputDir, 'cookies-after-submit.json'), cookies);
    const fingerprintFile = saveJson(path.join(outputDir, 'fingerprint-after-submit.json'), fingerprint);
    const requestFile = saveJson(path.join(outputDir, 'network-login-request.json'), loginRequest);
    evidenceFiles.push(cookiesFile, fingerprintFile, requestFile);

    const missingRequest = Boolean(requestMatcher && (!loginRequest || loginRequest.__error));
    const details = {
      submitted: true,
      usernameSelector: config.usernameSelector,
      passwordSelector: config.passwordSelector,
      submitSelector: config.submitSelector,
      loginRequestMatcher: requestMatcher || null,
      loginRequest,
      cookieNames: Object.keys(cookies).sort(),
      fingerprintAvailable: fingerprint && typeof fingerprint === 'object' && !fingerprint.__error,
    };
    const errors = [];
    if (missingRequest) errors.push(`No login request matched ${requestMatcher}: ${loginRequest.__error}`);

    addResult(
      results,
      'Cookies and Payload After Form Submission',
      errors.length === 0 ? 'PASS' : 'FAIL',
      details,
      evidenceFiles,
      errors
    );

    return details;
  } catch (error) {
    addResult(
      results,
      'Cookies and Payload After Form Submission',
      'FAIL',
      { error: error.message },
      evidenceFiles,
      [error.message]
    );
    return { error: error.message };
  }
}

async function waitForCookieSettle(page, phase) {
  const phaseKey = `${phase.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_COOKIE_WAIT_MS`;
  const waitMs = Number(process.env[phaseKey] || process.env.COOKIE_SETTLE_WAIT_MS || 0);
  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
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

async function getInteractionTargetPoint(page) {
  return page.evaluate(() => {
    const id = 'dfs-interaction-target';
    let target = document.getElementById(id);
    if (!target) {
      target = document.createElement('button');
      target.id = id;
      target.type = 'button';
      target.tabIndex = -1;
      target.setAttribute('aria-hidden', 'true');
      target.style.cssText = [
        'position:fixed',
        'left:24px',
        'top:24px',
        'width:96px',
        'height:96px',
        'z-index:2147483647',
        'opacity:0.01',
        'border:0',
        'padding:0',
        'margin:0',
        'background:#000',
        'pointer-events:auto',
      ].join(';');
      target.addEventListener('contextmenu', (event) => event.preventDefault());
      document.documentElement.appendChild(target);
    }
    const rect = target.getBoundingClientRect();
    return {
      x: Math.floor(rect.left + rect.width / 2),
      y: Math.floor(rect.top + rect.height / 2),
    };
  });
}

async function getRootInteractionTargetPoint(page, root) {
  if (!root || root === page || typeof root.frameElement !== 'function') {
    return {
      ...(await getInteractionTargetPoint(page)),
      context: 'page',
    };
  }

  const localPoint = await root.evaluate(() => {
    const selectors = [
      'input:not([type="hidden"]):not([disabled])',
      'button:not([disabled])',
      'a[href]',
      'body',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return {
          x: Math.floor(rect.left + Math.min(rect.width / 2, 40)),
          y: Math.floor(rect.top + Math.min(rect.height / 2, 20)),
          selector,
        };
      }
    }
    return {
      x: Math.floor(window.innerWidth / 2),
      y: Math.floor(window.innerHeight / 2),
      selector: 'viewport-center',
    };
  });
  const frameBox = await (await root.frameElement()).boundingBox();
  if (!frameBox) {
    return {
      ...(await getInteractionTargetPoint(page)),
      context: 'frame_no_box',
      frameUrl: root.url(),
    };
  }

  return {
    x: Math.floor(frameBox.x + localPoint.x),
    y: Math.floor(frameBox.y + localPoint.y),
    localX: localPoint.x,
    localY: localPoint.y,
    selector: localPoint.selector,
    frameBox,
    frameUrl: root.url(),
    context: 'frame',
  };
}

async function dispatchRootRapidClickEvents(root, count) {
  if (!root || typeof root.evaluate !== 'function') return null;
  return root.evaluate((clickCount) => {
    const target = document.querySelector('input:not([type="hidden"]):not([disabled])')
      || document.querySelector('button:not([disabled])')
      || document.body
      || document.documentElement;
    for (let index = 0; index < clickCount; index += 1) {
      target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 20 + index,
        clientY: 20 + index,
      }));
      window.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 20 + index,
        clientY: 20 + index,
      }));
    }
    return {
      dispatchedSyntheticClicks: clickCount,
      targetTagName: target.tagName,
      targetId: target.id || '',
    };
  }, count);
}

async function dispatchRootRapidScrollEvents(root, count) {
  if (!root || typeof root.evaluate !== 'function') return null;
  return root.evaluate((scrollCount) => {
    for (let index = 0; index < scrollCount; index += 1) {
      window.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 180,
      }));
      document.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('scroll'));
      window.scrollBy(0, 180);
    }
    return {
      dispatchedSyntheticScrolls: scrollCount,
      scrollY: window.scrollY,
    };
  }, count);
}

async function maybeTeleportMouse(page) {
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const start = [10, 10];
  const hops = [
    [Math.max(10, viewport.width - 10), Math.max(10, viewport.height - 10)],
    [Math.floor(viewport.width * 0.1), Math.floor(viewport.height * 0.85)],
    [Math.floor(viewport.width * 0.9), Math.floor(viewport.height * 0.15)],
  ];

  const installProbe = (frame) => frame.evaluate(() => {
    const probe = {
      installedAt: performance.now(),
      frameUrl: location.href,
      events: [],
      hops: [],
    };
    let previous = null;

    window.__DFS_MOUSE_TELEPORT_PROBE = probe;
    window.addEventListener('mousemove', (event) => {
      const current = {
        at: performance.now(),
        x: event.clientX,
        y: event.clientY,
        isTrusted: event.isTrusted,
      };
      probe.events.push(current);

      if (previous) {
        const dx = current.x - previous.x;
        const dy = current.y - previous.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const deltaMs = current.at - previous.at;
        const speedPxPerMs = deltaMs > 0 ? distance / deltaMs : null;
        probe.hops.push({
          from: { x: previous.x, y: previous.y },
          to: { x: current.x, y: current.y },
          distance: Math.round(distance * 1000) / 1000,
          deltaMs: Math.round(deltaMs * 1000) / 1000,
          speedPxPerMs: speedPxPerMs === null ? null : Math.round(speedPxPerMs * 1000) / 1000,
          meetsBit28Threshold: speedPxPerMs !== null && distance > 40 && deltaMs > 2 && speedPxPerMs > 250,
          isTrusted: current.isTrusted,
        });
      }

      previous = current;
    });
  });

  await Promise.all(page.frames().map((frame) => installProbe(frame).catch((error) => ({
    frameUrl: frame.url(),
    error: error.message,
  }))));

  const cdpDeltaSeconds = Number(process.env.MOUSE_TELEPORT_CDP_DELTA_MS || 3) / 1000;
  let usedCdp = false;
  if (readBoolean('MOUSE_TELEPORT_USE_CDP', true)) {
    try {
      const client = await page.context().newCDPSession(page);
      let timestamp = Date.now() / 1000;
      const cdpHops = readBoolean('MOUSE_TELEPORT_CDP_FAR_HOP', true)
        ? [
            [start[0], start[1]],
            [5010, start[1]],
          ]
        : [start, ...hops];
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: cdpHops[0][0],
        y: cdpHops[0][1],
        button: 'none',
        timestamp,
      });
      for (const [x, y] of cdpHops.slice(1)) {
        timestamp += cdpDeltaSeconds;
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          button: 'none',
          timestamp,
        });
      }
      await client.detach();
      usedCdp = true;
      await page.waitForTimeout(Number(process.env.MOUSE_TELEPORT_SETTLE_WAIT_MS || 100));
    } catch {
      usedCdp = false;
    }
  }

  if (!usedCdp) {
    await page.mouse.move(start[0], start[1], { steps: 1 });
    await page.waitForTimeout(Number(process.env.MOUSE_TELEPORT_DELTA_WAIT_MS || 3));

    for (const [x, y] of hops) {
      await page.mouse.move(x, y, { steps: 1 });
      await page.waitForTimeout(Number(process.env.MOUSE_TELEPORT_DELTA_WAIT_MS || 3));
    }
  }

  if (readBoolean('MOUSE_TELEPORT_SYNTHETIC_BURST', true)) {
    const syntheticWaitMs = Number(process.env.MOUSE_TELEPORT_SYNTHETIC_WAIT_MS || 3);
    await Promise.all(page.frames().map((frame) => frame.evaluate(async (waitMs) => {
      const first = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
        screenX: 10,
        screenY: 10,
      });
      const second = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: 5010,
        clientY: 10,
        screenX: 5010,
        screenY: 10,
      });
      window.dispatchEvent(first);
      document.dispatchEvent(first);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      window.dispatchEvent(second);
      document.dispatchEvent(second);
    }, syntheticWaitMs).catch(() => null)));
    await page.waitForTimeout(Number(process.env.MOUSE_TELEPORT_SETTLE_WAIT_MS || 100));
  }

  const frameProbes = await Promise.all(page.frames().map((frame) => frame.evaluate(() => window.__DFS_MOUSE_TELEPORT_PROBE || null)
    .then((probe) => probe || { frameUrl: frame.url(), events: [], hops: [] })
    .catch((error) => ({ frameUrl: frame.url(), error: error.message, events: [], hops: [] }))));
  const measuredHops = frameProbes.flatMap((probe) => (probe.hops || []).map((hop) => ({
    ...hop,
    frameUrl: probe.frameUrl,
  })));

  return {
    eventSource: usedCdp ? 'cdp' : 'playwright_mouse',
    frameProbes,
    hops: measuredHops,
    thresholdMatches: measuredHops.filter((hop) => hop.meetsBit28Threshold),
  };
}

function getScenarioText(name) {
  return readString(`${name}_VALUE`, readString('INTERACTION_TEST_VALUE', 'testuser1'));
}

function getInteractionScenarioNames() {
  return parseList(readString(
    'INTERACTION_TEST_SCENARIOS',
    'value_injection,synthetic_events,pointer_lock,pointer_travel,cold_focus,injected_text,cadence_rigidity,human_like_cadence,focus_anomaly,dwell_missing_keyups,dwell_short_holds,fill_speed,paste_fragmentation,focus_no_pointer,key_input_mismatch_cdp,key_input_mismatch_paste_negative,human_baseline,human_pause_baseline,human_mouse_path,browser_autofill_suppression'
  ));
}

function normalizeInteractionScenarioName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  const aliases = {
    a1: 'value_injection',
    a2: 'synthetic_events',
    a3: 'pointer_lock',
    a4: 'pointer_travel',
    a5: 'cold_focus',
    b1: 'injected_text',
    b2: 'cadence_rigidity',
    b3: 'human_like_cadence',
    b4: 'focus_anomaly',
    b5: 'dwell_missing_keyups',
    b6: 'dwell_short_holds',
    b7: 'fill_speed',
    b8: 'paste_fragmentation',
    b9: 'focus_no_pointer',
    b10: 'key_input_mismatch_cdp',
    b11: 'key_input_mismatch_paste_negative',
    c1: 'human_baseline',
    c2: 'human_pause_baseline',
    c3: 'human_mouse_path',
    c4: 'browser_autofill_suppression',
  };
  return aliases[normalized] || normalized;
}

function getAgenticScoreExpectations(scenarioName) {
  const field1 = (offset) => getDfsE7FieldTokenPosition(0, offset);
  const expectations = {
    value_injection: [{ position: E7_POS.VALUE_INJECTION, dimension: 'valueInjection', operator: '>=', expected: 80 }],
    synthetic_events: [{ position: E7_POS.SYNTHETIC_EVENTS, dimension: 'syntheticEvents', operator: '>=', expected: 80 }],
    pointer_lock: [{ position: E7_POS.POINTER_LOCK, dimension: 'pointerLock', operator: '>=', expected: 60 }],
    pointer_travel: [{ position: E7_POS.POINTER_TRAVEL, dimension: 'pointerTravel', operator: '>=', expected: 50 }],
    cold_focus: [{ position: E7_POS.COLD_FOCUS, dimension: 'coldFocus', operator: '>=', expected: 80, exactish: true }],
    injected_text: [{ position: field1(E7_FIELD.INJECTED_TEXT), dimension: 'field1.injectedText', operator: '>=', expected: 90 }],
    cadence_rigidity: [{ position: field1(E7_FIELD.CADENCE_RIGIDITY), dimension: 'field1.cadenceRigidity', operator: '>=', expected: 80, tolerance: 15 }],
    human_like_cadence: [{ position: field1(E7_FIELD.CADENCE_RIGIDITY), dimension: 'field1.cadenceRigidity', operator: '<=', expected: 30, tolerance: 15 }],
    focus_anomaly: [{ position: field1(E7_FIELD.FOCUS_ANOMALY), dimension: 'field1.focusAnomaly', operator: '>=', expected: 90 }],
    dwell_missing_keyups: [{ position: field1(E7_FIELD.DWELL_ANOMALY), dimension: 'field1.dwellAnomaly', operator: '>=', expected: 90, tolerance: 15 }],
    dwell_short_holds: [{ position: field1(E7_FIELD.DWELL_ANOMALY), dimension: 'field1.dwellAnomaly', operator: '>=', expected: 80, tolerance: 15 }],
    fill_speed: [{ position: field1(E7_FIELD.FILL_SPEED), dimension: 'field1.fillSpeed', operator: '>=', expected: 85, tolerance: 15 }],
    paste_fragmentation: [{ position: field1(E7_FIELD.PASTE_FRAGMENTATION), dimension: 'field1.pasteFragmentation', operator: '>=', expected: 90 }],
    focus_no_pointer: [{ position: field1(E7_FIELD.FOCUS_NO_POINTER), dimension: 'field1.focusNoPointer', operator: '==', expected: 99 }],
    key_input_mismatch_cdp: [{ position: field1(E7_FIELD.KEY_INPUT_MISMATCH), dimension: 'field1.keyInputMismatch', operator: '>=', expected: 90 }],
    key_input_mismatch_paste_negative: [{ position: field1(E7_FIELD.KEY_INPUT_MISMATCH), dimension: 'field1.keyInputMismatch', operator: '==', expected: 0 }],
    human_baseline: [{ allPositions: true, dimension: 'all', operator: '<=', expected: 0, allowNoIncrease: true, excludePositions: [E7_POS.COLD_FOCUS] }],
    human_pause_baseline: [{ allPositions: true, dimension: 'all', operator: '<=', expected: 20, allowNoIncrease: true, excludePositions: [E7_POS.COLD_FOCUS] }],
    human_mouse_path: [{ position: E7_POS.POINTER_TRAVEL, dimension: 'pointerTravel', operator: '<=', expected: 20 }],
    browser_autofill_suppression: [
      { position: E7_POS.VALUE_INJECTION, dimension: 'valueInjection', operator: '==', expected: 0 },
      { position: E7_POS.COLD_FOCUS, dimension: 'coldFocus', operator: '==', expected: 0 },
      { position: field1(E7_FIELD.INJECTED_TEXT), dimension: 'field1.injectedText', operator: '==', expected: 0 },
      { position: field1(E7_FIELD.DWELL_ANOMALY), dimension: 'field1.dwellAnomaly', operator: '==', expected: 0 },
      { position: field1(E7_FIELD.FILL_SPEED), dimension: 'field1.fillSpeed', operator: '==', expected: 0 },
      { position: field1(E7_FIELD.FOCUS_NO_POINTER), dimension: 'field1.focusNoPointer', operator: '==', expected: 0 },
    ],
  };
  return expectations[normalizeInteractionScenarioName(scenarioName)] || [];
}

function compareScore(actual, operator, expected, tolerance = 0) {
  if (actual === null || actual === undefined || Number.isNaN(Number(actual))) return false;
  if (operator === '>=') return Number(actual) >= Number(expected) - Number(tolerance || 0);
  if (operator === '<=') return Number(actual) <= Number(expected) + Number(tolerance || 0);
  if (operator === '>') return Number(actual) > Number(expected) - Number(tolerance || 0);
  if (operator === '<') return Number(actual) < Number(expected) + Number(tolerance || 0);
  return Number(actual) === Number(expected);
}

function getAgenticScoreFailures(scoreState, expectations, baselineState = null) {
  if (!scoreState || scoreState.format !== 'score-tokens') {
    return [`dfs_E_7 is not in numeric score-token format; got ${scoreState ? scoreState.format : 'missing'}`];
  }

  const failures = [];
  for (const expectation of expectations) {
    if (expectation.allPositions) {
      const excludedPositions = new Set((expectation.excludePositions || []).map((position) => Number(position)));
      scoreState.scores.forEach((score, position) => {
        if (excludedPositions.has(position)) return;
        const baselineScore = baselineState && Array.isArray(baselineState.scores)
          ? baselineState.scores[position]
          : null;
        const allowedByBaseline = expectation.allowNoIncrease &&
          baselineScore !== null &&
          baselineScore !== undefined &&
          Number(score) <= Number(baselineScore);
        if (allowedByBaseline) return;
        if (!compareScore(score, expectation.operator, expectation.expected, expectation.tolerance)) {
          failures.push(`token[${position}] expected ${expectation.operator} ${expectation.expected}${expectation.tolerance ? ` +/- ${expectation.tolerance}` : ''}${expectation.allowNoIncrease ? ' or no increase from baseline' : ''}, got ${score}${baselineScore !== null && baselineScore !== undefined ? `, baseline ${baselineScore}` : ''}`);
        }
      });
      continue;
    }

    const score = getDfsE7Score(scoreState, expectation.position);
    if (!compareScore(score, expectation.operator, expectation.expected, expectation.tolerance)) {
      failures.push(`${expectation.dimension} token[${expectation.position}] expected ${expectation.operator} ${expectation.expected}${expectation.tolerance ? ` +/- ${expectation.tolerance}` : ''}, got ${score}`);
    }
  }
  return failures;
}

function getTestRetryAttempts() {
  return Math.max(1, Number(process.env.TEST_RETRY_ATTEMPTS || 3));
}

function getTestRetryDelayMs() {
  return Math.max(0, Number(process.env.TEST_RETRY_DELAY_MS || 3000));
}

function isRetryableTestMessage(value) {
  return /null|undefined|not found|cannot find|can't find|no such|selector|locator|timeout|timed out|waiting for|not visible|detached|execution context was destroyed|frame|target closed|context closed/i.test(String(value || ''));
}

async function waitBeforeTestRetry() {
  const delayMs = getTestRetryDelayMs();
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function recoverSecureChaseSystemRequirements(page) {
  if (!readBoolean('SECURE_SYSTEM_REQUIREMENTS_SIGNIN_RECOVERY', true)) {
    return { attempted: false, reason: 'SECURE_SYSTEM_REQUIREMENTS_SIGNIN_RECOVERY=false' };
  }
  if (!/\/system-requirements\b/i.test(page.url())) {
    return { attempted: false, reason: 'Page is not the Chase system requirements redirect.', url: page.url() };
  }

  const selectors = [
    'a[type="mds-primary-button"]',
    'a:has-text("Sign in")',
    'text=Sign in',
  ];
  const beforeUrl = page.url();
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    try {
      await candidate.waitFor({ state: 'visible', timeout: Number(process.env.SECURE_SIGNIN_LINK_TIMEOUT_MS || 10000) });
      await candidate.click();
      await page.waitForLoadState(process.env.GOTO_WAIT_UNTIL || 'domcontentloaded', {
        timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
      }).catch(() => {});
      await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000));
      return { attempted: true, selector, beforeUrl, afterUrl: page.url() };
    } catch {}
  }

  return {
    attempted: true,
    beforeUrl,
    afterUrl: page.url(),
    error: 'Unable to click a visible Sign in link on the Chase system requirements page.',
  };
}

function isChaseSystemRequirementsUrl(value) {
  return /:\/\/www\.chase\.com\/digital\/resources\/privacy-security\/security\/system-requirements\b/i.test(String(value || ''));
}

function getInputInteractionConfig() {
  return {
    usernameSelector: readString('USERNAME_SELECTOR'),
    passwordSelector: readString('PASSWORD_SELECTOR'),
    submitSelector: readString('SUBMIT_SELECTOR'),
  };
}

function frameNameFromSelector(selector) {
  const text = String(selector || '').trim();
  if (!text) return '';
  const nameMatch = text.match(/\[\s*name\s*=\s*["']?([^"'\]]+)["']?\s*\]/i);
  if (nameMatch) return nameMatch[1];
  const idMatch = text.match(/^iframe#([A-Za-z0-9_-]+)$/i);
  if (idMatch) return idMatch[1];
  return '';
}

function supportsCdpInsertText(target) {
  return ['chrome', 'chromelatest', 'edge', 'opera', 'comet', 'atlas'].includes(String(target && target.browser || '').toLowerCase());
}

async function waitForLoginFrame(page, timeout = Number(process.env.LOGIN_FRAME_WAIT_TIMEOUT_MS || process.env.FIELD_TIMEOUT_MS || 45000)) {
  const frameName = process.env.LOGIN_FRAME_NAME || frameNameFromSelector(process.env.LOGIN_FRAME_SELECTOR);
  const frameUrlMatcher = process.env.LOGIN_FRAME_URL_MATCHER;
  if (!frameName && !frameUrlMatcher) return null;

  const startedAt = Date.now();
  const matchesUrl = frameUrlMatcher ? matcherFromConfig(frameUrlMatcher) : null;
  while (Date.now() - startedAt <= timeout) {
    const frame = page.frames().find((candidate) => {
      if (frameName && candidate.name() === frameName) return true;
      return Boolean(matchesUrl && matchesUrl(candidate.url()));
    });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }

  return null;
}

async function getScenarioRoot(page) {
  const frameSelector = process.env.LOGIN_FRAME_SELECTOR;
  const frame = await waitForLoginFrame(page);
  if (frame) return frame;
  if (frameSelector) return page.frameLocator(frameSelector);
  return page;
}

async function getFieldIdentity(locator) {
  return locator.evaluate((el) => ({
    id: el.id || '',
    name: el.getAttribute('name') || '',
    type: el.getAttribute('type') || el.tagName.toLowerCase(),
    tagName: el.tagName,
  }));
}

async function installFocusInputTimingProbe(locator) {
  return locator.evaluate((el) => {
    if (document.activeElement === el) {
      el.blur();
    }

    const probe = {
      installedAt: performance.now(),
      focusAt: null,
      firstInputAt: null,
      firstKeydownAt: null,
      firstBeforeInputAt: null,
      events: [],
    };
    const record = (type, event) => {
      const entry = {
        type,
        at: performance.now(),
        isTrusted: Boolean(event && event.isTrusted),
        key: event && event.key ? event.key : undefined,
        inputType: event && event.inputType ? event.inputType : undefined,
        data: event && event.data ? event.data : undefined,
      };
      probe.events.push(entry);
      if (type === 'focus' && probe.focusAt === null) probe.focusAt = entry.at;
      if (type === 'keydown' && probe.firstKeydownAt === null) probe.firstKeydownAt = entry.at;
      if (type === 'beforeinput' && probe.firstBeforeInputAt === null) probe.firstBeforeInputAt = entry.at;
      if (type === 'input' && probe.firstInputAt === null) probe.firstInputAt = entry.at;
    };

    el.__dfsFocusInputTimingProbe = probe;
    el.addEventListener('focus', (event) => record('focus', event), { once: true });
    el.addEventListener('keydown', (event) => record('keydown', event));
    el.addEventListener('beforeinput', (event) => record('beforeinput', event));
    el.addEventListener('input', (event) => record('input', event));
  });
}

async function readFocusInputTimingProbe(locator) {
  return locator.evaluate((el) => {
    const probe = el.__dfsFocusInputTimingProbe;
    if (!probe) return null;
    const deltaMs = probe.focusAt !== null && probe.firstInputAt !== null
      ? Math.round((probe.firstInputAt - probe.focusAt) * 1000) / 1000
      : null;
    const keydownDeltaMs = probe.focusAt !== null && probe.firstKeydownAt !== null
      ? Math.round((probe.firstKeydownAt - probe.focusAt) * 1000) / 1000
      : null;
    const beforeInputDeltaMs = probe.focusAt !== null && probe.firstBeforeInputAt !== null
      ? Math.round((probe.firstBeforeInputAt - probe.focusAt) * 1000) / 1000
      : null;
    return {
      ...probe,
      deltaMs,
      keydownDeltaMs,
      beforeInputDeltaMs,
      under300ms: deltaMs !== null ? deltaMs <= 300 : null,
    };
  });
}

async function ensureAgenticScratchFields(page, root, count) {
  const createFields = (requiredCount) => {
    const body = document.body;
    const created = [];
    for (let index = 0; index < requiredCount; index += 1) {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = `dfs-agentic-scratch-${index}`;
      input.name = `dfsAgenticScratch${index}`;
      input.autocomplete = 'off';
      input.style.cssText = [
        'position:fixed',
        `left:${20 + (index * 180)}px`,
        'top:20px',
        'width:160px',
        'height:24px',
        'z-index:2147483647',
        'opacity:1',
        'background:#fff',
        'color:#111',
        'border:1px solid #999',
      ].join(';');
      body.appendChild(input);
      created.push(`#${input.id}`);
    }
    return created;
  };

  if (root && typeof root.evaluate === 'function') return root.evaluate(createFields, count);
  if (root && typeof root.locator === 'function') return root.locator('body').evaluate((body, requiredCount) => {
    const created = [];
    for (let index = 0; index < requiredCount; index += 1) {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = `dfs-agentic-scratch-${index}`;
      input.name = `dfsAgenticScratch${index}`;
      input.autocomplete = 'off';
      input.style.cssText = [
        'position:fixed',
        `left:${20 + (index * 180)}px`,
        'top:20px',
        'width:160px',
        'height:24px',
        'z-index:2147483647',
        'opacity:1',
        'background:#fff',
        'color:#111',
        'border:1px solid #999',
      ].join(';');
      body.appendChild(input);
      created.push(`#${input.id}`);
    }
    return created;
  }, count);
  return page.evaluate(createFields, count);
}

async function getScenarioFieldSelectors(page, root, config, minimumCount = 1) {
  const selectors = [config.usernameSelector, config.passwordSelector].filter(Boolean);
  if (selectors.length < minimumCount) {
    selectors.push(...await ensureAgenticScratchFields(page, root, minimumCount - selectors.length));
  }
  return selectors;
}

async function ensureFocusAnomalyScratchField(page, root) {
  const createField = () => {
    const id = `dfs-focus-anomaly-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.name = id;
    input.autocomplete = 'off';
    input.setAttribute('data-dfs-focus-anomaly-scratch', 'true');
    input.style.cssText = [
      'position:fixed',
      'left:24px',
      'top:120px',
      'width:180px',
      'height:28px',
      'z-index:2147483647',
      'opacity:1',
      'background:#fff',
      'color:#111',
      'border:1px solid #999',
    ].join(';');
    document.body.appendChild(input);
    return `#${id}`;
  };

  if (root && typeof root.evaluate === 'function') return root.evaluate(createField);
  if (root && typeof root.locator === 'function') {
    return root.locator('body').evaluate((body) => {
      const id = `dfs-focus-anomaly-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.name = id;
      input.autocomplete = 'off';
      input.setAttribute('data-dfs-focus-anomaly-scratch', 'true');
      input.style.cssText = [
        'position:fixed',
        'left:24px',
        'top:120px',
        'width:180px',
        'height:28px',
        'z-index:2147483647',
        'opacity:1',
        'background:#fff',
        'color:#111',
        'border:1px solid #999',
      ].join(';');
      body.appendChild(input);
      return `#${id}`;
    });
  }
  return page.evaluate(createField);
}

async function setFieldValueWithoutKeys(locator, value, options = {}) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  return locator.evaluate((el, payload) => {
    const nextValue = payload.nextValue;
    const dispatchEvents = payload.dispatchEvents;
    if (document.activeElement === el) el.blur();
    const before = el.value;
    const valueDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (payload.useNativeSetter && valueDescriptor && typeof valueDescriptor.set === 'function') {
      valueDescriptor.set.call(el, nextValue);
    } else {
      el.value = nextValue;
    }
    const events = [];
    if (dispatchEvents) {
      const beforeInputEvent = typeof InputEvent === 'function'
        ? new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: nextValue })
        : new Event('beforeinput', { bubbles: true, cancelable: true });
      el.dispatchEvent(beforeInputEvent);
      events.push({ type: 'beforeinput', isTrusted: beforeInputEvent.isTrusted });

      const inputEvent = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: nextValue })
        : new Event('input', { bubbles: true, cancelable: true });
      el.dispatchEvent(inputEvent);
      events.push({ type: 'input', isTrusted: inputEvent.isTrusted });

      const changeEvent = new Event('change', { bubbles: true, cancelable: true });
      el.dispatchEvent(changeEvent);
      events.push({ type: 'change', isTrusted: changeEvent.isTrusted });
    }
    return {
      before,
      after: el.value,
      events,
      keydownCount: 0,
      method: 'direct_el_value_assignment',
    };
  }, {
    nextValue: String(value),
    dispatchEvents: options.dispatchEvents !== false,
    useNativeSetter: options.useNativeSetter === true,
  });
}

async function programmaticFocusField(locator) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  return locator.evaluate((el) => {
    if (document.activeElement !== el) el.focus();
    return {
      activeElementAfter: document.activeElement === el,
      method: 'element.focus',
      pointerOrTabBeforeFocus: false,
    };
  });
}

async function dispatchSyntheticInputEvents(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  const nextValue = String(value);
  const preProbe = await locator.evaluate((el) => {
    const events = [];
    el.__dfsSyntheticEventProbe = events;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown', 'beforeinput', 'input', 'keyup', 'change']) {
      el.addEventListener(type, (event) => {
        events.push({
          type,
          isTrusted: Boolean(event.isTrusted),
          inputType: event.inputType || '',
          key: event.key || '',
          data: event.data || '',
        });
      }, true);
    }
    if (document.activeElement === el) el.blur();
    return { activeElementBlurred: document.activeElement !== el };
  });

  const eventInit = { bubbles: true, cancelable: true };
  const keyboardInit = { ...eventInit, key: 'a', code: 'KeyA' };
  const inputInit = { ...eventInit, inputType: 'insertText', data: nextValue };
  await locator.dispatchEvent('pointerdown', { ...eventInit, pointerType: 'mouse', button: 0 });
  await locator.dispatchEvent('mousedown', { ...eventInit, button: 0 });
  await locator.dispatchEvent('mouseup', { ...eventInit, button: 0 });
  await locator.dispatchEvent('click', { ...eventInit, button: 0 });
  await locator.dispatchEvent('keydown', keyboardInit);
  await locator.dispatchEvent('beforeinput', inputInit);
  await locator.evaluate((el, payload) => {
    el.value = payload.nextValue;
  }, { nextValue });
  await locator.dispatchEvent('input', inputInit);
  await locator.dispatchEvent('keyup', keyboardInit);
  await locator.dispatchEvent('change', eventInit);

  return locator.evaluate((el, payload) => {
    const events = Array.isArray(el.__dfsSyntheticEventProbe) ? el.__dfsSyntheticEventProbe.slice() : [];
    delete el.__dfsSyntheticEventProbe;
    return {
      preProbe: payload.preProbe,
      value: el.value,
      events,
      method: 'locator.dispatchEvent_pointer_mouse_keyboard_input_change',
    };
  }, { preProbe });
}

async function dispatchSyntheticInputEventsInPage(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  return locator.evaluate((el, nextValue) => {
    if (document.activeElement === el) el.blur();
    el.value = nextValue;
    const events = [];
    const eventSpecs = [
      ['keydown', () => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a', code: 'KeyA' })],
      ['beforeinput', () => typeof InputEvent === 'function'
        ? new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: nextValue })
        : new Event('beforeinput', { bubbles: true, cancelable: true })],
      ['input', () => typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: nextValue })
        : new Event('input', { bubbles: true, cancelable: true })],
      ['change', () => new Event('change', { bubbles: true, cancelable: true })],
    ];
    for (const [type, createEvent] of eventSpecs) {
      const event = createEvent();
      el.dispatchEvent(event);
      events.push({ type, isTrusted: event.isTrusted });
    }
    return {
      value: el.value,
      events,
      method: 'manual_dispatchEvent_keyboard_input_change',
    };
  }, String(value));
}

async function insertTextWithCdp(page, root, selector, text) {
  const field = root.locator(selector);
  await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await field.click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.insertText', { text: String(text) });
  await cdp.detach().catch(() => {});
  return {
    selector,
    text: String(text),
    method: 'CDP Input.insertText',
    expectedInputEventsWithoutKeydown: true,
  };
}

async function pasteWithoutKeyInputMismatch(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await locator.click();
  return locator.evaluate((el, nextValue) => {
    const before = el.value;
    let execResult = false;
    try {
      execResult = document.execCommand('insertText', false, nextValue);
    } catch {}
    if (!execResult) {
      const data = new DataTransfer();
      data.setData('text/plain', nextValue);
      const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      el.dispatchEvent(pasteEvent);
      el.value = `${el.value || ''}${nextValue}`;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: nextValue }));
    }
    return {
      before,
      after: el.value,
      method: execResult ? 'document.execCommand(insertText)' : 'synthetic paste fallback',
      expectedInputType: execResult ? 'insertText' : 'insertFromPaste',
    };
  }, String(value));
}

async function detectAutofillSuppressionCandidate(locator) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  return locator.evaluate((el) => {
    const autofillMatches = (() => {
      try {
        return el.matches(':-webkit-autofill');
      } catch {
        return false;
      }
    })();
    return {
      valueLength: String(el.value || '').length,
      autofillMatches,
      autocomplete: el.getAttribute('autocomplete') || '',
      note: 'Browser autofill cannot be reliably forced by Playwright without a pre-existing browser profile; this validates suppression only when autofill is observed.',
    };
  });
}

async function typeWithVariableDelay(page, locator, value, minMs, maxMs, options = {}) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  if (!options.skipClick) await locator.click();
  const delays = [];
  const text = String(value);
  const spread = Math.max(1, maxMs - minMs);
  const highVariance = options.highVariance === true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const bucketBase = highVariance && index % 3 === 1
      ? minMs + Math.floor(spread * 0.78)
      : highVariance && index % 3 === 2
        ? minMs + Math.floor(spread * 0.35)
        : minMs;
    const bucketSize = highVariance ? Math.max(8, Math.floor(spread * 0.16)) : spread + 1;
    const delay = Math.min(maxMs, bucketBase + Math.floor(Math.random() * bucketSize));
    delays.push(delay);
    await page.keyboard.type(char, { delay });
  }
  return { value: text, delays, coefficientOfVariation: coefficientOfVariation(delays), highVariance };
}

async function typeWithFixedCadenceEvents(locator, value, delayMs) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await locator.click();
  return locator.evaluate(async (el, payload) => {
    const text = String(payload.value);
    const delay = Number(payload.delayMs);
    const events = [];
    const intervals = [];
    let previousAt = null;
    el.value = '';

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (const char of text) {
      const now = performance.now();
      if (previousAt !== null) intervals.push(Math.round((now - previousAt) * 1000) / 1000);
      previousAt = now;

      const keydown = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: char });
      el.dispatchEvent(keydown);
      const beforeinput = typeof InputEvent === 'function'
        ? new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: char })
        : new Event('beforeinput', { bubbles: true, cancelable: true });
      el.dispatchEvent(beforeinput);
      el.value = `${el.value || ''}${char}`;
      const input = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char })
        : new Event('input', { bubbles: true, cancelable: true });
      el.dispatchEvent(input);
      const keyup = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: char });
      el.dispatchEvent(keyup);
      events.push({
        char,
        keydownTrusted: keydown.isTrusted,
        inputTrusted: input.isTrusted,
        keyupTrusted: keyup.isTrusted,
      });
      await sleep(delay);
    }

    return {
      value: el.value,
      delayMs: delay,
      intervals,
      events,
      coefficientOfVariation: (() => {
        if (intervals.length === 0) return null;
        const mean = intervals.reduce((sum, item) => sum + item, 0) / intervals.length;
        if (mean === 0) return 0;
        const variance = intervals.reduce((sum, item) => sum + ((item - mean) ** 2), 0) / intervals.length;
        return Math.sqrt(variance) / mean;
      })(),
      method: 'fixed_cadence_manual_key_input_events',
    };
  }, { value: String(value), delayMs });
}

function coefficientOfVariation(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

async function dispatchFocusAnomaly(locator, text) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  return locator.evaluate((el, value) => {
    if (document.activeElement === el) el.blur();
    const before = el.value;
    el.value = String(value);
    const beforeinput = typeof InputEvent === 'function'
      ? new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: String(value) })
      : new Event('beforeinput', { bubbles: true, cancelable: true });
    const input = typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: String(value) })
      : new Event('input', { bubbles: true, cancelable: true });
    el.dispatchEvent(beforeinput);
    el.dispatchEvent(input);
    el.focus();
    return {
      before,
      after: el.value,
      inputBeforeFocus: true,
      beforeinputIsTrusted: beforeinput.isTrusted,
      inputIsTrusted: input.isTrusted,
      activeElementAfter: document.activeElement === el,
    };
  }, String(text));
}

async function dispatchKeydownsWithoutKeyups(locator, text) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  return locator.evaluate((el, value) => {
    el.focus();
    el.value = '';
    const events = [];
    for (const char of String(value)) {
      const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: char });
      el.dispatchEvent(down);
      const beforeinput = typeof InputEvent === 'function'
        ? new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: char })
        : new Event('beforeinput', { bubbles: true, cancelable: true });
      el.dispatchEvent(beforeinput);
      el.value = `${el.value || ''}${char}`;
      const input = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char })
        : new Event('input', { bubbles: true, cancelable: true });
      el.dispatchEvent(input);
      events.push({ key: char, keydownTrusted: down.isTrusted, inputTrusted: input.isTrusted, keyupDispatched: false });
    }
    return { value: el.value, keydownCount: events.length, keyupCount: 0, inputCount: events.length, events };
  }, String(text));
}

async function dispatchShortHoldKeys(locator, text) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  return locator.evaluate((el, value) => {
    el.focus();
    el.value = '';
    const events = [];
    for (const char of String(value)) {
      const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: char });
      const up = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: char });
      el.dispatchEvent(down);
      const beforeinput = typeof InputEvent === 'function'
        ? new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: char })
        : new Event('beforeinput', { bubbles: true, cancelable: true });
      el.dispatchEvent(beforeinput);
      el.value = `${el.value || ''}${char}`;
      const input = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char })
        : new Event('input', { bubbles: true, cancelable: true });
      el.dispatchEvent(input);
      el.dispatchEvent(up);
      events.push({ key: char, holdMs: 0, keydownTrusted: down.isTrusted, inputTrusted: input.isTrusted, keyupTrusted: up.isTrusted });
    }
    return { value: el.value, medianHoldMs: 0, events };
  }, String(text));
}

async function pasteFragments(locator, fragments) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await locator.click();
  return locator.evaluate((el, chunkList) => {
    const results = [];
    for (const chunk of chunkList) {
      const before = el.value;
      let pasteEventResult = false;
      let inputEventType = 'insertFromPaste';
      let pasteEventError = null;
      try {
        const data = new DataTransfer();
        data.setData('text/plain', chunk);
        const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
        pasteEventResult = el.dispatchEvent(pasteEvent);
      } catch (error) {
        pasteEventError = error.message;
      }

      el.value = `${el.value || ''}${chunk}`;
      try {
        const inputEvent = typeof InputEvent === 'function'
          ? new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: chunk })
          : new Event('input', { bubbles: true, cancelable: true });
        el.dispatchEvent(inputEvent);
        inputEventType = inputEvent.inputType || inputEventType;
      } catch {
        const event = new Event('input', { bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        inputEventType = 'input';
      }

      const changeEvent = new Event('change', { bubbles: true, cancelable: true });
      el.dispatchEvent(changeEvent);
      results.push({
        chunk,
        before,
        after: el.value,
        pasteEventResult,
        pasteEventError,
        inputEventType,
        method: 'clipboard_paste_event_plus_insertFromPaste_input',
      });
    }
    return {
      pasteLikeOperationCount: chunkList.length,
      fragments: results,
      expectedSignal: '3+ paste/inputType insertFromPaste operations in one field',
    };
  }, fragments);
}

async function ensureAgenticScratchClickTargets(page, root, count) {
  const createTargets = (requiredCount) => {
    const body = document.body;
    const created = [];
    for (let index = 0; index < requiredCount; index += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `dfs-agentic-click-target-${index}`;
      button.textContent = `DFS Target ${index + 1}`;
      button.style.cssText = [
        'position:fixed',
        `left:${20 + (index * 190)}px`,
        'top:70px',
        'width:160px',
        'height:36px',
        'z-index:2147483647',
        'opacity:1',
        'background:#fff',
        'color:#111',
        'border:1px solid #999',
      ].join(';');
      body.appendChild(button);
      created.push(`#${button.id}`);
    }
    return created;
  };

  if (root && typeof root.evaluate === 'function') return root.evaluate(createTargets, count);
  if (root && typeof root.locator === 'function') return root.locator('body').evaluate((body, requiredCount) => {
    const created = [];
    for (let index = 0; index < requiredCount; index += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `dfs-agentic-click-target-${index}`;
      button.textContent = `DFS Target ${index + 1}`;
      button.style.cssText = [
        'position:fixed',
        `left:${20 + (index * 190)}px`,
        'top:70px',
        'width:160px',
        'height:36px',
        'z-index:2147483647',
        'opacity:1',
        'background:#fff',
        'color:#111',
        'border:1px solid #999',
      ].join(';');
      body.appendChild(button);
      created.push(`#${button.id}`);
    }
    return created;
  }, count);
  return page.evaluate(createTargets, count);
}

async function clickDistinctCenterTargets(page, root, count) {
  let selector = 'button,a,input[type="button"],input[type="submit"],[role="button"]';
  const useScratchTargets = readBoolean('POINTER_LOCK_USE_SCRATCH_TARGETS', true);
  let total = 0;

  if (useScratchTargets) {
    const scratchSelectors = await ensureAgenticScratchClickTargets(page, root, count);
    selector = scratchSelectors.join(',');
  } else {
    const controls = root.locator(selector);
    total = await controls.count().catch(() => 0);
  }

  if (!useScratchTargets && total < count) {
    await ensureAgenticScratchClickTargets(page, root, count - total);
  }
  const refreshedControls = root.locator(selector);
  const refreshedTotal = await refreshedControls.count().catch(() => 0);
  const clicked = [];
  for (let index = 0; index < Math.min(refreshedTotal, count); index += 1) {
    const control = refreshedControls.nth(index);
    try {
      await control.waitFor({ state: 'visible', timeout: 3000 });
      const box = await control.boundingBox();
      if (!box) throw new Error('Missing bounding box for center click target');
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      if (readBoolean('POINTER_LOCK_USE_LOCATOR_CLICK', false)) {
        await control.click({ timeout: 3000, noWaitAfter: true });
        clicked.push({ index, center, method: 'locator.click_default_center' });
      } else {
        await page.mouse.click(center.x, center.y);
        clicked.push({ index, center, method: 'page.mouse.click_exact_center' });
      }
    } catch (error) {
      clicked.push({ index, error: error.message });
    }
  }
  return { selector, requested: count, available: refreshedTotal, clicked };
}

async function clickWithMousePath(page, locator, options = {}) {
  await locator.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  const box = await locator.boundingBox();
  if (!box) return { clicked: false, reason: 'No bounding box.' };
  const offsetX = box.width > 8 ? Math.max(4, Math.min(box.width - 4, box.width * (options.offsetRatioX || 0.37))) : box.width / 2;
  const offsetY = box.height > 8 ? Math.max(4, Math.min(box.height - 4, box.height * (options.offsetRatioY || 0.63))) : box.height / 2;
  const x = box.x + offsetX;
  const y = box.y + offsetY;
  const steps = Number(process.env.HUMAN_MOUSE_STEPS || 24);
  await page.mouse.move(x - 180, y - 120, { steps });
  await page.mouse.move(x - 18, y - 9, { steps: Math.max(4, Math.floor(steps / 2)) });
  await page.mouse.move(x + 3, y - 2, { steps: 4 });
  await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.click(x, y);
  return { clicked: true, x, y, steps, jitterMoves: 2 };
}

async function clickNonNavigatingHumanTarget(page, root, options = {}) {
  const selectors = await ensureAgenticScratchClickTargets(page, root, 1);
  const selector = selectors[0] || '#dfs-agentic-click-target-0';
  const click = await clickWithMousePath(page, root.locator(selector), options);
  return {
    ...click,
    selector,
    method: 'non_navigating_scratch_button',
  };
}

async function clickHumanScenarioSubmit(page, root, config, options = {}) {
  if (config.submitSelector && readBoolean('HUMAN_BASELINE_CLICK_REAL_SUBMIT', false)) {
    return {
      ...await clickWithMousePath(page, root.locator(config.submitSelector), options),
      selector: config.submitSelector,
      method: 'configured_submit',
    };
  }
  return clickNonNavigatingHumanTarget(page, root, options);
}

async function triggerBehaviorScore(page, root, config, options = {}) {
  if (config.submitSelector && !options.forceSyntheticSubmit) {
    try {
      const submitButton = root.locator(config.submitSelector);
      await clickLocatorWithoutNavigationWait(
        page,
        submitButton,
        Number(process.env.INTERACTION_SUBMIT_TIMEOUT_MS || process.env.FIELD_TIMEOUT_MS || 45000)
      );
      await page.waitForTimeout(Number(process.env.INTERACTION_SCORE_WAIT_MS || 750));
      return {
        method: 'configured_submit',
        submitSelector: config.submitSelector,
      };
    } catch (error) {
      await page.waitForTimeout(Number(process.env.INTERACTION_SCORE_WAIT_MS || 750));
      return {
        method: 'configured_submit_failed',
        submitSelector: config.submitSelector,
        error: error.message,
      };
    }
  }

  const createSyntheticSubmit = () => {
    const button = document.createElement('button');
    button.type = 'submit';
    button.id = 'submit';
    button.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;';
    document.body.appendChild(button);
    button.click();
    button.remove();
  };

  const submitCount = Number(process.env.INTERACTION_SYNTHETIC_SUBMIT_COUNT || 2);
  for (let index = 0; index < Math.max(1, submitCount); index += 1) {
    if (root && typeof root.evaluate === 'function') {
      await root.evaluate(createSyntheticSubmit);
    } else if (root && typeof root.locator === 'function') {
      await root.locator('body').evaluate((body) => {
        const button = document.createElement('button');
        button.type = 'submit';
        button.id = 'submit';
        button.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;';
        body.appendChild(button);
        button.click();
        button.remove();
      });
    } else {
      await page.evaluate(createSyntheticSubmit);
    }
    await page.waitForTimeout(Number(process.env.INTERACTION_SYNTHETIC_SUBMIT_GAP_MS || 250));
  }

  await page.waitForTimeout(Number(process.env.INTERACTION_SCORE_WAIT_MS || 750));
  return {
    method: 'synthetic_hidden_submit',
    submitCount: Math.max(1, submitCount),
    context: root && typeof root.evaluate === 'function' ? 'frame_or_page' : root && typeof root.locator === 'function' ? 'frame_locator' : 'page',
  };
}

async function readBehaviorState(page) {
  const cookies = parseCookieArray(await getDfsCookies(page));
  const fingerprint = await getFingerprint(page);
  const e7 = String(cookies.dfs_E_7 || getFingerprintValue(fingerprint, 'dfs_E_7') || '');
  const f5 = cookies.dfs_F_5 || getFingerprintValue(fingerprint, 'dfs_F_5');
  const e5 = cookies.dfs_E_5 || getFingerprintValue(fingerprint, 'dfs_E_5');
  const scoreState = decodeDfsE7ScoreTokens(e7, f5);
  return {
    cookies,
    fingerprint,
    dfs_E_5: e5,
    dfs_E_7: e7,
    dfs_E_7_format: getDfsE7Format(e7),
    dfs_E_7_score_tokens: scoreState,
    dfs_F_5: f5,
    dfs_F_2: cookies.dfs_F_2 || getFingerprintValue(fingerprint, 'dfs_F_2'),
  };
}

async function waitForBehaviorExpectations(page, expectations, baselineState = null) {
  const timeoutMs = Number(process.env.INTERACTION_SCORE_POLL_TIMEOUT_MS || 5000);
  const intervalMs = Number(process.env.INTERACTION_SCORE_POLL_INTERVAL_MS || 250);
  const startedAt = Date.now();
  const samples = [];
  let lastState = null;
  let lastFailures = [];

  do {
    lastState = await readBehaviorState(page);
    lastFailures = expectations.length > 0
      ? getAgenticScoreFailures(lastState.dfs_E_7_score_tokens, expectations, baselineState)
      : [];
    samples.push({
      elapsedMs: Date.now() - startedAt,
      dfs_E_7: lastState.dfs_E_7,
      scores: lastState.dfs_E_7_score_tokens && lastState.dfs_E_7_score_tokens.scores,
      failures: lastFailures,
    });
    if (lastFailures.length === 0) break;
    await page.waitForTimeout(intervalMs);
  } while (Date.now() - startedAt < timeoutMs);

  return {
    state: lastState,
    failures: lastFailures,
    samples,
    timeoutMs,
    intervalMs,
  };
}

async function performInteractionScenario(page, scenarioName, target = {}) {
  scenarioName = normalizeInteractionScenarioName(scenarioName);
  const config = getInputInteractionConfig();
  const root = await getScenarioRoot(page);
  const username = getScenarioText('USERNAME');
  const password = getScenarioText('PASSWORD');
  const needsInput = [
    'value_injection',
    'synthetic_events',
    'cold_focus',
    'injected_text',
    'cadence_rigidity',
    'human_like_cadence',
    'focus_anomaly',
    'dwell_missing_keyups',
    'dwell_short_holds',
    'fill_speed',
    'paste_fragmentation',
    'focus_no_pointer',
    'key_input_mismatch_cdp',
    'key_input_mismatch_paste_negative',
    'human_baseline',
    'human_pause_baseline',
    'human_mouse_path',
    'browser_autofill_suppression',
  ].includes(scenarioName);
  let scenarioDetails = {};
  let triggerOptions = {};

  if (needsInput && !config.usernameSelector) {
    return {
      skipped: true,
      reason: 'USERNAME_SELECTOR is required for this interaction scenario.',
      requiredConfig: ['USERNAME_SELECTOR'],
    };
  }

  switch (scenarioName) {
    case 'value_injection': {
      const selectors = await getScenarioFieldSelectors(page, root, config, Number(process.env.VALUE_INJECTION_FIELD_COUNT || 4));
      const injections = [];
      await page.waitForTimeout(Number(process.env.VALUE_INJECTION_ECHO_WINDOW_WAIT_MS || 2000));
      const dispatchEvents = readBoolean('VALUE_INJECTION_DISPATCH_EVENTS', true);
      for (let index = 0; index < selectors.length; index += 1) {
        injections.push(await setFieldValueWithoutKeys(root.locator(selectors[index]), `${username}-${index}`, {
          dispatchEvents,
          useNativeSetter: readBoolean('VALUE_INJECTION_USE_NATIVE_SETTER', false),
        }));
      }
      scenarioDetails.valueInjection = {
        fieldCount: selectors.length,
        selectors,
        injections,
        dispatchEvents,
        expectedToken: 'valueInjection',
        expectedPosition: 0,
      };
      triggerOptions.forceSyntheticSubmit = readBoolean('VALUE_INJECTION_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    }
    case 'cold_focus': {
      const selectors = await getScenarioFieldSelectors(page, root, config, 3);
      const focused = [];
      for (let index = 0; index < selectors.length; index += 1) {
        const selector = selectors[index];
        const field = root.locator(selector);
        focused.push({
          selector,
          focus: await programmaticFocusField(field),
        });
        await page.keyboard.type(`${username}${index}`, { delay: Number(process.env.COLD_FOCUS_TYPE_DELAY_MS || 60) });
      }
      scenarioDetails.coldFocus = {
        fieldCount: selectors.length,
        focused,
        expectedToken: 'coldFocus',
        expectedPosition: E7_POS.COLD_FOCUS,
      };
      triggerOptions.forceSyntheticSubmit = false;
      break;
    }
    case 'synthetic_events': {
      const selectors = await getScenarioFieldSelectors(page, root, config, Number(process.env.SYNTHETIC_EVENTS_FIELD_COUNT || 4));
      const events = [];
      for (let index = 0; index < selectors.length; index += 1) {
        const selector = selectors[index];
        events.push(await dispatchSyntheticInputEvents(root.locator(selector), `${username}-${index}`));
      }
      scenarioDetails.syntheticEvents = {
        selectors,
        events,
        fieldCount: selectors.length,
        expectedToken: 'syntheticEvents',
        expectedPosition: 1,
      };
      triggerOptions.forceSyntheticSubmit = true;
      break;
    }
    case 'pointer_lock': {
      const centerClicks = await clickDistinctCenterTargets(page, root, Number(process.env.POINTER_LOCK_CLICK_COUNT || 5));
      scenarioDetails.pointerLock = {
        ...centerClicks,
        expectedToken: 'pointerLock',
        expectedPosition: 2,
      };
      triggerOptions.forceSyntheticSubmit = readBoolean('POINTER_LOCK_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    }
    case 'pointer_travel': {
      const selectors = await getScenarioFieldSelectors(page, root, config, Number(process.env.POINTER_TRAVEL_CLICK_COUNT || 3));
      const clicked = [];
      for (const selector of selectors) {
        const field = root.locator(selector);
        await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
        await field.click({ noWaitAfter: true });
        clicked.push(selector);
      }
      const mouseTeleport = readBoolean('POINTER_TRAVEL_USE_MOUSE_TELEPORT', true)
        ? await maybeTeleportMouse(page)
        : null;
      scenarioDetails.pointerTravel = {
        clicked,
        clickCount: clicked.length,
        usedIntermediateMouseMoves: false,
        usedMouseTeleport: Boolean(mouseTeleport),
        expectedToken: 'pointerTravel',
        expectedPosition: 3,
      };
      scenarioDetails.mouseTeleport = mouseTeleport;
      triggerOptions.forceSyntheticSubmit = readBoolean('POINTER_TRAVEL_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    }
    case 'injected_text': {
      const field = root.locator(config.usernameSelector);
      await page.waitForTimeout(Number(process.env.INJECTED_TEXT_ECHO_WINDOW_WAIT_MS || process.env.VALUE_INJECTION_ECHO_WINDOW_WAIT_MS || 2000));
      scenarioDetails.injectedText = await setFieldValueWithoutKeys(field, username, {
        dispatchEvents: readBoolean('INJECTED_TEXT_DISPATCH_EVENTS', true),
        useNativeSetter: readBoolean('INJECTED_TEXT_USE_NATIVE_SETTER', false),
      });
      scenarioDetails.injectedText.expectedToken = 'field1.injectedText';
      scenarioDetails.injectedText.expectedPosition = getDfsE7FieldTokenPosition(0, E7_FIELD.INJECTED_TEXT);
      triggerOptions.forceSyntheticSubmit = readBoolean('INJECTED_TEXT_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    }
    case 'cadence_rigidity': {
      const delayMs = Number(process.env.ROBOTIC_TYPING_DELAY_MS || 50);
      const field = root.locator(config.usernameSelector);
      await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
      const cadence = readBoolean('CADENCE_RIGIDITY_USE_MANUAL_EVENTS', true)
        ? await typeWithFixedCadenceEvents(field, username, delayMs)
        : await (async () => {
            await field.click();
            await page.keyboard.type(String(username), { delay: delayMs });
            return { value: String(username), delayMs, method: 'page.keyboard.type' };
          })();
      scenarioDetails.cadenceRigidity = {
        ...cadence,
        textLength: String(username).length,
        expectedToken: 'field1.cadenceRigidity',
        expectedPosition: getDfsE7FieldTokenPosition(0, E7_FIELD.CADENCE_RIGIDITY),
      };
      triggerOptions.forceSyntheticSubmit = readBoolean('CADENCE_RIGIDITY_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    }
    case 'human_like_cadence': {
      const minMs = Number(process.env.HUMAN_TYPE_MIN_DELAY_MS || 50);
      const maxMs = Number(process.env.HUMAN_TYPE_MAX_DELAY_MS || 300);
      scenarioDetails.humanLikeCadence = await typeWithVariableDelay(page, root.locator(config.usernameSelector), username, minMs, maxMs, {
        highVariance: readBoolean('HUMAN_LIKE_CADENCE_HIGH_VARIANCE', true),
      });
      scenarioDetails.humanLikeCadence.expectedToken = 'field1.cadenceRigidity';
      scenarioDetails.humanLikeCadence.expectedPosition = getDfsE7FieldTokenPosition(0, E7_FIELD.CADENCE_RIGIDITY);
      triggerOptions.forceSyntheticSubmit = readBoolean('HUMAN_LIKE_CADENCE_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    }
    case 'focus_anomaly':
      const focusAnomalySelector = readBoolean('FOCUS_ANOMALY_USE_SCRATCH_FIELD', false)
        ? await ensureFocusAnomalyScratchField(page, root)
        : config.usernameSelector;
      scenarioDetails.focusAnomaly = await dispatchFocusAnomaly(root.locator(focusAnomalySelector), username);
      scenarioDetails.focusAnomaly.selector = focusAnomalySelector;
      scenarioDetails.focusAnomaly.usesScratchField = focusAnomalySelector !== config.usernameSelector;
      scenarioDetails.focusAnomaly.expectedToken = 'field1.focusAnomaly';
      scenarioDetails.focusAnomaly.expectedPosition = getDfsE7FieldTokenPosition(0, E7_FIELD.FOCUS_ANOMALY);
      triggerOptions.forceSyntheticSubmit = readBoolean('FOCUS_ANOMALY_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    case 'dwell_missing_keyups':
      scenarioDetails.dwellAnomaly = await dispatchKeydownsWithoutKeyups(root.locator(config.usernameSelector), username);
      scenarioDetails.dwellAnomaly.expectedToken = 'field1.dwellAnomaly';
      scenarioDetails.dwellAnomaly.expectedPosition = getDfsE7FieldTokenPosition(0, E7_FIELD.DWELL_ANOMALY);
      triggerOptions.forceSyntheticSubmit = readBoolean('DWELL_ANOMALY_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    case 'dwell_short_holds':
      scenarioDetails.dwellAnomaly = await dispatchShortHoldKeys(root.locator(config.usernameSelector), username);
      scenarioDetails.dwellAnomaly.expectedToken = 'field1.dwellAnomaly';
      scenarioDetails.dwellAnomaly.expectedPosition = getDfsE7FieldTokenPosition(0, E7_FIELD.DWELL_ANOMALY);
      triggerOptions.forceSyntheticSubmit = readBoolean('DWELL_ANOMALY_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    case 'fill_speed': {
      const selector = readString('FILL_SPEED_SELECTOR', config.usernameSelector);
      const field = root.locator(selector);
      await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
      await field.click();
      const text = readString('FILL_SPEED_TEXT', `${username || 'testuser1'}${password || 'password123'}`);
      const delayMs = Number(process.env.FILL_SPEED_TYPE_DELAY_MS || 0);
      await page.keyboard.type(String(text), { delay: delayMs });
      scenarioDetails.fillSpeed = {
        selector,
        textLength: String(text).length,
        delayMs,
        expectedToken: 'field1.fillSpeed',
        expectedPosition: getDfsE7FieldTokenPosition(0, E7_FIELD.FILL_SPEED),
      };
      triggerOptions.forceSyntheticSubmit = readBoolean('FILL_SPEED_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    }
    case 'paste_fragmentation': {
      const fragments = parseList(readString('PASTE_FRAGMENTATION_CHUNKS', 'te,st,us,er1'));
      scenarioDetails.pasteFragmentation = await pasteFragments(root.locator(config.usernameSelector), fragments);
      scenarioDetails.pasteFragmentation.expectedToken = 'field1.pasteFragmentation';
      scenarioDetails.pasteFragmentation.expectedPosition = getDfsE7FieldTokenPosition(0, E7_FIELD.PASTE_FRAGMENTATION);
      triggerOptions.forceSyntheticSubmit = readBoolean('PASTE_FRAGMENTATION_FORCE_SYNTHETIC_SUBMIT', true);
      break;
    }
    case 'focus_no_pointer':
      scenarioDetails.focusNoPointer = await programmaticFocusField(root.locator(config.usernameSelector));
      await page.keyboard.type(String(username), { delay: Number(process.env.FOCUS_NO_POINTER_TYPE_DELAY_MS || 60) });
      scenarioDetails.focusNoPointer.expectedToken = 'field1.focusNoPointer';
      scenarioDetails.focusNoPointer.expectedPosition = getDfsE7FieldTokenPosition(0, E7_FIELD.FOCUS_NO_POINTER);
      triggerOptions.forceSyntheticSubmit = false;
      break;
    case 'key_input_mismatch_cdp':
      if (!supportsCdpInsertText(target)) {
        return {
          skipped: true,
          reason: 'CDP Input.insertText is Chromium-only; skipping keyInputMismatch CDP scenario for this browser target.',
          browser: target.browser,
        };
      }
      scenarioDetails.keyInputMismatch = await insertTextWithCdp(page, root, config.usernameSelector, readString('KEY_INPUT_MISMATCH_VALUE', 'textuser'));
      scenarioDetails.keyInputMismatch.expectedToken = 'field1.keyInputMismatch';
      scenarioDetails.keyInputMismatch.expectedPosition = getDfsE7FieldTokenPosition(0, E7_FIELD.KEY_INPUT_MISMATCH);
      triggerOptions.forceSyntheticSubmit = false;
      break;
    case 'key_input_mismatch_paste_negative':
      scenarioDetails.keyInputMismatchPasteNegative = await pasteWithoutKeyInputMismatch(root.locator(config.usernameSelector), readString('KEY_INPUT_MISMATCH_PASTE_VALUE', 'pasted'));
      scenarioDetails.keyInputMismatchPasteNegative.expectedToken = 'field1.keyInputMismatch';
      scenarioDetails.keyInputMismatchPasteNegative.expectedPosition = getDfsE7FieldTokenPosition(0, E7_FIELD.KEY_INPUT_MISMATCH);
      triggerOptions.forceSyntheticSubmit = false;
      break;
    case 'browser_autofill_suppression': {
      const field = root.locator(config.usernameSelector);
      scenarioDetails.autofill = await detectAutofillSuppressionCandidate(field);
      if (!scenarioDetails.autofill.autofillMatches) {
        return {
          skipped: true,
          reason: 'Browser autofill was not observed. Seed a persistent browser profile with saved credentials, then rerun C4 to validate autofill suppression.',
          autofill: scenarioDetails.autofill,
        };
      }
      scenarioDetails.autofill.expectedSuppressedPositions = [
        E7_POS.VALUE_INJECTION,
        E7_POS.COLD_FOCUS,
        getDfsE7FieldTokenPosition(0, E7_FIELD.INJECTED_TEXT),
        getDfsE7FieldTokenPosition(0, E7_FIELD.DWELL_ANOMALY),
        getDfsE7FieldTokenPosition(0, E7_FIELD.FILL_SPEED),
        getDfsE7FieldTokenPosition(0, E7_FIELD.FOCUS_NO_POINTER),
      ];
      triggerOptions.forceSyntheticSubmit = false;
      break;
    }
    case 'human_baseline':
      const baselineMinMs = Number(process.env.HUMAN_BASELINE_TYPE_MIN_DELAY_MS || process.env.HUMAN_TYPE_MIN_DELAY_MS || 50);
      const baselineMaxMs = Number(process.env.HUMAN_BASELINE_TYPE_MAX_DELAY_MS || process.env.HUMAN_TYPE_MAX_DELAY_MS || 300);
      await clickWithMousePath(page, root.locator(config.usernameSelector));
      scenarioDetails.usernameTyping = await typeWithVariableDelay(page, root.locator(config.usernameSelector), username, baselineMinMs, baselineMaxMs, { skipClick: true });
      if (config.passwordSelector) {
        await clickWithMousePath(page, root.locator(config.passwordSelector), { offsetRatioX: 0.42, offsetRatioY: 0.58 });
        scenarioDetails.passwordTyping = await typeWithVariableDelay(page, root.locator(config.passwordSelector), password, baselineMinMs, baselineMaxMs, { skipClick: true });
      }
      scenarioDetails.baselineCadenceRange = { minMs: baselineMinMs, maxMs: baselineMaxMs };
      scenarioDetails.submitClick = await clickHumanScenarioSubmit(page, root, config, { offsetRatioX: 0.41, offsetRatioY: 0.52 });
      triggerOptions.forceSyntheticSubmit = false;
      triggerOptions.skipSubmit = true;
      break;
    case 'human_pause_baseline': {
      await clickWithMousePath(page, root.locator(config.usernameSelector));
      const text = String(username);
      await page.keyboard.type(text.slice(0, 3), { delay: 90 });
      await page.waitForTimeout(Number(process.env.HUMAN_PAUSE_MS || 500));
      await page.keyboard.type(text.slice(3), { delay: 100 });
      if (config.passwordSelector) {
        await clickWithMousePath(page, root.locator(config.passwordSelector), { offsetRatioX: 0.43, offsetRatioY: 0.57 });
        const passwordText = String(password || 'password123');
        await page.keyboard.type(passwordText.slice(0, 3), { delay: 95 });
        await page.waitForTimeout(Number(process.env.HUMAN_PAUSE_MS || 500));
        await page.keyboard.type(passwordText.slice(3), { delay: 105 });
      }
      scenarioDetails.submitClick = await clickHumanScenarioSubmit(page, root, config, { offsetRatioX: 0.36, offsetRatioY: 0.61 });
      scenarioDetails.humanPauseBaseline = {
        usernameFirstChunkLength: Math.min(3, text.length),
        passwordIncluded: Boolean(config.passwordSelector),
        passwordFirstChunkLength: config.passwordSelector ? Math.min(3, String(password || 'password123').length) : 0,
        pauseMs: Number(process.env.HUMAN_PAUSE_MS || 500),
      };
      triggerOptions.forceSyntheticSubmit = false;
      triggerOptions.skipSubmit = true;
      break;
    }
    case 'human_mouse_path':
      await clickWithMousePath(page, root.locator(config.usernameSelector));
      if (config.passwordSelector) await clickWithMousePath(page, root.locator(config.passwordSelector), { offsetRatioX: 0.45, offsetRatioY: 0.55 });
      scenarioDetails.submitClick = await clickHumanScenarioSubmit(page, root, config, { offsetRatioX: 0.4, offsetRatioY: 0.6 });
      scenarioDetails.humanMousePath = {
        usedIntermediateMouseMoves: true,
        expectedToken: 'pointerTravel',
        expectedPosition: 3,
      };
      triggerOptions.skipSubmit = true;
      break;
    default:
      return {
        skipped: true,
        reason: `Unknown interaction scenario: ${scenarioName}`,
      };
  }

  const trigger = triggerOptions.skipSubmit
    ? { method: 'scenario_already_submitted' }
    : await triggerBehaviorScore(page, root, config, {
      forceSyntheticSubmit: triggerOptions.forceSyntheticSubmit !== undefined
        ? triggerOptions.forceSyntheticSubmit
        : true,
    });
  return { skipped: false, trigger, ...scenarioDetails };
}

async function runInteractionScenario(browser, target, config, outputDir, results, scenarioName, attempt = 1) {
  const requestedScenarioName = scenarioName;
  scenarioName = normalizeInteractionScenarioName(scenarioName);
  const scenarioSlug = sanitizeSegment(scenarioName);
  let scenarioContext;
  let scenarioPage;
  const maxAttempts = getTestRetryAttempts();
  try {
    scenarioContext = await runStep(`create ${scenarioName} interaction context`, () => browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    }));
    await runStep(`install ${scenarioName} script override`, () => installScriptOverride(scenarioContext, outputDir));
    scenarioPage = await runStep(`open ${scenarioName} interaction page`, () => scenarioContext.newPage());
    await runStep(`navigate ${scenarioName} interaction page`, () => scenarioPage.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    }));
    await runStep(`${scenarioName} post-load wait`, () => scenarioPage.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000)));
    await runStep(`${scenarioName} secure redirect recovery`, () => recoverSecureChaseSystemRequirements(scenarioPage));

    const before = await runStep(`read ${scenarioName} baseline behavior state`, () => readBehaviorState(scenarioPage));
    const performed = await runStep(`perform ${scenarioName} interaction scenario`, () => performInteractionScenario(scenarioPage, scenarioName, target));
    if (performed.skipped) {
      addResult(
        results,
        `Interaction Scenario - ${scenarioName}`,
        'SKIP',
        performed,
        [],
        [performed.reason]
      );
      return;
    }
    const scoreExpectations = getAgenticScoreExpectations(scenarioName);
    const expectationWait = await runStep(`wait for ${scenarioName} behavior expectations`, () => waitForBehaviorExpectations(scenarioPage, scoreExpectations, before.dfs_E_7_score_tokens));
    const after = expectationWait.state;
    const debugLog = await runStep(`read ${scenarioName} dfs_E_5 debug log`, () => getDfsE5DebugLog(scenarioPage));
    const scoreFailures = expectationWait.failures;
    const f2Changed = before.dfs_F_2 !== undefined && after.dfs_F_2 !== undefined && String(before.dfs_F_2) !== String(after.dfs_F_2);
    const failures = [...scoreFailures];
    const evidence = {
      scenario: scenarioName,
      requestedScenario: requestedScenarioName,
      browser: target.browser,
      attempt,
      maxAttempts,
      before: {
        dfs_E_5: before.dfs_E_5,
        dfs_E_7: before.dfs_E_7,
        dfs_E_7_format: before.dfs_E_7_format,
        dfs_E_7_score_tokens: before.dfs_E_7_score_tokens,
        dfs_F_5: before.dfs_F_5,
        dfs_F_2: before.dfs_F_2,
      },
      performed,
      after: {
        dfs_E_5: after.dfs_E_5,
        dfs_E_7: after.dfs_E_7,
        dfs_E_7_format: after.dfs_E_7_format,
        dfs_E_7_score_tokens: after.dfs_E_7_score_tokens,
        dfs_F_5: after.dfs_F_5,
        dfs_F_2: after.dfs_F_2,
      },
      expectations: scoreExpectations,
      expectationWait,
      assertionMode: 'score-tokens',
      f2Changed,
      trigger: performed.trigger,
      focusInputTiming: performed.focusInputTiming,
      mouseTeleport: performed.mouseTeleport,
      debugLog,
    };
    if (failures.length > 0 && attempt < maxAttempts && failures.some(isRetryableTestMessage)) {
      if (scenarioPage && !scenarioPage.isClosed()) await closeWithTimeout(`${scenarioName} retry page`, () => scenarioPage.close());
      if (scenarioContext) await closeWithTimeout(`${scenarioName} retry context`, () => scenarioContext.close());
      await waitBeforeTestRetry();
      return runInteractionScenario(browser, target, config, outputDir, results, scenarioName, attempt + 1);
    }
    const evidenceFile = saveJson(path.join(outputDir, `interaction-${scenarioSlug}.json`), evidence);
    addResult(
      results,
      `Interaction Scenario - ${scenarioName}`,
      failures.length === 0 ? 'PASS' : 'FAIL',
      evidence,
      [evidenceFile],
      failures
    );
  } catch (error) {
    if (attempt < maxAttempts && isRetryableTestMessage(error.message)) {
      if (scenarioPage && !scenarioPage.isClosed()) await closeWithTimeout(`${scenarioName} retry page`, () => scenarioPage.close());
      if (scenarioContext) await closeWithTimeout(`${scenarioName} retry context`, () => scenarioContext.close());
      await waitBeforeTestRetry();
      return runInteractionScenario(browser, target, config, outputDir, results, scenarioName, attempt + 1);
    }
    addResult(
      results,
      `Interaction Scenario - ${scenarioName}`,
      'FAIL',
      { scenario: scenarioName, attempt, maxAttempts, error: error.message },
      [],
      [error.message]
    );
  } finally {
    if (scenarioPage && !scenarioPage.isClosed()) await closeWithTimeout(`${scenarioName} page`, () => scenarioPage.close());
    if (scenarioContext) await closeWithTimeout(`${scenarioName} context`, () => scenarioContext.close());
  }
}

async function runInteractionScenarioTests(browser, target, config, outputDir, results) {
  if (!readBoolean('PERFORM_INTERACTION_SCENARIO_TESTS', true)) {
    addResult(
      results,
      'Interaction Scenario Tests',
      'SKIP',
      { reason: 'PERFORM_INTERACTION_SCENARIO_TESTS=false; interaction scenarios skipped by configuration.' },
      [],
      ['Interaction scenario tests skipped by configuration.']
    );
    return;
  }

  for (const scenarioName of getInteractionScenarioNames()) {
    await runInteractionScenario(browser, target, config, outputDir, results, scenarioName);
  }
}

async function runPrivateModeBrowserTest(target, config, outputDir, results) {
  if (!readBoolean('PERFORM_PRIVATE_MODE_BROWSER_TEST', true)) {
    addResult(
      results,
      'Private / Incognito Browser Mode Launch',
      'SKIP',
      { reason: 'PERFORM_PRIVATE_MODE_BROWSER_TEST=false; private/incognito browser launch skipped by configuration.' },
      [],
      ['Private/incognito browser mode launch skipped by configuration.']
    );
    return;
  }

  const launchOptions = getPrivateModeLaunchOptions(target);
  if (!launchOptions) {
    addResult(
      results,
      'Private / Incognito Browser Mode Launch',
      'SKIP',
      {
        browser: target.browser,
        reason: 'This runner does not have a reliable private/incognito launch strategy for this browser target.',
        supportedTargets: ['chrome', 'edge', 'opera', 'comet', 'atlas', 'firefox'],
      },
      [],
      [`Private/incognito launch is not supported for ${target.browser}.`]
    );
    return;
  }

  const browserType = getBrowserType(target.browser);
  let privateBrowser;
  let privateContext;
  let privatePage;

  try {
    privateBrowser = await runStep('launch private/incognito browser', () => browserType.launch(launchOptions));
    privateContext = await runStep('create private/incognito context', () => privateBrowser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    }));
    await runStep('install private/incognito script override', () => installScriptOverride(privateContext, outputDir));
    privatePage = await runStep('open private/incognito page', () => privateContext.newPage());
    await runStep(`navigate private/incognito page to ${config.targetUrl}`, () => privatePage.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    }));
    await runStep('private/incognito post-load wait', () => privatePage.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000)));
    const fingerprint = await runStep('read private/incognito fingerprint', () => getFingerprint(privatePage));
    await runStep('private/incognito cookie settle wait', () => waitForCookieSettle(privatePage, 'private_mode'));
    const cookies = parseCookieArray(await runStep('read private/incognito DFS cookies', () => getDfsCookies(privatePage)));
    const dfsE1 = cookies.dfs_E_1 || getFingerprintValue(fingerprint, 'dfs_E_1');
    const evidence = {
      browser: target.browser,
      launchStrategy: target.browser === 'firefox' ? 'firefoxUserPrefs browser.privatebrowsing.autostart=true' : '--incognito',
      dfs_E_1: dfsE1,
      expectedDfs_E_1: '1',
      cookies,
      fingerprint,
      note: 'This validates whether DFS private-mode detection identifies a browser launched through the runner private/incognito strategy.',
    };
    const evidenceFile = saveJson(path.join(outputDir, 'private-mode-browser-launch.json'), evidence);
    addResult(
      results,
      'Private / Incognito Browser Mode Launch',
      String(dfsE1) === '1' ? 'PASS' : 'FAIL',
      evidence,
      [evidenceFile],
      String(dfsE1) === '1' ? [] : [`dfs_E_1 expected 1 in private/incognito mode, got ${dfsE1}`]
    );
  } catch (error) {
    addResult(
      results,
      'Private / Incognito Browser Mode Launch',
      'FAIL',
      { browser: target.browser, error: error.message },
      [],
      [error]
    );
  } finally {
    if (privatePage && !privatePage.isClosed()) await closeWithTimeout('Private/incognito page', () => privatePage.close());
    if (privateContext) await closeWithTimeout('Private/incognito context', () => privateContext.close());
    if (privateBrowser) await closeWithTimeout('Private/incognito browser', () => privateBrowser.close());
  }
}

let currentRun = { outputDir: ROOT_DIR, steps: [], currentStep: null };

function writeRunProgress() {
  if (!currentRun.outputDir) return;

  const progressPath = path.join(currentRun.outputDir, 'test-progress.json');
  const currentStep = currentRun.currentStep
    ? {
        ...currentRun.currentStep,
        elapsedMs: Date.now() - currentRun.currentStep.startedAtMs,
      }
    : null;

  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  fs.writeFileSync(
    progressPath,
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        currentStep,
        steps: currentRun.steps,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function runStep(label, action) {
  const traceSteps = readBoolean('TRACE_STEPS', false);
  const stallLogMs = Number(process.env.STEP_STALL_LOG_MS || 10000);
  const stepTimeoutMs = Number(process.env.STEP_TIMEOUT_MS || 60000);
  const step = {
    label,
    status: 'waiting',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  };
  let heartbeat;

  currentRun.currentStep = step;
  if (traceSteps) console.log(`    waiting: ${label}`);
  writeRunProgress();

  if (traceSteps && stallLogMs > 0) {
    heartbeat = setInterval(() => {
      const elapsedMs = Date.now() - step.startedAtMs;
      console.log(`    still waiting after ${elapsedMs}ms: ${label}`);
      writeRunProgress();
    }, stallLogMs);
    heartbeat.unref();
  }

  try {
    const actionPromise = Promise.resolve().then(action);
    actionPromise.catch(() => {});
    let stepTimeout;

    const result = stepTimeoutMs > 0
      ? await Promise.race([
          actionPromise,
          new Promise((_, reject) => {
            stepTimeout = setTimeout(() => reject(new Error(`${label} timed out after ${stepTimeoutMs}ms`)), stepTimeoutMs);
          }),
        ]).finally(() => clearTimeout(stepTimeout))
      : await actionPromise;
    const completedStep = {
      label,
      status: 'complete',
      startedAt: step.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - step.startedAtMs,
    };
    currentRun.steps.push(completedStep);
    if (traceSteps) console.log(`    complete: ${label} (${completedStep.durationMs}ms)`);
    return result;
  } catch (error) {
    const failedStep = {
      label,
      status: 'error',
      startedAt: step.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - step.startedAtMs,
      error: error.message,
    };
    currentRun.steps.push(failedStep);
    if (traceSteps) console.log(`    error: ${label} (${failedStep.durationMs}ms): ${error.message}`);
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    currentRun.currentStep = null;
    writeRunProgress();
  }
}

async function runTarget(target, config) {
  const results = [];
  const consoleMessages = [];
  const dfsJsFiles = [];
  const releaseVersion = getReleaseVersion();
  const browserVersion = target.configuredVersion;
  const outputDir = config.lob
    ? path.join(config.releaseDir, sanitizeSegment(config.lob), sanitizeSegment(target.browser), sanitizeSegment(browserVersion))
    : path.join(config.releaseDir, sanitizeSegment(target.browser), sanitizeSegment(browserVersion));
  currentRun = { outputDir, steps: [], currentStep: null };
  fs.mkdirSync(path.join(outputDir, 'screenshots'), { recursive: true });

  const metadata = {
    browser: target.browser,
    configuredVersion: target.configuredVersion,
    executablePath: target.executablePath,
    launchMode: usesBundledFirefox(target) ? 'playwright-bundled-firefox' : 'configured-executable',
    lob: config.lob || null,
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
  let scriptOverride = null;

  try {
    browser = await runStep('launch browser', () => browserType.launch(getLaunchOptions(target)));

    context = await runStep('create browser context', () => browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    }));
    scriptOverride = await runStep('install script override', () => installScriptOverride(context, outputDir));
    page = await runStep('open new page', () => context.newPage());
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
    page.on('request', (request) => {
      const url = request.url();
      if (!isDfsOrLevoJsUrl(url)) return;

      dfsJsFiles.push({
        url,
        method: request.method(),
        resourceType: request.resourceType(),
        timestamp: new Date().toISOString(),
      });
    });

    await runStep(`navigate to ${config.targetUrl}`, () => page.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    }));
    await runStep('post-load wait', () => page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000)));
    metadata.secureRedirectRecovery = await runStep('secure redirect recovery', () => recoverSecureChaseSystemRequirements(page));

    if (isChaseSystemRequirementsUrl(page.url())) {
      const screenshot = await runStep('save chase-system-requirements screenshot', () => saveScreenshot(page, 'chase-system-requirements'));
      const targetLabel = config.lob || 'Target';
      metadata.skippedReason = `${targetLabel} redirected to Chase system requirements page; DFS/login tests are not available in this browser mode.`;
      metadata.finalUrl = page.url();
      addResult(
        results,
        'Chase Target Availability',
        'SKIP',
        {
          reason: metadata.skippedReason,
          targetUrl: config.targetUrl,
          finalUrl: page.url(),
          recovery: metadata.secureRedirectRecovery,
          recommendation: config.lob === 'SECURE'
            ? 'Run Secure with SECURE.HEADLESS=false or a browser mode that reaches the logonbox frame.'
            : 'Run this target in a browser mode that is not redirected to Chase system requirements.',
        },
        [screenshot],
        [metadata.skippedReason]
      );
      return { metadata, results };
    }

    const screenshotInitial = await runStep('save initial-page screenshot', () => saveScreenshot(page, 'initial-page'));
    const inputDiscovery = await runStep('discover page input fields', () => discoverInputFields(page));
    const inputDiscoveryFile = saveJson(path.join(outputDir, 'input-fields.json'), inputDiscovery);
    logInputDiscovery(inputDiscovery);
    addResult(
      results,
      'Page Input Field Discovery',
      inputDiscovery.totals.visibleFields > 0 ? 'PASS' : 'FAIL',
      inputDiscovery.totals,
      [inputDiscoveryFile, screenshotInitial],
      inputDiscovery.totals.visibleFields > 0 ? [] : ['No visible input, button, or link controls were found on the page.']
    );

    if (readBoolean('DISCOVER_INPUTS_ONLY', false)) {
      metadata.discoveryOnly = true;
      return { metadata, results };
    }

    initialFingerprint = await runStep('read initial fingerprint', () => getFingerprint(page));
    await runStep('initial cookie settle wait', () => waitForCookieSettle(page, 'initial'));
    const initialCookies = await runStep('read initial DFS cookies', () => getDfsCookies(page));
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
      userAgent: await runStep('read user agent', () => page.evaluate(() => navigator.userAgent)),
      dfs_E_6_cookie: initialCookieMap.dfs_E_6,
      dfs_E_6_fingerprint: getFingerprintValue(initialFingerprint, 'dfs_E_6'),
      expectedValue: getExpectedDfsE6(target.browser),
      expectedFormat: 'dd - dd',
    };
    const e6FormatOk = /^\d{2}\s-\s\d{2}$/.test(String(browserDetection.dfs_E_6_cookie || ''));
    const e6Matches = browserDetection.dfs_E_6_fingerprint === undefined || String(browserDetection.dfs_E_6_cookie) === String(browserDetection.dfs_E_6_fingerprint);
    const e6ExpectedMatches = !browserDetection.expectedValue || String(browserDetection.dfs_E_6_cookie) === browserDetection.expectedValue;
    const browserDetectionPassed = e6FormatOk && e6Matches && e6ExpectedMatches;
    let browserDetectionFailureSignalsFile = null;
    if (!browserDetectionPassed) {
      browserDetection.failureSignals = await runStep('read browser detection failure signals', () => getBrowserDetectionFailureSignals(page));
      browserDetectionFailureSignalsFile = saveJson(path.join(outputDir, 'browser-detection-failure-signals.json'), browserDetection.failureSignals);
    }
    const browserDetectionFile = saveJson(path.join(outputDir, 'browser-detection.json'), browserDetection);
    addResult(
      results,
      'Browser Detection',
      browserDetectionPassed ? 'PASS' : 'FAIL',
      browserDetection,
      [browserDetectionFile, ...(browserDetectionFailureSignalsFile ? [browserDetectionFailureSignalsFile] : [])],
      [
        ...(e6FormatOk ? [] : ['dfs_E_6 does not match expected format dd - dd']),
        ...(e6Matches ? [] : ['dfs_E_6 cookie does not match fingerprint value']),
        ...(e6ExpectedMatches ? [] : [`dfs_E_6 expected ${browserDetection.expectedValue} for ${process.platform}/${target.browser}, got ${browserDetection.dfs_E_6_cookie}`]),
      ]
    );

    const e7 = String(initialCookieMap.dfs_E_7 || getFingerprintValue(initialFingerprint, 'dfs_E_7') || '');
    const e7Format = getDfsE7Format(e7);
    const e7ScoreTokens = decodeDfsE7ScoreTokens(e7, initialCookieMap.dfs_F_5 || getFingerprintValue(initialFingerprint, 'dfs_F_5'));
    const e7Evaluation = {
      dfs_E_7: e7,
      dfs_E_7_format: e7Format,
      dfs_E_7_score_tokens: e7ScoreTokens,
      expectedFormat: 'score-tokens',
      expectedLengthRule: '10 + (nFields x 16) digits; 10-74 digits total; 2 decimal digits per token',
      dePermutationSeedSource: 'dfs_F_5 first 8 hex characters',
    };
    const e7Failures = [
      ...(e7Format === 'score-tokens' ? [] : [`dfs_E_7 expected score-token format, got ${e7Format}`]),
      ...(e7ScoreTokens.rawTokens.length >= 4 ? [] : [`dfs_E_7 expected at least 4 score tokens, got ${e7ScoreTokens.rawTokens.length}`]),
    ];
    const e7EvidenceFile = saveJson(path.join(outputDir, 'dfs-e7-score-token-evaluation.json'), e7Evaluation);
    addResult(
      results,
      'dfs_E_7 Score Token Format',
      e7Failures.length === 0 ? 'PASS' : 'FAIL',
      e7Evaluation,
      [e7EvidenceFile],
      e7Failures
    );

    if (readBoolean('PERFORM_PRIVATE_MODE_DETECTION_TEST', true)) {
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
    } else {
      addResult(
        results,
        'Private / Incognito Mode Detection',
        'SKIP',
        { reason: 'PERFORM_PRIVATE_MODE_DETECTION_TEST=false; normal-session private/incognito check skipped by configuration.' },
        [],
        ['Private/incognito mode detection skipped by configuration.']
      );
    }

    if (readBoolean('PERFORM_PRIVATE_MODE_BROWSER_TEST', true)) {
      await runPrivateModeBrowserTest(target, config, outputDir, results);
    } else {
      addResult(
        results,
        'Private / Incognito Browser Mode Launch',
        'SKIP',
        { reason: 'PERFORM_PRIVATE_MODE_BROWSER_TEST=false; private/incognito browser launch skipped by configuration before launch.' },
        [],
        ['Private/incognito browser mode launch skipped by configuration.']
      );
    }

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

    await runInteractionScenarioTests(browser, target, config, outputDir, results);

    const loginBeforeMouse = readBoolean('LOGIN_BEFORE_MOUSE', false);
    let logonValidationRan = false;
    if (loginBeforeMouse) {
      await runLogonValidation(page, outputDir, results);
      logonValidationRan = true;
    }

    if (readBoolean('PERFORM_MOUSE_MOVEMENT', true)) {
      await runStep('pre-mouse wait', () => page.waitForTimeout(Number(process.env.MOUSE_WAIT_BEFORE_MS || 15000)));
      await runStep('perform mouse movement', () => maybeMoveMouse(page));
      await runStep('post-mouse wait', () => page.waitForTimeout(Number(process.env.MOUSE_WAIT_AFTER_MS || 1000)));
      const afterMouseScreenshot = await runStep('save after-mouse screenshot', () => saveScreenshot(page, 'after-mouse'));
      const fingerprintAfterMouse = await runStep('read fingerprint after mouse', () => getFingerprint(page));
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

    const loginBeforeReload = readBoolean('LOGIN_BEFORE_RELOAD', false);
    if (loginBeforeReload && !logonValidationRan) {
      await runLogonValidation(page, outputDir, results);
      logonValidationRan = true;
    }

    if (readBoolean('PERFORM_RELOAD_TEST', true)) {
      await runStep('reload page', () => page.reload({ waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded', timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000) }));
      await runStep('post-reload wait', () => page.waitForTimeout(Number(process.env.POST_RELOAD_WAIT_MS || 5000)));
      const fingerprintAfterReload = await runStep('read fingerprint after reload', () => getFingerprint(page));
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
    } else {
      addResult(
        results,
        'Session Stability',
        'SKIP',
        { reason: 'PERFORM_RELOAD_TEST=false; reload skipped by configuration.' },
        [],
        ['Reload/session-stability validation skipped by configuration.']
      );
    }

    if (!loginBeforeReload && !logonValidationRan) {
      await runLogonValidation(page, outputDir, results);
    }

    const expectedDfsE8 = process.env.EXPECTED_DFS_E_8 || process.env.RELEASE_VERSION;
    if (expectedDfsE8) {
      const actual = initialCookieMap.dfs_E_8 || getFingerprintValue(initialFingerprint, 'dfs_E_8');
      const releaseComparison = {
        expected: expectedDfsE8,
        actual,
        matches: String(actual) === String(expectedDfsE8),
      };
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
    if (scriptOverride) {
      saveJson(path.join(outputDir, 'script-override.json'), scriptOverride);
      metadata.scriptOverride = scriptOverride.overrides
        ? {
          overrides: scriptOverride.overrides.map((override) => ({
            name: override.name,
            match: override.match,
            sourceType: override.sourceType,
            source: override.source,
            found: override.found,
            matchedRequests: override.matchedRequests.length,
          })),
        }
        : {
          match: scriptOverride.match,
          sourceType: scriptOverride.sourceType,
          source: scriptOverride.source,
          found: scriptOverride.found,
          matchedRequests: scriptOverride.matchedRequests.length,
        };
    }

    const consoleFile = saveJson(path.join(outputDir, 'console-log.json'), consoleMessages);
    saveJson(path.join(outputDir, 'dfs-js-files.json'), {
      found: dfsJsFiles.length > 0,
      count: dfsJsFiles.length,
      files: dfsJsFiles,
    });
    const hasFailures = results.some((result) => result.status === 'FAIL');
    let browserFailureDiagnosticsFile = null;

    if (hasFailures && page && !page.isClosed()) {
      const diagnostics = await runWithTimeout(
        'Browser failure diagnostics',
        Number(process.env.BROWSER_DIAGNOSTICS_TIMEOUT_MS || 5000),
        () => getBrowserFailureDiagnostics(page)
      ).catch((error) => ({
        capturedAt: new Date().toISOString(),
        error: error.message,
        values: [],
      }));
      if (diagnostics) {
        browserFailureDiagnosticsFile = saveJson(path.join(outputDir, 'browser-failure-diagnostics.json'), diagnostics);
        for (const result of results.filter((item) => item.status === 'FAIL')) {
          result.evidenceFilePaths.push(browserFailureDiagnosticsFile);
        }
      }
    }

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

function getResultReason(result) {
  if (result.details && typeof result.details === 'object' && result.details.reason) {
    return result.details.reason;
  }
  if (result.errors && result.errors.length > 0) {
    return result.errors[0];
  }
  return '';
}

function getCoverStatusText(result) {
  if (result.status !== 'FAIL') return result.status;

  const reason = getResultReason(result);
  return reason ? `${result.status} - ${reason}` : result.status;
}

function getAggregateTotals(aggregate) {
  return {
    browsers: aggregate.length,
    tests: aggregate.reduce((sum, item) => sum + item.results.length, 0),
    passed: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'PASS').length, 0),
    failed: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'FAIL').length, 0),
    skipped: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'SKIP').length, 0),
    running: aggregate.reduce((sum, item) => sum + item.results.filter((test) => test.status === 'RUNNING').length, 0),
  };
}

function createRunningAggregateItem(target, config) {
  return {
    metadata: {
      browser: target.browser,
      configuredVersion: target.configuredVersion,
      executablePath: target.executablePath,
      launchMode: usesBundledFirefox(target) ? 'playwright-bundled-firefox' : 'configured-executable',
      lob: config.lob || null,
      targetUrl: config.targetUrl,
      releaseVersion: config.releaseVersion,
      startedAt: new Date().toISOString(),
      actualBrowserVersion: null,
    },
    results: [
      {
        testName: 'Browser Run',
        status: 'RUNNING',
        details: { reason: 'Browser run is in progress.' },
        evidenceFilePaths: [],
        errors: [],
      },
    ],
  };
}

function writeAggregateSummary(releaseDir, aggregate, context) {
  const aggregatePath = path.join(releaseDir, 'summary-report.json');
  saveJson(aggregatePath, {
    releaseVersion: context.releaseVersion,
    targetUrls: context.targetUrls,
    generatedAt: new Date().toISOString(),
    inProgress: Boolean(context.inProgress),
    totals: getAggregateTotals(aggregate),
    runs: aggregate.map((item) => ({
      metadata: item.metadata,
      results: item.results,
    })),
  });
  return aggregatePath;
}

function getFingerprintSummaryValue(fingerprintFile) {
  if (!fingerprintFile || !fs.existsSync(fingerprintFile)) return '';
  try {
    const fingerprint = JSON.parse(fs.readFileSync(fingerprintFile, 'utf8'));
    const values = extractFingerprintValues(fingerprint);
    return Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join('; ');
  } catch (error) {
    return `Unable to read fingerprint: ${error.message}`;
  }
}

function getCookieSummaryValue(cookieFile) {
  if (!cookieFile || !fs.existsSync(cookieFile)) return '';
  try {
    const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    return Object.keys(cookies).sort().map((key) => `${key}=${cookies[key]}`).join('; ');
  } catch (error) {
    return `Unable to read cookies: ${error.message}`;
  }
}

function findEvidenceFile(result, fileName) {
  return (result.evidenceFilePaths || []).find((filePath) => path.basename(filePath) === fileName);
}

function writePortableEvidenceText(releaseDir, aggregate, context) {
  const reportPath = path.join(releaseDir, 'portable-evidence.txt');
  const lines = [
    'DFS Portable Evidence',
    `Generated: ${new Date().toISOString()}`,
    `Release: ${context.releaseVersion}`,
    `Target URLs: ${Object.entries(context.targetUrls).map(([lob, url]) => `${lob}: ${url}`).join(', ')}`,
    `Status: ${context.inProgress ? 'IN PROGRESS' : 'COMPLETE'}`,
    '',
  ];

  for (const item of aggregate) {
    const metadata = item.metadata;
    const fingerprintResult = item.results.find((result) => result.testName === 'Script Initialization and Page Load')
      || item.results.find((result) => findEvidenceFile(result, 'fingerprint-initial.json'));
    const cookieResult = item.results.find((result) => result.testName === 'Cookie Presence on Page Load')
      || item.results.find((result) => findEvidenceFile(result, 'cookies-initial.json'));
    const fingerprintText = getFingerprintSummaryValue(findEvidenceFile(fingerprintResult || {}, 'fingerprint-initial.json'));
    const cookieText = getCookieSummaryValue(findEvidenceFile(cookieResult || {}, 'cookies-initial.json'));

    lines.push('='.repeat(100));
    lines.push(`BROWSER-VERSION: ${metadata.lob ? `${metadata.lob} ` : ''}${metadata.browser} ${metadata.configuredVersion}`);
    lines.push(`Actual Browser Version: ${metadata.actualBrowserVersion || ''}`);
    lines.push(`Target URL: ${metadata.targetUrl || ''}`);
    lines.push('');
    lines.push('Fingerprint');
    lines.push(fingerprintText || 'No fingerprint captured.');
    lines.push('');
    lines.push('Cookies');
    lines.push(cookieText || 'No cookies captured.');
    lines.push('');
    lines.push('Test Results');
    for (const result of item.results) {
      const reason = getResultReason(result);
      lines.push(`${result.status} | ${result.testName}${reason ? ` | ${reason}` : ''}`);
    }
    lines.push('');
  }

  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  return reportPath;
}

function writeLatestReleasePointer(releaseDir, reports, context) {
  if (!isNumberedEvidenceRunDir(releaseDir)) return null;

  const releaseRootDir = path.dirname(releaseDir);
  const generatedAt = new Date().toISOString();
  const coverHref = relativeLink(releaseRootDir, reports.coverReportPath);
  const summaryPath = path.join(releaseRootDir, 'summary-report.json');
  const portableEvidencePath = path.join(releaseRootDir, 'portable-evidence.txt');
  const coverReportPath = path.join(releaseRootDir, 'cover-report.html');
  const latestRunPath = path.join(releaseRootDir, 'latest-run.json');

  fs.copyFileSync(reports.aggregatePath, summaryPath);
  fs.copyFileSync(reports.portableEvidencePath, portableEvidencePath);
  saveJson(latestRunPath, {
    releaseVersion: context.releaseVersion,
    generatedAt,
    inProgress: Boolean(context.inProgress),
    latestRunDir: path.basename(releaseDir),
    summaryReport: relativeLink(releaseRootDir, reports.aggregatePath),
    coverReport: coverHref,
    portableEvidence: relativeLink(releaseRootDir, reports.portableEvidencePath),
  });

  fs.writeFileSync(
    coverReportPath,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=${escapeHtml(coverHref)}">
  <title>Latest DFS Evidence Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #172033; }
    a { color: #155eef; }
  </style>
</head>
<body>
  <h1>Latest DFS Evidence Report</h1>
  <p>Latest run: ${escapeHtml(path.basename(releaseDir))}</p>
  <p>Generated: ${escapeHtml(generatedAt)}</p>
  <p><a href="${escapeHtml(coverHref)}">Open latest cover report</a></p>
</body>
</html>
`,
    'utf8'
  );

  return { summaryPath, coverReportPath, portableEvidencePath, latestRunPath };
}

function writeLiveReports(releaseDir, aggregate, context) {
  const aggregatePath = writeAggregateSummary(releaseDir, aggregate, context);
  const coverReportPath = writeCoverReport(releaseDir, aggregate, aggregatePath, {
    releaseVersion: context.releaseVersion,
    targetUrl: Object.entries(context.targetUrls).map(([lob, url]) => `${lob}: ${url}`).join(', '),
    inProgress: context.inProgress,
  });
  const portableEvidencePath = writePortableEvidenceText(releaseDir, aggregate, context);
  const latestReleasePaths = writeLatestReleasePointer(releaseDir, { aggregatePath, coverReportPath, portableEvidencePath }, context);
  return { aggregatePath, coverReportPath, portableEvidencePath, latestReleasePaths };
}

function writeCoverReport(releaseDir, aggregate, aggregateJsonPath, context) {
  const allTestNames = [...new Set(aggregate.flatMap((item) => item.results.map((result) => result.testName)))];
  const totals = getAggregateTotals(aggregate);
  const generatedAt = new Date().toISOString();

  const rows = aggregate.map((item) => {
    const resultByName = new Map(item.results.map((result) => [result.testName, result]));
    const runDir = path.join(
      releaseDir,
      ...(item.metadata.lob ? [sanitizeSegment(item.metadata.lob)] : []),
      sanitizeSegment(item.metadata.browser),
      sanitizeSegment(item.metadata.configuredVersion)
    );
    const summaryLink = relativeLink(releaseDir, path.join(runDir, 'summary-report.json'));
    const evidenceLink = relativeLink(releaseDir, runDir);
    const cells = allTestNames.map((testName) => {
      const result = resultByName.get(testName);
      if (!result) return '<td class="skip">N/A</td>';
      const statusClass = result.status === 'PASS' ? 'pass' : result.status === 'FAIL' ? 'fail' : result.status === 'RUNNING' ? 'running' : 'skip';
      const title = result.errors && result.errors.length > 0 ? ` title="${escapeHtml(result.errors.join('; '))}"` : '';
      return `<td class="${statusClass}"${title}>${escapeHtml(getCoverStatusText(result))}</td>`;
    }).join('');

    return `
      <tr>
        <td>${escapeHtml(item.metadata.lob || '')}</td>
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
    .running { background: #fff8c5; color: #7a4f01; font-weight: bold; }
    a { color: #0b5cab; }
  </style>
</head>
<body>
  <h1>DFS Evidence Report</h1>
  <p class="meta">Release: ${escapeHtml(context.releaseVersion)}</p>
  <p class="meta">Target URL(s): ${escapeHtml(context.targetUrl)}</p>
  <p class="meta">Generated: ${escapeHtml(generatedAt)}</p>
  <p class="meta">Status: ${context.inProgress ? 'IN PROGRESS - refresh this page for updates' : 'COMPLETE'}</p>
  <p class="meta">Aggregate JSON: <a href="${escapeHtml(aggregateLink)}">${escapeHtml(aggregateLink)}</a></p>
  <div class="totals">
    <div class="total"><strong>${totals.browsers}</strong> Browser Runs</div>
    <div class="total"><strong>${totals.tests}</strong> Tests</div>
    <div class="total"><strong>${totals.passed}</strong> Passed</div>
    <div class="total"><strong>${totals.failed}</strong> Failed</div>
    <div class="total"><strong>${totals.skipped}</strong> Skipped</div>
    <div class="total"><strong>${totals.running}</strong> Running</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>LOB</th>
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
  const lobs = getLobs();
  const allTargets = discoverBrowserTargets();

  if (allTargets.length === 0) {
    throw new Error(`No browser executable paths found in ${BROWSER_PATHS_FILE}.`);
  }

  const releaseVersion = getReleaseVersion();
  const releaseDir = getNextEvidenceDir(releaseVersion);
  console.log(`Evidence directory: ${releaseDir}`);

  const aggregate = [];
  const targetUrls = {};
  const runLobs = lobs.length > 0 ? lobs : [null];
  let latestReports = writeLiveReports(releaseDir, aggregate, {
    releaseVersion,
    targetUrls,
    inProgress: true,
  });

  for (const lob of runLobs) {
    await withLobEnvironment(lob, async () => {
      const selectedBrowsers = parseList(process.env.BROWSERS);
      const targets = allTargets.filter((target) => selectedBrowsers.length === 0 || selectedBrowsers.includes(target.browser));
      if (targets.length === 0) {
        throw new Error(`No browser executable paths selected for ${lob || 'default'} in ${BROWSER_PATHS_FILE}.`);
      }

      let targetUrl = process.env.TARGET_URL;
      if (!targetUrl) {
        throw new Error(`${lob ? `${lob} ` : ''}TARGET_URL is required. Set ${lob ? `${lob}.TARGET_URL` : 'TARGET_URL'} in .env or the environment.`);
      }
      targetUrl = requireHttpsUrl(targetUrl);
      targetUrls[lob || 'default'] = targetUrl;

      for (const target of targets) {
        const launchNote = usesBundledFirefox(target) ? ' using Playwright bundled Firefox' : '';
        const lobLabel = lob ? `${lob} ` : '';
        console.log(`Running ${lobLabel}${target.browser} ${target.configuredVersion}: ${target.executablePath}${launchNote}`);
        const aggregateIndex = aggregate.length;
        aggregate.push(createRunningAggregateItem(target, { targetUrl, lob, releaseVersion }));
        latestReports = writeLiveReports(releaseDir, aggregate, {
          releaseVersion,
          targetUrls,
          inProgress: true,
        });
        const result = await runTarget(target, { targetUrl, releaseDir, lob });
        const failed = result.results.filter((test) => test.status === 'FAIL').length;
        const passed = result.results.filter((test) => test.status === 'PASS').length;
        const skipped = result.results.filter((test) => test.status === 'SKIP').length;
        console.log(`  ${passed}/${result.results.length} passed, ${failed} failed, ${skipped} skipped`);
        aggregate[aggregateIndex] = result;
        latestReports = writeLiveReports(releaseDir, aggregate, {
          releaseVersion,
          targetUrls,
          inProgress: true,
        });
      }
    });
  }

  latestReports = writeLiveReports(releaseDir, aggregate, {
    releaseVersion,
    targetUrls,
    inProgress: false,
  });

  console.log(`Summary: ${latestReports.aggregatePath}`);
  console.log(`Cover report: ${latestReports.coverReportPath}`);
  console.log(`Portable evidence: ${latestReports.portableEvidencePath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
