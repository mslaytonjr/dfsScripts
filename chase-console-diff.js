const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT_DIR = __dirname;
const BROWSER_PATHS_FILE = path.join(ROOT_DIR, 'browser-paths.properties');
const DEFAULT_ENV_FILE = path.join(ROOT_DIR, '.env');
const DEFAULT_URLS = ['https://secure.chase.com', 'https://www.chase.com'];
const DEFAULT_BROWSERS = ['comet', 'chrome'];
const SYSTEM_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const SIGNAL_DESCRIPTIONS = {
  'location.href': 'Final loaded URL after redirects.',
  'document.title': 'Page title exposed to browser scripts.',
  'document.readyState': 'Document lifecycle state when values were captured.',
  'navigator.userAgent': 'Classic user-agent string used by browser detection and fingerprint logic.',
  'navigator.webdriver': 'Automation-exposure flag that can affect bot and risk scoring.',
  'navigator.platform': 'Legacy OS/platform signal.',
  'navigator.vendor': 'Browser vendor string.',
  'navigator.language': 'Primary browser language.',
  'navigator.languages': 'Ordered browser language list.',
  'navigator.cookieEnabled': 'Whether browser cookies are enabled.',
  'navigator.hardwareConcurrency': 'Reported CPU thread count.',
  'navigator.deviceMemory': 'Reported device memory bucket.',
  'navigator.maxTouchPoints': 'Touch-capability signal.',
  'navigator.pdfViewerEnabled': 'Built-in PDF viewer availability.',
  'navigator.plugins': 'Legacy plugin inventory exposed to scripts.',
  'navigator.mimeTypes': 'Legacy MIME type inventory exposed to scripts.',
  'navigator.connection': 'Network Information API values exposed by the browser.',
  'navigator.permissions.states': 'Permission states for browser APIs that sites can query.',
  'navigator.mediaDevices.enumerateDevices': 'Media device inventory exposed before permissions are granted.',
  'navigator.storage.estimate': 'Storage quota and usage estimate exposed to scripts.',
  'navigator.storage.persisted': 'Storage persistence state.',
  'navigator.doNotTrack': 'Do Not Track preference exposed to scripts.',
  'navigator.globalPrivacyControl': 'Global Privacy Control preference exposed to scripts.',
  'navigator.brave': 'Brave-specific browser global presence check.',
  'navigator.userAgentData': 'Low-entropy User-Agent Client Hints brand/platform data.',
  'navigator.userAgentData.highEntropy': 'High-entropy User-Agent Client Hints including full browser version and platform details.',
  screen: 'Screen size and color-depth fingerprint surface.',
  'window.devicePixelRatio': 'Display scaling ratio exposed to scripts.',
  'window.chrome': 'Chromium chrome global shape exposed to page JavaScript.',
  'window.browserGlobals': 'Presence of common browser/vendor-specific globals.',
  'window.featureSupport': 'Support matrix for selected browser APIs.',
  'browser.capabilityMatrix': 'Broad categorized browser capability support matrix.',
  'window.objectInventories': 'Bounded property-name inventories for browser objects and prototypes.',
  'window.prototypeInventories': 'Bounded prototype property inventories for DOM and browser classes.',
  'document.policyAndSecurity': 'Document policy, referrer, CSP, origin isolation, and visibility signals.',
  'document.dimensions': 'Document and viewport dimensions.',
  'css.supports': 'CSS feature support matrix.',
  'css.mediaQueries': 'Media query match matrix.',
  'Intl.DateTimeFormat.timeZone': 'Resolved browser time zone.',
  'Intl.DateTimeFormat.locale': 'Resolved Intl locale.',
  'Intl.supportedValues': 'Selected Intl supported values counts and samples.',
  'performance.memory': 'Chromium performance memory values when exposed.',
  'permissions.notifications': 'Notification permission state from the Permissions API.',
  'mediaCapabilities.decodingInfo': 'Media codec support reported by Media Capabilities.',
  'audioContext.sampleRate': 'AudioContext sample rate and output latency where exposed.',
  'webrtc.rtcConfiguration': 'RTCPeerConnection support and default configuration shape.',
  'webgpu.adapter': 'WebGPU adapter information when available.',
  'battery.status': 'Battery Status API values when exposed.',
  'fonts.checks': 'Font availability checks through the Font Loading API.',
  'fonts.measurements': 'Canvas text measurement samples for common fonts and emoji.',
  'speechSynthesis.voices': 'Speech synthesis voice inventory exposed by the browser/OS.',
  'speechSynthesis.state': 'Speech synthesis API state and event support.',
  'media.support': 'HTML media canPlayType support matrix.',
  'navigator.keyboard': 'Keyboard layout map support and keyboard API presence.',
  'navigator.gamepads': 'Gamepad API presence and connected gamepad summary.',
  'navigator.maxTouchPoints.detail': 'Touch event and pointer capability details.',
  'credential.payment.shareCapabilities': 'Credential, payment, and Web Share capability checks.',
  'locale.formatSamples': 'Locale-sensitive formatting samples.',
  'headers.clientHintsMeta': 'Client-hint related browser metadata visible to page JavaScript.',
  'document.cookie.dfs': 'DFS cookies visible to page JavaScript.',
  'localStorage.keys': 'Local storage keys created or reused by Chase scripts.',
  'sessionStorage.keys': 'Session storage keys created or reused by Chase scripts.',
  webgl: 'WebGL vendor, renderer, and version fingerprint surface.',
  'canvas.sample': 'Canvas rendering sample used to detect rendering differences.',
  'performance.navigation': 'Navigation timing data for the top-level page load.',
  'performance.chaseResources': 'Chase, DFS, Akamai, and telemetry resource load inventory.',
  'window.probedKeys': 'Relevant Chase, DFS, Akamai, and fingerprint globals found on window.',
  'window.FingerprintData.getFingerPrint': 'DFS fingerprint payload returned by Chase page code.',
};
const NON_ATTRIBUTION_DIFFERENCE_NAMES = new Set([
  'document.cookie.dfs',
  'localStorage.keys',
  'sessionStorage.keys',
  'performance.navigation',
  'performance.chaseResources',
  'performance.memory',
  'document.dimensions',
  'window.FingerprintData.getFingerPrint',
  'window.probedKeys',
  'navigator.storage.estimate',
  'navigator.connection',
  'screen',
  'audioContext.sampleRate',
  'speechSynthesis.voices',
  'fonts.measurements',
  'navigator.gamepads',
  'battery.status',
]);
const NON_ATTRIBUTION_REASON_BY_NAME = {
  'document.cookie.dfs': 'DFS cookie hash values are request/session specific. A name present only in one browser may matter; changed values alone do not.',
  'localStorage.keys': 'Storage keys can include per-visitor or experiment IDs. Browser-only key names are useful; changed dynamic IDs are not.',
  'sessionStorage.keys': 'Session storage keys can include per-load state. Browser-only key names are useful; changed dynamic IDs are not.',
  'performance.navigation': 'Navigation timing changes on every request and mainly reflects network/cache/load timing.',
  'performance.chaseResources': 'Resource timing, order, query strings, and experiment paths can change per request. Browser-only normalized calls are useful; changed request details are not.',
  'performance.memory': 'Memory values can vary by run and page state. API presence and shape are more useful than raw values.',
  'document.dimensions': 'Viewport and page dimensions can vary with layout timing and viewport configuration.',
  'window.FingerprintData.getFingerPrint': 'Fingerprint hash payloads can include nonce/session-derived fields. Field presence can matter; full payload value changes alone are not attribution evidence.',
  'window.probedKeys': 'Large page globals include session, analytics, and experiment values. Browser-only global names are useful; nested value changes are not.',
  'navigator.storage.estimate': 'Storage quota can vary by profile, disk state, and browser session. API support matters more than raw quota values.',
  'navigator.connection': 'Network Information API values such as RTT can vary by request and profile. API presence is useful; raw timing buckets are not enough for attribution.',
  screen: 'Screen geometry can vary by display, window placement, and automation viewport. API presence and stable shape are more useful than raw dimensions.',
  'audioContext.sampleRate': 'Audio latency and state can vary by device/session. API presence and broad capability are more useful than raw latency.',
  'speechSynthesis.voices': 'Speech voices depend on OS/profile installed voices. Useful for browser profile comparison, but not necessarily browser-code specific.',
  'fonts.measurements': 'Font rendering can vary by OS, installed fonts, display settings, and canvas implementation.',
  'navigator.gamepads': 'Connected gamepads are device/session state. API presence is useful; connected device details are not stable attribution evidence.',
  'battery.status': 'Battery level and charging state can vary by device/session. API presence is more useful than raw values.',
};
const STRUCTURED_DIFF_VALUE_NAMES = new Set([
  'window.objectInventories',
  'window.prototypeInventories',
  'window.chrome',
  'window.browserGlobals',
  'window.featureSupport',
  'browser.capabilityMatrix',
  'css.supports',
  'css.mediaQueries',
  'document.policyAndSecurity',
  'headers.clientHintsMeta',
  'navigator.permissions.states',
  'navigator.userAgentData',
  'navigator.userAgentData.highEntropy',
  'mediaCapabilities.decodingInfo',
  'webgpu.adapter',
  'fonts.checks',
  'webgl',
  'webgl2',
]);

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

function parsePropertiesFile(filePath) {
  const properties = {};
  if (!fs.existsSync(filePath)) return properties;

  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const separatorIndex = line.search(/[:=]/);
    if (separatorIndex === -1) continue;
    properties[line.slice(0, separatorIndex).trim()] = line.slice(separatorIndex + 1).trim();
  }

  return properties;
}

function expandWindowsEnv(value) {
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferVersionFromPath(executablePath) {
  const parts = executablePath.split(/[\\/]+/);
  const versionLike = [...parts].reverse().find((part) => /^\d+\.\d+(?:\.\d+){0,3}$/.test(part));
  return versionLike || 'system';
}

function compareVersions(left, right) {
  const leftParts = String(left || '').split('.').map((part) => Number(part));
  const rightParts = String(right || '').split('.').map((part) => Number(part));
  const width = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < width; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : -1;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : -1;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }

  return 0;
}

