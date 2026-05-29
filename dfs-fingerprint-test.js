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

async function installFirefoxWebdriverTrueInitScript(context, target) {
  if (target.browser !== 'firefox' || !readBoolean('FIREFOX_FORCE_WEBDRIVER_TRUE', true)) {
    return {
      installed: false,
      reason: target.browser === 'firefox'
        ? 'FIREFOX_FORCE_WEBDRIVER_TRUE=false'
        : 'Target browser is not firefox.',
    };
  }

  await context.addInitScript(() => {
    try {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        configurable: true,
        enumerable: true,
        get: () => true,
      });
    } catch {}
    try {
      Object.defineProperty(navigator, 'webdriver', {
        configurable: true,
        get: () => true,
      });
    } catch {}
  });

  return {
    installed: true,
    reason: 'Forced navigator.webdriver=true for Firefox bit0 validation.',
  };
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

async function getScarBit16FailureSignals(page) {
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

    function readDescriptor(object, property) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(object, property);
        if (!descriptor) return { present: false };
        return {
          present: true,
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          writable: Object.prototype.hasOwnProperty.call(descriptor, 'writable') ? descriptor.writable : undefined,
          hasGetter: typeof descriptor.get === 'function',
          hasSetter: typeof descriptor.set === 'function',
          valueType: Object.prototype.hasOwnProperty.call(descriptor, 'value') ? typeof descriptor.value : 'accessor',
        };
      } catch (error) {
        return { present: false, error: error.message };
      }
    }

    async function readPermissionStates() {
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return null;
      const names = ['notifications', 'geolocation', 'camera', 'microphone', 'clipboard-read', 'clipboard-write', 'persistent-storage'];
      const states = {};
      for (const name of names) {
        try {
          states[name] = (await navigator.permissions.query({ name })).state;
        } catch (error) {
          states[name] = `[error: ${error.message}]`;
        }
      }
      return states;
    }

    function safeResources(pattern) {
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

    function isPlatformMismatch(uaLow, pfLow) {
      const platformPatterns = [
        { prefix: 'macos', pattern: /macintosh|mac os x|macos/ },
        { prefix: 'windows', pattern: /windows/ },
        { prefix: 'win', pattern: /windows/ },
        { prefix: 'android', pattern: /android/ },
        { prefix: 'ios', pattern: /iphone|ipad|ipod|ios/ },
        { prefix: 'chrome os', pattern: /cros|chrome os/ },
        { prefix: 'chromeos', pattern: /cros|chrome os/ },
        { prefix: 'linux', pattern: /linux/ },
      ];
      const match = platformPatterns.find((item) => pfLow === item.prefix || pfLow.startsWith(`${item.prefix} `));
      if (match) return !match.pattern.test(uaLow);
      return !uaLow.includes(pfLow);
    }

    function getWebglSpoofSignals() {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) {
          return {
            available: false,
            renderer: '',
            vendor: '',
            score: 0,
            triggered: false,
            reason: 'No WebGL context; UASpoof _scoreWebGLAnomaly returns 0 when gl is unavailable.',
          };
        }
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
        const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '';
        const swiftShader = /SwiftShader/i.test(renderer);
        const unknownVendor = !/NVIDIA|AMD|Intel|Apple|Mesa|ANGLE/i.test(renderer);
        return {
          available: true,
          renderer,
          vendor,
          swiftShader,
          unknownVendor,
          score: swiftShader ? 20 : unknownVendor ? 10 : 0,
          triggered: swiftShader || unknownVendor,
          reason: swiftShader
            ? 'Renderer contains SwiftShader.'
            : unknownVendor
              ? 'Renderer does not match NVIDIA/AMD/Intel/Apple/Mesa/ANGLE.'
              : 'Renderer is recognized by UASpoof.',
        };
      } catch (error) {
        return {
          available: false,
          error: error.message,
          score: 0,
          triggered: false,
        };
      }
    }

    function scoreUASpoofBreakdown(ua, pf, lang, tz, ch) {
      const brands = Array.isArray(ch && ch.brands) ? ch.brands : [];
      const fullVersionList = Array.isArray(ch && ch.fullVersionList) ? ch.fullVersionList : [];
      const emptyBrands = ch ? Array.isArray(ch.brands) && ch.brands.length === 0 : false;
      const emptyVersions = ch ? Array.isArray(ch.fullVersionList) && ch.fullVersionList.length === 0 : false;
      const emptyPlatform = ch ? !ch.platform || ch.platform === '' : false;
      const emptyHintsScore = ch && (emptyBrands || emptyVersions || emptyPlatform) ? 50 : 0;

      const uaMatch = ua.match(/Chrome\/(\d+)/i);
      const chMatch = fullVersionList.length > 0 ? fullVersionList[0].version?.match(/(\d+)/) : null;
      const versionMismatch = Boolean(uaMatch && chMatch && uaMatch[1] !== chMatch[1]);
      const platformMismatch = Boolean(ch && ch.platform && isPlatformMismatch(ua.toLowerCase(), ch.platform.toLowerCase()));
      const hintsMismatchScore = (versionMismatch ? 40 : 0) + (platformMismatch ? 40 : 0);

      const appleSignature = !/Mac|iPhone|iPad|iOS|Safari/.test(ua) && /Apple|Heisei|Macintosh|Darwin|CoreAnimation|Metal/i.test(ua + pf);
      const webgl = getWebglSpoofSignals();
      const brandStr = JSON.stringify(brands);
      const brandQuirk = /Windows/i.test(ua) && brandStr.includes('Not?A_Brand');
      const localeTzEnUsOutsideAmerica = lang.startsWith('en-US') && /Asia|Europe|Africa/.test(tz);
      const localeTzNonEnAmerica = !lang.startsWith('en') && /America|US/.test(tz);
      const localeTzScore = (localeTzEnUsOutsideAmerica ? 25 : 0) + (localeTzNonEnAmerica ? 25 : 0);

      const checks = {
        emptyHints: {
          score: emptyHintsScore,
          triggered: emptyHintsScore > 0,
          emptyBrands,
          emptyVersions,
          emptyPlatform,
          scarFlag: 'UA_CH_EMPTY',
        },
        hintsVersionMismatch: {
          score: versionMismatch ? 40 : 0,
          triggered: versionMismatch,
          uaChromeMajor: uaMatch ? uaMatch[1] : null,
          firstFullVersionListMajor: chMatch ? chMatch[1] : null,
          firstFullVersionListEntry: fullVersionList[0] || null,
          scarFlag: 'UA_CH_VER_MISMATCH',
        },
        hintsPlatformMismatch: {
          score: platformMismatch ? 40 : 0,
          triggered: platformMismatch,
          uaLower: ua.toLowerCase(),
          clientHintsPlatform: ch && ch.platform ? ch.platform : null,
          scarFlag: 'UA_CH_PLATFORM_MISMATCH',
        },
        appleSignatures: {
          score: appleSignature ? 30 : 0,
          triggered: appleSignature,
          ua,
          platform: pf,
          scarFlag: 'UA_APPLE_SIG',
        },
        webglAnomaly: {
          ...webgl,
          scarFlag: 'UA_WEBGL_ANOMALY',
        },
        windowsNotABrandQuirk: {
          score: brandQuirk ? 8 : 0,
          triggered: brandQuirk,
          brandStr,
          exactNeedle: 'Not?A_Brand',
          note: 'The current UASpoof source checks for Not?A_Brand with a question mark.',
          scarFlag: 'UA_BRAND_NOTABRAND',
        },
        localeTimezone: {
          score: localeTzScore,
          triggered: localeTzScore > 0,
          language: lang,
          timeZone: tz,
          enUsOutsideAmerica: localeTzEnUsOutsideAmerica,
          nonEnglishInAmerica: localeTzNonEnAmerica,
          scarFlag: 'UA_LOCALE_TZ_WEIRD',
        },
      };

      const totalScore = Object.values(checks).reduce((sum, item) => sum + (Number(item.score) || 0), 0);
      return {
        sourceReviewed: '.ignore/dfs.js UASpoof()',
        scoreRule: 'UA_SPOOF bit16 is set when UASpoof score > 0.',
        inputs: {
          ua,
          platform: pf,
          language: lang,
          timeZone: tz,
          clientHints: ch,
        },
        checks,
        totalScore,
        triggeredScarFlags: Object.values(checks)
          .filter((item) => item.triggered && item.scarFlag)
          .map((item) => item.scarFlag),
        bit16ExpectedFromScore: totalScore > 0 ? '1' : '0',
      };
    }

    const automationLikeWindowKeys = Object.keys(window)
      .filter((key) => /webdriver|selenium|playwright|puppeteer|cdc_|driver|automation/i.test(key))
      .sort()
      .map((key) => ({ key, type: typeof window[key] }));

    const highEntropyUserAgentData = navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function'
      ? await navigator.userAgentData.getHighEntropyValues(['brands', 'fullVersionList', 'platform', 'platformVersion', 'architecture', 'bitness', 'model', 'uaFullVersion'])
        .catch((error) => ({ error: error.message }))
      : null;
    const uaSpoofClientHints = navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function'
      ? await navigator.userAgentData.getHighEntropyValues(['brands', 'fullVersionList', 'platform'])
        .catch(() => null)
      : null;
    const ua = navigator.userAgent || '';
    const pf = navigator.platform || '';
    const lang = navigator.language || '';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const uaSpoofBreakdown = scoreUASpoofBreakdown(ua, pf, lang, tz, uaSpoofClientHints);

    return {
      capturedAt: new Date().toISOString(),
      reason: 'Captured because dfs_E_7 bit16 was expected 0 but observed 1.',
      uaSpoofBreakdown,
      navigatorSignals: {
        userAgent: ua,
        webdriver: navigator.webdriver,
        webdriverPresent: 'webdriver' in navigator,
        webdriverDescriptorOnNavigator: readDescriptor(navigator, 'webdriver'),
        webdriverDescriptorOnPrototype: readDescriptor(Object.getPrototypeOf(navigator), 'webdriver'),
        platform: pf,
        vendor: navigator.vendor,
        language: lang,
        timeZone: tz,
        languages: navigator.languages,
        cookieEnabled: navigator.cookieEnabled,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        maxTouchPoints: navigator.maxTouchPoints,
        pdfViewerEnabled: navigator.pdfViewerEnabled,
        doNotTrack: navigator.doNotTrack,
        globalPrivacyControlPresent: 'globalPrivacyControl' in navigator || navigator.globalPrivacyControl !== undefined,
        globalPrivacyControlValue: navigator.globalPrivacyControl,
      },
      userAgentData: {
        lowEntropy: navigator.userAgentData && typeof navigator.userAgentData.toJSON === 'function'
          ? navigator.userAgentData.toJSON()
          : null,
        highEntropy: highEntropyUserAgentData,
      },
      permissions: await readPermissionStates(),
      browserGlobals: {
        chrome: readWindowValue('chrome'),
        chromeKeys: window.chrome && typeof window.chrome === 'object' ? Object.keys(window.chrome).sort() : [],
        chromeRuntimePresent: Boolean(window.chrome && window.chrome.runtime),
        browser: readWindowValue('browser'),
        opr: readWindowValue('opr'),
        opera: readWindowValue('opera'),
        InstallTrigger: readWindowValue('InstallTrigger'),
        StyleMedia: readWindowValue('StyleMedia'),
      },
      automationLikeWindowKeys,
      documentSignals: {
        hasFocus: document.hasFocus(),
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        referrer: document.referrer,
        domain: document.domain,
        isSecureContext,
        crossOriginIsolated,
      },
      storageAndCapabilitySignals: {
        localStorageKeys: (() => {
          try {
            return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).sort();
          } catch (error) {
            return [`[error: ${error.message}]`];
          }
        })(),
        sessionStorageKeys: (() => {
          try {
            return Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).sort();
          } catch (error) {
            return [`[error: ${error.message}]`];
          }
        })(),
        indexedDBPresent: 'indexedDB' in window,
        cachesPresent: 'caches' in window,
        serviceWorkerPresent: 'serviceWorker' in navigator,
        webgpuPresent: 'gpu' in navigator,
        webhidPresent: 'hid' in navigator,
        webusbPresent: 'usb' in navigator,
        serialPresent: 'serial' in navigator,
      },
      dfsAndTelemetrySignals: {
        FingerprintData: readWindowValue('FingerprintData'),
        clientEnvProps: readWindowValue('clientEnvProps'),
        clientEnvPropsComplete: readWindowValue('clientEnvPropsComplete'),
        BOOMR_check_doc_domain: readWindowValue('BOOMR_check_doc_domain'),
        BOOMR_check_domain: readWindowValue('BOOMR_check_domain'),
        _sentryDebugIdIdentifier: readWindowValue('_sentryDebugIdIdentifier'),
        bmRM: readWindowValue('bmRM'),
        dfsJsResources: safeResources(/\/dfs\.js(?:[?#]|$)/i),
        telemetryResources: safeResources(/dfs|fingerprint|sentry|boomr|boomerang|akamai/i),
      },
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

function getBitValue(bitString, bitNumber) {
  if (bitString === undefined || bitString === null) return null;
  const text = String(bitString);
  const index = Number(bitNumber);
  if (index < 0 || index >= text.length) return null;
  return text[index];
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

function getDfsE7Shuffle(seedHex, bitCount = 32) {
  const seedText = String(seedHex || '').slice(0, 8);
  if (!/^[0-9a-f]{8}$/i.test(seedText)) return null;

  const seed = parseInt(seedText, 16);
  const random = mulberry32(seed);
  const labels = Array.from({ length: bitCount }, (_, index) => `S${String(index + 1).padStart(3, '0')}`);

  for (let index = labels.length - 1; index > 0; index -= 1) {
    const nextIndex = random() % (index + 1);
    [labels[index], labels[nextIndex]] = [labels[nextIndex], labels[index]];
  }

  const semanticToShuffledIndex = {};
  const semanticToLabelIndex = {};
  labels.forEach((label, shuffledIndex) => {
    semanticToShuffledIndex[Number(label.slice(1)) - 1] = shuffledIndex;
    semanticToLabelIndex[shuffledIndex] = Number(label.slice(1)) - 1;
  });

  return {
    enabled: true,
    seedHex: seedText,
    seed,
    mapping: readString('DFS_E7_BIT_SHUFFLE_MAPPING', 'semantic-index-to-label-index'),
    shuffledLabels: labels,
    semanticToShuffledIndex,
    semanticToLabelIndex,
  };
}

function getDfsE7BitValue(bitString, bitNumber, shuffle) {
  if (!shuffle) return getBitValue(bitString, bitNumber);
  const decoded = decodeDfsE7BitString(bitString, shuffle);
  return getBitValue(decoded, bitNumber);
}

function decodeDfsE7BitString(bitString, shuffle) {
  if (bitString === undefined || bitString === null || !shuffle || !Array.isArray(shuffle.shuffledLabels)) {
    return bitString === undefined || bitString === null ? '' : String(bitString);
  }

  const text = String(bitString);
  const decoded = Array.from({ length: text.length }, () => null);

  shuffle.shuffledLabels.forEach((label, shuffledIndex) => {
    const labelIndex = Number(label.slice(1)) - 1;
    if (labelIndex < 0 || labelIndex >= decoded.length) return;

    if (shuffle.mapping === 'find-label') {
      decoded[labelIndex] = text[shuffledIndex];
    } else {
      decoded[shuffledIndex] = text[labelIndex];
    }
  });

  return decoded.map((value) => value === null ? '' : value).join('');
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

function getBrowsersExpectingMissingClientHints() {
  return parseSet(
    process.env.DFS_E7_CLIENT_HINTS_MISSING_BROWSERS ||
    process.env.DFS_E7_BIT22_EXPECTED_1_BROWSERS ||
    process.env.CLIENT_HINTS_MISSING_BROWSERS
  );
}

function expectsMissingClientHints(browser) {
  return getBrowsersExpectingMissingClientHints().has(String(browser || '').toLowerCase());
}

function getExpectedDfsE7Bit16(browser, userAgentDataSignal) {
  return expectsMissingClientHints(browser) ||
    Boolean(userAgentDataSignal && userAgentDataSignal.userAgentDataPresent === false) ||
    Boolean(userAgentDataSignal && userAgentDataSignal.triggered)
    ? '1'
    : '0';
}

function getExpectedDfsE7Bit22(browser) {
  return expectsMissingClientHints(browser) ? '1' : '0';
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

async function getNotABrandQuestionMarkSignal(page) {
  return page.evaluate(async () => {
    function normalizeBrand(value) {
      return String(value || '').replace(/[^a-z]/gi, '').toLowerCase();
    }

    function collectBrands(source, items) {
      if (!Array.isArray(items)) return [];
      return items
        .map((item) => ({
          source,
          brand: item && item.brand !== undefined ? String(item.brand) : '',
          version: item && item.version !== undefined ? String(item.version) : undefined,
        }))
        .filter((item) => item.brand);
    }

    const userAgentDataPresent = Boolean(navigator.userAgentData);
    const userAgentDataToJsonPresent = Boolean(navigator.userAgentData && typeof navigator.userAgentData.toJSON === 'function');
    const userAgentDataHighEntropyPresent = Boolean(navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function');
    const lowEntropy = userAgentDataToJsonPresent
      ? navigator.userAgentData.toJSON()
      : null;
    const highEntropy = userAgentDataHighEntropyPresent
      ? await navigator.userAgentData.getHighEntropyValues(['brands', 'fullVersionList'])
        .catch((error) => ({ error: error.message }))
      : null;
    const brandEntries = [
      ...collectBrands('lowEntropy.brands', lowEntropy && lowEntropy.brands),
      ...collectBrands('highEntropy.brands', highEntropy && highEntropy.brands),
      ...collectBrands('highEntropy.fullVersionList', highEntropy && highEntropy.fullVersionList),
    ];
    const matches = brandEntries.filter((entry) => entry.brand.includes('?') && normalizeBrand(entry.brand) === 'notabrand');

    return {
      triggered: matches.length > 0,
      userAgentDataPresent,
      userAgentDataToJsonPresent,
      userAgentDataHighEntropyPresent,
      matches,
      brandEntries,
      lowEntropy,
      highEntropy,
      rule: 'Expect dfs_E_7 bit16 to be 1 when navigator.userAgentData is missing or a Not A Brand client-hints brand contains "?".',
    };
  });
}

async function getNavigatorWebdriverState(page) {
  return page.evaluate(() => {
    function readDescriptor(object, property) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(object, property);
        if (!descriptor) return { present: false };
        return {
          present: true,
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          writable: Object.prototype.hasOwnProperty.call(descriptor, 'writable') ? descriptor.writable : undefined,
          hasGetter: typeof descriptor.get === 'function',
          hasSetter: typeof descriptor.set === 'function',
          valueType: Object.prototype.hasOwnProperty.call(descriptor, 'value') ? typeof descriptor.value : 'accessor',
          value: Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined,
        };
      } catch (error) {
        return { error: error.message };
      }
    }

    return {
      webdriver: navigator.webdriver,
      webdriverType: typeof navigator.webdriver,
      webdriverPresent: 'webdriver' in navigator,
      webdriverDescriptorOnNavigator: readDescriptor(navigator, 'webdriver'),
      webdriverDescriptorOnPrototype: readDescriptor(Object.getPrototypeOf(navigator), 'webdriver'),
      rule: 'dfs_E_7 bit0 is expected to be 1 when navigator.webdriver === true.',
    };
  });
}

async function getNavigatorPluginState(page) {
  return page.evaluate(() => {
    const plugins = Array.from(navigator.plugins || []).map((plugin) => ({
      name: plugin.name,
      filename: plugin.filename,
      description: plugin.description,
      mimeTypes: Array.from(plugin || []).map((mimeType) => ({
        type: mimeType.type,
        suffixes: mimeType.suffixes,
        description: mimeType.description,
      })),
    }));

    return {
      length: navigator.plugins ? navigator.plugins.length : 0,
      plugins,
      zeroPlugins: !navigator.plugins || navigator.plugins.length === 0,
      oneOrMorePlugins: Boolean(navigator.plugins && navigator.plugins.length > 0),
      rule: 'S002 is 1 when navigator.plugins.length === 0; S003 is 1 when navigator.plugins.length > 0.',
    };
  });
}

async function getIndexedDBState(page) {
  return page.evaluate(() => ({
    indexedDBType: typeof window.indexedDB,
    indexedDBPresent: 'indexedDB' in window,
    indexedDBAvailable: window.indexedDB !== undefined && window.indexedDB !== null,
    rule: 'S004 is expected to be 1 when window.indexedDB is unavailable.',
  }));
}

async function getWebGLRendererState(page) {
  return page.evaluate(() => {
    function readRenderer(contextType) {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext(contextType);
        if (!gl) return { contextType, available: false };
        const debugInfo = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
        const parameter = debugInfo && debugInfo.UNMASKED_RENDERER_WEBGL
          ? debugInfo.UNMASKED_RENDERER_WEBGL
          : 0x9246;
        return {
          contextType,
          available: true,
          renderer: gl.getParameter(parameter),
        };
      } catch (error) {
        return { contextType, error: error.message };
      }
    }

    return {
      webgl: readRenderer('webgl'),
      experimentalWebgl: readRenderer('experimental-webgl'),
      webgl2: readRenderer('webgl2'),
      rule: 'S005 is expected when GPU renderer maps to 00/missing; S006 is expected when GPU renderer maps to 01/software.',
    };
  });
}

async function getWebGLExtensionState(page) {
  return page.evaluate(() => {
    function readExtensions(contextType) {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext(contextType);
        if (!gl) return { contextType, available: false };
        const extensions = typeof gl.getSupportedExtensions === 'function'
          ? gl.getSupportedExtensions()
          : [];
        return {
          contextType,
          available: true,
          extensionCount: Array.isArray(extensions) ? extensions.length : 0,
          extensions,
        };
      } catch (error) {
        return { contextType, error: error.message };
      }
    }

    return {
      webgl: readExtensions('webgl'),
      experimentalWebgl: readExtensions('experimental-webgl'),
      webgl2: readExtensions('webgl2'),
      rule: 'S007 is expected when the WebGL supported extension count is less than 15.',
    };
  });
}

async function getDevicePixelRatioState(page) {
  return page.evaluate(() => ({
    devicePixelRatio: window.devicePixelRatio,
    rule: 'S008 is expected when devicePixelRatio < 1; S009 when devicePixelRatio === 1; S010 when devicePixelRatio >= 2.',
  }));
}

async function getMediaDeviceEnumerationState(page) {
  return page.evaluate(async () => {
    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
        return {
          available: false,
          deviceCount: 0,
          devices: [],
          rule: 'S011 is expected when media device enumeration returns no devices or rejects.',
        };
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        available: true,
        deviceCount: Array.isArray(devices) ? devices.length : 0,
        devices: Array.isArray(devices)
          ? devices.map((device) => ({
            kind: device.kind,
            label: device.label,
            deviceId: device.deviceId,
            groupId: device.groupId,
          }))
          : devices,
        rule: 'S011 is expected when media device enumeration returns no devices or rejects.',
      };
    } catch (error) {
      return {
        available: true,
        rejected: true,
        errorName: error && error.name,
        errorMessage: error && error.message,
        rule: 'S011 is expected when media device enumeration returns no devices or rejects.',
      };
    }
  });
}

async function getHardwareConcurrencyState(page) {
  return page.evaluate(() => ({
    hardwareConcurrency: navigator.hardwareConcurrency,
    rule: 'S012 is expected when hardwareConcurrency === 1; S013 when hardwareConcurrency > 1 and < 5; S014 when hardwareConcurrency >= 5.',
  }));
}

async function getUserAgentKeywordState(page, keyword) {
  return page.evaluate((expectedKeyword) => {
    const userAgent = navigator.userAgent || '';
    return {
      userAgent,
      keyword: expectedKeyword,
      containsKeyword: userAgent.toLowerCase().includes(String(expectedKeyword || '').toLowerCase()),
      rule: 'S015 is expected when navigator.userAgent contains suspicious keywords such as bot, headless, or ChatGPT.',
    };
  }, keyword);
}

async function getClientHintsState(page) {
  return page.evaluate(async () => {
    function readWebGLRendererAnomaly() {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) {
          return {
            available: false,
            renderer: '',
            swiftShader: false,
            unrecognizedRenderer: false,
            triggered: false,
          };
        }
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
        const swiftShader = /SwiftShader/i.test(renderer);
        const unrecognizedRenderer = !/NVIDIA|AMD|Intel|Apple|Mesa|ANGLE/i.test(renderer);
        return {
          available: true,
          renderer,
          swiftShader,
          unrecognizedRenderer,
          triggered: swiftShader || unrecognizedRenderer,
          rule: 'S019 is expected when WebGL renderer is SwiftShader or does not match NVIDIA/AMD/Intel/Apple/Mesa/ANGLE.',
        };
      } catch (error) {
        return {
          error: error.message,
          renderer: '',
          swiftShader: false,
          unrecognizedRenderer: false,
          triggered: false,
        };
      }
    }

    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const language = navigator.language || '';
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const appleSignature = !/Mac|iPhone|iPad|iOS|Safari/.test(ua) && /Apple|Heisei|Macintosh|Darwin|CoreAnimation|Metal/i.test(ua + platform);
    const webglRendererAnomaly = readWebGLRendererAnomaly();
    const localeTimezoneMismatch =
      (language.startsWith('en-US') && /Asia|Europe|Africa/.test(timeZone)) ||
      (!language.startsWith('en') && /America|US/.test(timeZone));
    if (!navigator.userAgentData || typeof navigator.userAgentData.getHighEntropyValues !== 'function') {
      return {
        available: false,
        userAgent: ua,
        platform,
        language,
        timeZone,
        highEntropy: null,
        emptyBrands: true,
        emptyFullVersionList: true,
        emptyPlatform: true,
        appleSignature,
        webglRendererAnomaly,
        brandQuirk: false,
        localeTimezoneMismatch,
        rule: 'S023 and S017 are expected when high-entropy client hints brands, fullVersionList, or platform are empty.',
      };
    }

    const highEntropy = await navigator.userAgentData
      .getHighEntropyValues(['brands', 'fullVersionList', 'platform'])
      .catch((error) => ({ error: error.message }));
    const emptyBrands = !Array.isArray(highEntropy.brands) || highEntropy.brands.length === 0;
    const emptyFullVersionList = !Array.isArray(highEntropy.fullVersionList) || highEntropy.fullVersionList.length === 0;
    const emptyPlatform = !highEntropy.platform;
    const uaMatch = ua.match(/Chrome\/(\d+)/i);
    const chMatch = highEntropy.fullVersionList && highEntropy.fullVersionList[0] && highEntropy.fullVersionList[0].version
      ? highEntropy.fullVersionList[0].version.match(/(\d+)/)
      : null;
    const uaLower = ua.toLowerCase();
    const chPlatform = String(highEntropy.platform || '').toLowerCase();
    const platformMismatch = Boolean(chPlatform && (
      (/windows|win64|win32|winnt/.test(uaLower) && !/windows|win/.test(chPlatform)) ||
      (/macintosh|mac os|darwin/.test(uaLower) && !/mac|darwin/.test(chPlatform)) ||
      (/android/.test(uaLower) && !/android/.test(chPlatform)) ||
      (/iphone|ipad|ios/.test(uaLower) && !/ios|iphone|ipad/.test(chPlatform))
    ));
    const brandStr = JSON.stringify(highEntropy.brands || []);
    const brandQuirk = /Windows/i.test(ua) && brandStr.includes('Not?A_Brand');
    return {
      available: true,
      userAgent: ua,
      platform,
      language,
      timeZone,
      highEntropy,
      emptyBrands,
      emptyFullVersionList,
      emptyPlatform,
      anyEmpty: emptyBrands || emptyFullVersionList || emptyPlatform,
      uaChromeMajor: uaMatch ? uaMatch[1] : null,
      firstFullVersionListMajor: chMatch ? chMatch[1] : null,
      versionMismatch: Boolean(uaMatch && chMatch && uaMatch[1] !== chMatch[1]),
      platformMismatch,
      appleSignature,
      webglRendererAnomaly,
      brandStr,
      brandQuirk,
      localeTimezoneMismatch,
      rule: 'S023 and S017 are expected when high-entropy client hints brands, fullVersionList, or platform are empty.',
    };
  });
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
  const e7Seed =
    documentDfsCookies.dfs_F_5 ||
    contextDfsCookies.dfs_F_5 ||
    getFingerprintValue(fingerprint, 'dfs_F_5');
  const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(e7Seed, e7.length || 32) : null;
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
    dfs_E_7_decoded: decodeDfsE7BitString(e7, e7Shuffle),
    dfs_F_5_seed_source: e7Seed,
    dfs_E_7_shuffle: e7Shuffle,
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

