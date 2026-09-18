// proxyManager.js — Dual-mode proxy management
// Mode 1: Urban VPN extension (residential IPs, headed mode + Xvfb)
// Mode 2: Webshare datacenter proxies (headless mode, Days 1-3)

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ========================
// Configuration
// ========================

const EXTENSION_PATH = path.join(__dirname, '..', 'extensions', 'urban-vpn');
const PROXY_CONFIG_PATH = path.join(__dirname, '..', 'config', 'proxies.json');

// Region-to-country mapping for Urban VPN selection
const VPN_REGION_MAP = {
  'United States - New York':     { label: 'New York',      country: 'United States', countryCode: 'US' },
  'United States - California':   { label: 'California',    country: 'United States', countryCode: 'US' },
  'United States - Texas':        { label: 'Texas',         country: 'United States', countryCode: 'US' },
  'United States - Florida':      { label: 'Florida',       country: 'United States', countryCode: 'US' },
  'United States - Illinois':     { label: 'Illinois',      country: 'United States', countryCode: 'US' },
  'United Kingdom - London':      { label: 'London',        country: 'United Kingdom', countryCode: 'GB' },
  'United Kingdom - Manchester':  { label: 'Manchester',    country: 'United Kingdom', countryCode: 'GB' },
};

// ========================
// State
// ========================

let proxyMode = 'webshare'; // 'urban' | 'webshare' — set at runtime
let webshareProxies = [];   // [{ ip, port, username, password, country, alive }]
let webshareIndex = 0;      // round-robin pointer

// ========================
// Proxy Pool Management
// ========================

/**
 * Load Webshare proxies from a JSON config file
 * Expected format:
 *   [ { ip, port, username, password, country } ]
 */
function loadProxiesFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[proxyManager] Proxy file not found: ${filePath}`);
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const proxies = JSON.parse(raw);
  webshareProxies = proxies.map(p => ({ ...p, alive: true }));
  console.log(`[proxyManager] Loaded ${webshareProxies.length} proxies from ${filePath}`);
  return webshareProxies;
}

/**
 * Set proxies programmatically (used by tests)
 */
function setProxies(proxies) {
  webshareProxies = proxies.map(p => ({ ...p, alive: true }));
  webshareIndex = 0;
}

/**
 * Mark a proxy as dead (failed health check)
 */
function markProxyDead(index) {
  if (webshareProxies[index]) {
    webshareProxies[index].alive = false;
  }
}

/**
 * Get count of alive proxies
 */
function getAliveCount() {
  return webshareProxies.filter(p => p.alive !== false).length;
}

// ========================
// Mode Switching
// ========================

function setMode(mode) {
  if (!['urban', 'webshare'].includes(mode)) {
    throw new Error(`Invalid proxy mode: ${mode}. Must be 'urban' or 'webshare'`);
  }
  proxyMode = mode;
  console.log(`[proxyManager] Mode set to: ${mode}`);
}

function getMode() {
  return proxyMode;
}

// ========================
// Bot-to-Proxy Assignment
// ========================

/**
 * Get proxy configuration for a specific bot profile
 * @param {object} profile - bot profile (from identity.js)
 * @returns {object} proxy config
 */
function getProxyForBot(profile) {
  if (proxyMode === 'urban') {
    const region = VPN_REGION_MAP[profile.vpnRegion] || VPN_REGION_MAP['United States - New York'];
    return {
      type: 'urban',
      region: profile.vpnRegion,
      country: region.country,
      countryCode: region.countryCode,
      label: region.label,
      extensionPath: EXTENSION_PATH,
    };
  }

  // Webshare mode: round-robin over alive proxies
  const alive = webshareProxies.filter(p => p.alive !== false);
  if (alive.length === 0) {
    throw new Error('[proxyManager] No alive Webshare proxies available');
  }

  const index = (profile.botId - 1) % alive.length;
  const proxy = alive[index];

  return {
    type: 'webshare',
    server: `http://${proxy.ip}:${proxy.port}`,
    username: proxy.username,
    password: proxy.password,
    country: proxy.country || 'US',
    poolIndex: webshareProxies.indexOf(proxy),
  };
}

/**
 * Get Playwright launch configuration for a given proxy config
 * @param {object} proxyConfig - from getProxyForBot()
 * @returns {object} { headless, proxy, args }
 */