function sanitizeSegment(value) {
  return String(value || 'unknown').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function getTimestampSegment() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

function discoverLatestTargets() {
  const browserPaths = parsePropertiesFile(BROWSER_PATHS_FILE);
  const selectedBrowsers = parseList(process.env.CONSOLE_DIFF_BROWSERS);
  const browserNames = selectedBrowsers.length > 0 ? selectedBrowsers : DEFAULT_BROWSERS;
  const targets = [];

  for (const browser of browserNames) {
    if (browser === 'chrome') {
      const systemChromeTarget = discoverSystemChromeTarget();
      if (systemChromeTarget) {
        targets.push(systemChromeTarget);
        continue;
      }
    }

    const value = browserPaths[browser];
    if (!value) continue;

    const candidates = value.split(';')
      .map((rawCandidate) => expandWindowsEnv(rawCandidate.trim()))
      .filter(Boolean)
      .map((executablePath) => ({
        browser,
        executablePath,
        exists: fs.existsSync(executablePath),
        configuredVersion: inferVersionFromPath(executablePath),
      }));

    const existingCandidates = candidates.filter((candidate) => candidate.exists);
    const usableCandidates = existingCandidates.length > 0 ? existingCandidates : candidates;
    usableCandidates.sort((left, right) => compareVersions(right.configuredVersion, left.configuredVersion));
    if (usableCandidates[0]) targets.push(usableCandidates[0]);
  }

  return targets;
}

function discoverSystemChromeTarget() {
  if (String(process.env.CONSOLE_DIFF_CHROME_SOURCE || 'system').toLowerCase() !== 'system') return null;
  const configuredPath = expandWindowsEnv(String(process.env.CONSOLE_DIFF_CHROME_PATH || '').trim());
  const candidates = [
    ...(configuredPath ? [configuredPath] : []),
    ...SYSTEM_CHROME_PATHS,
  ];
  const executablePath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!executablePath) return null;

  return {
    browser: 'chrome',
    executablePath,
    exists: true,
    configuredVersion: 'system-stable',
    source: 'system-installed-chrome',
  };
}

function getLaunchOptions(target) {
  return {
    executablePath: target.executablePath,
    headless: readBoolean('CONSOLE_DIFF_HEADLESS', false),
  };
}

function readBoolean(name, defaultValue) {
  if (!(name in process.env)) return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(process.env[name]).trim());
}

function getUrls() {
  const urls = parseList(process.env.CONSOLE_DIFF_URLS);
  return urls.length > 0 ? urls : DEFAULT_URLS;
}

function valueKey(value) {
  return JSON.stringify(value);
}

function hasDifferentValues(results) {
  return new Set(results.map((result) => valueKey(result.error ? { error: result.error } : result.value))).size > 1;
}

function buildDiff(urlRuns) {
  const expressionNames = [...new Set(urlRuns.flatMap((run) => run.values.map((entry) => entry.name)))].sort();
  const expressions = [];

  for (const name of expressionNames) {
    const results = urlRuns.map((run) => {
      const entry = run.values.find((item) => item.name === name);
      return {
        browser: run.browser,
        version: run.actualBrowserVersion || run.configuredVersion,
        value: entry ? entry.value : undefined,
        error: entry ? entry.error : 'not captured',
      };
    });
    expressions.push({
      name,
      different: hasDifferentValues(results),
      results,
      structuredDiff: buildStructuredDiff(name, results),
    });
  }

  const consoleMessages = urlRuns.map((run) => ({
    browser: run.browser,
    version: run.actualBrowserVersion || run.configuredVersion,
    messageCount: run.consoleMessages.length,
    messages: run.consoleMessages,
  }));

  return {
    expressions,
    differences: expressions.filter((expression) => expression.different),
    browserSpecificDifferences: expressions.filter((expression) => expression.different && isBrowserSpecificValueDifference(expression)),
    nonAttributionDifferences: expressions
      .filter((expression) => expression.different && !isBrowserSpecificValueDifference(expression))
      .map((expression) => ({
        name: expression.name,
        reason: NON_ATTRIBUTION_REASON_BY_NAME[expression.name] || 'Value changes in both browsers are not treated as browser-specific attribution unless they expose a stable browser identity signal.',
      })),
    attributionSignals: buildAttributionSignals(expressions),
    recommendedChecks: buildRecommendedChecks(expressions),
    consoleMessages,
  };
}

function buildRecommendedChecks(expressions) {
  const recommendations = [];

  function add(expressionName, pathValue, reason, score) {
    const expression = expressions.find((item) => item.name === expressionName);
    if (!expression || !expression.different) return;
    const values = getPathComparison(expression, pathValue);
    if (!values || valueKey(values.comet) === valueKey(values.chrome)) return;
    recommendations.push({
      expressionName,
      path: pathValue,
      cometValue: values.comet,
      chromeValue: values.chrome,
      reason,
      score,
    });
  }

  add('navigator.globalPrivacyControl', '$', 'Comet exposes Global Privacy Control while installed Chrome does not in current runs.', 100);
  add('headers.clientHintsMeta', 'globalPrivacyControlPresent', 'Simple boolean presence check for Global Privacy Control.', 98);
  add('browser.capabilityMatrix', 'navigator.globalPrivacyControl', 'Capability matrix confirms the navigator property exists only on one side.', 96);
  add('window.prototypeInventories', 'Navigator.globalPrivacyControl', 'Prototype-level presence is harder to confuse with page-created globals.', 94);
  add('window.objectInventories', 'navigator.globalPrivacyControl', 'Runtime navigator inventory confirms property presence.', 92);
  add('navigator.userAgentData', 'brands.Google Chrome 147', 'UA Client Hints brand presence differs between Comet and installed Chrome.', 90);
  add('navigator.userAgentData.highEntropy', 'fullVersionList.Google Chrome 147.0.7727.56', 'High-entropy full version brand is a strong observed differentiator.', 88);
  add('navigator.userAgentData.highEntropy', 'uaFullVersion', 'Full browser version differs and can explain DFS enhanced-version logic.', 82);
  add('speechSynthesis.voices', 'Google US English|en-US|Google US English|remote|', 'Speech synthesis voice inventory differed in current runs; useful as supporting evidence.', 70);
  add('credential.payment.shareCapabilities', 'share', 'Share/payment/credential capability surface differed in some runs.', 65);
  add('browser.capabilityMatrix', 'navigator.share', 'Capability matrix check for Web Share support.', 64);
  add('browser.capabilityMatrix', 'navigator.canShare', 'Capability matrix check for canShare support.', 64);
  add('browser.capabilityMatrix', 'navigator.gpu', 'WebGPU navigator capability can differ by browser/profile/policy.', 55);
  add('browser.capabilityMatrix', 'storageAndFiles.showOpenFilePicker', 'File System Access support can distinguish Chromium variants or policies.', 50);
  add('browser.capabilityMatrix', 'windowApis.EyeDropper', 'EyeDropper support can differ by Chromium variant/profile/policy.', 45);

  return recommendations.sort((left, right) => right.score - left.score);
}

function getPathComparison(expression, pathValue) {
  const comet = findResultByBrowser(expression.results, 'comet');
  const chrome = findResultByBrowser(expression.results, 'chrome');
  if (!comet || !chrome || comet.error || chrome.error) return null;
  if (pathValue === '$') return { comet: comet.value, chrome: chrome.value };

  const structuredDiff = expression.structuredDiff || compareStructuredValues(comet.value, chrome.value);
  const cometOnly = structuredDiff.cometOnly.find((item) => item.path === pathValue);
  const chromeOnly = structuredDiff.chromeOnly.find((item) => item.path === pathValue);
  const changed = structuredDiff.changed.find((item) => item.path === pathValue);
  if (changed) return { comet: changed.comet, chrome: changed.chrome };
  if (cometOnly) return { comet: cometOnly.value, chrome: undefined };
  if (chromeOnly) return { comet: undefined, chrome: chromeOnly.value };
  return null;
}

function buildStructuredDiff(name, results) {
  if (!STRUCTURED_DIFF_VALUE_NAMES.has(name)) return null;
  const comet = findResultByBrowser(results, 'comet');
  const chrome = findResultByBrowser(results, 'chrome');
  if (!comet || !chrome || comet.error || chrome.error) return null;
  return compareStructuredValues(comet.value, chrome.value);
}

function compareStructuredValues(cometValue, chromeValue) {
  const cometMap = flattenForStructuredDiff(cometValue);
  const chromeMap = flattenForStructuredDiff(chromeValue);
  const paths = [...new Set([...Object.keys(cometMap), ...Object.keys(chromeMap)])].sort();
  const cometOnly = [];
  const chromeOnly = [];
  const changed = [];

  for (const itemPath of paths) {
    const cometHas = Object.prototype.hasOwnProperty.call(cometMap, itemPath);
    const chromeHas = Object.prototype.hasOwnProperty.call(chromeMap, itemPath);
    if (cometHas && !chromeHas) {
      cometOnly.push({ path: itemPath, value: cometMap[itemPath] });
    } else if (!cometHas && chromeHas) {
      chromeOnly.push({ path: itemPath, value: chromeMap[itemPath] });
    } else if (valueKey(cometMap[itemPath]) !== valueKey(chromeMap[itemPath])) {
      changed.push({ path: itemPath, comet: cometMap[itemPath], chrome: chromeMap[itemPath] });
    }
  }

  return {
    cometOnly,
    chromeOnly,
    changed,
    totals: {
      cometOnly: cometOnly.length,
      chromeOnly: chromeOnly.length,
      changed: changed.length,
    },
  };
}

function flattenForStructuredDiff(value, prefix = '', output = {}) {
  if (value === null || value === undefined || typeof value !== 'object') {
    output[prefix || '$'] = value;
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const pathValue = `${prefix}.${normalizeDiffToken(item)}`.replace(/^\./, '');
      output[pathValue] = true;
    }
    if (value.length === 0 && prefix) output[prefix] = [];
    return output;
  }

  const keys = Object.keys(value).sort();
  if (keys.length === 0 && prefix) {
    output[prefix] = {};
    return output;
  }

  for (const key of keys) {
    const childPath = prefix ? `${prefix}.${normalizeDiffToken(key)}` : normalizeDiffToken(key);
    flattenForStructuredDiff(value[key], childPath, output);
  }
  return output;
}

function normalizeDiffToken(value) {
  return String(value)
    .replace(/[a-f0-9]{24,}/gi, ':hash')
    .replace(/\b\d{12,}\b/g, ':id')
    .replace(/__react(?:Container|Resources)\$[a-z0-9]+/gi, '__react:$token')
    .replace(/_reactListening[a-z0-9]+/gi, '_reactListening:$token');
}

function isBrowserSpecificValueDifference(expression) {
  if (NON_ATTRIBUTION_DIFFERENCE_NAMES.has(expression.name)) return false;
  return true;
}