function addScarBitResult(results, bitName, description, actual, expected, details, evidenceFilePaths = []) {
  const matches = actual === expected;
  addResult(
    results,
    `${bitName} ${description}`,
    matches ? 'PASS' : 'FAIL',
    {
      bit: bitName,
      description,
      actual,
      expected,
      ...details,
    },
    evidenceFilePaths,
    matches ? [] : [`${bitName} expected ${expected}, got ${actual}`]
  );
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

function addDfsE7ControlResult(results, testName, evidence, evidenceFilePaths, failures, bitKeys = []) {
  if (isMissingDfsE7Evidence(evidence, bitKeys)) {
    const classification = classifyMissingDfsE7Evidence(evidence);
    addResult(
      results,
      testName,
      classification.status,
      {
        ...evidence,
        availabilityReason: classification.reason,
        suppressedFailureCount: failures.length,
      },
      evidenceFilePaths,
      [classification.reason]
    );
    return;
  }

  addResult(results, testName, failures.length === 0 ? 'PASS' : 'FAIL', evidence, evidenceFilePaths, failures);
}

function gpuRendererMutualExclusionFailures(evidence) {
  if (evidence.baselineBeforeMock && evidence.baselineBeforeMock.bit4 === '1') {
    return [];
  }
  if (evidence.bit4 === '1' && evidence.bit5 === '1') {
    return ['S005 and S006 both fired; this control is invalid because GPU renderer missing/null and software renderer should not both be true.'];
  }
  return [];
}

function shouldIgnoreS005ForGpuRendererControl(evidence) {
  return Boolean(evidence && evidence.baselineBeforeMock && evidence.baselineBeforeMock.bit4 === '1');
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
    ['USERNAME_SELECTOR', process.env.USERNAME_SELECTOR],
    ['PASSWORD_SELECTOR', process.env.PASSWORD_SELECTOR],
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
    'human_typing,bot_fast_typing,robotic_typing_cadence,paste,programmatic_input,mouse_teleport,low_mouse_activity,focus_input_speed,rapid_click_pattern,rapid_scroll_pattern,payload_coverage'
  ));
}

