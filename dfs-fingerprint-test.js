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

function getExpectedDfsE7Bit16(browser, notABrandQuestionMarkSignal) {
  return expectsMissingClientHints(browser) || Boolean(notABrandQuestionMarkSignal && notABrandQuestionMarkSignal.triggered) ? '1' : '0';
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

    const lowEntropy = navigator.userAgentData && typeof navigator.userAgentData.toJSON === 'function'
      ? navigator.userAgentData.toJSON()
      : null;
    const highEntropy = navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function'
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
      matches,
      brandEntries,
      lowEntropy,
      highEntropy,
      rule: 'Expect dfs_E_7 bit16 to be 1 when a Not A Brand client-hints brand contains "?".',
    };
  });
}

function isDfsJsUrl(value) {
  try {
    return new URL(value).pathname.toLowerCase().endsWith('dfs.js');
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
  const match = readString('SCRIPT_OVERRIDE_MATCH');
  const source = readString('SCRIPT_OVERRIDE_SOURCE');
  if (!match && !source) return null;
  if (!match || !source) {
    throw new Error('SCRIPT_OVERRIDE_MATCH and SCRIPT_OVERRIDE_SOURCE must both be configured to override a script.');
  }

  const matches = matcherFromConfig(match);
  const replacement = await loadScriptOverrideSource(context, source);
  const details = {
    enabled: true,
    match,
    sourceType: replacement.sourceType,
    source: replacement.source,
    contentType: replacement.contentType,
    found: false,
    matchedRequests: [],
  };

  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!matches(request.url())) {
      await route.continue();
      return;
    }

    details.matchedRequests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      timestamp: new Date().toISOString(),
    });
    details.found = true;

    await route.fulfill({
      status: 200,
      contentType: replacement.contentType,
      body: replacement.body,
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

async function maybeTeleportMouse(page) {
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const points = [
    [5, 5],
    [Math.max(10, viewport.width - 10), Math.max(10, viewport.height - 10)],
    [Math.floor(viewport.width * 0.1), Math.floor(viewport.height * 0.85)],
    [Math.floor(viewport.width * 0.9), Math.floor(viewport.height * 0.15)],
  ];

  for (const [x, y] of points) {
    await page.mouse.move(x, y, { steps: 1 });
    await page.waitForTimeout(5);
  }
}

function getScenarioText(name) {
  return readString(`${name}_VALUE`, readString('INTERACTION_TEST_VALUE', 'testuser1'));
}

function getInteractionScenarioNames() {
  return parseList(readString(
    'INTERACTION_TEST_SCENARIOS',
    'human_typing,bot_fast_typing,paste,programmatic_input,mouse_teleport,low_mouse_activity,focus_input_speed,scroll_click_pattern,payload_coverage'
  ));
}

function getBehaviorBitExpectations(scenarioName) {
  const expectations = {
    human_typing: { bit25: '0', bit26: '0', bit27: '0', bit28: '0' },
    bot_fast_typing: { bit21: '1', bit25: '1' },
    paste: { bit21: '1', bit27: '1' },
    programmatic_input: { bit21: '1', bit26: '1' },
    mouse_teleport: { bit21: '1', bit28: '1' },
    low_mouse_activity: { bit21: '1', bit29: '1' },
    focus_input_speed: { bit21: '1', bit30: '1' },
    scroll_click_pattern: { bit31: '1' },
  };
  return expectations[scenarioName] || {};
}

function getInputInteractionConfig() {
  return {
    usernameSelector: readString('USERNAME_SELECTOR'),
    passwordSelector: readString('PASSWORD_SELECTOR'),
    submitSelector: readString('SUBMIT_SELECTOR'),
  };
}

async function getScenarioRoot(page) {
  const frameSelector = process.env.LOGIN_FRAME_SELECTOR;
  const frame = getLoginFrame(page);
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
}

async function setProgrammaticInput(root, selector, value) {
  const field = root.locator(selector);
  await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
  await field.evaluate((el, nextValue) => {
    el.value = nextValue;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
  }, String(value));
}

async function triggerBehaviorScore(page) {
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.type = 'submit';
    button.id = 'submit';
    button.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;';
    document.body.appendChild(button);
    button.click();
    button.remove();
  });
  await page.waitForTimeout(Number(process.env.INTERACTION_SCORE_WAIT_MS || 750));
}

async function readBehaviorState(page) {
  const cookies = parseCookieArray(await getDfsCookies(page));
  const fingerprint = await getFingerprint(page);
  const e7 = String(cookies.dfs_E_7 || getFingerprintValue(fingerprint, 'dfs_E_7') || '');
  return {
    cookies,
    fingerprint,
    dfs_E_5: cookies.dfs_E_5 || getFingerprintValue(fingerprint, 'dfs_E_5'),
    dfs_E_7: e7,
    dfs_F_2: cookies.dfs_F_2 || getFingerprintValue(fingerprint, 'dfs_F_2'),
    bits: {
      bit21: getBitValue(e7, 21),
      bit25: getBitValue(e7, 25),
      bit26: getBitValue(e7, 26),
      bit27: getBitValue(e7, 27),
      bit28: getBitValue(e7, 28),
      bit29: getBitValue(e7, 29),
      bit30: getBitValue(e7, 30),
      bit31: getBitValue(e7, 31),
    },
  };
}