function buildAttributionSignals(expressions) {
  return [
    buildPresenceSignal(expressions, 'performance.chaseResources', 'Network/resource calls', getResourceCallItems),
    buildPresenceSignal(expressions, 'document.cookie.dfs', 'DFS cookie names', getCookieNameItems),
    buildPresenceSignal(expressions, 'localStorage.keys', 'Local storage keys', getStorageKeyItems),
    buildPresenceSignal(expressions, 'sessionStorage.keys', 'Session storage keys', getStorageKeyItems),
    buildPresenceSignal(expressions, 'navigator.userAgentData', 'Low-entropy User-Agent Client Hints brands', getUserAgentBrandItems),
    buildPresenceSignal(expressions, 'navigator.userAgentData.highEntropy', 'High-entropy User-Agent Client Hints brands and full versions', getHighEntropyBrandItems),
    buildPresenceSignal(expressions, 'window.chrome', 'Chromium chrome global keys', getObjectKeyItems),
    buildPresenceSignal(expressions, 'window.browserGlobals', 'Browser/vendor global names', getPresentBooleanObjectItems),
    buildPresenceSignal(expressions, 'window.featureSupport', 'Supported browser APIs', getPresentBooleanObjectItems),
    buildPresenceSignal(expressions, 'browser.capabilityMatrix', 'Supported browser capability matrix', getCapabilityMatrixItems),
    buildPresenceSignal(expressions, 'window.objectInventories', 'Browser object inventory keys', getInventoryItems),
    buildPresenceSignal(expressions, 'window.prototypeInventories', 'Browser prototype inventory keys', getInventoryItems),
    buildPresenceSignal(expressions, 'css.supports', 'Supported CSS features', getPresentBooleanObjectItems),
    buildPresenceSignal(expressions, 'css.mediaQueries', 'Matched media queries', getPresentBooleanObjectItems),
    buildPresenceSignal(expressions, 'speechSynthesis.voices', 'Speech synthesis voices', getSpeechVoiceItems),
    buildPresenceSignal(expressions, 'media.support', 'Supported media MIME types', getPositiveSupportItems),
    buildPresenceSignal(expressions, 'credential.payment.shareCapabilities', 'Credential/payment/share capabilities', getPresentBooleanObjectItems),
    buildPresenceSignal(expressions, 'window.probedKeys', 'Browser-visible Chase/DFS globals', getWindowProbeItems),
    buildPresenceSignal(expressions, 'window.FingerprintData.getFingerPrint', 'DFS fingerprint field names', getFingerprintFieldItems),
  ].filter((signal) => signal && (signal.cometOnly.length > 0 || signal.chromeOnly.length > 0));
}

function buildPresenceSignal(expressions, expressionName, signalName, itemGetter) {
  const expression = expressions.find((item) => item.name === expressionName);
  if (!expression) return null;

  const comet = findResultByBrowser(expression.results, 'comet');
  const chrome = findResultByBrowser(expression.results, 'chrome');
  const cometItems = new Set(itemGetter(comet && !comet.error ? comet.value : undefined));
  const chromeItems = new Set(itemGetter(chrome && !chrome.error ? chrome.value : undefined));

  return {
    expressionName,
    signalName,
    description: SIGNAL_DESCRIPTIONS[expressionName] || 'Console-accessible browser or page signal.',
    cometOnly: [...cometItems].filter((item) => !chromeItems.has(item)).sort(),
    chromeOnly: [...chromeItems].filter((item) => !cometItems.has(item)).sort(),
    sharedCount: [...cometItems].filter((item) => chromeItems.has(item)).length,
  };
}

function getScalarItems(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function getCookieNameItems(value) {
  return getScalarItems(value).map((cookie) => cookie.split('=')[0]).filter(Boolean);
}

function getResourceCallItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const call = normalizeUrlForComparison(entry && entry.name);
    const initiatorType = entry && entry.initiatorType ? entry.initiatorType : 'unknown';
    if (isVolatileResourceCall(call)) return null;
    return `${initiatorType} ${call}`;
  }).filter(Boolean);
}

function normalizeUrlForComparison(value) {
  try {
    const parsed = new URL(String(value));
    const pathname = parsed.pathname
      .replace(/\/memberships\/[a-z0-9-]+/gi, '/memberships/:member')
      .replace(/\/prod\/[a-z0-9-]+\/versions\.json/gi, '/prod/:version/versions.json')
      .replace(/desktop-\d+\.jpg/gi, 'desktop-:variant.jpg')
      .replace(/\/\d{8,}(?=\/|$)/g, '/:id')
      .replace(/[a-f0-9]{24,}/gi, ':hash');
    return `${parsed.origin}${pathname}`;
  } catch {
    return String(value || '');
  }
}

function isVolatileResourceCall(call) {
  return [
    /:\/\/sites\.chase\.com\/content\/mktservices\/digital-assets\//i,
    /:\/\/sites\.chase\.com\/content\/services\/structured-image\//i,
  ].some((pattern) => pattern.test(call));
}

function getStorageKeyItems(value) {
  return getScalarItems(value).map((item) => item
    .replace(/pub\.SPLITIO\.[^.]+\.largeSegments\.till/g, 'pub.SPLITIO.:member.largeSegments.till')
    .replace(/[a-f0-9]{24,}/gi, ':hash')
    .replace(/\d{12,}/g, ':id'));
}

function getUserAgentBrandItems(value) {
  return Array.isArray(value && value.brands)
    ? value.brands.map((brand) => `${brand.brand} ${brand.version}`.trim())
    : [];
}

function getHighEntropyBrandItems(value) {
  const items = getUserAgentBrandItems(value);
  if (Array.isArray(value && value.fullVersionList)) {
    for (const brand of value.fullVersionList) items.push(`${brand.brand} ${brand.version}`.trim());
  }
  return items;
}

function getObjectKeyItems(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

function getPresentBooleanObjectItems(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, itemValue]) => itemValue === true)
    .map(([key]) => key)
    .sort();
}

function getCapabilityMatrixItems(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const items = [];
  for (const [category, capabilities] of Object.entries(value)) {
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) continue;
    for (const [name, supported] of Object.entries(capabilities)) {
      if (supported === true) items.push(`${category}.${name}`);
    }
  }
  return items.sort();
}

function getPositiveSupportItems(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, itemValue]) => itemValue && itemValue !== 'no' && itemValue !== 'unsupported')
    .map(([key, itemValue]) => `${key}:${itemValue}`)
    .sort();
}

function getSpeechVoiceItems(value) {
  return Array.isArray(value)
    ? value.map((voice) => `${voice.name}|${voice.lang}|${voice.voiceURI}|${voice.localService ? 'local' : 'remote'}|${voice.default ? 'default' : ''}`)
    : [];
}

function getInventoryItems(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const items = [];
  for (const [group, groupValue] of Object.entries(value)) {
    if (Array.isArray(groupValue)) {
      for (const key of groupValue) {
        const item = normalizeInventoryItem(`${group}.${key}`);
        if (item) items.push(item);
      }
    } else if (groupValue && typeof groupValue === 'object' && Array.isArray(groupValue.keys)) {
      for (const key of groupValue.keys) {
        const item = normalizeInventoryItem(`${group}.${key}`);
        if (item) items.push(item);
      }
    }
  }
  return items.sort();
}

function normalizeInventoryItem(item) {
  const value = String(item || '');
  if (/\.__react(?:Container|Resources)[a-z0-9]+$/i.test(value)) return null;
  if (/\._reactListening[a-z0-9]+$/i.test(value)) return null;
  if (/\.webpackChunk/i.test(value)) return null;
  return value.replace(/[a-f0-9]{24,}/gi, ':hash').replace(/[a-z0-9]{10,}$/i, ':token');
}

function getWindowProbeItems(value) {
  return Array.isArray(value) ? value.map((entry) => entry && entry.key).filter(Boolean) : [];
}

function getFingerprintFieldItems(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => entry && typeof entry === 'object' ? Object.keys(entry) : []))];
}