function getBehaviorBitExpectations(scenarioName) {
  const expectations = {
    human_typing: { bit25: '0', bit26: '0', bit27: '0', bit28: '0' },
    bot_fast_typing: { bit21: '1', bit25: '1' },
    robotic_typing_cadence: { bit21: '1', bit25: '1' },
    paste: { bit21: '1', bit27: '1' },
    programmatic_input: { bit21: '1', bit26: '1' },
    mouse_teleport: { bit21: '1', bit28: '1' },
    low_mouse_activity: { bit21: '1', bit29: '1' },
    focus_input_speed: { bit21: '1', bit30: '1' },
    rapid_click_pattern: { bit31: '1' },
    rapid_scroll_pattern: { bit31: '1' },
    scroll_click_pattern: { bit21: '1', bit31: '1' },
  };
  const ignoredBits = parseSet(readString('IGNORE_INTERACTION_SCAR_BITS'));
  return Object.fromEntries(
    Object.entries(expectations[scenarioName] || {})
      .filter(([key]) => !ignoredBits.has(key.toLowerCase()) && !ignoredBits.has(key.toLowerCase().replace('bit', '')))
  );
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

async function fillWithHumanTyping(page, root, selector, value) {
  const field = root.locator(selector);
  await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await field.click();
  for (const char of String(value)) {
    await page.keyboard.type(char, { delay: 80 + Math.floor(Math.random() * 90) });
  }
}

async function fillWithFastTyping(page, root, selector, value) {
  const field = root.locator(selector);
  await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await field.click();
  await page.keyboard.type(String(value), { delay: Number(process.env.BOT_TYPE_DELAY_MS || 20) });
}

async function pasteIntoField(page, root, selector, value) {
  const field = root.locator(selector);
  await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await field.click();
  const text = String(value);
  const clipboardWritten = await page.evaluate(async (nextValue) => {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return false;
      await navigator.clipboard.writeText(nextValue);
      return true;
    } catch {
      return false;
    }
  }, text);

  if (clipboardWritten) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  } else {
    await field.evaluate((el, nextValue) => {
      const data = new DataTransfer();
      data.setData('text/plain', nextValue);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
      el.value = nextValue;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: nextValue }));
    }, text);
  }

  return {
    value: text,
    textLength: text.length,
    method: clipboardWritten ? 'clipboard_keyboard_paste' : 'synthetic_clipboard_event',
    expectedBit: 'S028',
    expectedRollupBit: 'S022',
  };
}

async function setProgrammaticInput(root, selector, value) {
  const field = root.locator(selector);
  await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  return field.evaluate((el, nextValue) => {
    el.value = nextValue;
    const event = new Event('input', { bubbles: true });
    el.dispatchEvent(event);
    return {
      value: el.value,
      eventType: event.type,
      isTrusted: event.isTrusted,
      expectedBit: 'S027',
      expectedRollupBit: 'S022',
    };
  }, String(value));
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

  await page.waitForTimeout(Number(process.env.INTERACTION_SCORE_WAIT_MS || 750));
  return {
    method: 'synthetic_hidden_submit',
    context: root && typeof root.evaluate === 'function' ? 'frame_or_page' : root && typeof root.locator === 'function' ? 'frame_locator' : 'page',
  };
}

async function readBehaviorState(page) {
  const cookies = parseCookieArray(await getDfsCookies(page));
  const fingerprint = await getFingerprint(page);
  const e7 = String(cookies.dfs_E_7 || getFingerprintValue(fingerprint, 'dfs_E_7') || '');
  const f5 = cookies.dfs_F_5 || getFingerprintValue(fingerprint, 'dfs_F_5');
  const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(f5, e7.length || 32) : null;
  const decodedE7 = decodeDfsE7BitString(e7, e7Shuffle);
  return {
    cookies,
    fingerprint,
    dfs_E_5: cookies.dfs_E_5 || getFingerprintValue(fingerprint, 'dfs_E_5'),
    dfs_E_7: e7,
    dfs_E_7_decoded: decodedE7,
    dfs_F_5: f5,
    dfs_E_7_shuffle: e7Shuffle,
    dfs_F_2: cookies.dfs_F_2 || getFingerprintValue(fingerprint, 'dfs_F_2'),
    bits: {
      bit21: getDfsE7BitValue(e7, 21, e7Shuffle),
      bit25: getDfsE7BitValue(e7, 25, e7Shuffle),
      bit26: getDfsE7BitValue(e7, 26, e7Shuffle),
      bit27: getDfsE7BitValue(e7, 27, e7Shuffle),
      bit28: getDfsE7BitValue(e7, 28, e7Shuffle),
      bit29: getDfsE7BitValue(e7, 29, e7Shuffle),
      bit30: getDfsE7BitValue(e7, 30, e7Shuffle),
      bit31: getDfsE7BitValue(e7, 31, e7Shuffle),
    },
  };
}

async function performInteractionScenario(page, scenarioName) {
  const config = getInputInteractionConfig();
  const root = await getScenarioRoot(page);
  const username = getScenarioText('USERNAME');
  const password = getScenarioText('PASSWORD');
  const needsInput = ['human_typing', 'bot_fast_typing', 'robotic_typing_cadence', 'paste', 'programmatic_input', 'focus_input_speed'].includes(scenarioName);
  let scenarioDetails = {};

  if (needsInput && !config.usernameSelector) {
    return {
      skipped: true,
      reason: 'USERNAME_SELECTOR is required for this interaction scenario.',
      requiredConfig: ['USERNAME_SELECTOR'],
    };
  }

  switch (scenarioName) {
    case 'human_typing':
      await maybeMoveMouse(page);
      await fillWithHumanTyping(page, root, config.usernameSelector, username);
      if (config.passwordSelector) await fillWithHumanTyping(page, root, config.passwordSelector, password);
      break;
    case 'bot_fast_typing':
      await maybeMoveMouse(page);
      await fillWithFastTyping(page, root, config.usernameSelector, username);
      if (config.passwordSelector) await fillWithFastTyping(page, root, config.passwordSelector, password);
      break;
    case 'robotic_typing_cadence': {
      await maybeMoveMouse(page);
      const text = readString('ROBOTIC_TYPING_VALUE', 'user123');
      const delayMs = Number(process.env.ROBOTIC_TYPING_DELAY_MS || 50);
      const field = root.locator(config.usernameSelector);
      await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
      await field.click();
      await page.keyboard.type(text, { delay: delayMs });
      scenarioDetails.roboticTypingCadence = {
        textLength: text.length,
        delayMs,
        expectedAverageUnderMs: 120,
        expectedVarianceUnder: 200,
        rule: 'S026 is expected for at least 5 typed characters with fast, uniform cadence; S022 should also fire.',
      };
      break;
    }
    case 'paste':
      await maybeMoveMouse(page);
      scenarioDetails.pasteEvent = await pasteIntoField(page, root, config.usernameSelector, username);
      break;
    case 'programmatic_input':
      await maybeMoveMouse(page);
      scenarioDetails.programmaticInput = await setProgrammaticInput(root, config.usernameSelector, readString('PROGRAMMATIC_INPUT_VALUE', 'bot@test.com'));
      await page.waitForTimeout(Number(process.env.PROGRAMMATIC_INPUT_POLL_WAIT_MS || 500));
      break;
    case 'mouse_teleport':
      return {
        skipped: true,
        reason: 'Skipped due to not being able replicate conditions to cause Bit to fire',
      };
    case 'low_mouse_activity': {
      const waitMs = Number(process.env.LOW_MOUSE_ACTIVITY_WAIT_MS || 3000);
      await page.waitForTimeout(waitMs);
      scenarioDetails.lowMouseActivity = {
        waitMs,
        mouseMoved: false,
        expectedBit: 'S030',
        expectedRollupBit: 'S022',
      };
      break;
    }
    case 'focus_input_speed': {
      const field = root.locator(config.usernameSelector);
      await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
      await field.evaluate((el) => {
        el.setAttribute('name', 'username');
        el.setAttribute('autocomplete', 'username');
      });
      const identity = await getFieldIdentity(field);
      const focusKey = identity.name || identity.id || identity.tagName;
      if (!['username', 'password'].includes(String(focusKey || '').toLowerCase())) {
        return {
          skipped: true,
          reason: 'DFS focus-speed scoring only checks focused controls named or identified as username/password.',
          fieldIdentity: identity,
        };
      }
      await maybeMoveMouse(page);
      await installFocusInputTimingProbe(field);
      await field.click();
      const text = String(username);
      if (text.length > 0) {
        await page.keyboard.press(text[0]);
        if (text.length > 1) {
          await page.keyboard.type(text.slice(1), { delay: Number(process.env.FOCUS_INPUT_TYPE_DELAY_MS || 10) });
        }
      }
      scenarioDetails.focusInputTiming = await readFocusInputTimingProbe(field);
      break;
    }
    case 'rapid_click_pattern': {
      const clickCount = Number(process.env.RAPID_CLICK_COUNT || 6);
      const delayMs = Number(process.env.RAPID_CLICK_DELAY_MS || 40);
      const point = await getRootInteractionTargetPoint(page, root);
      await page.mouse.move(point.x, point.y);
      for (let index = 0; index < clickCount; index += 1) {
        await page.mouse.click(point.x + (index % 2), point.y + (index % 2));
        await page.waitForTimeout(delayMs);
      }
      const syntheticWindowEvents = await dispatchRootRapidClickEvents(root, clickCount);
      scenarioDetails.rapidClickPattern = {
        clickCount,
        delayMs,
        point,
        syntheticWindowEvents,
        expectedBit: 'S032',
      };
      break;
    }
    case 'rapid_scroll_pattern': {
      const scrollCount = Number(process.env.RAPID_SCROLL_COUNT || 6);
      const delayMs = Number(process.env.RAPID_SCROLL_DELAY_MS || 40);
      const point = await getRootInteractionTargetPoint(page, root);
      await page.mouse.move(point.x, point.y);
      for (let index = 0; index < scrollCount; index += 1) {
        await page.mouse.wheel(0, 180);
        await page.waitForTimeout(delayMs);
      }
      const syntheticWindowEvents = await dispatchRootRapidScrollEvents(root, scrollCount);
      scenarioDetails.rapidScrollPattern = {
        scrollCount,
        delayMs,
        point,
        syntheticWindowEvents,
        expectedBit: 'S032',
      };
      break;
    }
    case 'scroll_click_pattern':
      for (let index = 0; index < 5; index += 1) {
        await page.mouse.click(100 + index * 12, 100 + index * 8);
        await page.waitForTimeout(50);
      }
      for (let index = 0; index < 5; index += 1) {
        await page.mouse.wheel(0, 180);
        await page.waitForTimeout(50);
      }
      break;
    case 'payload_coverage':
      await maybeMoveMouse(page);
      const point = await getRootInteractionTargetPoint(page, root);
      await page.mouse.click(point.x, point.y);
      await page.mouse.dblclick(point.x + 8, point.y + 8);
      await page.mouse.click(point.x + 16, point.y + 16, { button: 'right' });
      await page.mouse.wheel(0, 250);
      if (root && typeof root.evaluate === 'function') {
        await root.evaluate(() => window.scrollBy(0, 250));
      } else if (root && typeof root.locator === 'function') {
        await root.locator('body').evaluate(() => window.scrollBy(0, 250));
      } else {
        await page.evaluate(() => window.scrollBy(0, 250));
      }
      scenarioDetails.payloadPoint = point;
      if (config.usernameSelector) {
        await fillWithHumanTyping(page, root, config.usernameSelector, username);
        scenarioDetails.payloadPaste = await pasteIntoField(page, root, config.usernameSelector, `${username}2`);
      }
      break;
    default:
      return {
        skipped: true,
        reason: `Unknown interaction scenario: ${scenarioName}`,
      };
  }

  const trigger = await triggerBehaviorScore(page, root, config, {
    forceSyntheticSubmit: !['human_typing', 'rapid_click_pattern', 'rapid_scroll_pattern'].includes(scenarioName),
  });
  return { skipped: false, trigger, ...scenarioDetails };
}

async function runInteractionScenario(browser, target, config, outputDir, results, scenarioName, attempt = 1) {
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
    const performed = await runStep(`perform ${scenarioName} interaction scenario`, () => performInteractionScenario(scenarioPage, scenarioName));
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
    const after = await runStep(`read ${scenarioName} behavior state`, () => readBehaviorState(scenarioPage));
    const debugLog = await runStep(`read ${scenarioName} dfs_E_5 debug log`, () => getDfsE5DebugLog(scenarioPage));
    const expectations = getBehaviorBitExpectations(scenarioName);
    const bitFailures = Object.entries(expectations)
      .filter(([key, expected]) => after.bits[key] !== expected)
      .map(([key, expected]) => `${key} expected ${expected}, got ${after.bits[key]}`);
    const f2Changed = before.dfs_F_2 !== undefined && after.dfs_F_2 !== undefined && String(before.dfs_F_2) !== String(after.dfs_F_2);
    const payloadFailure = scenarioName === 'payload_coverage' && !f2Changed ? ['dfs_F_2 did not change after payload coverage interactions'] : [];
    const failures = [...bitFailures, ...payloadFailure];
    const evidence = {
      scenario: scenarioName,
      browser: target.browser,
      attempt,
      maxAttempts,
      before: {
        dfs_E_5: before.dfs_E_5,
        dfs_E_7: before.dfs_E_7,
        dfs_E_7_decoded: before.dfs_E_7_decoded,
        dfs_F_5: before.dfs_F_5,
        dfs_E_7_shuffle: before.dfs_E_7_shuffle,
        dfs_F_2: before.dfs_F_2,
        bits: before.bits,
      },
      performed,
      after: {
        dfs_E_5: after.dfs_E_5,
        dfs_E_7: after.dfs_E_7,
        dfs_E_7_decoded: after.dfs_E_7_decoded,
        dfs_F_5: after.dfs_F_5,
        dfs_E_7_shuffle: after.dfs_E_7_shuffle,
        dfs_F_2: after.dfs_F_2,
        bits: after.bits,
      },
      expectations,
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

async function runWebdriverSuppressionTest(browser, target, config, outputDir, results) {
  if (!readBoolean('PERFORM_WEBDRIVER_SUPPRESSION_TEST', false)) {
    addResult(
      results,
      'S001 navigator.webdriver suppressed',
      'SKIP',
      {
        reason: 'PERFORM_WEBDRIVER_SUPPRESSION_TEST=false; webdriver suppression check skipped by configuration.',
        expectedUnsuppressedBit0: readString('EXPECTED_DFS_E7_BIT0', '1'),
      },
      [],
      ['Webdriver suppression check skipped by configuration.']
    );
    return;
  }

  let suppressionContext;
  let suppressionPage;

  try {
    suppressionContext = await runStep('create webdriver suppression context', () => browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    }));
    await runStep('install webdriver suppression init script', () => suppressionContext.addInitScript(() => {
      try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          configurable: true,
          get: () => undefined,
        });
      } catch {}
      try {
        Object.defineProperty(navigator, 'webdriver', {
          configurable: true,
          get: () => undefined,
        });
      } catch {}
    }));
    await runStep('install webdriver suppression script override', () => installScriptOverride(suppressionContext, outputDir));
    suppressionPage = await runStep('open webdriver suppression page', () => suppressionContext.newPage());
    await runStep(`navigate webdriver suppression page to ${config.targetUrl}`, () => suppressionPage.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    }));
    await runStep('webdriver suppression post-load wait', () => suppressionPage.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000)));

    const fingerprint = await runStep('read webdriver suppression fingerprint', () => getFingerprint(suppressionPage));
    await runStep('webdriver suppression cookie settle wait', () => waitForCookieSettle(suppressionPage, 'webdriver_suppression'));
    const cookies = parseCookieArray(await runStep('read webdriver suppression DFS cookies', () => getDfsCookies(suppressionPage)));
    const webdriverState = await runStep('read suppressed navigator.webdriver state', () => getNavigatorWebdriverState(suppressionPage));
    const e7 = String(cookies.dfs_E_7 || getFingerprintValue(fingerprint, 'dfs_E_7') || '');
    const e7Seed = cookies.dfs_F_5 || getFingerprintValue(fingerprint, 'dfs_F_5');
    const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(e7Seed, e7.length || 32) : null;
    const evidence = {
      browser: target.browser,
      navigator: webdriverState,
      dfs_E_7: e7,
      dfs_E_7_decoded: decodeDfsE7BitString(e7, e7Shuffle),
      dfs_F_5_seed_source: e7Seed,
      dfs_E_7_shuffle: e7Shuffle,
      bit0: getDfsE7BitValue(e7, 0, e7Shuffle),
      expectedBit0: '0',
      suppression: 'Navigator.prototype.webdriver and navigator.webdriver getters return undefined before page scripts run.',
    };
    const evidenceFile = saveJson(path.join(outputDir, 'webdriver-suppression-bit0.json'), evidence);
    const failures = [
      ...(webdriverState.webdriver === true ? ['navigator.webdriver remained true after suppression'] : []),
      ...(evidence.bit0 === '0' ? [] : [`bit0 expected 0 with webdriver suppressed, got ${evidence.bit0}`]),
    ];

    addResult(
      results,
      'S001 navigator.webdriver suppressed',
      failures.length === 0 ? 'PASS' : 'FAIL',
      evidence,
      [evidenceFile],
      failures
    );
  } catch (error) {
    addResult(
      results,
      'S001 navigator.webdriver suppressed',
      'FAIL',
      { error: error.message },
      [],
      [error.message]
    );
  } finally {
    if (suppressionPage && !suppressionPage.isClosed()) await closeWithTimeout('Webdriver suppression page', () => suppressionPage.close());
    if (suppressionContext) await closeWithTimeout('Webdriver suppression context', () => suppressionContext.close());
  }
}