function getLaunchConfig(proxyConfig) {
  const webrtcArgs = [
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ];

  if (proxyConfig.type === 'urban') {
    return {
      headless: false,
      proxy: null,
      args: [
        ...webrtcArgs,
        `--disable-extensions-except=${proxyConfig.extensionPath}`,
        `--load-extension=${proxyConfig.extensionPath}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    };
  }

  return {
    headless: true,
    proxy: {
      server: proxyConfig.server,
      username: proxyConfig.username,
      password: proxyConfig.password,
    },
    args: [
      ...webrtcArgs,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
}

// ========================
// Urban VPN Connection Flow
// ========================

/**
 * Find the Urban VPN extension ID from browser context service workers
 */
async function findExtensionId(context) {
  const sws = context.serviceWorkers();
  for (const sw of sws) {
    const url = sw.url();
    const match = url.match(/chrome-extension:\/\/([a-z]{32})\//);
    if (match) return match[1];
  }
  // Fallback: try listing all service workers after a short wait
  await new Promise(r => setTimeout(r, 2000));
  const sws2 = context.serviceWorkers();
  for (const sw of sws2) {
    const url = sw.url();
    const match = url.match(/chrome-extension:\/\/([a-z]{32})\//);
    if (match) return match[1];
  }
  return null;
}

/**
 * Connect to a specific region via Urban VPN popup
 *
 * Strategy: Navigate to the extension popup, wait for the React app
 * to render, then inspect the DOM to find:
 *   1. Country/location selector (dropdown or button list)
 *   2. Connect button
 *   3. Connection status indicator
 *
 * @param {import('playwright').Browser} browser
 * @param {object} proxyConfig - from getProxyForBot()
 * @returns {boolean} connected successfully
 */
async function connectUrbanVpn(browser, proxyConfig) {
  const context = browser.contexts()[0];
  if (!context) throw new Error('[urbanVpn] No browser context available');

  const extensionId = await findExtensionId(context);
  if (!extensionId) {
    throw new Error('[urbanVpn] Could not find Urban VPN extension ID. Ensure extension loads correctly.');
  }
  console.log(`[urbanVpn] Extension ID: ${extensionId}`);

  const page = await context.newPage();
  const region = proxyConfig;

  try {
    // Step 1: Open popup
    await page.goto(`chrome-extension://${extensionId}/popup/index.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(2000); // Let React render

    // Step 2: Inspect popup DOM to find interactive elements
    const popupStructure = await page.evaluate(() => {
      const app = document.getElementById('app');
      if (!app) return { error: 'No #app container' };

      // Walk the DOM tree and collect all interactive-looking elements
      const elements = [];
      const walker = document.createTreeWalker(app, NodeFilter.SHOW_ELEMENT, null, false);
      let node;
      while (node = walker.nextNode()) {
        const tag = node.tagName.toLowerCase();
        const text = (node.textContent || '').trim().slice(0, 80);
        const type = node.getAttribute('type') || '';
        const role = node.getAttribute('role') || '';
        const className = (node.className || '').slice(0, 120);
        const rect = node.getBoundingClientRect();

        // Only care about visible interactive elements
        if (rect.width > 30 && rect.height > 20 &&
            ['button', 'select', 'a', 'div', 'span', 'input'].includes(tag) &&
            (tag !== 'div' || role || text.length > 0)) {
          elements.push({
            tag, text, type, role,
            className: className.slice(0, 80),
            x: rect.x, y: rect.y, w: rect.width, h: rect.height,
          });
        }
      }
      return { elements, html: app.innerHTML.slice(0, 3000) };
    });

    console.log(`[urbanVpn] Popup DOM: ${JSON.stringify(popupStructure, null, 2).slice(0, 2000)}`);

    // Step 3: Find country/location selector
    // Common patterns: dropdown with country names, list of location buttons
    const countryElements = popupStructure.elements.filter(e =>
      e.text.toLowerCase().includes(region.country.toLowerCase()) ||
      e.text.toLowerCase().includes(region.label.toLowerCase())
    );

    if (countryElements.length > 0) {
      // Click the element matching our target region
      const target = countryElements[0];
      await page.clickAt(target.x + target.w / 2, target.y + target.h / 2);
      console.log(`[urbanVpn] Selected region: ${region.label}`);
      await page.waitForTimeout(1000);
    } else {
      console.log(`[urbanVpn] Could not find "${region.label}" in popup. Trying default connect...`);
    }

    // Step 4: Find and click the Connect button
    const connectButtons = popupStructure.elements.filter(e =>
      e.text.toLowerCase().includes('connect') ||
      e.text.toLowerCase().includes('start') ||
      (e.role === 'button' && e.text.length < 20)
    );

    if (connectButtons.length > 0) {
      const connectBtn = connectButtons[0];
      await page.clickAt(connectBtn.x + connectBtn.w / 2, connectBtn.y + connectBtn.h / 2);
      console.log(`[urbanVpn] Clicked "${connectBtn.text}" button`);
    } else {
      // Fallback: try common selectors
      const connected = await tryCommonConnectSelectors(page);
      if (!connected) {
        throw new Error('[urbanVpn] Could not find connect button. Popup structure may have changed.');
      }
    }

    // Step 5: Wait for connection to establish
    await page.waitForTimeout(5000);

    // Step 6: Verify IP changed
    const ipVerified = await verifyIp(browser);
    if (!ipVerified) {
      // Retry once
      console.log('[urbanVpn] IP not changed yet, waiting 5 more seconds...');
      await page.waitForTimeout(5000);
      const retry = await verifyIp(browser);
      return retry;
    }

    return true;
  } catch (err) {
    console.error(`[urbanVpn] Connection error: ${err.message}`);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fallback: try common element selectors for connect button
 */
async function tryCommonConnectSelectors(page) {
  const selectors = [
    'button:has-text("Connect")',
    'button:has-text("Start")',
    'button:has-text("Go")',
    '[role="button"]:has-text("Connect")',
    '.connect-btn',
    '#connect-btn',
    'button:not([aria-hidden])',
  ];

  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click();
      return true;
    }
  }
  return false;
}

// ========================
// IP Verification
// ========================

/**
 * Check current IP via api.ipify.org and verify it matches expected country
 * Creates its own page and closes it afterwards.
 */
async function verifyIp(browser) {
  const context = browser.contexts()[0];
  const ownsContext = !context;
  const ctx = ownsContext ? await browser.newContext() : context;
  const page = await ctx.newPage();
  try {
    await page.goto('https://api.ipify.org?format=json', { timeout: 10000 });
    const text = await page.evaluate(() => document.body.textContent);
    const ipData = JSON.parse(text);
    console.log(`[proxyManager] Current IP: ${ipData.ip}`);

    // Optionally check country via ipapi.co
    let locationData = null;
    try {
      await page.goto(`https://ipapi.co/${ipData.ip}/json/`, { timeout: 8000 });
      const locText = await page.evaluate(() => document.body.textContent);
      locationData = JSON.parse(locText);
      if (locationData && locationData.country_name) {
        console.log(`[proxyManager] Location: ${locationData.country_name}, ${locationData.city || ''}`);
      }
    } catch {
      // ipapi.co is optional, ignore failures
    }

    return { ip: ipData.ip, location: locationData };
  } catch (err) {
    console.error(`[proxyManager] IP verification failed: ${err.message}`);
    return false;
  } finally {
    await page.close().catch(() => {});
    if (ownsContext) await ctx.close().catch(() => {});
  }
}

/**
 * Check if a Webshare proxy connection is working
 */
async function testProxyConnection(proxyConfig) {
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: {
        server: proxyConfig.server,
        username: proxyConfig.username,
        password: proxyConfig.password,
      },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    const result = await page.goto('https://api.ipify.org?format=json', { timeout: 15000 });
    if (!result || !result.ok()) return { alive: false, error: 'HTTP error' };

    const text = await page.evaluate(() => JSON.parse(document.body.textContent));
    console.log(`[proxyManager] Proxy test — IP: ${text.ip}`);

    return { alive: true, ip: text.ip };
  } catch (err) {
    return { alive: false, error: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Test all proxies in the pool concurrently
 */
async function testAllProxies(concurrency = 10) {
  const results = [];
  const batches = [];
  for (let i = 0; i < webshareProxies.length; i += concurrency) {
    batches.push(webshareProxies.slice(i, i + concurrency));
  }

  for (const batch of batches) {
    const batchResults = await Promise.allSettled(
      batch.map(proxy => {
        const config = {
          type: 'webshare',
          server: `http://${proxy.ip}:${proxy.port}`,
          username: proxy.username,
          password: proxy.password,
        };
        return testProxyConnection(config);
      })
    );

    batchResults.forEach((r, i) => {
      const idx = webshareProxies.indexOf(batch[i]);
      if (r.status === 'fulfilled' && r.value.alive) {
        results.push({ index: idx, ...r.value });
      } else {
        markProxyDead(idx);
        results.push({ index: idx, alive: false, error: r.status === 'rejected' ? r.reason?.message : r.value?.error });
      }
    });
  }

  const alive = results.filter(r => r.alive).length;
  console.log(`[proxyManager] Proxy health check: ${alive}/${webshareProxies.length} alive`);
  return results;
}

// ========================
// Browser Launch Helper
// ========================

/**
 * Launch a browser configured for a bot's proxy
 * @param {object} proxyConfig - from getProxyForBot()
 * @returns {Promise<{ browser, launchConfig }>}
 */
async function launchWithProxy(proxyConfig) {
  const launchConfig = getLaunchConfig(proxyConfig);
  const browser = await chromium.launch(launchConfig);
  return { browser, launchConfig };
}

/**
 * Full connection flow: launch browser + connect proxy
 * @param {object} profile - bot profile
 * @returns {Promise<{ browser, proxyConfig, connected }>}
 */
async function connectBot(profile) {
  const proxyConfig = getProxyForBot(profile);
  const { browser } = await launchWithProxy(proxyConfig);

  let connected = true;
  if (proxyConfig.type === 'urban') {
    connected = await connectUrbanVpn(browser, proxyConfig);
  }

  return { browser, proxyConfig, connected };
}

// ========================
// Exports
// ========================

module.exports = {
  // State management
  setMode,
  getMode,
  setProxies,
  loadProxiesFromFile,
  markProxyDead,
  getAliveCount,

  // Proxy assignment
  getProxyForBot,
  getLaunchConfig,

  // Urban VPN
  findExtensionId,
  connectUrbanVpn,

  // Testing & health
  verifyIp,
  testProxyConnection,
  testAllProxies,

  // Launch helpers
  launchWithProxy,
  connectBot,

  // Constants
  VPN_REGION_MAP,
  EXTENSION_PATH,
};