function writeMarkdownReport(outputDir, report) {
  const lines = [
    '# Chase Console Difference Report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Runs',
    '',
  ];

  for (const run of report.runs) {
    lines.push(`- ${run.url} | ${run.browser} ${run.actualBrowserVersion || run.configuredVersion} | ${run.status}`);
  }

  for (const [url, diff] of Object.entries(report.byUrl)) {
    lines.push('', `## ${url}`, '');
    lines.push('Differences that exist in both browsers and change across requests are treated as volatile request/session data, not browser attribution evidence.', '');
    if (diff.recommendedChecks.length > 0) {
      lines.push('### Recommended Values To Check', '');
      lines.push('| score | expression | path | comet value | chrome value | reason |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const recommendation of diff.recommendedChecks) lines.push(formatRecommendationRow(recommendation));
      lines.push('');
    }

    if (diff.attributionSignals.length > 0) {
      lines.push('### Calls And Browser-Only Signals', '');
      lines.push('| signal | comet only | chrome only | description |');
      lines.push('| --- | --- | --- | --- |');
      for (const signal of diff.attributionSignals) lines.push(formatAttributionSignalRow(signal));
      lines.push('');
    }

    if (diff.browserSpecificDifferences.length === 0) {
      lines.push('No browser-specific value differences found.');
    } else {
      lines.push('### Browser-Specific Value Differences', '');
      lines.push('| name | comet value | chrome value | description of signal |');
      lines.push('| --- | --- | --- | --- |');
      for (const difference of diff.browserSpecificDifferences) lines.push(formatDifferenceRow(difference));
      lines.push('');
    }

    if (diff.nonAttributionDifferences.length > 0) {
      lines.push('### Volatile Differences Not Used For Attribution', '');
      lines.push('| name | reason |');
      lines.push('| --- | --- |');
      for (const difference of diff.nonAttributionDifferences) {
        lines.push(`| ${escapeMarkdownTableCell(difference.name)} | ${escapeMarkdownTableCell(difference.reason)} |`);
      }
      lines.push('');
    }

    const messageRows = diff.consoleMessages.filter((item) => item.messageCount > 0);
    if (messageRows.length > 0) {
      lines.push('### Console Messages', '');
      for (const row of messageRows) {
        lines.push(`- ${row.browser} ${row.version}: ${row.messageCount} message(s)`);
      }
    }
  }

  const reportPath = path.join(outputDir, 'console-diff-report.md');
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  return reportPath;
}

function formatRecommendationRow(recommendation) {
  return [
    recommendation.score,
    escapeMarkdownTableCell(recommendation.expressionName),
    escapeMarkdownTableCell(recommendation.path),
    escapeMarkdownTableCell(`\`${formatMarkdownValue(recommendation.cometValue)}\``),
    escapeMarkdownTableCell(`\`${formatMarkdownValue(recommendation.chromeValue)}\``),
    escapeMarkdownTableCell(recommendation.reason),
  ].join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function formatAttributionSignalRow(signal) {
  return [
    escapeMarkdownTableCell(signal.signalName),
    escapeMarkdownTableCell(formatListForMarkdown(signal.cometOnly)),
    escapeMarkdownTableCell(formatListForMarkdown(signal.chromeOnly)),
    escapeMarkdownTableCell(`${signal.description} Shared items: ${signal.sharedCount}.`),
  ].join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function formatDifferenceRow(difference) {
  const comet = findResultByBrowser(difference.results, 'comet');
  const chrome = findResultByBrowser(difference.results, 'chrome');
  const cometValue = difference.structuredDiff
    ? formatStructuredDiffSide(difference.structuredDiff, 'comet')
    : comet ? getResultMarkdownValue(comet) : 'not captured';
  const chromeValue = difference.structuredDiff
    ? formatStructuredDiffSide(difference.structuredDiff, 'chrome')
    : chrome ? getResultMarkdownValue(chrome) : 'not captured';

  return [
    escapeMarkdownTableCell(difference.name),
    escapeMarkdownTableCell(cometValue),
    escapeMarkdownTableCell(chromeValue),
    escapeMarkdownTableCell(SIGNAL_DESCRIPTIONS[difference.name] || 'Console-accessible browser or page signal.'),
  ].join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

function findResultByBrowser(results, browser) {
  return results.find((result) => result.browser === browser);
}

function getResultMarkdownValue(result) {
  const value = result.error ? { error: result.error } : result.value;
  return `\`${formatMarkdownValue(value)}\``;
}

function formatStructuredDiffSide(diff, side) {
  const maxItems = Number(process.env.CONSOLE_DIFF_MARKDOWN_STRUCTURED_ITEM_LIMIT || 15);
  const onlyItems = side === 'comet' ? diff.cometOnly : diff.chromeOnly;
  const changedItems = diff.changed.map((item) => ({
    path: item.path,
    value: side === 'comet' ? item.comet : item.chrome,
    forceValue: true,
  }));
  const parts = [];

  if (onlyItems.length > 0) {
    parts.push(`only: ${formatStructuredItems(onlyItems, maxItems)}`);
  }
  if (changedItems.length > 0) {
    parts.push(`changed: ${formatStructuredItems(changedItems, Math.max(0, maxItems - onlyItems.length))}`);
  }
  if (parts.length === 0) return 'no side-specific paths';
  return parts.join('<br>');
}

function formatStructuredItems(items, maxItems) {
  const visibleItems = items.slice(0, Math.max(maxItems, 0));
  const rendered = visibleItems.map((item) => {
    const valueText = item.value === true && !Object.prototype.hasOwnProperty.call(item, 'forceValue')
      ? ''
      : `=${formatMarkdownValue(item.value)}`;
    return `${item.path}${valueText}`;
  });
  const suffix = items.length > visibleItems.length ? `; +${items.length - visibleItems.length} more` : '';
  return `\`${rendered.join('; ')}${suffix}\``;
}

function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|');
}

function formatMarkdownValue(value) {
  const maxLength = Number(process.env.CONSOLE_DIFF_MARKDOWN_VALUE_LIMIT || 600);
  const text = JSON.stringify(value);
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated, see console-diff-report.json]`;
}

function formatListForMarkdown(items) {
  if (!items || items.length === 0) return 'none';
  const maxItems = Number(process.env.CONSOLE_DIFF_MARKDOWN_ITEM_LIMIT || 12);
  const visibleItems = items.slice(0, maxItems);
  const suffix = items.length > visibleItems.length ? `; +${items.length - visibleItems.length} more` : '';
  return `\`${visibleItems.join('; ')}${suffix}\``;
}

async function collectRun(target, url, outputDir) {
  const runDir = path.join(outputDir, sanitizeSegment(new URL(url).hostname), sanitizeSegment(target.browser));
  const consoleMessages = [];
  const run = {
    url,
    browser: target.browser,
    configuredVersion: target.configuredVersion,
    executablePath: target.executablePath,
    source: target.source || 'browser-paths.properties',
    exists: target.exists,
    startedAt: new Date().toISOString(),
    status: 'pending',
    actualBrowserVersion: null,
    values: [],
    consoleMessages,
  };

  if (!target.exists) {
    run.status = 'failed';
    run.error = `Missing executable: ${target.executablePath}`;
    run.finishedAt = new Date().toISOString();
    saveJson(path.join(runDir, 'console-values.json'), run);
    return run;
  }

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch(getLaunchOptions(target));
    run.actualBrowserVersion = browser.version();
    context = await browser.newContext({
      viewport: {
        width: Number(process.env.CONSOLE_DIFF_VIEWPORT_WIDTH || process.env.VIEWPORT_WIDTH || 1365),
        height: Number(process.env.CONSOLE_DIFF_VIEWPORT_HEIGHT || process.env.VIEWPORT_HEIGHT || 900),
      },
    });
    page = await context.newPage();
    page.on('console', (message) => {
      consoleMessages.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
        timestamp: new Date().toISOString(),
      });
    });
    page.on('pageerror', (error) => {
      consoleMessages.push({
        type: 'pageerror',
        text: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      });
    });

    await page.goto(url, {
      waitUntil: process.env.CONSOLE_DIFF_GOTO_WAIT_UNTIL || process.env.GOTO_WAIT_UNTIL || 'domcontentloaded',
      timeout: Number(process.env.CONSOLE_DIFF_NAVIGATION_TIMEOUT_MS || process.env.NAVIGATION_TIMEOUT_MS || 30000),
    });
    await page.waitForLoadState('networkidle', {
      timeout: Number(process.env.CONSOLE_DIFF_NETWORK_IDLE_TIMEOUT_MS || 10000),
    }).catch(() => {});
    await page.waitForTimeout(Number(process.env.CONSOLE_DIFF_POST_LOAD_WAIT_MS || process.env.POST_LOAD_WAIT_MS || 5000));
    const finalUrl = page.url();
    if (finalUrl === 'about:blank') {
      throw new Error(`Navigation did not leave about:blank for ${url}`);
    }
    run.values = await page.evaluate(evaluateConsoleValues);
    run.status = 'ok';
  } catch (error) {
    run.status = 'failed';
    run.error = error.stack || error.message;
  } finally {
    run.finishedAt = new Date().toISOString();
    saveJson(path.join(runDir, 'console-values.json'), run);
    if (page && !page.isClosed()) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return run;
}