async function runPluginSuppressionTest(browser, target, config, outputDir, results) {
  if (!readBoolean('PERFORM_PLUGIN_SUPPRESSION_TEST', false)) {
    addResult(
      results,
      'S002 navigator.plugins.length == 0 suppressed',
      'SKIP',
      {
        reason: 'PERFORM_PLUGIN_SUPPRESSION_TEST=false; zero-plugin check skipped by configuration.',
      },
      [],
      ['Plugin suppression check skipped by configuration.']
    );
    return;
  }

  let suppressionContext;
  let suppressionPage;

  try {
    suppressionContext = await runStep('create plugin suppression context', () => browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    }));
    await runStep('install plugin suppression init script', () => suppressionContext.addInitScript(() => {
      const emptyPlugins = Object.freeze([]);
      try {
        Object.defineProperty(Navigator.prototype, 'plugins', {
          configurable: true,
          get: () => emptyPlugins,
        });
      } catch {}
      try {
        Object.defineProperty(navigator, 'plugins', {
          configurable: true,
          get: () => emptyPlugins,
        });
      } catch {}
    }));
    await runStep('install plugin suppression script override', () => installScriptOverride(suppressionContext, outputDir));
    suppressionPage = await runStep('open plugin suppression page', () => suppressionContext.newPage());
    await runStep(`navigate plugin suppression page to ${config.targetUrl}`, () => suppressionPage.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    }));
    await runStep('plugin suppression post-load wait', () => suppressionPage.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000)));

    const fingerprint = await runStep('read plugin suppression fingerprint', () => getFingerprint(suppressionPage));
    await runStep('plugin suppression cookie settle wait', () => waitForCookieSettle(suppressionPage, 'plugin_suppression'));
    const cookies = parseCookieArray(await runStep('read plugin suppression DFS cookies', () => getDfsCookies(suppressionPage)));
    const pluginState = await runStep('read suppressed navigator.plugins state', () => getNavigatorPluginState(suppressionPage));
    const e7 = String(cookies.dfs_E_7 || getFingerprintValue(fingerprint, 'dfs_E_7') || '');
    const e7Seed = cookies.dfs_F_5 || getFingerprintValue(fingerprint, 'dfs_F_5');
    const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(e7Seed, e7.length || 32) : null;
    const evidence = {
      browser: target.browser,
      navigatorPlugins: pluginState,
      dfs_E_7: e7,
      dfs_E_7_decoded: decodeDfsE7BitString(e7, e7Shuffle),
      dfs_F_5_seed_source: e7Seed,
      dfs_E_7_shuffle: e7Shuffle,
      bit1: getDfsE7BitValue(e7, 1, e7Shuffle),
      bit2: getDfsE7BitValue(e7, 2, e7Shuffle),
      expectedBit1: '1',
      expectedBit2: '0',
      suppression: 'Navigator.prototype.plugins and navigator.plugins return an empty frozen array before page scripts run.',
    };
    const evidenceFile = saveJson(path.join(outputDir, 'plugin-suppression-s002-s003.json'), evidence);
    const s002Failures = [
      ...(pluginState.length === 0 ? [] : [`navigator.plugins.length expected 0, got ${pluginState.length}`]),
      ...(evidence.bit1 === '1' ? [] : [`S002 expected 1, got ${evidence.bit1}`]),
    ];
    const s003Failures = [
      ...(evidence.bit2 === '0' ? [] : [`S003 expected 0, got ${evidence.bit2}`]),
    ];

    addResult(
      results,
      'S002 navigator.plugins.length == 0 suppressed',
      s002Failures.length === 0 ? 'PASS' : 'FAIL',
      evidence,
      [evidenceFile],
      s002Failures
    );
    addResult(
      results,
      'S003 navigator.plugins.length > 0 suppressed',
      s003Failures.length === 0 ? 'PASS' : 'FAIL',
      evidence,
      [evidenceFile],
      s003Failures
    );
  } catch (error) {
    addResult(
      results,
      'S002/S003 navigator.plugins suppressed',
      'FAIL',
      { error: error.message },
      [],
      [error.message]
    );
  } finally {
    if (suppressionPage && !suppressionPage.isClosed()) await closeWithTimeout('Plugin suppression page', () => suppressionPage.close());
    if (suppressionContext) await closeWithTimeout('Plugin suppression context', () => suppressionContext.close());
  }
}

async function runIndexedDBSuppressionTest(browser, target, config, outputDir, results) {
  if (!readBoolean('PERFORM_INDEXEDDB_SUPPRESSION_TEST', false)) {
    addResult(
      results,
      'S004 window.indexedDB unavailable',
      'SKIP',
      {
        reason: 'PERFORM_INDEXEDDB_SUPPRESSION_TEST=false; IndexedDB unavailable check skipped by configuration.',
      },
      [],
      ['IndexedDB unavailable check skipped by configuration.']
    );
    return;
  }

  let suppressionContext;
  let suppressionPage;

  try {
    suppressionContext = await runStep('create IndexedDB suppression context', () => browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    }));
    await runStep('install IndexedDB suppression init script', () => suppressionContext.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined });
    }));
    await runStep('install IndexedDB suppression script override', () => installScriptOverride(suppressionContext, outputDir));
    suppressionPage = await runStep('open IndexedDB suppression page', () => suppressionContext.newPage());
    await runStep(`navigate IndexedDB suppression page to ${config.targetUrl}`, () => suppressionPage.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    }));
    await runStep('IndexedDB suppression post-load wait', () => suppressionPage.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000)));

    const fingerprint = await runStep('read IndexedDB suppression fingerprint', () => getFingerprint(suppressionPage));
    await runStep('IndexedDB suppression cookie settle wait', () => waitForCookieSettle(suppressionPage, 'indexeddb_suppression'));
    const cookies = parseCookieArray(await runStep('read IndexedDB suppression DFS cookies', () => getDfsCookies(suppressionPage)));
    const indexedDBState = await runStep('read suppressed IndexedDB state', () => getIndexedDBState(suppressionPage));
    const e7 = String(cookies.dfs_E_7 || getFingerprintValue(fingerprint, 'dfs_E_7') || '');
    const e7Seed = cookies.dfs_F_5 || getFingerprintValue(fingerprint, 'dfs_F_5');
    const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(e7Seed, e7.length || 32) : null;
    const evidence = {
      browser: target.browser,
      indexedDB: indexedDBState,
      dfs_E_7: e7,
      dfs_E_7_decoded: decodeDfsE7BitString(e7, e7Shuffle),
      dfs_F_5_seed_source: e7Seed,
      dfs_E_7_shuffle: e7Shuffle,
      bit3: getDfsE7BitValue(e7, 3, e7Shuffle),
      expectedBit3: '1',
      suppression: "Object.defineProperty(window, 'indexedDB', { value: undefined }) before page scripts run.",
    };
    const evidenceFile = saveJson(path.join(outputDir, 'indexeddb-suppression-s004.json'), evidence);
    const failures = [
      ...(indexedDBState.indexedDBType === 'undefined' ? [] : [`window.indexedDB expected undefined, got ${indexedDBState.indexedDBType}`]),
      ...(evidence.bit3 === '1' ? [] : [`S004 expected 1, got ${evidence.bit3}`]),
    ];

    addResult(
      results,
      'S004 window.indexedDB unavailable',
      failures.length === 0 ? 'PASS' : 'FAIL',
      evidence,
      [evidenceFile],
      failures
    );
  } catch (error) {
    addResult(
      results,
      'S004 window.indexedDB unavailable',
      'FAIL',
      { error: error.message },
      [],
      [error.message]
    );
  } finally {
    if (suppressionPage && !suppressionPage.isClosed()) await closeWithTimeout('IndexedDB suppression page', () => suppressionPage.close());
    if (suppressionContext) await closeWithTimeout('IndexedDB suppression context', () => suppressionContext.close());
  }
}

function isChromiumLaunchTarget(target) {
  return !['firefox', 'webkit', 'safari'].includes(target.browser);
}

async function installWebGLRendererMock(context, rendererValue) {
  await context.addInitScript((renderer) => {
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    const CONTEXT_TYPES = new Set(['webgl', 'experimental-webgl', 'webgl2']);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...args) {
      const context = originalGetContext.call(this, type, ...args);
      if (!context || !CONTEXT_TYPES.has(String(type))) return context;

      const originalGetExtension = context.getExtension && context.getExtension.bind(context);
      const originalGetParameter = context.getParameter && context.getParameter.bind(context);
      if (originalGetExtension) {
        context.getExtension = function patchedGetExtension(name) {
          if (name === 'WEBGL_debug_renderer_info') {
            return {
              UNMASKED_VENDOR_WEBGL: 0x9245,
              UNMASKED_RENDERER_WEBGL,
            };
          }
          return originalGetExtension(name);
        };
      }
      if (originalGetParameter) {
        context.getParameter = function patchedGetParameter(parameter) {
          if (parameter === UNMASKED_RENDERER_WEBGL) return renderer;
          return originalGetParameter(parameter);
        };
      }
      return context;
    };
  }, rendererValue);
}

async function installFakeWebGLContextMock(context, rendererValue, extensions) {
  await context.addInitScript(({ renderer, extensionList }) => {
    const UNMASKED_VENDOR_WEBGL = 0x9245;
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    const CONTEXT_TYPES = new Set(['webgl', 'experimental-webgl']);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const fakeExtensions = Object.freeze(Array.isArray(extensionList) ? [...extensionList] : ['EXT_fake']);

    HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...args) {
      if (!CONTEXT_TYPES.has(String(type))) {
        return originalGetContext.call(this, type, ...args);
      }

      return {
        canvas: this,
        drawingBufferWidth: this.width || 300,
        drawingBufferHeight: this.height || 150,
        getExtension: (name) => name === 'WEBGL_debug_renderer_info'
          ? { UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL }
          : null,
        getExtensions: (name) => name === 'WEBGL_debug_renderer_info'
          ? { UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL }
          : null,
        getParameter: () => renderer,
        getSupportedExtensions: () => [...fakeExtensions],
        getSupportExtensions: () => [...fakeExtensions],
      };
    };
  }, {
    renderer: rendererValue,
    extensionList: extensions,
  });
}

async function installWebGLExtensionCountMock(context, extensions) {
  await context.addInitScript((extensionList) => {
    const CONTEXT_TYPES = new Set(['webgl', 'experimental-webgl', 'webgl2']);
    const mockedExtensions = Object.freeze(Array.isArray(extensionList) ? [...extensionList] : []);

    function patchContext(context) {
      if (!context || context.__dfsWebGLExtensionMocked) return context;
      try {
        Object.defineProperty(context, '__dfsWebGLExtensionMocked', { value: true });
      } catch {}
      context.getSupportedExtensions = () => [...mockedExtensions];
      context.getSupportExtensions = () => [...mockedExtensions];
      return context;
    }

    for (const contextClass of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!contextClass || !contextClass.prototype) continue;
      try {
        contextClass.prototype.getSupportedExtensions = function getSupportedExtensionsMock() {
          return [...mockedExtensions];
        };
      } catch {}
      try {
        contextClass.prototype.getSupportExtensions = function getSupportExtensionsMock() {
          return [...mockedExtensions];
        };
      } catch {}
    }

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...args) {
      const context = originalGetContext.call(this, type, ...args);
      if (!context || !CONTEXT_TYPES.has(String(type))) return context;
      return patchContext(context);
    };
  }, extensions);
}

async function runSingleGpuRendererTest(target, config, outputDir, resultConfig) {
  const browserType = getBrowserType(target);
  const launchOptions = getLaunchOptions(target);
  const gpuTestArgs = resultConfig.launchArgs || ['--headless=new'];
  const browser = await browserType.launch({
    ...launchOptions,
    headless: true,
    args: [...(launchOptions.args || []), ...gpuTestArgs],
  });
  let context;
  let page;
  let scriptOverride = null;
  let dfsScriptRequests = [];

  try {
    context = await browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    });
    if (resultConfig.fakeWebGLContext) {
      await installFakeWebGLContextMock(context, resultConfig.rendererValue, resultConfig.extensions);
    } else if (Object.prototype.hasOwnProperty.call(resultConfig, 'rendererValue')) {
      await installWebGLRendererMock(context, resultConfig.rendererValue);
    }
    if (resultConfig.extensions && !resultConfig.fakeWebGLContext) {
      await installWebGLExtensionCountMock(context, resultConfig.extensions);
    }
    scriptOverride = await installScriptOverride(context, outputDir);
    page = await context.newPage();
    dfsScriptRequests = createDfsScriptRequestLog(page);
    await page.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000));
    await recoverSecureChaseSystemRequirements(page);

    await waitForCookieSettle(page, resultConfig.phase);
    const diagnostics = await collectDfsControlDiagnostics(page, context, outputDir, resultConfig, scriptOverride, dfsScriptRequests);
    const rendererState = await getWebGLRendererState(page);
    const extensionState = await getWebGLExtensionState(page);
    const e7 = diagnostics.dfs_E_7;
    const e7Shuffle = diagnostics.dfs_E_7_shuffle;
    return {
      browser: target.browser,
      launchArgs: gpuTestArgs,
      rendererMock: resultConfig.rendererValue,
      fakeWebGLContext: Boolean(resultConfig.fakeWebGLContext),
      renderer: rendererState,
      webglExtensions: extensionState,
      ...diagnostics,
      dfs_E_7: e7,
      bit4: getDfsE7BitValue(e7, 4, e7Shuffle),
      bit5: getDfsE7BitValue(e7, 5, e7Shuffle),
      bit6: getDfsE7BitValue(e7, 6, e7Shuffle),
      expectedBit4: resultConfig.expectedBit4,
      expectedBit5: resultConfig.expectedBit5,
      expectedBit6: resultConfig.expectedBit6,
    };
  } finally {
    if (page && !page.isClosed()) await closeWithTimeout(`${resultConfig.label} page`, () => page.close());
    if (context) await closeWithTimeout(`${resultConfig.label} context`, () => context.close());
    if (browser) await closeWithTimeout(`${resultConfig.label} browser`, () => browser.close());
  }
}