async function performInteractionScenario(page, scenarioName) {
  const config = getInputInteractionConfig();
  const root = await getScenarioRoot(page);
  const username = getScenarioText('USERNAME');
  const password = getScenarioText('PASSWORD');
  const needsInput = ['human_typing', 'bot_fast_typing', 'paste', 'programmatic_input', 'focus_input_speed'].includes(scenarioName);

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
    case 'paste':
      await maybeMoveMouse(page);
      await pasteIntoField(page, root, config.usernameSelector, username);
      break;
    case 'programmatic_input':
      await maybeMoveMouse(page);
      await setProgrammaticInput(root, config.usernameSelector, username);
      await page.waitForTimeout(Number(process.env.PROGRAMMATIC_INPUT_POLL_WAIT_MS || 500));
      break;
    case 'mouse_teleport':
      await maybeTeleportMouse(page);
      break;
    case 'low_mouse_activity':
      break;
    case 'focus_input_speed': {
      const field = root.locator(config.usernameSelector);
      await field.waitFor({ state: 'visible', timeout: Number(process.env.FIELD_TIMEOUT_MS || 45000) });
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
      await field.click();
      await page.keyboard.type(username, { delay: 10 });
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
      await page.mouse.click(120, 120);
      await page.mouse.dblclick(140, 140);
      await page.mouse.click(160, 160, { button: 'right' });
      await page.mouse.wheel(0, 250);
      await page.evaluate(() => window.scrollBy(0, 250));
      if (config.usernameSelector) {
        await fillWithHumanTyping(page, root, config.usernameSelector, username);
        await pasteIntoField(page, root, config.usernameSelector, `${username}2`);
      }
      break;
    default:
      return {
        skipped: true,
        reason: `Unknown interaction scenario: ${scenarioName}`,
      };
  }

  await triggerBehaviorScore(page);
  return { skipped: false };
}

async function runInteractionScenario(browser, target, config, outputDir, results, scenarioName) {
  const scenarioSlug = sanitizeSegment(scenarioName);
  let scenarioContext;
  let scenarioPage;
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
    const evidence = {
      scenario: scenarioName,
      browser: target.browser,
      before: {
        dfs_E_5: before.dfs_E_5,
        dfs_E_7: before.dfs_E_7,
        dfs_F_2: before.dfs_F_2,
        bits: before.bits,
      },
      after: {
        dfs_E_5: after.dfs_E_5,
        dfs_E_7: after.dfs_E_7,
        dfs_F_2: after.dfs_F_2,
        bits: after.bits,
      },
      expectations,
      f2Changed,
      debugLog,
    };
    const evidenceFile = saveJson(path.join(outputDir, `interaction-${scenarioSlug}.json`), evidence);
    addResult(
      results,
      `Interaction Scenario - ${scenarioName}`,
      bitFailures.length === 0 && payloadFailure.length === 0 ? 'PASS' : 'FAIL',
      evidence,
      [evidenceFile],
      [...bitFailures, ...payloadFailure]
    );
  } catch (error) {
    addResult(
      results,
      `Interaction Scenario - ${scenarioName}`,
      'FAIL',
      { scenario: scenarioName, error: error.message },
      [],
      [error]
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

  const frame = getLoginFrame(page);
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
    await submitButton.click();
  } else {
    await passwordField.press('Enter');
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
      if (!isDfsJsUrl(url)) return;

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
    const expectedWebdriverBit0 = readString('EXPECTED_DFS_E7_BIT0', '1');
    const expectedMissingClientHints = expectsMissingClientHints(target.browser);
    const notABrandQuestionMarkSignal = await runStep('read Not A Brand client-hints signal', () => getNotABrandQuestionMarkSignal(page));
    const scarBits = {
      dfs_E_7: e7,
      indexing: 'zero-based; bit 0 is the first character',
      expectedMissingClientHints,
      notABrandQuestionMarkSignal,
      expectations: {
        bit0: expectedWebdriverBit0,
        bit1: '0',
        ...(readBoolean('IGNORE_DFS_E7_BIT16', false) ? {} : { bit16: getExpectedDfsE7Bit16(target.browser, notABrandQuestionMarkSignal) }),
        bit22: getExpectedDfsE7Bit22(target.browser),
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
      metadata.scriptOverride = {
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

function writeLiveReports(releaseDir, aggregate, context) {
  const aggregatePath = writeAggregateSummary(releaseDir, aggregate, context);
  const coverReportPath = writeCoverReport(releaseDir, aggregate, aggregatePath, {
    releaseVersion: context.releaseVersion,
    targetUrl: Object.entries(context.targetUrls).map(([lob, url]) => `${lob}: ${url}`).join(', '),
    inProgress: context.inProgress,
  });
  const portableEvidencePath = writePortableEvidenceText(releaseDir, aggregate, context);
  return { aggregatePath, coverReportPath, portableEvidencePath };
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