async function main() {
  loadEnvFile(process.env.DFS_ENV_FILE || DEFAULT_ENV_FILE);
  const targets = discoverLatestTargets();
  const urls = getUrls();

  if (targets.length === 0) {
    throw new Error(`No Comet or Chrome executable paths found in ${BROWSER_PATHS_FILE}.`);
  }

  const outputDir = path.join(ROOT_DIR, 'evidence', 'console-diff', getTimestampSegment());
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`Console diff evidence directory: ${outputDir}`);
  console.log(`Targets: ${targets.map((target) => `${target.browser} ${target.configuredVersion}`).join(', ')}`);

  const runs = [];
  for (const url of urls) {
    for (const target of targets) {
      console.log(`Running ${target.browser} ${target.configuredVersion} against ${url}`);
      const run = await collectRun(target, url, outputDir);
      console.log(`  ${run.status}${run.error ? ` - ${String(run.error).split(/\r?\n/)[0]}` : ''}`);
      runs.push(run);
    }
  }

  const byUrl = {};
  for (const url of urls) {
    byUrl[url] = buildDiff(runs.filter((run) => run.url === url));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    outputDir,
    targets,
    urls,
    runs: runs.map((run) => ({
      url: run.url,
      browser: run.browser,
      configuredVersion: run.configuredVersion,
      actualBrowserVersion: run.actualBrowserVersion,
      executablePath: run.executablePath,
      source: run.source,
      status: run.status,
      error: run.error,
      consoleMessageCount: run.consoleMessages.length,
    })),
    byUrl,
  };
  const jsonPath = saveJson(path.join(outputDir, 'console-diff-report.json'), report);
  const markdownPath = writeMarkdownReport(outputDir, report);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${markdownPath}`);
}

async function evaluateConsoleValues() {
  const entries = [];

  async function read(name, getter) {
    try {
      entries.push({
        name,
        value: normalizeValue(await getter()),
      });
    } catch (error) {
      entries.push({
        name,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  function normalizeValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (depth > 4) return '[max-depth]';
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.slice(0, 100).map((item) => normalizeValue(item, depth + 1, seen));
    const output = {};
    for (const key of Object.keys(value).sort().slice(0, 200)) {
      try {
        output[key] = normalizeValue(value[key], depth + 1, seen);
      } catch (error) {
        output[key] = `[error: ${error.message}]`;
      }
    }
    return output;
  }

  function getPropertyNames(value) {
    if (!value) return [];
    const names = new Set();
    let current = value;
    let depth = 0;
    while (current && depth < 4) {
      for (const name of Object.getOwnPropertyNames(current)) names.add(name);
      for (const symbol of Object.getOwnPropertySymbols(current)) names.add(symbol.toString());
      current = Object.getPrototypeOf(current);
      depth += 1;
    }
    return [...names].sort().slice(0, 500);
  }

  function getOwnDescriptorSummary(value) {
    if (!value) return {};
    const output = {};
    for (const key of Object.getOwnPropertyNames(value).sort().slice(0, 250)) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        output[key] = {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          writable: Object.prototype.hasOwnProperty.call(descriptor, 'writable') ? descriptor.writable : undefined,
          get: typeof descriptor.get === 'function',
          set: typeof descriptor.set === 'function',
          type: Object.prototype.hasOwnProperty.call(descriptor, 'value') ? typeof descriptor.value : 'accessor',
        };
      } catch (error) {
        output[key] = { error: error.message };
      }
    }
    return output;
  }

  function getObjectInventories() {
    return {
      navigator: getPropertyNames(navigator),
      navigatorOwnDescriptors: getOwnDescriptorSummary(navigator),
      window: getPropertyNames(window),
      document: getPropertyNames(document),
      screen: getPropertyNames(screen),
      location: getPropertyNames(location),
      history: getPropertyNames(history),
      performance: getPropertyNames(performance),
      crypto: getPropertyNames(crypto),
      css: window.CSS ? getPropertyNames(CSS) : [],
      intl: getPropertyNames(Intl),
      chrome: window.chrome ? getPropertyNames(window.chrome) : [],
    };
  }

  function getPrototypeInventories() {
    const constructors = {
      Navigator,
      Window,
      Document,
      HTMLDocument,
      Screen,
      Location,
      History,
      Performance,
      Storage,
      HTMLElement,
      HTMLCanvasElement,
      HTMLIFrameElement,
      HTMLInputElement,
      HTMLScriptElement,
      CSSStyleDeclaration,
      EventTarget,
      Node,
      Element,
      RTCPeerConnection: window.RTCPeerConnection,
      AudioContext: window.AudioContext || window.webkitAudioContext,
      WebGLRenderingContext: window.WebGLRenderingContext,
      WebGL2RenderingContext: window.WebGL2RenderingContext,
    };
    const output = {};
    for (const [name, constructor] of Object.entries(constructors)) {
      output[name] = constructor && constructor.prototype ? getPropertyNames(constructor.prototype) : [];
    }
    return output;
  }

  function getWebglInfo() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return { available: false };
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      available: true,
      vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    };
  }

  function getWebgl2Info() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return { available: false };
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      available: true,
      vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      extensions: gl.getSupportedExtensions(),
    };
  }

  function getCanvasSample() {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.textBaseline = 'top';
    context.font = '18px Arial';
    context.fillStyle = '#f60';
    context.fillRect(0, 0, 240, 60);
    context.fillStyle = '#069';
    context.fillText('Chase browser console diff', 4, 8);
    return canvas.toDataURL().slice(0, 120);
  }

  function getStorageKeys(storage) {
    if (!storage) return [];
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) keys.push(storage.key(index));
    return keys.sort();
  }

  function getWindowProbe() {
    const pattern = /dfs|fingerprint|clientenv|akamai|boomerang|_abck|sensor|chase/i;
    return Object.keys(window)
      .filter((key) => pattern.test(key))
      .sort()
      .slice(0, 100)
      .map((key) => {
        let value;
        try {
          value = normalizeValue(window[key]);
        } catch (error) {
          value = `[error: ${error.message}]`;
        }
        return { key, type: typeof window[key], value };
      });
  }

  function getChromeGlobal() {
    if (!window.chrome || typeof window.chrome !== 'object') return null;
    const output = {};
    for (const key of Object.keys(window.chrome).sort()) {
      const value = window.chrome[key];
      output[key] = typeof value === 'object' && value !== null ? Object.keys(value).sort() : typeof value;
    }
    return output;
  }

  function getBrowserGlobals() {
    return {
      chrome: typeof window.chrome !== 'undefined',
      chromeApp: !!(window.chrome && window.chrome.app),
      chromeRuntime: !!(window.chrome && window.chrome.runtime),
      chromeCsi: typeof window.chrome === 'object' && typeof window.chrome.csi === 'function',
      chromeLoadTimes: typeof window.chrome === 'object' && typeof window.chrome.loadTimes === 'function',
      browser: typeof window.browser !== 'undefined',
      opr: typeof window.opr !== 'undefined',
      opera: typeof window.opera !== 'undefined',
      safari: typeof window.safari !== 'undefined',
      InstallTrigger: typeof window.InstallTrigger !== 'undefined',
      StyleMedia: typeof window.StyleMedia !== 'undefined',
      external: typeof window.external !== 'undefined',
      trustedTypes: typeof window.trustedTypes !== 'undefined',
      EyeDropper: typeof window.EyeDropper !== 'undefined',
      launchQueue: typeof window.launchQueue !== 'undefined',
    };
  }

  function getFeatureSupport() {
    return {
      webgpu: 'gpu' in navigator,
      webusb: 'usb' in navigator,
      webhid: 'hid' in navigator,
      serial: 'serial' in navigator,
      bluetooth: 'bluetooth' in navigator,
      contacts: 'contacts' in navigator,
      credentials: 'credentials' in navigator,
      clipboardRead: !!(navigator.clipboard && navigator.clipboard.read),
      clipboardWrite: !!(navigator.clipboard && navigator.clipboard.write),
      cookieStore: 'cookieStore' in window,
      sharedStorage: 'sharedStorage' in window,
      fencedFrames: 'HTMLFencedFrameElement' in window,
      privateAggregation: 'privateAggregation' in window,
      topics: !!(document.browsingTopics || (document.featurePolicy && document.featurePolicy.allowsFeature && document.featurePolicy.allowsFeature('browsing-topics'))),
      paymentRequest: 'PaymentRequest' in window,
      credentialManagement: 'PasswordCredential' in window || 'FederatedCredential' in window,
      publicKeyCredential: 'PublicKeyCredential' in window,
      webauthnConditionalMediation: !!(window.PublicKeyCredential && PublicKeyCredential.isConditionalMediationAvailable),
      idleDetector: 'IdleDetector' in window,
      scheduler: 'scheduler' in window,
      compressionStream: 'CompressionStream' in window,
      decompressionStream: 'DecompressionStream' in window,
      navigationApi: 'navigation' in window,
      visualViewport: 'visualViewport' in window,
      documentPictureInPicture: 'documentPictureInPicture' in window,
      audioOutputDevices: !!(navigator.mediaDevices && navigator.mediaDevices.selectAudioOutput),
      getDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
      serviceWorker: 'serviceWorker' in navigator,
      locks: 'locks' in navigator,
      wakeLock: 'wakeLock' in navigator,
      virtualKeyboard: 'virtualKeyboard' in navigator,
      windowControlsOverlay: 'windowControlsOverlay' in navigator,
      userActivation: 'userActivation' in navigator,
      devicePosture: 'devicePosture' in navigator,
      keyboard: 'keyboard' in navigator,
      managed: 'managed' in navigator,
      mediaSession: 'mediaSession' in navigator,
      presentation: 'presentation' in navigator,
      usbForget: !!(navigator.usb && navigator.usb.forget),
      webShare: !!navigator.share,
      canShare: !!navigator.canShare,
      fileSystemAccess: 'showOpenFilePicker' in window,
      originPrivateFileSystem: !!(navigator.storage && navigator.storage.getDirectory),
      indexedDB: 'indexedDB' in window,
      caches: 'caches' in window,
      broadcastChannel: 'BroadcastChannel' in window,
      sharedWorker: 'SharedWorker' in window,
      wasm: 'WebAssembly' in window,
      wasmSimd: typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      offscreenCanvas: 'OffscreenCanvas' in window,
      createImageBitmap: 'createImageBitmap' in window,
      resizeObserver: 'ResizeObserver' in window,
      intersectionObserver: 'IntersectionObserver' in window,
      mutationObserver: 'MutationObserver' in window,
      reportingObserver: 'ReportingObserver' in window,
      performanceObserver: 'PerformanceObserver' in window,
    };
  }

  function hasPath(pathValue) {
    const parts = pathValue.split('.');
    let current = window;
    for (const part of parts) {
      if (current === undefined || current === null || !(part in current)) return false;
      current = current[part];
    }
    return true;
  }

  function hasNavigatorPath(pathValue) {
    const parts = pathValue.split('.');
    let current = navigator;
    for (const part of parts) {
      if (current === undefined || current === null || !(part in current)) return false;
      current = current[part];
    }
    return true;
  }

  function getBrowserCapabilityMatrix() {
    return {
      navigator: {
        userAgentData: hasNavigatorPath('userAgentData'),
        webdriver: hasNavigatorPath('webdriver'),
        globalPrivacyControl: hasNavigatorPath('globalPrivacyControl'),
        doNotTrack: hasNavigatorPath('doNotTrack'),
        deviceMemory: hasNavigatorPath('deviceMemory'),
        hardwareConcurrency: hasNavigatorPath('hardwareConcurrency'),
        maxTouchPoints: hasNavigatorPath('maxTouchPoints'),
        pdfViewerEnabled: hasNavigatorPath('pdfViewerEnabled'),
        connection: hasNavigatorPath('connection'),
        bluetooth: hasNavigatorPath('bluetooth'),
        usb: hasNavigatorPath('usb'),
        hid: hasNavigatorPath('hid'),
        serial: hasNavigatorPath('serial'),
        gpu: hasNavigatorPath('gpu'),
        keyboard: hasNavigatorPath('keyboard'),
        locks: hasNavigatorPath('locks'),
        mediaDevices: hasNavigatorPath('mediaDevices'),
        mediaSession: hasNavigatorPath('mediaSession'),
        permissions: hasNavigatorPath('permissions'),
        presentation: hasNavigatorPath('presentation'),
        serviceWorker: hasNavigatorPath('serviceWorker'),
        storage: hasNavigatorPath('storage'),
        wakeLock: hasNavigatorPath('wakeLock'),
        virtualKeyboard: hasNavigatorPath('virtualKeyboard'),
        windowControlsOverlay: hasNavigatorPath('windowControlsOverlay'),
        userActivation: hasNavigatorPath('userActivation'),
        devicePosture: hasNavigatorPath('devicePosture'),
        contacts: hasNavigatorPath('contacts'),
        credentials: hasNavigatorPath('credentials'),
        clipboard: hasNavigatorPath('clipboard'),
        share: hasNavigatorPath('share'),
        canShare: hasNavigatorPath('canShare'),
        getBattery: hasNavigatorPath('getBattery'),
        getGamepads: hasNavigatorPath('getGamepads'),
        registerProtocolHandler: hasNavigatorPath('registerProtocolHandler'),
        unregisterProtocolHandler: hasNavigatorPath('unregisterProtocolHandler'),
        clearAppBadge: hasNavigatorPath('clearAppBadge'),
        setAppBadge: hasNavigatorPath('setAppBadge'),
        deprecatedRunAdAuction: hasNavigatorPath('deprecatedRunAdAuction'),
        runAdAuction: hasNavigatorPath('runAdAuction'),
        joinAdInterestGroup: hasNavigatorPath('joinAdInterestGroup'),
        leaveAdInterestGroup: hasNavigatorPath('leaveAdInterestGroup'),
        updateAdInterestGroups: hasNavigatorPath('updateAdInterestGroups'),
        adAuctionComponents: hasNavigatorPath('adAuctionComponents'),
      },
      windowApis: {
        caches: hasPath('caches'),
        cookieStore: hasPath('cookieStore'),
        credentialless: hasPath('credentialless'),
        crossOriginIsolated: hasPath('crossOriginIsolated'),
        crypto: hasPath('crypto'),
        trustedTypes: hasPath('trustedTypes'),
        scheduler: hasPath('scheduler'),
        navigation: hasPath('navigation'),
        visualViewport: hasPath('visualViewport'),
        launchQueue: hasPath('launchQueue'),
        sharedStorage: hasPath('sharedStorage'),
        privateAggregation: hasPath('privateAggregation'),
        fencedFrames: hasPath('HTMLFencedFrameElement'),
        documentPictureInPicture: hasPath('documentPictureInPicture'),
        PaymentRequest: hasPath('PaymentRequest'),
        PaymentManager: hasPath('PaymentManager'),
        PublicKeyCredential: hasPath('PublicKeyCredential'),
        PasswordCredential: hasPath('PasswordCredential'),
        FederatedCredential: hasPath('FederatedCredential'),
        IdentityCredential: hasPath('IdentityCredential'),
        EyeDropper: hasPath('EyeDropper'),
        IdleDetector: hasPath('IdleDetector'),
        BarcodeDetector: hasPath('BarcodeDetector'),
        FaceDetector: hasPath('FaceDetector'),
        TextDetector: hasPath('TextDetector'),
        AbsoluteOrientationSensor: hasPath('AbsoluteOrientationSensor'),
        Accelerometer: hasPath('Accelerometer'),
        AmbientLightSensor: hasPath('AmbientLightSensor'),
        GravitySensor: hasPath('GravitySensor'),
        Gyroscope: hasPath('Gyroscope'),
        LinearAccelerationSensor: hasPath('LinearAccelerationSensor'),
        Magnetometer: hasPath('Magnetometer'),
      },
      storageAndFiles: {
        localStorage: hasPath('localStorage'),
        sessionStorage: hasPath('sessionStorage'),
        indexedDB: hasPath('indexedDB'),
        CacheStorage: hasPath('CacheStorage'),
        StorageManager: hasPath('StorageManager'),
        StorageBucket: hasPath('StorageBucket'),
        File: hasPath('File'),
        FileReader: hasPath('FileReader'),
        FileList: hasPath('FileList'),
        Blob: hasPath('Blob'),
        showOpenFilePicker: hasPath('showOpenFilePicker'),
        showSaveFilePicker: hasPath('showSaveFilePicker'),
        showDirectoryPicker: hasPath('showDirectoryPicker'),
        FileSystemHandle: hasPath('FileSystemHandle'),
        FileSystemFileHandle: hasPath('FileSystemFileHandle'),
        FileSystemDirectoryHandle: hasPath('FileSystemDirectoryHandle'),
        FileSystemWritableFileStream: hasPath('FileSystemWritableFileStream'),
        OriginPrivateFileSystem: !!(navigator.storage && navigator.storage.getDirectory),
      },
      workersAndExecution: {
        Worker: hasPath('Worker'),
        SharedWorker: hasPath('SharedWorker'),
        ServiceWorker: hasPath('ServiceWorker'),
        Worklet: hasPath('Worklet'),
        AudioWorklet: hasPath('AudioWorklet'),
        PaintWorklet: !!(window.CSS && CSS.paintWorklet),
        WebAssembly: hasPath('WebAssembly'),
        WebAssemblyCompileStreaming: !!(window.WebAssembly && WebAssembly.compileStreaming),
        WebAssemblyInstantiateStreaming: !!(window.WebAssembly && WebAssembly.instantiateStreaming),
        Atomics: hasPath('Atomics'),
        SharedArrayBuffer: hasPath('SharedArrayBuffer'),
        queueMicrotask: hasPath('queueMicrotask'),
        requestIdleCallback: hasPath('requestIdleCallback'),
        requestAnimationFrame: hasPath('requestAnimationFrame'),
      },
      networkAndStreams: {
        fetch: hasPath('fetch'),
        Request: hasPath('Request'),
        Response: hasPath('Response'),
        Headers: hasPath('Headers'),
        WebSocket: hasPath('WebSocket'),
        EventSource: hasPath('EventSource'),
        WebTransport: hasPath('WebTransport'),
        XMLHttpRequest: hasPath('XMLHttpRequest'),
        URLPattern: hasPath('URLPattern'),
        BroadcastChannel: hasPath('BroadcastChannel'),
        MessageChannel: hasPath('MessageChannel'),
        ReadableStream: hasPath('ReadableStream'),
        WritableStream: hasPath('WritableStream'),
        TransformStream: hasPath('TransformStream'),
        CompressionStream: hasPath('CompressionStream'),
        DecompressionStream: hasPath('DecompressionStream'),
        TextEncoderStream: hasPath('TextEncoderStream'),
        TextDecoderStream: hasPath('TextDecoderStream'),
      },
      mediaAndRealtime: {
        Audio: hasPath('Audio'),
        AudioContext: hasPath('AudioContext') || hasPath('webkitAudioContext'),
        OfflineAudioContext: hasPath('OfflineAudioContext') || hasPath('webkitOfflineAudioContext'),
        MediaCapabilities: hasNavigatorPath('mediaCapabilities'),
        MediaRecorder: hasPath('MediaRecorder'),
        MediaSource: hasPath('MediaSource'),
        ManagedMediaSource: hasPath('ManagedMediaSource'),
        SourceBuffer: hasPath('SourceBuffer'),
        VideoDecoder: hasPath('VideoDecoder'),
        VideoEncoder: hasPath('VideoEncoder'),
        AudioDecoder: hasPath('AudioDecoder'),
        AudioEncoder: hasPath('AudioEncoder'),
        ImageDecoder: hasPath('ImageDecoder'),
        RTCPeerConnection: hasPath('RTCPeerConnection'),
        RTCDataChannel: hasPath('RTCDataChannel'),
        RTCIceCandidate: hasPath('RTCIceCandidate'),
        RTCSessionDescription: hasPath('RTCSessionDescription'),
        MediaStream: hasPath('MediaStream'),
        MediaStreamTrack: hasPath('MediaStreamTrack'),
        ImageCapture: hasPath('ImageCapture'),
        PictureInPictureWindow: hasPath('PictureInPictureWindow'),
        RemotePlayback: hasPath('RemotePlayback'),
        speechSynthesis: hasPath('speechSynthesis'),
        SpeechSynthesisUtterance: hasPath('SpeechSynthesisUtterance'),
        SpeechRecognition: hasPath('SpeechRecognition') || hasPath('webkitSpeechRecognition'),
      },
      graphicsAndRendering: {
        CanvasRenderingContext2D: hasPath('CanvasRenderingContext2D'),
        OffscreenCanvas: hasPath('OffscreenCanvas'),
        ImageBitmap: hasPath('ImageBitmap'),
        createImageBitmap: hasPath('createImageBitmap'),
        WebGLRenderingContext: hasPath('WebGLRenderingContext'),
        WebGL2RenderingContext: hasPath('WebGL2RenderingContext'),
        GPU: hasPath('GPU'),
        CSS: hasPath('CSS'),
        CSSStyleSheet: hasPath('CSSStyleSheet'),
        CSSLayoutValue: hasPath('CSSLayoutValue'),
        CSSNumericValue: hasPath('CSSNumericValue'),
        CSSUnitValue: hasPath('CSSUnitValue'),
        CSSKeywordValue: hasPath('CSSKeywordValue'),
        DOMMatrix: hasPath('DOMMatrix'),
        DOMPoint: hasPath('DOMPoint'),
        Path2D: hasPath('Path2D'),
        ResizeObserver: hasPath('ResizeObserver'),
        IntersectionObserver: hasPath('IntersectionObserver'),
        MutationObserver: hasPath('MutationObserver'),
        PerformanceObserver: hasPath('PerformanceObserver'),
        ReportingObserver: hasPath('ReportingObserver'),
        ViewTransition: hasPath('ViewTransition'),
      },
      htmlAndUi: {
        customElements: hasPath('customElements'),
        ShadowRoot: hasPath('ShadowRoot'),
        HTMLDialogElement: hasPath('HTMLDialogElement'),
        HTMLPortalElement: hasPath('HTMLPortalElement'),
        HTMLElementPopover: 'popover' in HTMLElement.prototype,
        HTMLTemplateElement: hasPath('HTMLTemplateElement'),
        HTMLSlotElement: hasPath('HTMLSlotElement'),
        DragEvent: hasPath('DragEvent'),
        PointerEvent: hasPath('PointerEvent'),
        TouchEvent: hasPath('TouchEvent'),
        InputEvent: hasPath('InputEvent'),
        CompositionEvent: hasPath('CompositionEvent'),
        ClipboardEvent: hasPath('ClipboardEvent'),
        BeforeUnloadEvent: hasPath('BeforeUnloadEvent'),
        DeviceMotionEvent: hasPath('DeviceMotionEvent'),
        DeviceOrientationEvent: hasPath('DeviceOrientationEvent'),
        FullscreenApi: !!(document.documentElement && document.documentElement.requestFullscreen),
      },
      internationalization: {
        Intl: hasPath('Intl'),
        Collator: !!(window.Intl && Intl.Collator),
        DateTimeFormat: !!(window.Intl && Intl.DateTimeFormat),
        DisplayNames: !!(window.Intl && Intl.DisplayNames),
        DurationFormat: !!(window.Intl && Intl.DurationFormat),
        ListFormat: !!(window.Intl && Intl.ListFormat),
        Locale: !!(window.Intl && Intl.Locale),
        NumberFormat: !!(window.Intl && Intl.NumberFormat),
        PluralRules: !!(window.Intl && Intl.PluralRules),
        RelativeTimeFormat: !!(window.Intl && Intl.RelativeTimeFormat),
        Segmenter: !!(window.Intl && Intl.Segmenter),
        supportedValuesOf: !!(window.Intl && Intl.supportedValuesOf),
      },
      privacyAndAttribution: {
        browsingTopics: typeof document.browsingTopics === 'function',
        featurePolicy: hasPath('FeaturePolicy') || !!document.featurePolicy,
        permissionsPolicy: !!document.permissionsPolicy,
        attributionReporting: hasPath('AttributionReporting'),
        fence: hasPath('Fence'),
        SharedStorage: hasPath('SharedStorage'),
        PrivateAggregation: hasPath('PrivateAggregation'),
        ProtectedAudience: hasNavigatorPath('runAdAuction') || hasNavigatorPath('joinAdInterestGroup'),
      },
    };
  }

  function getCssSupport() {
    if (!window.CSS || typeof CSS.supports !== 'function') return {};
    return {
      selectorHas: CSS.supports('selector(:has(*))'),
      containerQueries: CSS.supports('container-type: inline-size'),
      subgrid: CSS.supports('grid-template-rows: subgrid'),
      colorP3: CSS.supports('color: color(display-p3 1 0 0)'),
      oklch: CSS.supports('color: oklch(50% 0.2 180)'),
      backdropFilter: CSS.supports('backdrop-filter: blur(1px)'),
      webkitBackdropFilter: CSS.supports('-webkit-backdrop-filter: blur(1px)'),
      viewTransitionName: CSS.supports('view-transition-name: root'),
      anchorName: CSS.supports('anchor-name: --anchor'),
      textWrapBalance: CSS.supports('text-wrap: balance'),
      dynamicViewportUnit: CSS.supports('height: 100dvh'),
      scrollTimeline: CSS.supports('animation-timeline: scroll()'),
      masonry: CSS.supports('grid-template-rows: masonry'),
      popover: CSS.supports('selector(:popover-open)'),
      fontTechColorColrv1: CSS.supports('font-tech(color-COLRv1)'),
      fontFormatWoff2: CSS.supports('font-format(woff2)'),
    };
  }

  function getMediaQueryMatches() {
    const queries = {
      reducedMotion: '(prefers-reduced-motion: reduce)',
      reducedTransparency: '(prefers-reduced-transparency: reduce)',
      contrastMore: '(prefers-contrast: more)',
      forcedColors: '(forced-colors: active)',
      hover: '(hover: hover)',
      anyHover: '(any-hover: hover)',
      pointerFine: '(pointer: fine)',
      anyPointerFine: '(any-pointer: fine)',
      colorGamutP3: '(color-gamut: p3)',
      colorGamutRec2020: '(color-gamut: rec2020)',
      dynamicRangeHigh: '(dynamic-range: high)',
      displayModeBrowser: '(display-mode: browser)',
      scriptingEnabled: '(scripting: enabled)',
    };
    const output = {};
    for (const [key, query] of Object.entries(queries)) output[key] = matchMedia(query).matches;
    return output;
  }

  function getDocumentPolicyAndSecurity() {
    return {
      referrer: document.referrer,
      domain: document.domain,
      characterSet: document.characterSet,
      contentType: document.contentType,
      compatMode: document.compatMode,
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      origin: location.origin,
      isSecureContext,
      crossOriginIsolated,
      cookieStorePresent: 'cookieStore' in window,
      featurePolicyFeatures: document.featurePolicy && typeof document.featurePolicy.features === 'function'
        ? document.featurePolicy.features().sort()
        : null,
      permissionsPolicyFeatures: document.permissionsPolicy && typeof document.permissionsPolicy.features === 'function'
        ? document.permissionsPolicy.features().sort()
        : null,
      metaCsp: Array.from(document.querySelectorAll('meta[http-equiv]')).map((meta) => ({
        httpEquiv: meta.httpEquiv,
        content: meta.content,
      })),
    };
  }

  function getDocumentDimensions() {
    return {
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      screenX,
      screenY,
      pageXOffset,
      pageYOffset,
      visualViewport: window.visualViewport ? {
        width: visualViewport.width,
        height: visualViewport.height,
        scale: visualViewport.scale,
        offsetLeft: visualViewport.offsetLeft,
        offsetTop: visualViewport.offsetTop,
      } : null,
      documentElement: {
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      body: document.body ? {
        clientWidth: document.body.clientWidth,
        clientHeight: document.body.clientHeight,
        scrollWidth: document.body.scrollWidth,
        scrollHeight: document.body.scrollHeight,
      } : null,
    };
  }

  async function getPermissionStates() {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return null;
    const names = [
      'accelerometer',
      'ambient-light-sensor',
      'background-sync',
      'camera',
      'clipboard-read',
      'clipboard-write',
      'geolocation',
      'gyroscope',
      'magnetometer',
      'microphone',
      'midi',
      'notifications',
      'payment-handler',
      'persistent-storage',
      'push',
      'screen-wake-lock',
      'storage-access',
      'top-level-storage-access',
      'window-management',
    ];
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

  async function getMediaDevices() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return null;
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.map((device) => ({
      kind: device.kind,
      labelPresent: Boolean(device.label),
      deviceIdPresent: Boolean(device.deviceId),
      groupIdPresent: Boolean(device.groupId),
    }));
  }

  async function getSpeechVoices() {
    if (!window.speechSynthesis || typeof speechSynthesis.getVoices !== 'function') return null;
    let voices = speechSynthesis.getVoices();
    if (voices.length === 0) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 500);
        speechSynthesis.onvoiceschanged = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      voices = speechSynthesis.getVoices();
    }
    return voices.map((voice) => ({
      name: voice.name,
      lang: voice.lang,
      voiceURI: voice.voiceURI,
      localService: voice.localService,
      default: voice.default,
    })).sort((left, right) => `${left.lang}:${left.name}`.localeCompare(`${right.lang}:${right.name}`));
  }

  function getSpeechState() {
    return window.speechSynthesis ? {
      present: true,
      pending: speechSynthesis.pending,
      speaking: speechSynthesis.speaking,
      paused: speechSynthesis.paused,
      onvoiceschangedSupported: 'onvoiceschanged' in speechSynthesis,
      SpeechSynthesisUtterance: 'SpeechSynthesisUtterance' in window,
    } : { present: false };
  }

  async function getBatteryStatus() {
    if (typeof navigator.getBattery !== 'function') return null;
    const battery = await navigator.getBattery();
    return {
      charging: battery.charging,
      chargingTime: battery.chargingTime,
      dischargingTime: battery.dischargingTime,
      level: battery.level,
    };
  }

  async function getWebGpuAdapter() {
    if (!navigator.gpu || typeof navigator.gpu.requestAdapter !== 'function') return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false };
    return {
      available: true,
      features: adapter.features ? Array.from(adapter.features).sort() : [],
      limits: adapter.limits ? normalizeValue(adapter.limits) : null,
      info: adapter.info ? normalizeValue(adapter.info) : null,
    };
  }

  function getFontChecks() {
    if (!document.fonts || typeof document.fonts.check !== 'function') return null;
    const fonts = ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'];
    const output = {};
    for (const font of fonts) output[font] = document.fonts.check(`12px "${font}"`);
    return output;
  }

  function getFontMeasurements() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;
    const samples = ['mmmmmmmmmm', 'iiiiiiiiii', 'Comet Chrome Chase 147', '😀😃😄😁', '銀行 Chase १२३'];
    const fonts = ['Arial', 'Calibri', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana', 'serif', 'sans-serif', 'monospace'];
    const output = {};
    for (const font of fonts) {
      output[font] = {};
      for (const sample of samples) {
        context.font = `16px "${font}"`;
        const measurement = context.measureText(sample);
        output[font][sample] = {
          width: Number(measurement.width.toFixed(3)),
          actualBoundingBoxAscent: Number((measurement.actualBoundingBoxAscent || 0).toFixed(3)),
          actualBoundingBoxDescent: Number((measurement.actualBoundingBoxDescent || 0).toFixed(3)),
        };
      }
    }
    return output;
  }

  function getMediaSupport() {
    const video = document.createElement('video');
    const audio = document.createElement('audio');
    const checks = {
      'video/mp4; codecs="avc1.42E01E"': video.canPlayType('video/mp4; codecs="avc1.42E01E"'),
      'video/mp4; codecs="hvc1"': video.canPlayType('video/mp4; codecs="hvc1"'),
      'video/mp4; codecs="av01.0.05M.08"': video.canPlayType('video/mp4; codecs="av01.0.05M.08"'),
      'video/webm; codecs="vp8"': video.canPlayType('video/webm; codecs="vp8"'),
      'video/webm; codecs="vp09.00.10.08"': video.canPlayType('video/webm; codecs="vp09.00.10.08"'),
      'audio/mpeg': audio.canPlayType('audio/mpeg'),
      'audio/mp4; codecs="mp4a.40.2"': audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
      'audio/ogg; codecs="vorbis"': audio.canPlayType('audio/ogg; codecs="vorbis"'),
      'audio/webm; codecs="opus"': audio.canPlayType('audio/webm; codecs="opus"'),
      'audio/wav; codecs="1"': audio.canPlayType('audio/wav; codecs="1"'),
    };
    return checks;
  }

  async function getKeyboardInfo() {
    const info = {
      keyboardPresent: 'keyboard' in navigator,
      getLayoutMapPresent: !!(navigator.keyboard && navigator.keyboard.getLayoutMap),
      lockPresent: !!(navigator.keyboard && navigator.keyboard.lock),
      unlockPresent: !!(navigator.keyboard && navigator.keyboard.unlock),
    };
    if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
      try {
        const layout = await navigator.keyboard.getLayoutMap();
        info.layoutSample = {};
        for (const key of ['KeyA', 'KeyQ', 'KeyW', 'KeyZ', 'Digit1', 'Minus', 'Equal', 'BracketLeft', 'Semicolon', 'Quote']) {
          info.layoutSample[key] = layout.get(key);
        }
      } catch (error) {
        info.layoutError = error.message;
      }
    }
    return info;
  }

  function getGamepadInfo() {
    const gamepads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    return {
      getGamepadsPresent: typeof navigator.getGamepads === 'function',
      count: gamepads.length,
      gamepads: gamepads.map((gamepad) => ({
        id: gamepad.id,
        index: gamepad.index,
        mapping: gamepad.mapping,
        axes: gamepad.axes.length,
        buttons: gamepad.buttons.length,
        connected: gamepad.connected,
      })),
    };
  }

  function getTouchDetails() {
    return {
      maxTouchPoints: navigator.maxTouchPoints,
      ontouchstart: 'ontouchstart' in window,
      TouchEvent: 'TouchEvent' in window,
      PointerEvent: 'PointerEvent' in window,
      MSPointerEvent: 'MSPointerEvent' in window,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
      finePointer: matchMedia('(pointer: fine)').matches,
      anyCoarsePointer: matchMedia('(any-pointer: coarse)').matches,
      anyFinePointer: matchMedia('(any-pointer: fine)').matches,
    };
  }

  function getCredentialPaymentShareCapabilities() {
    const canShareText = navigator.canShare ? navigator.canShare({ text: 'test' }) : false;
    return {
      credentials: 'credentials' in navigator,
      passwordCredential: 'PasswordCredential' in window,
      federatedCredential: 'FederatedCredential' in window,
      publicKeyCredential: 'PublicKeyCredential' in window,
      identityCredential: 'IdentityCredential' in window,
      paymentRequest: 'PaymentRequest' in window,
      paymentManager: 'PaymentManager' in window,
      securePaymentConfirmation: 'SecurePaymentConfirmationAvailability' in window,
      share: typeof navigator.share === 'function',
      canShare: typeof navigator.canShare === 'function',
      canShareText,
    };
  }

  function getLocaleFormatSamples() {
    const date = new Date('2026-05-06T15:30:45Z');
    const number = 1234567.89;
    return {
      dateDefault: new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(date),
      dateEnUs: new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long' }).format(date),
      numberDefault: new Intl.NumberFormat().format(number),
      currencyUsd: new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(number),
      listDefault: new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }).format(['Comet', 'Chrome', 'Chase']),
      pluralOne: new Intl.PluralRules().select(1),
      pluralTwo: new Intl.PluralRules().select(2),
      relativeTime: new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-1, 'day'),
    };
  }

  async function getMediaDecodingInfo() {
    if (!navigator.mediaCapabilities || typeof navigator.mediaCapabilities.decodingInfo !== 'function') return null;
    const configs = {
      h264: {
        type: 'file',
        video: {
          contentType: 'video/mp4; codecs="avc1.42E01E"',
          width: 1920,
          height: 1080,
          bitrate: 5000000,
          framerate: 30,
        },
      },
      vp9: {
        type: 'file',
        video: {
          contentType: 'video/webm; codecs="vp09.00.10.08"',
          width: 1920,
          height: 1080,
          bitrate: 5000000,
          framerate: 30,
        },
      },
      av1: {
        type: 'file',
        video: {
          contentType: 'video/mp4; codecs="av01.0.05M.08"',
          width: 1920,
          height: 1080,
          bitrate: 5000000,
          framerate: 30,
        },
      },
    };
    const results = {};
    for (const [name, config] of Object.entries(configs)) {
      try {
        results[name] = await navigator.mediaCapabilities.decodingInfo(config);
      } catch (error) {
        results[name] = { error: error.message };
      }
    }
    return results;
  }

  function getAudioContextInfo() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    const context = new AudioContextClass();
    const info = {
      sampleRate: context.sampleRate,
      baseLatency: context.baseLatency,
      outputLatency: context.outputLatency,
      state: context.state,
    };
    context.close();
    return info;
  }

  function getRtcConfiguration() {
    if (!window.RTCPeerConnection) return null;
    const peer = new RTCPeerConnection();
    const config = peer.getConfiguration();
    peer.close();
    return {
      bundlePolicy: config.bundlePolicy,
      iceCandidatePoolSize: config.iceCandidatePoolSize,
      iceServersCount: Array.isArray(config.iceServers) ? config.iceServers.length : null,
      iceTransportPolicy: config.iceTransportPolicy,
      rtcpMuxPolicy: config.rtcpMuxPolicy,
    };
  }

  function getPerformanceMemory() {
    return performance.memory ? {
      jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      usedJSHeapSize: performance.memory.usedJSHeapSize,
    } : null;
  }

  function getClientHintsMeta() {
    return {
      userAgentDataPresent: !!navigator.userAgentData,
      globalPrivacyControlPresent: 'globalPrivacyControl' in navigator || navigator.globalPrivacyControl !== undefined,
      doNotTrackPresent: 'doNotTrack' in navigator,
      webdriverPresent: 'webdriver' in navigator,
      platformPresent: 'platform' in navigator,
      deviceMemoryPresent: 'deviceMemory' in navigator,
      connectionPresent: 'connection' in navigator,
      brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
    };
  }

  function getIntlSupportedValues() {
    if (typeof Intl.supportedValuesOf !== 'function') return null;
    const keys = ['calendar', 'collation', 'currency', 'numberingSystem', 'timeZone', 'unit'];
    const output = {};
    for (const key of keys) {
      try {
        const values = Intl.supportedValuesOf(key);
        output[key] = {
          count: values.length,
          sample: values.slice(0, 20),
        };
      } catch (error) {
        output[key] = { error: error.message };
      }
    }
    return output;
  }

  await read('location.href', () => location.href);
  await read('document.title', () => document.title);
  await read('document.readyState', () => document.readyState);
  await read('navigator.userAgent', () => navigator.userAgent);
  await read('navigator.webdriver', () => navigator.webdriver);
  await read('navigator.platform', () => navigator.platform);
  await read('navigator.vendor', () => navigator.vendor);
  await read('navigator.language', () => navigator.language);
  await read('navigator.languages', () => navigator.languages);
  await read('navigator.cookieEnabled', () => navigator.cookieEnabled);
  await read('navigator.hardwareConcurrency', () => navigator.hardwareConcurrency);
  await read('navigator.deviceMemory', () => navigator.deviceMemory);
  await read('navigator.maxTouchPoints', () => navigator.maxTouchPoints);
  await read('navigator.pdfViewerEnabled', () => navigator.pdfViewerEnabled);
  await read('navigator.doNotTrack', () => navigator.doNotTrack);
  await read('navigator.globalPrivacyControl', () => navigator.globalPrivacyControl);
  await read('navigator.connection', () => navigator.connection ? {
    effectiveType: navigator.connection.effectiveType,
    downlink: navigator.connection.downlink,
    rtt: navigator.connection.rtt,
    saveData: navigator.connection.saveData,
  } : null);
  await read('navigator.brave', () => navigator.brave ? Object.keys(navigator.brave).sort() : null);
  await read('navigator.plugins', () => Array.from(navigator.plugins || []).map((plugin) => ({
    name: plugin.name,
    filename: plugin.filename,
    description: plugin.description,
  })));
  await read('navigator.mimeTypes', () => Array.from(navigator.mimeTypes || []).map((mimeType) => ({
    type: mimeType.type,
    suffixes: mimeType.suffixes,
    description: mimeType.description,
  })));
  await read('navigator.userAgentData', () => navigator.userAgentData ? navigator.userAgentData.toJSON() : null);
  await read('navigator.userAgentData.highEntropy', () => navigator.userAgentData
    ? navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'brands', 'fullVersionList', 'mobile', 'model', 'platform', 'platformVersion', 'uaFullVersion', 'wow64'])
    : null);
  await read('navigator.permissions.states', () => getPermissionStates());
  await read('navigator.mediaDevices.enumerateDevices', () => getMediaDevices());
  await read('navigator.storage.estimate', () => navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : null);
  await read('navigator.storage.persisted', () => navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : null);
  await read('screen', () => ({
    width: screen.width,
    height: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    colorDepth: screen.colorDepth,
    pixelDepth: screen.pixelDepth,
    orientation: screen.orientation ? {
      type: screen.orientation.type,
      angle: screen.orientation.angle,
    } : null,
  }));
  await read('window.devicePixelRatio', () => window.devicePixelRatio);
  await read('window.chrome', () => getChromeGlobal());
  await read('window.browserGlobals', () => getBrowserGlobals());
  await read('window.featureSupport', () => getFeatureSupport());
  await read('browser.capabilityMatrix', () => getBrowserCapabilityMatrix());
  await read('window.objectInventories', () => getObjectInventories());
  await read('window.prototypeInventories', () => getPrototypeInventories());
  await read('document.policyAndSecurity', () => getDocumentPolicyAndSecurity());
  await read('document.dimensions', () => getDocumentDimensions());
  await read('css.supports', () => getCssSupport());
  await read('css.mediaQueries', () => getMediaQueryMatches());
  await read('Intl.DateTimeFormat.timeZone', () => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await read('Intl.DateTimeFormat.locale', () => Intl.DateTimeFormat().resolvedOptions().locale);
  await read('Intl.supportedValues', () => getIntlSupportedValues());
  await read('performance.memory', () => getPerformanceMemory());
  await read('permissions.notifications', () => navigator.permissions ? navigator.permissions.query({ name: 'notifications' }).then((result) => result.state) : null);
  await read('mediaCapabilities.decodingInfo', () => getMediaDecodingInfo());
  await read('audioContext.sampleRate', () => getAudioContextInfo());
  await read('webrtc.rtcConfiguration', () => getRtcConfiguration());
  await read('webgpu.adapter', () => getWebGpuAdapter());
  await read('battery.status', () => getBatteryStatus());
  await read('fonts.checks', () => getFontChecks());
  await read('fonts.measurements', () => getFontMeasurements());
  await read('speechSynthesis.voices', () => getSpeechVoices());
  await read('speechSynthesis.state', () => getSpeechState());
  await read('media.support', () => getMediaSupport());
  await read('navigator.keyboard', () => getKeyboardInfo());
  await read('navigator.gamepads', () => getGamepadInfo());
  await read('navigator.maxTouchPoints.detail', () => getTouchDetails());
  await read('credential.payment.shareCapabilities', () => getCredentialPaymentShareCapabilities());
  await read('locale.formatSamples', () => getLocaleFormatSamples());
  await read('headers.clientHintsMeta', () => getClientHintsMeta());
  await read('document.cookie.dfs', () => document.cookie.split(';').map((cookie) => cookie.trim()).filter((cookie) => cookie.startsWith('dfs_')).sort());
  await read('localStorage.keys', () => getStorageKeys(window.localStorage));
  await read('sessionStorage.keys', () => getStorageKeys(window.sessionStorage));
  await read('webgl', () => getWebglInfo());
  await read('webgl2', () => getWebgl2Info());
  await read('canvas.sample', () => getCanvasSample());
  await read('performance.navigation', () => performance.getEntriesByType('navigation').map((entry) => entry.toJSON()));
  await read('performance.chaseResources', () => performance.getEntriesByType('resource')
    .filter((entry) => /chase|akamai|dfs|fingerprint|boomerang|sentry/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    }))
    .slice(0, 200));
  await read('window.probedKeys', () => getWindowProbe());
  await read('window.FingerprintData.getFingerPrint', () => {
    const data = window.FingerprintData;
    if (!data) return null;
    const getter =
      typeof data.getFingerPrint === 'function'
        ? data.getFingerPrint
        : typeof data.getFingerprint === 'function'
          ? data.getFingerprint
          : null;
    return getter ? getter.call(data) : { error: 'FingerprintData getter unavailable' };
  });

  return entries;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