async function runGpuRendererTests(target, config, outputDir, results) {
  if (!readBoolean('PERFORM_GPU_RENDERER_TESTS', false)) {
    addResult(
      results,
      'S005 GPU renderer missing/null',
      'SKIP',
      { reason: 'PERFORM_GPU_RENDERER_TESTS=false; GPU renderer controls skipped by configuration.' },
      [],
      ['GPU renderer controls skipped by configuration.']
    );
    addResult(
      results,
      'S006 GPU renderer software',
      'SKIP',
      { reason: 'PERFORM_GPU_RENDERER_TESTS=false; GPU renderer controls skipped by configuration.' },
      [],
      ['GPU renderer controls skipped by configuration.']
    );
    addResult(
      results,
      'S007 WebGL extension count < 15',
      'SKIP',
      { reason: 'PERFORM_GPU_RENDERER_TESTS=false; WebGL extension controls skipped by configuration.' },
      [],
      ['WebGL extension controls skipped by configuration.']
    );
    return;
  }

  if (!isChromiumLaunchTarget(target)) {
    for (const testName of ['S005 GPU renderer missing/null', 'S006 GPU renderer software', 'S007 WebGL extension count < 15']) {
      addResult(
        results,
        testName,
        'SKIP',
        { reason: 'GPU/WebGL controls use Chromium launch flags and WebGL mocks.' },
        [],
        ['GPU/WebGL controls skipped for non-Chromium target.']
      );
    }
    return;
  }

  const tests = [
    {
      label: 'S005 GPU renderer missing/null',
      phase: 'gpu_renderer_missing',
      launchArgs: ['--headless=new', '--disable-gpu'],
      rendererValue: null,
      expectedBit4: '1',
      expectedBit5: '0',
      evidenceName: 'gpu-renderer-missing-s005.json',
      failures: (evidence) => [
        ...gpuRendererMutualExclusionFailures(evidence),
        ...(evidence.bit4 === '1' ? [] : [`S005 expected 1, got ${evidence.bit4}`]),
        ...(evidence.bit5 === '0' ? [] : [`S006 expected 0, got ${evidence.bit5}`]),
      ],
    },
    {
      label: 'S006 GPU renderer software',
      phase: 'gpu_renderer_software',
      launchArgs: ['--headless=new'],
      fakeWebGLContext: true,
      rendererValue: 'FictionalVendor FakeGPU 9000',
      extensions: ['EXT_fake'],
      expectedBit4: '0',
      expectedBit5: '1',
      baselineBeforeMock: true,
      evidenceName: 'gpu-renderer-software-s006.json',
      failures: (evidence) => [
        ...gpuRendererMutualExclusionFailures(evidence),
        ...(evidence.webglExtensions.webgl.extensionCount > 0 ? [] : [`S006 setup expected WebGL extension count > 0 so S005 is not triggered by wgl=0, got ${evidence.webglExtensions.webgl.extensionCount}`]),
        ...(evidence.bit5 === '1' ? [] : [`S006 expected 1, got ${evidence.bit5}`]),
        ...(shouldIgnoreS005ForGpuRendererControl(evidence) || evidence.bit4 === '0' ? [] : [`S005 expected 0, got ${evidence.bit4}`]),
      ],
    },
    {
      label: 'S007 WebGL extension count < 15',
      phase: 'webgl_low_extension_count',
      launchArgs: ['--headless=new'],
      extensions: [
        'ANGLE_instanced_arrays',
        'EXT_blend_minmax',
        'EXT_color_buffer_half_float',
        'EXT_float_blend',
        'EXT_frag_depth',
        'EXT_shader_texture_lod',
        'EXT_texture_filter_anisotropic',
        'OES_element_index_uint',
        'OES_standard_derivatives',
        'OES_texture_float',
      ],
      expectedBit6: '1',
      evidenceName: 'webgl-low-extension-count-s007.json',
      failures: (evidence) => [
        ...(evidence.webglExtensions.webgl.extensionCount < 15 ? [] : [`WebGL extension count expected < 15, got ${evidence.webglExtensions.webgl.extensionCount}`]),
        ...(evidence.bit6 === '1' ? [] : [`S007 expected 1, got ${evidence.bit6}`]),
      ],
    },
  ];

  for (const test of tests) {
    try {
      let baselineBeforeMock = null;
      if (test.baselineBeforeMock) {
        const baselineConfig = {
          ...test,
          label: `${test.label} baseline before mock`,
          phase: `${test.phase}_baseline_before_mock`,
          evidenceName: test.evidenceName.replace(/\.json$/i, '-baseline-before-mock.json'),
          expectedBit4: undefined,
          expectedBit5: undefined,
          expectedBit6: undefined,
          baselineBeforeMock: false,
        };
        delete baselineConfig.rendererValue;
        delete baselineConfig.extensions;
        baselineBeforeMock = await runStep(`run ${test.label} baseline before mock`, () => runSingleGpuRendererTest(target, config, outputDir, baselineConfig));
      }
      const evidence = await runStep(`run ${test.label}`, () => runSingleGpuRendererTest(target, config, outputDir, test));
      if (baselineBeforeMock) {
        evidence.baselineBeforeMock = baselineBeforeMock;
        evidence.s005Expectation = baselineBeforeMock.bit4 === '1'
          ? 'ignored because S005 was already 1 before the S006 renderer mock'
          : 'S005 expected 0 because baseline S005 was not already 1';
      }
      const evidenceFile = saveJson(path.join(outputDir, test.evidenceName), evidence);
      const failures = test.failures(evidence);
      addDfsE7ControlResult(
        results,
        test.label,
        evidence,
        [evidenceFile],
        failures,
        ['bit4', 'bit5', 'bit6'].filter((key) => evidence[`expectedBit${key.slice(3)}`] !== undefined)
      );
    } catch (error) {
      addResult(results, test.label, 'FAIL', { error: error.message }, [], [error.message]);
    }
  }
}

async function runSingleDevicePixelRatioTest(browser, config, outputDir, resultConfig) {
  let context;
  let page;

  try {
    context = await browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
      deviceScaleFactor: resultConfig.devicePixelRatio,
    });
    await context.addInitScript((dpr) => {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        get: () => dpr,
      });
    }, resultConfig.devicePixelRatio);
    await installScriptOverride(context, outputDir);
    page = await context.newPage();
    await page.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000));

    const fingerprint = await getFingerprint(page);
    await waitForCookieSettle(page, resultConfig.phase);
    const cookies = parseCookieArray(await getDfsCookies(page));
    const dprState = await getDevicePixelRatioState(page);
    const e7 = String(cookies.dfs_E_7 || getFingerprintValue(fingerprint, 'dfs_E_7') || '');
    const e7Seed = cookies.dfs_F_5 || getFingerprintValue(fingerprint, 'dfs_F_5');
    const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(e7Seed, e7.length || 32) : null;
    return {
      devicePixelRatio: dprState,
      configuredDevicePixelRatio: resultConfig.devicePixelRatio,
      dfs_E_7: e7,
      dfs_E_7_decoded: decodeDfsE7BitString(e7, e7Shuffle),
      dfs_F_5_seed_source: e7Seed,
      dfs_E_7_shuffle: e7Shuffle,
      bit7: getDfsE7BitValue(e7, 7, e7Shuffle),
      bit8: getDfsE7BitValue(e7, 8, e7Shuffle),
      bit9: getDfsE7BitValue(e7, 9, e7Shuffle),
      expectedBit7: resultConfig.expectedBit7,
      expectedBit8: resultConfig.expectedBit8,
      expectedBit9: resultConfig.expectedBit9,
    };
  } finally {
    if (page && !page.isClosed()) await closeWithTimeout(`${resultConfig.label} page`, () => page.close());
    if (context) await closeWithTimeout(`${resultConfig.label} context`, () => context.close());
  }
}

async function runDevicePixelRatioTests(browser, config, outputDir, results) {
  const testNames = [
    'S008/S009/S010 devicePixelRatio < 1',
    'S008/S009/S010 devicePixelRatio == 1',
    'S008/S009/S010 devicePixelRatio >= 2',
  ];

  if (!readBoolean('PERFORM_DEVICE_PIXEL_RATIO_TESTS', false)) {
    for (const testName of testNames) {
      addResult(
        results,
        testName,
        'SKIP',
        { reason: 'PERFORM_DEVICE_PIXEL_RATIO_TESTS=false; DPR controls skipped by configuration.' },
        [],
        ['DPR controls skipped by configuration.']
      );
    }
    return;
  }

  const tests = [
    {
      label: testNames[0],
      phase: 'dpr_less_than_1',
      devicePixelRatio: 0.75,
      expectedBit7: '1',
      expectedBit8: '0',
      expectedBit9: '0',
      evidenceName: 'device-pixel-ratio-less-than-1-s008.json',
    },
    {
      label: testNames[1],
      phase: 'dpr_equal_1',
      devicePixelRatio: 1,
      expectedBit7: '0',
      expectedBit8: '1',
      expectedBit9: '0',
      evidenceName: 'device-pixel-ratio-equal-1-s009.json',
    },
    {
      label: testNames[2],
      phase: 'dpr_greater_than_or_equal_2',
      devicePixelRatio: 2,
      expectedBit7: '0',
      expectedBit8: '0',
      expectedBit9: '1',
      evidenceName: 'device-pixel-ratio-greater-than-or-equal-2-s010.json',
    },
  ];

  for (const test of tests) {
    try {
      const evidence = await runStep(`run ${test.label}`, () => runSingleDevicePixelRatioTest(browser, config, outputDir, test));
      const evidenceFile = saveJson(path.join(outputDir, test.evidenceName), evidence);
      const failures = [
        ...(evidence.devicePixelRatio.devicePixelRatio === test.devicePixelRatio ? [] : [`window.devicePixelRatio expected ${test.devicePixelRatio}, got ${evidence.devicePixelRatio.devicePixelRatio}`]),
        ...(evidence.bit7 === test.expectedBit7 ? [] : [`S008 expected ${test.expectedBit7}, got ${evidence.bit7}`]),
        ...(evidence.bit8 === test.expectedBit8 ? [] : [`S009 expected ${test.expectedBit8}, got ${evidence.bit8}`]),
        ...(evidence.bit9 === test.expectedBit9 ? [] : [`S010 expected ${test.expectedBit9}, got ${evidence.bit9}`]),
      ];
      addDfsE7ControlResult(results, test.label, evidence, [evidenceFile], failures, ['bit7', 'bit8', 'bit9']);
    } catch (error) {
      addResult(results, test.label, 'FAIL', { error: error.message }, [], [error.message]);
    }
  }
}

async function installMediaDeviceEnumerationMock(context, mode) {
  await context.addInitScript((enumerationMode) => {
    const mediaDevices = navigator.mediaDevices || {};
    const enumerateDevices = enumerationMode === 'reject'
      ? () => Promise.reject(new DOMException('S011 enumerateDevices rejection mock', 'NotAllowedError'))
      : () => Promise.resolve([]);

    try {
      Object.defineProperty(mediaDevices, 'enumerateDevices', {
        configurable: true,
        value: enumerateDevices,
      });
    } catch {}

    try {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        get: () => mediaDevices,
      });
    } catch {}
  }, mode);
}

async function runSingleMediaDeviceEnumerationTest(target, config, outputDir, resultConfig) {
  const browserType = getBrowserType(target);
  const launchOptions = getLaunchOptions(target);
  const browser = await browserType.launch({
    ...launchOptions,
    headless: true,
  });
  let context;
  let page;
  let scriptOverride = null;
  let dfsScriptRequests = [];

  try {
    context = await browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    });
    await installMediaDeviceEnumerationMock(context, resultConfig.mode);
    scriptOverride = await installScriptOverride(context, outputDir);
    page = await context.newPage();
    dfsScriptRequests = createDfsScriptRequestLog(page);
    await page.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000));

    await waitForCookieSettle(page, resultConfig.phase);
    const diagnostics = await collectDfsControlDiagnostics(page, context, outputDir, resultConfig, scriptOverride, dfsScriptRequests);
    const mediaDevices = await getMediaDeviceEnumerationState(page);
    const e7 = diagnostics.dfs_E_7;
    const e7Shuffle = diagnostics.dfs_E_7_shuffle;
    return {
      browser: target.browser,
      headless: true,
      mode: resultConfig.mode,
      mediaDevices,
      ...diagnostics,
      dfs_E_7: e7,
      bit10: getDfsE7BitValue(e7, 10, e7Shuffle),
      expectedBit10: '1',
    };
  } finally {
    if (page && !page.isClosed()) await closeWithTimeout(`${resultConfig.label} page`, () => page.close());
    if (context) await closeWithTimeout(`${resultConfig.label} context`, () => context.close());
    if (browser) await closeWithTimeout(`${resultConfig.label} browser`, () => browser.close());
  }
}

async function runMediaDeviceEnumerationTests(target, config, outputDir, results) {
  const testNames = [
    'S011 mediaDevices.enumerateDevices returns empty array',
    'S011 mediaDevices.enumerateDevices rejects',
  ];

  if (!readBoolean('PERFORM_MEDIA_DEVICE_ENUMERATION_TESTS', false)) {
    for (const testName of testNames) {
      addResult(
        results,
        testName,
        'SKIP',
        { reason: 'PERFORM_MEDIA_DEVICE_ENUMERATION_TESTS=false; media-device enumeration controls skipped by configuration.' },
        [],
        ['Media-device enumeration controls skipped by configuration.']
      );
    }
    return;
  }

  const tests = [
    {
      label: testNames[0],
      phase: 'media_devices_empty',
      mode: 'empty',
      evidenceName: 'media-devices-empty-s011.json',
      failures: (evidence) => [
        ...(evidence.mediaDevices.deviceCount === 0 ? [] : [`enumerateDevices expected 0 devices, got ${evidence.mediaDevices.deviceCount}`]),
        ...(evidence.bit10 === '1' ? [] : [`S011 expected 1, got ${evidence.bit10}`]),
      ],
    },
    {
      label: testNames[1],
      phase: 'media_devices_reject',
      mode: 'reject',
      evidenceName: 'media-devices-reject-s011.json',
      failures: (evidence) => [
        ...(evidence.mediaDevices.rejected ? [] : ['enumerateDevices expected to reject']),
        ...(evidence.bit10 === '1' ? [] : [`S011 expected 1, got ${evidence.bit10}`]),
      ],
    },
  ];

  for (const test of tests) {
    try {
      const evidence = await runStep(`run ${test.label}`, () => runSingleMediaDeviceEnumerationTest(target, config, outputDir, test));
      const evidenceFile = saveJson(path.join(outputDir, test.evidenceName), evidence);
      const failures = test.failures(evidence);
      addDfsE7ControlResult(results, test.label, evidence, [evidenceFile], failures, ['bit10']);
    } catch (error) {
      addResult(results, test.label, 'FAIL', { error: error.message }, [], [error.message]);
    }
  }
}

async function runSingleHardwareConcurrencyTest(browser, config, outputDir, resultConfig) {
  let context;
  let page;

  try {
    context = await browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    });
    await context.addInitScript((hardwareConcurrency) => {
      try {
        Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
          configurable: true,
          enumerable: true,
          get: () => hardwareConcurrency,
        });
      } catch {}
      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          configurable: true,
          get: () => hardwareConcurrency,
        });
      } catch {}
    }, resultConfig.hardwareConcurrency);
    await installScriptOverride(context, outputDir);
    page = await context.newPage();
    await page.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000));

    const fingerprint = await getFingerprint(page);
    await waitForCookieSettle(page, resultConfig.phase);
    const cookies = parseCookieArray(await getDfsCookies(page));
    const hardwareConcurrency = await getHardwareConcurrencyState(page);
    const e7 = String(cookies.dfs_E_7 || getFingerprintValue(fingerprint, 'dfs_E_7') || '');
    const e7Seed = cookies.dfs_F_5 || getFingerprintValue(fingerprint, 'dfs_F_5');
    const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(e7Seed, e7.length || 32) : null;
    return {
      hardwareConcurrency,
      configuredHardwareConcurrency: resultConfig.hardwareConcurrency,
      dfs_E_7: e7,
      dfs_E_7_decoded: decodeDfsE7BitString(e7, e7Shuffle),
      dfs_F_5_seed_source: e7Seed,
      dfs_E_7_shuffle: e7Shuffle,
      bit11: getDfsE7BitValue(e7, 11, e7Shuffle),
      bit12: getDfsE7BitValue(e7, 12, e7Shuffle),
      bit13: getDfsE7BitValue(e7, 13, e7Shuffle),
      expectedBit11: resultConfig.expectedBit11,
      expectedBit12: resultConfig.expectedBit12,
      expectedBit13: resultConfig.expectedBit13,
    };
  } finally {
    if (page && !page.isClosed()) await closeWithTimeout(`${resultConfig.label} page`, () => page.close());
    if (context) await closeWithTimeout(`${resultConfig.label} context`, () => context.close());
  }
}

async function runHardwareConcurrencyTests(browser, config, outputDir, results) {
  const testNames = [
    'S012/S013/S014 navigator.hardwareConcurrency == 1',
    'S012/S013/S014 navigator.hardwareConcurrency > 1 and < 5',
    'S012/S013/S014 navigator.hardwareConcurrency >= 5',
  ];

  if (!readBoolean('PERFORM_HARDWARE_CONCURRENCY_TESTS', false)) {
    for (const testName of testNames) {
      addResult(
        results,
        testName,
        'SKIP',
        { reason: 'PERFORM_HARDWARE_CONCURRENCY_TESTS=false; hardware-concurrency controls skipped by configuration.' },
        [],
        ['Hardware-concurrency controls skipped by configuration.']
      );
    }
    return;
  }

  const tests = [
    {
      label: testNames[0],
      phase: 'hardware_concurrency_equal_1',
      hardwareConcurrency: 1,
      expectedBit11: '1',
      expectedBit12: '0',
      expectedBit13: '0',
      evidenceName: 'hardware-concurrency-equal-1-s012.json',
    },
    {
      label: testNames[1],
      phase: 'hardware_concurrency_between_2_and_4',
      hardwareConcurrency: 4,
      expectedBit11: '0',
      expectedBit12: '1',
      expectedBit13: '0',
      evidenceName: 'hardware-concurrency-between-2-and-4-s013.json',
    },
    {
      label: testNames[2],
      phase: 'hardware_concurrency_greater_than_or_equal_5',
      hardwareConcurrency: 8,
      expectedBit11: '0',
      expectedBit12: '0',
      expectedBit13: '1',
      evidenceName: 'hardware-concurrency-greater-than-or-equal-5-s014.json',
    },
  ];

  for (const test of tests) {
    try {
      const evidence = await runStep(`run ${test.label}`, () => runSingleHardwareConcurrencyTest(browser, config, outputDir, test));
      const evidenceFile = saveJson(path.join(outputDir, test.evidenceName), evidence);
      const failures = [
        ...(evidence.hardwareConcurrency.hardwareConcurrency === test.hardwareConcurrency ? [] : [`navigator.hardwareConcurrency expected ${test.hardwareConcurrency}, got ${evidence.hardwareConcurrency.hardwareConcurrency}`]),
        ...(evidence.bit11 === test.expectedBit11 ? [] : [`S012 expected ${test.expectedBit11}, got ${evidence.bit11}`]),
        ...(evidence.bit12 === test.expectedBit12 ? [] : [`S013 expected ${test.expectedBit12}, got ${evidence.bit12}`]),
        ...(evidence.bit13 === test.expectedBit13 ? [] : [`S014 expected ${test.expectedBit13}, got ${evidence.bit13}`]),
      ];
      addDfsE7ControlResult(results, test.label, evidence, [evidenceFile], failures, ['bit11', 'bit12', 'bit13']);
    } catch (error) {
      addResult(results, test.label, 'FAIL', { error: error.message }, [], [error.message]);
    }
  }
}

async function runSuspiciousUserAgentKeywordTest(browser, config, outputDir, results) {
  const testName = 'S015 suspicious user-agent keyword';
  if (!readBoolean('PERFORM_SUSPICIOUS_UA_KEYWORD_TEST', false)) {
    addResult(
      results,
      testName,
      'SKIP',
      { reason: 'PERFORM_SUSPICIOUS_UA_KEYWORD_TEST=false; suspicious UA keyword control skipped by configuration.' },
      [],
      ['Suspicious UA keyword control skipped by configuration.']
    );
    return;
  }

  const keyword = readString('SUSPICIOUS_UA_KEYWORD', 'Googlebot');
  const userAgent = readString(
    'SUSPICIOUS_UA_STRING',
    `Mozilla/5.0 (compatible; ${keyword}/2.1; +https://www.google.com/bot.html)`
  );
  let context;
  let page;
  let scriptOverride = null;
  let dfsScriptRequests = [];

  try {
    context = await browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
      userAgent,
    });
    scriptOverride = await installScriptOverride(context, outputDir);
    page = await context.newPage();
    dfsScriptRequests = createDfsScriptRequestLog(page);
    await page.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000));

    await waitForCookieSettle(page, 'suspicious_user_agent_keyword');
    const diagnostics = await collectDfsControlDiagnostics(
      page,
      context,
      outputDir,
      { phase: 'suspicious_user_agent_keyword', evidenceName: 'suspicious-user-agent-keyword-s015.json' },
      scriptOverride,
      dfsScriptRequests
    );
    const userAgentState = await getUserAgentKeywordState(page, keyword);
    const e7 = diagnostics.dfs_E_7;
    const e7Shuffle = diagnostics.dfs_E_7_shuffle;
    const evidence = {
      userAgent: userAgentState,
      configuredUserAgent: userAgent,
      ...diagnostics,
      dfs_E_7: e7,
      bit14: getDfsE7BitValue(e7, 14, e7Shuffle),
      expectedBit14: '1',
    };
    const evidenceFile = saveJson(path.join(outputDir, 'suspicious-user-agent-keyword-s015.json'), evidence);
    const failures = [
      ...(userAgentState.containsKeyword ? [] : [`navigator.userAgent expected to contain ${keyword}`]),
      ...(evidence.bit14 === '1' ? [] : [`S015 expected 1, got ${evidence.bit14}`]),
    ];
    addDfsE7ControlResult(results, testName, evidence, [evidenceFile], failures, ['bit14']);
  } catch (error) {
    addResult(results, testName, 'FAIL', { error: error.message }, [], [error.message]);
  } finally {
    if (page && !page.isClosed()) await closeWithTimeout(`${testName} page`, () => page.close());
    if (context) await closeWithTimeout(`${testName} context`, () => context.close());
  }
}

async function runFingerprintModificationTest(browser, config, outputDir, results) {
  const testName = 'S016 browser fingerprint localStorage modification detected';
  if (!readBoolean('PERFORM_FINGERPRINT_MODIFICATION_TEST', false)) {
    addResult(
      results,
      testName,
      'SKIP',
      { reason: 'PERFORM_FINGERPRINT_MODIFICATION_TEST=false; fingerprint modification control skipped by configuration.' },
      [],
      ['Fingerprint modification control skipped by configuration.']
    );
    return;
  }

  let context;
  let page;

  try {
    context = await browser.newContext({
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    });
    await installScriptOverride(context, outputDir);
    page = await context.newPage();
    await page.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000));
    await waitForDfsFingerprintValue(page, 'dfs_F_1');

    const beforeFingerprint = await getFingerprint(page);
    await waitForCookieSettle(page, 'fingerprint_modification_before');
    const beforeCookies = parseCookieArray(await getDfsCookies(page));
    const beforeContextCookies = await getDfsContextCookies(context);
    const beforeF1 = beforeCookies.dfs_F_1 || beforeContextCookies.dfs_F_1 || getFingerprintValue(beforeFingerprint, 'dfs_F_1');
    const beforeLocalStorageValue = await page.evaluate(() => localStorage.getItem('browserFingerPrint'));

    await page.evaluate(() => {
      localStorage.setItem('browserFingerPrint', 'bad_value');
    });
    const tamperedLocalStorageValue = await page.evaluate(() => localStorage.getItem('browserFingerPrint'));

    await page.reload({
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForTimeout(Number(process.env.POST_RELOAD_WAIT_MS || 5000));

    const afterFingerprint = await getFingerprint(page);
    await waitForCookieSettle(page, 'fingerprint_modification_after');
    const afterCookies = parseCookieArray(await getDfsCookies(page));
    const afterContextCookies = await getDfsContextCookies(context);
    const e7 = String(afterCookies.dfs_E_7 || getFingerprintValue(afterFingerprint, 'dfs_E_7') || '');
    const e7Seed = afterCookies.dfs_F_5 || getFingerprintValue(afterFingerprint, 'dfs_F_5');
    const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(e7Seed, e7.length || 32) : null;
    const evidence = {
      before: {
        dfs_F_1: beforeF1,
        browserFingerPrint: beforeLocalStorageValue,
        cookies: beforeCookies,
        contextCookies: beforeContextCookies,
      },
      tampered: {
        key: 'browserFingerPrint',
        attemptedValue: 'bad_value',
        browserFingerPrint: tamperedLocalStorageValue,
      },
      afterRecollection: {
        cookies: afterCookies,
        contextCookies: afterContextCookies,
        dfs_F_1: afterCookies.dfs_F_1 || afterContextCookies.dfs_F_1 || getFingerprintValue(afterFingerprint, 'dfs_F_1'),
        browserFingerPrint: await page.evaluate(() => localStorage.getItem('browserFingerPrint')).catch(() => null),
      },
      trigger: "Set localStorage browserFingerPrint to bad_value, then reloaded the page to force DFS re-collection.",
      dfs_E_7: e7,
      dfs_E_7_decoded: decodeDfsE7BitString(e7, e7Shuffle),
      dfs_F_5_seed_source: e7Seed,
      dfs_E_7_shuffle: e7Shuffle,
      bit15: getDfsE7BitValue(e7, 15, e7Shuffle),
      expectedBit15: '1',
    };
    const evidenceFile = saveJson(path.join(outputDir, 'fingerprint-localstorage-modification-s016.json'), evidence);
    const failures = [
      ...(beforeF1 ? [] : ['dfs_F_1 was not present before tampering']),
      ...(evidence.tampered.browserFingerPrint === 'bad_value' ? [] : [`browserFingerPrint tamper expected bad_value, got ${evidence.tampered.browserFingerPrint}`]),
      ...(evidence.bit15 === '1' ? [] : [`S016 expected 1, got ${evidence.bit15}`]),
    ];
    addResult(results, testName, failures.length === 0 ? 'PASS' : 'FAIL', evidence, [evidenceFile], failures);
  } catch (error) {
    addResult(results, testName, 'FAIL', { error: error.message }, [], [error.message]);
  } finally {
    if (page && !page.isClosed()) await closeWithTimeout(`${testName} page`, () => page.close());
    if (context) await closeWithTimeout(`${testName} context`, () => context.close());
  }
}

async function installClientHintsMock(context, mode) {
  await context.addInitScript((clientHintsMode) => {
    const fullVersion = clientHintsMode === 'version-mismatch' ? '147.0.7778.97' : '148.0.7778.97';
    const majorVersion = fullVersion.match(/(\d+)/)?.[1] || '148';
    const platform = clientHintsMode === 'platform-mismatch' ? 'Android' : 'Windows';
    const notABrand = clientHintsMode === 'brand-quirk' ? 'Not?A_Brand' : 'Not/A)Brand';
    const populatedHints = {
      brands: [
        { brand: 'Chromium', version: majorVersion },
        { brand: notABrand, version: '99' },
      ],
      fullVersionList: [
        { brand: 'Chromium', version: fullVersion },
        { brand: notABrand, version: '99.0.0.0' },
      ],
      platform,
    };
    const emptyHints = {
      brands: [],
      fullVersionList: [],
      platform: '',
    };
    const highEntropy = clientHintsMode === 'empty' ? emptyHints : populatedHints;
    const lowEntropy = {
      brands: highEntropy.brands,
      mobile: false,
      platform: highEntropy.platform,
    };
    const userAgentData = {
      brands: lowEntropy.brands,
      mobile: false,
      platform: lowEntropy.platform,
      toJSON: () => ({ ...lowEntropy }),
      getHighEntropyValues: async (hints) => {
        const result = { ...lowEntropy };
        for (const hint of hints || []) {
          if (Object.prototype.hasOwnProperty.call(highEntropy, hint)) {
            result[hint] = highEntropy[hint];
          }
        }
        return result;
      },
    };

    try {
      Object.defineProperty(Navigator.prototype, 'userAgentData', {
        configurable: true,
        enumerable: true,
        get: () => userAgentData,
      });
    } catch {}
    try {
      Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        get: () => userAgentData,
      });
    } catch {}
  }, mode);
}

async function installNavigatorPlatformMock(context, platform) {
  if (platform === undefined) return;
  await context.addInitScript((mockPlatform) => {
    try {
      Object.defineProperty(Navigator.prototype, 'platform', {
        configurable: true,
        enumerable: true,
        get: () => mockPlatform,
      });
    } catch {}
    try {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        get: () => mockPlatform,
      });
    } catch {}
  }, platform);
}

async function runSingleClientHintsTest(browser, config, outputDir, resultConfig) {
  let context;
  let page;

  try {
    context = await browser.newContext({
      ...(resultConfig.userAgent ? { userAgent: resultConfig.userAgent } : {}),
      ...(resultConfig.locale ? { locale: resultConfig.locale } : {}),
      ...(resultConfig.timezoneId ? { timezoneId: resultConfig.timezoneId } : {}),
      viewport: {
        width: Number(process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.VIEWPORT_HEIGHT || 900),
      },
    });
    await installClientHintsMock(context, resultConfig.mode);
    await installNavigatorPlatformMock(context, resultConfig.navigatorPlatform);
    if (Object.prototype.hasOwnProperty.call(resultConfig, 'rendererValue')) {
      await installWebGLRendererMock(context, resultConfig.rendererValue);
    }
    await installScriptOverride(context, outputDir);
    page = await context.newPage();
    await page.goto(config.targetUrl, {
      waitUntil: process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForTimeout(Number(process.env.POST_LOAD_WAIT_MS || 2000));

    const fingerprint = await getFingerprint(page);
    await waitForCookieSettle(page, resultConfig.phase);
    const cookies = parseCookieArray(await getDfsCookies(page));
    const clientHints = await getClientHintsState(page);
    const e7 = String(cookies.dfs_E_7 || getFingerprintValue(fingerprint, 'dfs_E_7') || '');
    const e7Seed = cookies.dfs_F_5 || getFingerprintValue(fingerprint, 'dfs_F_5');
    const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(e7Seed, e7.length || 32) : null;
    return {
      mode: resultConfig.mode,
      clientHints,
      dfs_E_7: e7,
      dfs_E_7_decoded: decodeDfsE7BitString(e7, e7Shuffle),
      dfs_F_5_seed_source: e7Seed,
      dfs_E_7_shuffle: e7Shuffle,
      bit16: getDfsE7BitValue(e7, 16, e7Shuffle),
      bit17: getDfsE7BitValue(e7, 17, e7Shuffle),
      bit18: getDfsE7BitValue(e7, 18, e7Shuffle),
      bit19: getDfsE7BitValue(e7, 19, e7Shuffle),
      bit20: getDfsE7BitValue(e7, 20, e7Shuffle),
      bit22: getDfsE7BitValue(e7, 22, e7Shuffle),
      bit23: getDfsE7BitValue(e7, 23, e7Shuffle),
      bit24: getDfsE7BitValue(e7, 24, e7Shuffle),
      expectedBit16: resultConfig.expectedBit16,
      expectedBit17: resultConfig.expectedBit17,
      expectedBit18: resultConfig.expectedBit18,
      expectedBit19: resultConfig.expectedBit19,
      expectedBit20: resultConfig.expectedBit20,
      expectedBit22: resultConfig.expectedBit22,
      expectedBit23: resultConfig.expectedBit23,
      expectedBit24: resultConfig.expectedBit24,
    };
  } finally {
    if (page && !page.isClosed()) await closeWithTimeout(`${resultConfig.label} page`, () => page.close());
    if (context) await closeWithTimeout(`${resultConfig.label} context`, () => context.close());
  }
}

async function runClientHintsTests(browser, config, outputDir, results) {
  const testNames = [
    'S023/S017 client hints empty',
    'S023/S017 client hints populated',
    'S018 Apple signatures in non-Apple UA',
    'S018 Apple signatures allowed Apple UA control',
    'S019 WebGL renderer anomaly SwiftShader',
    'S019 WebGL renderer recognized control',
    'S020 client hints Not?A_Brand quirk',
    'S020 client hints normal brand control',
    'S021 locale/timezone mismatch en-US outside America',
    'S021 locale/timezone matched control',
    'S024 userAgent/client hints version mismatch',
    'S024 userAgent/client hints version match',
    'S025 userAgent/client hints platform mismatch',
    'S025 userAgent/client hints platform match',
  ];

  if (!readBoolean('PERFORM_CLIENT_HINTS_TESTS', false)) {
    for (const testName of testNames) {
      addResult(
        results,
        testName,
        'SKIP',
        { reason: 'PERFORM_CLIENT_HINTS_TESTS=false; client-hints controls skipped by configuration.' },
        [],
        ['Client-hints controls skipped by configuration.']
      );
    }
    return;
  }

  const tests = [
    {
      label: testNames[0],
      phase: 'client_hints_empty',
      mode: 'empty',
      expectedBit16: '1',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: '1',
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'client-hints-empty-s023-s017.json',
      failures: (evidence) => [
        ...(evidence.clientHints.anyEmpty ? [] : ['Expected at least one of brands, fullVersionList, or platform to be empty']),
        ...(evidence.bit16 === '1' ? [] : [`S017 expected 1, got ${evidence.bit16}`]),
        ...(evidence.bit22 === '1' ? [] : [`S023 expected 1, got ${evidence.bit22}`]),
      ],
    },
    {
      label: testNames[1],
      phase: 'client_hints_populated',
      mode: 'populated',
      expectedBit16: '0',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: '0',
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'client-hints-populated-s023-s017.json',
      failures: (evidence) => [
        ...(!evidence.clientHints.anyEmpty ? [] : ['Expected brands, fullVersionList, and platform to be populated']),
        ...(evidence.bit16 === '0' ? [] : [`S017 expected 0, got ${evidence.bit16}`]),
        ...(evidence.bit22 === '0' ? [] : [`S023 expected 0, got ${evidence.bit22}`]),
      ],
    },
    {
      label: testNames[2],
      phase: 'apple_signature_non_apple_ua',
      mode: 'populated',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0',
      navigatorPlatform: 'Win32',
      expectedBit16: '1',
      expectedBit17: '1',
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'apple-signature-non-apple-ua-s018.json',
      failures: (evidence) => [
        ...(evidence.clientHints.appleSignature ? [] : ['Expected Apple signature in non-Apple UA to be detected']),
        ...(evidence.bit16 === '1' ? [] : [`S017 expected 1 when S018 fires, got ${evidence.bit16}`]),
        ...(evidence.bit17 === '1' ? [] : [`S018 expected 1, got ${evidence.bit17}`]),
      ],
    },
    {
      label: testNames[3],
      phase: 'apple_signature_apple_ua_control',
      mode: 'populated',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36',
      navigatorPlatform: 'Win32',
      expectedBit16: '0',
      expectedBit17: '0',
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'apple-signature-apple-ua-control-s018.json',
      failures: (evidence) => [
        ...(!evidence.clientHints.appleSignature ? [] : ['Expected Safari token to suppress S018 apple-signature condition']),
        ...(evidence.bit16 === '0' ? [] : [`S017 expected 0 when S018 does not fire, got ${evidence.bit16}`]),
        ...(evidence.bit17 === '0' ? [] : [`S018 expected 0, got ${evidence.bit17}`]),
      ],
    },
    {
      label: testNames[4],
      phase: 'webgl_renderer_anomaly_swiftshader',
      mode: 'populated',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      rendererValue: 'Google SwiftShader',
      expectedBit16: '1',
      expectedBit17: undefined,
      expectedBit18: '1',
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'webgl-renderer-anomaly-swiftshader-s019.json',
      failures: (evidence) => [
        ...(evidence.clientHints.webglRendererAnomaly.triggered ? [] : [`Expected WebGL renderer anomaly, got ${evidence.clientHints.webglRendererAnomaly.renderer}`]),
        ...(evidence.clientHints.webglRendererAnomaly.swiftShader ? [] : [`Expected SwiftShader renderer, got ${evidence.clientHints.webglRendererAnomaly.renderer}`]),
        ...(evidence.bit16 === '1' ? [] : [`S017 expected 1 when S019 fires, got ${evidence.bit16}`]),
        ...(evidence.bit18 === '1' ? [] : [`S019 expected 1, got ${evidence.bit18}`]),
      ],
    },
    {
      label: testNames[5],
      phase: 'webgl_renderer_recognized_control',
      mode: 'populated',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      rendererValue: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)',
      expectedBit16: '0',
      expectedBit17: undefined,
      expectedBit18: '0',
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'webgl-renderer-recognized-control-s019.json',
      failures: (evidence) => [
        ...(!evidence.clientHints.webglRendererAnomaly.triggered ? [] : [`Expected recognized WebGL renderer, got ${evidence.clientHints.webglRendererAnomaly.renderer}`]),
        ...(evidence.bit16 === '0' ? [] : [`S017 expected 0 when S019 does not fire, got ${evidence.bit16}`]),
        ...(evidence.bit18 === '0' ? [] : [`S019 expected 0, got ${evidence.bit18}`]),
      ],
    },
    {
      label: testNames[6],
      phase: 'client_hints_brand_quirk',
      mode: 'brand-quirk',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      expectedBit16: '1',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: '1',
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'client-hints-brand-quirk-s020.json',
      failures: (evidence) => [
        ...(evidence.clientHints.brandQuirk ? [] : [`Expected Not?A_Brand brand quirk, got ${evidence.clientHints.brandStr}`]),
        ...(evidence.bit16 === '1' ? [] : [`S017 expected 1 when S020 fires, got ${evidence.bit16}`]),
        ...(evidence.bit19 === '1' ? [] : [`S020 expected 1, got ${evidence.bit19}`]),
      ],
    },
    {
      label: testNames[7],
      phase: 'client_hints_normal_brand_control',
      mode: 'populated',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      expectedBit16: '0',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: '0',
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'client-hints-normal-brand-control-s020.json',
      failures: (evidence) => [
        ...(!evidence.clientHints.brandQuirk ? [] : [`Expected normal brand list, got ${evidence.clientHints.brandStr}`]),
        ...(evidence.bit16 === '0' ? [] : [`S017 expected 0 when S020 does not fire, got ${evidence.bit16}`]),
        ...(evidence.bit19 === '0' ? [] : [`S020 expected 0, got ${evidence.bit19}`]),
      ],
    },
    {
      label: testNames[8],
      phase: 'locale_timezone_en_us_outside_america',
      mode: 'populated',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Europe/London',
      expectedBit16: '1',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: '1',
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'locale-timezone-mismatch-s021.json',
      failures: (evidence) => [
        ...(evidence.clientHints.localeTimezoneMismatch ? [] : [`Expected locale/timezone mismatch, got ${evidence.clientHints.language}/${evidence.clientHints.timeZone}`]),
        ...(evidence.bit16 === '1' ? [] : [`S017 expected 1 when S021 fires, got ${evidence.bit16}`]),
        ...(evidence.bit20 === '1' ? [] : [`S021 expected 1, got ${evidence.bit20}`]),
      ],
    },
    {
      label: testNames[9],
      phase: 'locale_timezone_matched_control',
      mode: 'populated',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      expectedBit16: '0',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: '0',
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: undefined,
      evidenceName: 'locale-timezone-matched-control-s021.json',
      failures: (evidence) => [
        ...(!evidence.clientHints.localeTimezoneMismatch ? [] : [`Expected locale/timezone match, got ${evidence.clientHints.language}/${evidence.clientHints.timeZone}`]),
        ...(evidence.bit16 === '0' ? [] : [`S017 expected 0 when S021 does not fire, got ${evidence.bit16}`]),
        ...(evidence.bit20 === '0' ? [] : [`S021 expected 0, got ${evidence.bit20}`]),
      ],
    },
    {
      label: testNames[10],
      phase: 'client_hints_version_mismatch',
      mode: 'version-mismatch',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      expectedBit16: '1',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: '1',
      expectedBit24: undefined,
      evidenceName: 'client-hints-version-mismatch-s024.json',
      failures: (evidence) => [
        ...(evidence.clientHints.versionMismatch ? [] : [`Expected UA Chrome major ${evidence.clientHints.uaChromeMajor} to differ from CH major ${evidence.clientHints.firstFullVersionListMajor}`]),
        ...(evidence.bit16 === '1' ? [] : [`S017 expected 1 when S024 fires, got ${evidence.bit16}`]),
        ...(evidence.bit23 === '1' ? [] : [`S024 expected 1, got ${evidence.bit23}`]),
      ],
    },
    {
      label: testNames[11],
      phase: 'client_hints_version_match',
      mode: 'version-match',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      expectedBit16: '0',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: '0',
      expectedBit24: undefined,
      evidenceName: 'client-hints-version-match-s024.json',
      failures: (evidence) => [
        ...(!evidence.clientHints.versionMismatch ? [] : [`Expected UA Chrome major ${evidence.clientHints.uaChromeMajor} to match CH major ${evidence.clientHints.firstFullVersionListMajor}`]),
        ...(evidence.bit16 === '0' ? [] : [`S017 expected 0 when S024 does not fire, got ${evidence.bit16}`]),
        ...(evidence.bit23 === '0' ? [] : [`S024 expected 0, got ${evidence.bit23}`]),
      ],
    },
    {
      label: testNames[12],
      phase: 'client_hints_platform_mismatch',
      mode: 'platform-mismatch',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      expectedBit16: '1',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: '1',
      evidenceName: 'client-hints-platform-mismatch-s025.json',
      failures: (evidence) => [
        ...(evidence.clientHints.platformMismatch ? [] : [`Expected UA platform to differ from CH platform ${evidence.clientHints.highEntropy?.platform}`]),
        ...(evidence.bit16 === '1' ? [] : [`S017 expected 1 when S025 fires, got ${evidence.bit16}`]),
        ...(evidence.bit24 === '1' ? [] : [`S025 expected 1, got ${evidence.bit24}`]),
      ],
    },
    {
      label: testNames[13],
      phase: 'client_hints_platform_match',
      mode: 'platform-match',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      expectedBit16: '0',
      expectedBit17: undefined,
      expectedBit18: undefined,
      expectedBit19: undefined,
      expectedBit20: undefined,
      expectedBit22: undefined,
      expectedBit23: undefined,
      expectedBit24: '0',
      evidenceName: 'client-hints-platform-match-s025.json',
      failures: (evidence) => [
        ...(!evidence.clientHints.platformMismatch ? [] : [`Expected UA platform to match CH platform ${evidence.clientHints.highEntropy?.platform}`]),
        ...(evidence.bit16 === '0' ? [] : [`S017 expected 0 when S025 does not fire, got ${evidence.bit16}`]),
        ...(evidence.bit24 === '0' ? [] : [`S025 expected 0, got ${evidence.bit24}`]),
      ],
    },
  ];

  for (const test of tests) {
    const maxAttempts = getTestRetryAttempts();
    try {
      let evidence;
      let failures = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        evidence = await runStep(`run ${test.label} attempt ${attempt}`, () => runSingleClientHintsTest(browser, config, outputDir, test));
        evidence.attempt = attempt;
        evidence.maxAttempts = maxAttempts;
        failures = test.failures(evidence);
        if (failures.length === 0 || attempt === maxAttempts || !failures.some(isRetryableTestMessage)) break;
        await waitBeforeTestRetry();
      }
      const evidenceFile = saveJson(path.join(outputDir, test.evidenceName), evidence);
      addResult(results, test.label, failures.length === 0 ? 'PASS' : 'FAIL', evidence, [evidenceFile], failures);
    } catch (error) {
      if (isRetryableTestMessage(error.message)) {
        let retryError = error;
        for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
          try {
            await waitBeforeTestRetry();
            const evidence = await runStep(`run ${test.label} attempt ${attempt}`, () => runSingleClientHintsTest(browser, config, outputDir, test));
            evidence.attempt = attempt;
            evidence.maxAttempts = maxAttempts;
            const failures = test.failures(evidence);
            if (failures.length === 0 || attempt === maxAttempts || !failures.some(isRetryableTestMessage)) {
              const evidenceFile = saveJson(path.join(outputDir, test.evidenceName), evidence);
              addResult(results, test.label, failures.length === 0 ? 'PASS' : 'FAIL', evidence, [evidenceFile], failures);
              retryError = null;
              break;
            }
          } catch (nextError) {
            retryError = nextError;
          }
        }
        if (!retryError) continue;
        addResult(results, test.label, 'FAIL', { error: retryError.message, maxAttempts }, [], [retryError.message]);
      } else {
        addResult(results, test.label, 'FAIL', { error: error.message, maxAttempts }, [], [error.message]);
      }
    }
  }
}

function frameNameFromSelector(selector) {
  const match = String(selector || '').match(/\bname\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : '';
}

function getLoginFrame(page) {
  const frameName = process.env.LOGIN_FRAME_NAME || frameNameFromSelector(process.env.LOGIN_FRAME_SELECTOR);
  const frameUrlMatcher = process.env.LOGIN_FRAME_URL_MATCHER;
  const frames = page.frames();

  if (frameName) {
    const namedFrame = frames.find((frame) => frame.name() === frameName);
    if (namedFrame) return namedFrame;
  }

  if (frameUrlMatcher) {
    const matches = matcherFromConfig(frameUrlMatcher);
    const urlFrame = frames.find((frame) => matches(frame.url()));
    if (urlFrame) return urlFrame;
  }

  return null;
}

async function clickLocatorWithoutNavigationWait(page, locator, timeout = Number(process.env.FIELD_TIMEOUT_MS || 45000)) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded({ timeout });

  const box = await locator.boundingBox({ timeout });
  if (!box) {
    throw new Error('Unable to resolve submit button coordinates.');
  }

  await page.mouse.click(
    Math.floor(box.x + box.width / 2),
    Math.floor(box.y + box.height / 2)
  );
}

async function fillAndSubmit(page) {
  const frameSelector = process.env.LOGIN_FRAME_SELECTOR;
  const usernameSelector = process.env.USERNAME_SELECTOR;
  const passwordSelector = process.env.PASSWORD_SELECTOR;
  const submitSelector = process.env.SUBMIT_SELECTOR;
  const username = process.env.LOGIN_USERNAME;
  const password = process.env.LOGIN_PASSWORD;
  const usernameDelayMs = Number(process.env.USERNAME_TYPE_DELAY_MS || process.env.TYPE_DELAY_MS || 45);
  const passwordDelayMs = Number(process.env.PASSWORD_TYPE_DELAY_MS || process.env.TYPE_DELAY_MS || 55);
  const beforeSubmitWaitMs = Number(process.env.BEFORE_SUBMIT_WAIT_MS || 750);

  if (!usernameSelector || !passwordSelector || !username || !password) {
    throw new Error('SUBMIT_CREDENTIALS requires USERNAME_SELECTOR, PASSWORD_SELECTOR, LOGIN_USERNAME, and LOGIN_PASSWORD.');
  }

  const frame = await waitForLoginFrame(page);
  const root = frame || (frameSelector ? page.frameLocator(frameSelector) : page);
  const usernameField = root.locator(usernameSelector);
  const passwordField = root.locator(passwordSelector);
  const submitButton = submitSelector ? root.locator(submitSelector) : null;

  await usernameField.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await usernameField.click();
  await page.keyboard.type(username, { delay: usernameDelayMs });
  await passwordField.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await passwordField.click();
  await page.keyboard.type(password, { delay: passwordDelayMs });
  if (beforeSubmitWaitMs > 0) {
    await page.waitForTimeout(beforeSubmitWaitMs);
  }

  if (submitButton) {
    await clickLocatorWithoutNavigationWait(page, submitButton);
  } else {
    await page.keyboard.press('Enter');
  }
}

async function runLogonValidation(page, outputDir, results) {
  const logonSkipReason = getLogonSkipReason();
  if (logonSkipReason) {
    addResult(
      results,
      'Cookies and Payload After Form Submission',
      'SKIP',
      {
        reason: logonSkipReason.reason,
        flag: 'TEST_LOGON',
        enabledValue: 'true',
        compatibilityFlag: 'SUBMIT_CREDENTIALS',
        ...(logonSkipReason.missing ? { missing: logonSkipReason.missing } : {}),
      },
      [],
      logonSkipReason.errors
    );
    return;
  }

  try {
    const beforeLogonScreenshot = await runStep('save before-logon screenshot', () => saveScreenshot(page, 'before-logon'));
    const beforeLogonInputDiscovery = await runStep('discover before-logon input fields', () => discoverInputFields(page));
    const beforeLogonInputFile = saveJson(path.join(outputDir, 'input-fields-before-logon.json'), beforeLogonInputDiscovery);
    const matcher = process.env.LOGIN_REQUEST_MATCHER || '';
    const requestPromise = matcher ? waitForLoginRequest(page, matcher).catch((error) => ({ __error: error.message })) : Promise.resolve({ __error: 'LOGIN_REQUEST_MATCHER is not configured' });
    await runStep('fill and submit login form', () => fillAndSubmit(page));
    const loginRequest = await runStep('wait for login request', () => requestPromise);
    await runStep('wait for post-submit load state', () => page.waitForLoadState(process.env.POST_SUBMIT_LOAD_STATE || 'networkidle', { timeout: Number(process.env.POST_SUBMIT_TIMEOUT_MS || 30000) }).catch(() => {}));
    const afterSubmitScreenshot = await runStep('save after-submit screenshot', () => saveScreenshot(page, 'after-submit'));
    await runStep('post-submit cookie settle wait', () => waitForCookieSettle(page, 'post_submit'));
    const afterSubmitCookies = parseCookieArray(await runStep('read post-submit DFS cookies', () => getDfsCookies(page)));
    const afterSubmitFingerprint = await runStep('read post-submit fingerprint', () => getFingerprint(page));
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
    const dfsE5DebugFile = saveJson(path.join(outputDir, 'dfs-e5-debug-log.json'), await runStep('read dfs_E_5 debug log', () => getDfsE5DebugLog(page)));
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
      [beforeLogonScreenshot, beforeLogonInputFile, afterSubmitScreenshot, requestFile, afterSubmitCookiesFile, afterSubmitFingerprintFile, submitComparisonFile, dfsE5DebugFile],
      submitFailures
    );
  } catch (error) {
    const failureEvidence = [];
    try {
      failureEvidence.push(await runStep('save failed-logon screenshot', () => saveScreenshot(page, 'failed-logon')));
    } catch {
      // Keep the original login failure as the useful error.
    }
    try {
      const failedLogonInputDiscovery = await runStep('discover failed-logon input fields', () => discoverInputFields(page));
      failureEvidence.push(saveJson(path.join(outputDir, 'input-fields-failed-logon.json'), failedLogonInputDiscovery));
    } catch {
      // Keep the original login failure as the useful error.
    }
    addResult(
      results,
      'Cookies and Payload After Form Submission',
      'FAIL',
      {
        reason: 'Logon validation failed before post-submit evidence could be collected.',
        usernameSelector: process.env.USERNAME_SELECTOR,
        passwordSelector: process.env.PASSWORD_SELECTOR,
        submitSelector: process.env.SUBMIT_SELECTOR,
        error: error.message,
      },
      failureEvidence,
      [error.message]
    );
  }
}

async function discoverInputFields(page) {
  const frames = page.frames();
  const results = [];

  for (const [frameIndex, frame] of frames.entries()) {
    const frameFields = await frame.evaluate(() => {
      function cssEscape(value) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
        return String(value).replace(/["\\#.:,[\]>+~*^$|= !]/g, '\\$&');
      }

      function quoteAttr(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }

      function isVisible(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden'
          && style.display !== 'none'
          && Number(style.opacity || 1) !== 0
          && rect.width > 0
          && rect.height > 0;
      }

      function labelText(el) {
        const labels = Array.from(el.labels || []).map((label) => label.innerText.trim()).filter(Boolean);
        if (labels.length > 0) return labels.join(' | ');

        if (el.id) {
          const explicit = document.querySelector(`label[for="${quoteAttr(el.id)}"]`);
          if (explicit && explicit.innerText.trim()) return explicit.innerText.trim();
        }

        const parentLabel = el.closest('label');
        return parentLabel ? parentLabel.innerText.trim() : '';
      }

      function nthSelector(el) {
        const tag = el.tagName.toLowerCase();
        const siblings = Array.from(document.querySelectorAll(tag));
        const index = siblings.indexOf(el) + 1;
        return index > 0 ? `${tag}:nth-of-type(${index})` : tag;
      }

      function selectorFor(el) {
        const tag = el.tagName.toLowerCase();
        const candidates = [];

        if (el.id) candidates.push(`#${cssEscape(el.id)}`);
        for (const attr of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'placeholder', 'type']) {
          const value = el.getAttribute(attr);
          if (value) candidates.push(`${tag}[${attr}="${quoteAttr(value)}"]`);
        }

        return candidates.find((candidate) => {
          try {
            return document.querySelectorAll(candidate).length === 1;
          } catch {
            return false;
          }
        }) || nthSelector(el);
      }

      function textFor(el) {
        if (el.matches('input, textarea, select')) return '';
        return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      }

      const elements = Array.from(document.querySelectorAll([
        'input',
        'textarea',
        'select',
        'button',
        '[role="button"]',
        'a[href]',
      ].join(',')));

      return elements.map((el, index) => {
        const rect = el.getBoundingClientRect();
        const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
        const visible = isVisible(el);
        const disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
        const text = textFor(el);
        const label = labelText(el);
        const inputCandidate = el.matches('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
        const fieldHints = `${type} ${el.id || ''} ${el.name || ''} ${el.getAttribute('autocomplete') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${label}`;
        const isSubmitCandidate = el.matches('button, [role="button"], a[href], input[type="submit"], input[type="button"]')
          && /submit|sign in|signin|log in|login|continue|next|verify|authenticate/i.test(`${type} ${text} ${label} ${el.id || ''} ${el.name || ''} ${el.getAttribute('aria-label') || ''}`);

        return {
          index,
          tag: el.tagName.toLowerCase(),
          type,
          selector: selectorFor(el),
          id: el.id || '',
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '',
          autocomplete: el.getAttribute('autocomplete') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          label,
          text,
          visible,
          enabled: !disabled,
          required: Boolean(el.required) || el.getAttribute('aria-required') === 'true',
          inputCandidate,
          passwordCandidate: inputCandidate && (el.matches('input[type="password"]') || /password/i.test(fieldHints)),
          usernameCandidate: inputCandidate && /user|username|email|login|member/i.test(fieldHints),
          submitCandidate: isSubmitCandidate,
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      });
    }).catch((error) => ([{
      frameError: error.message,
    }]));

    results.push({
      frameIndex,
      frameName: frame.name(),
      frameUrl: frame.url(),
      fields: frameFields,
    });
  }

  return {
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    frames: results,
    totals: {
      frames: results.length,
      fields: results.reduce((sum, frame) => sum + frame.fields.length, 0),
      visibleFields: results.reduce((sum, frame) => sum + frame.fields.filter((field) => field.visible).length, 0),
      inputCandidates: results.reduce((sum, frame) => sum + frame.fields.filter((field) => field.inputCandidate && field.visible).length, 0),
      passwordCandidates: results.reduce((sum, frame) => sum + frame.fields.filter((field) => field.passwordCandidate && field.visible).length, 0),
      submitCandidates: results.reduce((sum, frame) => sum + frame.fields.filter((field) => field.submitCandidate && field.visible).length, 0),
    },
  };
}

function logInputDiscovery(discovery) {
  console.log(`    input discovery: ${discovery.totals.visibleFields}/${discovery.totals.fields} visible controls across ${discovery.totals.frames} frame(s)`);

  for (const frame of discovery.frames) {
    const visible = frame.fields.filter((field) => field.visible);
    if (visible.length === 0) continue;

    console.log(`    frame ${frame.frameIndex}: ${frame.frameUrl}`);
    for (const field of visible) {
      const role = [
        field.usernameCandidate ? 'username?' : '',
        field.passwordCandidate ? 'password?' : '',
        field.submitCandidate ? 'submit?' : '',
      ].filter(Boolean).join(' ');
      const label = field.label || field.placeholder || field.ariaLabel || field.text || field.name || field.id || field.type;
      console.log(`      ${field.selector} | ${field.tag}/${field.type} | ${label}${role ? ` | ${role}` : ''}`);
    }
  }
}

function getReleaseVersion() {
  return process.env.RELEASE_VERSION || process.env.RELEASEVERSION || process.env.EXPECTED_DFS_E_8 || 'unversioned';
}

function requireHttpsUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`TARGET_URL must be a valid HTTPS URL. Got: ${value}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`TARGET_URL must use HTTPS. Got: ${value}`);
  }

  return parsed.toString();
}

function getNextEvidenceDir(releaseVersion) {
  const baseDir = path.join(ROOT_DIR, 'evidence', sanitizeSegment(releaseVersion));
  if (!fs.existsSync(baseDir)) return baseDir;

  let index = 1;
  while (fs.existsSync(path.join(baseDir, `test-${index}`))) {
    index += 1;
  }

  return path.join(baseDir, `test-${index}`);
}

function isNumberedEvidenceRunDir(dirName) {
  return /^test-\d+$/i.test(path.basename(dirName || ''));
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
    metadata.webdriverInitScript = await runStep('install webdriver expectation init script', () => installFirefoxWebdriverTrueInitScript(context, target));
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
    const e7Seed = initialCookieMap.dfs_F_5 || getFingerprintValue(initialFingerprint, 'dfs_F_5');
    const e7Shuffle = readBoolean('DFS_E7_BIT_SHUFFLE_ENABLED', false) ? getDfsE7Shuffle(e7Seed, e7.length || 32) : null;
    const decodedE7 = decodeDfsE7BitString(e7, e7Shuffle);
    const expectedWebdriverBit0 = readString('EXPECTED_DFS_E7_BIT0', '1');
    const expectedMissingClientHints = expectsMissingClientHints(target.browser);
    const notABrandQuestionMarkSignal = await runStep('read Not A Brand client-hints signal', () => getNotABrandQuestionMarkSignal(page));
    const webdriverState = await runStep('read navigator.webdriver state', () => getNavigatorWebdriverState(page));
    const pluginState = await runStep('read navigator.plugins state', () => getNavigatorPluginState(page));
    const scarBits = {
      dfs_E_7: e7,
      dfs_E_7_decoded: decodedE7,
      dfs_F_5_seed_source: e7Seed,
      dfs_E_7_shuffle: e7Shuffle,
      indexing: e7Shuffle ? 'semantic bit numbers decoded from shuffled dfs_E_7; bit 0 maps to S001' : 'zero-based; bit 0 is the first character',
      expectedMissingClientHints,
      notABrandQuestionMarkSignal,
      webdriver: webdriverState,
      plugins: pluginState,
      expectations: {
        bit0: expectedWebdriverBit0,
        ...(readBoolean('IGNORE_DFS_E7_BIT16', false) ? {} : { bit16: getExpectedDfsE7Bit16(target.browser, notABrandQuestionMarkSignal) }),
        bit22: getExpectedDfsE7Bit22(target.browser),
        bit25: '0',
        bit26: '0',
        bit27: '0',
      },
      bit0: getDfsE7BitValue(e7, 0, e7Shuffle),
      bit1: getDfsE7BitValue(e7, 1, e7Shuffle),
      bit2: getDfsE7BitValue(e7, 2, e7Shuffle),
      bit16: getDfsE7BitValue(e7, 16, e7Shuffle),
      bit22: getDfsE7BitValue(e7, 22, e7Shuffle),
      bit25: getDfsE7BitValue(e7, 25, e7Shuffle),
      bit26: getDfsE7BitValue(e7, 26, e7Shuffle),
      bit27: getDfsE7BitValue(e7, 27, e7Shuffle),
    };
    const bit16Expected = scarBits.expectations.bit16;
    let scarBit16FailureSignalsFile = null;
    if (bit16Expected !== undefined && bit16Expected !== scarBits.bit16 && scarBits.bit16 === '1') {
      scarBits.bit16FailureSignals = await runStep('read SCAR bit16 failure signals', () => getScarBit16FailureSignals(page));
      scarBit16FailureSignalsFile = saveJson(path.join(outputDir, 'scar-bit16-failure-signals.json'), scarBits.bit16FailureSignals);
    }
    const scarEvidenceFiles = [saveJson(path.join(outputDir, 'scar-bit-evaluation.json'), scarBits)];
    if (scarBit16FailureSignalsFile) scarEvidenceFiles.push(scarBit16FailureSignalsFile);
    const scarFailures = Object.entries(scarBits.expectations)
      .filter(([key, expectedValue]) => scarBits[key] !== expectedValue)
      .map(([key, expectedValue]) => `${key} expected ${expectedValue}, got ${scarBits[key]}`);
    addResult(results, 'AI Score / SCAR Testing', scarFailures.length === 0 ? 'PASS' : 'FAIL', scarBits, scarEvidenceFiles, scarFailures);
    addScarBitResult(
      results,
      'S001',
      'navigator.webdriver == true',
      scarBits.bit0,
      '1',
      {
        navigator: webdriverState,
        expectationSource: 'navigator.webdriver === true should set dfs_E_7 S001/bit0 to 1.',
        configuredExpectedBit0: expectedWebdriverBit0,
      },
      scarEvidenceFiles
    );
    addScarBitResult(
      results,
      'S002',
      'navigator.plugins.length == 0',
      scarBits.bit1,
      pluginState.zeroPlugins ? '1' : '0',
      {
        navigatorPlugins: pluginState,
        expectationSource: 'navigator.plugins.length === 0 should set dfs_E_7 S002/bit1 to 1 and S003/bit2 to 0.',
      },
      scarEvidenceFiles
    );
    addScarBitResult(
      results,
      'S003',
      'navigator.plugins.length > 0',
      scarBits.bit2,
      pluginState.oneOrMorePlugins ? '1' : '0',
      {
        navigatorPlugins: pluginState,
        expectationSource: 'navigator.plugins.length > 0 should set dfs_E_7 S003/bit2 to 1 and S002/bit1 to 0.',
      },
      scarEvidenceFiles
    );
    await runWebdriverSuppressionTest(browser, target, config, outputDir, results);
    await runPluginSuppressionTest(browser, target, config, outputDir, results);
    await runIndexedDBSuppressionTest(browser, target, config, outputDir, results);
    await runGpuRendererTests(target, config, outputDir, results);
    await runDevicePixelRatioTests(browser, config, outputDir, results);
    await runMediaDeviceEnumerationTests(target, config, outputDir, results);
    await runHardwareConcurrencyTests(browser, config, outputDir, results);
    await runSuspiciousUserAgentKeywordTest(browser, config, outputDir, results);
    await runFingerprintModificationTest(browser, config, outputDir, results);
    await runClientHintsTests(browser, config, outputDir, results);

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

    await runPrivateModeBrowserTest(target, config, outputDir, results);

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
