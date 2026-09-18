// Reactive State Machine Worker v2 — sequential state transitions
// Each ad cycle follows a strict pipeline: trigger → watch → skip → CTA → cleanup → next

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const { getCanvasNoiseScript } = require('./canvasNoise');
const { scanDom } = require('./domSniper');
const { humanClick } = require('./bezierMouse');
const { getContextOptions } = require('./identity');
const { getProxyForBot, getLaunchConfig, connectUrbanVpn, verifyIp, setMode, loadProxiesFromFile } = require('./proxyManager');

const GAME_URL = process.env.GAME_URL || 'https://gifterly.vercel.app';
const PROXY_CONFIG_PATH = require('path').join(__dirname, '..', 'config', 'proxies.json');

// Set proxy mode from env (urban | webshare)
const PROXY_MODE = process.env.PROXY_MODE || 'webshare';
setMode(PROXY_MODE);

// Auto-load Webshare proxies if in webshare mode
if (PROXY_MODE === 'webshare') {
  const loaded = loadProxiesFromFile(PROXY_CONFIG_PATH);
  if (loaded.length === 0) {
    console.log(`[Worker] No proxies loaded. Set PROXY_MODE=urban or place proxies in config/proxies.json`);
  }
}

// ========================
// Pacing Constants
// ========================
const MAX_ADS_PER_HOUR = 6;
const HOURLY_WINDOW_MS = 3600000;
const COOLDOWN_MS = 300000;       // 5 min cooldown after any ad
const MAX_HOURLY_COOLDOWN_MS = 600000; // 10 min forced gameplay after hitting hourly cap
const CTR_PROBABILITY = 0.3;      // 30% chance to click CTA

/**
 * Create a fresh pacing state for a session
 */
function createPacingState() {
  return {
    adsThisHour: 0,
    hourStart: Date.now(),
    lastAdTime: 0,
  };
}

/**
 * Reset hourly counter if window has elapsed
 */
function checkHourlyReset(state) {
  const now = Date.now();
  if (now - state.hourStart > HOURLY_WINDOW_MS) {
    state.adsThisHour = 0;
    state.hourStart = now;
  }
}

/**
 * Wait until a specific selector is visible, or timeout
 */
async function waitForVisible(page, selector, timeoutMs) {
  for (let i = 0; i < timeoutMs / 200; i++) {
    if (page.isClosed()) return false;
    const visible = await page.locator(selector).isVisible({ timeout: 100 }).catch(() => false);
    if (visible) return true;
    await page.waitForTimeout(200).catch(() => {});
  }
  return false;
}

/**
 * Run ONE complete ad cycle:
 * 1. Trigger → 2. Wait for skip → 3. Skip → 4. CTA (30%) → 5. Cleanup
 * @param {Page} page
 * @param {number} botId
 * @param {object} pacing - pacing state (mutated: lastAdTime, adsThisHour)
 * @returns {boolean} true if ad was consumed
 */
async function runAdCycle(page, botId, pacing) {
  // Step 1: Trigger the ad
  await page.goto(GAME_URL, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  if (page.isClosed()) return false;
  await page.waitForTimeout(2000 + Math.random() * 2000).catch(() => {});
  
  const claimBox = await page.locator('#claim-bonus-btn').boundingBox().catch(() => null);
  if (claimBox) {
    // Use page.click for known selectors (works on mobile)
    await page.click('#claim-bonus-btn');
  } else {
    // Fallback
    await page.click('#claim-bonus-btn', { timeout: 2000 }).catch(() => false);
  }
  console.log(`[Bot ${botId}] Ad triggered`);

  // Step 2: Wait for video overlay + skip button (up to 12s)
  const overlayVisible = await waitForVisible(page, '#video-ad-overlay', 5000);
  if (!overlayVisible) {
    console.log(`[Bot ${botId}] Video overlay didn't appear`);
    return false;
  }

  const skipAppeared = await waitForVisible(page, '#skip-ad-btn', 10000);
  if (!skipAppeared || page.isClosed()) {
    console.log(`[Bot ${botId}] Skip button never appeared`);
    return false;
  }
  console.log(`[Bot ${botId}] Skip button appeared`);

  // Step 3: Click skip using known selector
  await page.waitForTimeout(300 + Math.random() * 500).catch(() => {});
  await page.click('#skip-ad-btn', { timeout: 2000 }).catch(() => {
    // Fallback: try DOM coordinates
    const dom = scanDom(page).catch(() => ({ skip: null }));
    if (dom.skip) {
      page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); if (el) el.click(); }, [dom.skip.x, dom.skip.y]);
    }
  });
  console.log(`[Bot ${botId}] Ad skipped`);

  // Step 4: CTA — only 30% chance to click (CTR control)
  await page.waitForTimeout(1000 + Math.random() * 500).catch(() => {});
  const ctaVisible = await waitForVisible(page, '#cta-overlay', 5000);
  
  const shouldClickCta = ctaVisible && !page.isClosed() && Math.random() < CTR_PROBABILITY;

  if (shouldClickCta) {
    console.log(`[Bot ${botId}] CTA appeared → clicking (30% roll)`);
    const ctaBox = await page.locator('#cta-install-btn').boundingBox().catch(() => null);
    if (ctaBox) {
      await page.click('#cta-install-btn');
      await page.waitForTimeout(3000 + Math.random() * 2000).catch(() => {});
    }
  } else if (ctaVisible) {
    console.log(`[Bot ${botId}] CTA appeared → skipping (70% roll)`);
  } else {
    console.log(`[Bot ${botId}] No CTA appeared`);
  }

  // Step 5: Cleanup — close extra tabs, dismiss overlays
  for (const p of page.context().pages()) {
    if (p !== page) {
      await p.close().catch(() => {});
      console.log(`[Bot ${botId}] Closed extra tab`);
    }
  }
  await page.locator('#cta-close-btn').click({ timeout: 1000 }).catch(() => {});

  // Step 6: Navigate back to game
  await page.goto(GAME_URL, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500 + Math.random() * 1000).catch(() => {});

  // Update pacing state
  pacing.lastAdTime = Date.now();
  pacing.adsThisHour++;

  console.log(`[Bot ${botId}] Ad cycle complete`);
  return true;
}

/**
 * Browse game with random actions — runs for at least `minDurationSec` if provided
 */
async function browseGame(page, minDurationSec) {
  const actions = [
    async () => {
      await page.goto(GAME_URL, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
      await page.evaluate(() => window.scrollBy(0, 100 + Math.random() * 200)).catch(() => {});
    },
    async () => {
      await page.goto(GAME_URL + '/trade', { waitUntil: 'load', timeout: 15000 }).catch(() => {});
      await page.locator('button:has-text("BTC")').first().click().catch(() => {});
    },
    async () => {
      await page.goto(GAME_URL + '/portfolio', { waitUntil: 'load', timeout: 15000 }).catch(() => {});
    },
    async () => {
      await page.goto(GAME_URL + '/settings', { waitUntil: 'load', timeout: 15000 }).catch(() => {});
    },
  ];

  const startTime = Date.now();
  const minDurationMs = (minDurationSec || 0) * 1000;

  do {
    if (page.isClosed()) break;
    const action = actions[Math.floor(Math.random() * actions.length)];
    await action();
    if (!page.isClosed()) {
      try { await page.waitForTimeout(2000 + Math.random() * 5000); } catch { break; }
    }
  } while (!page.isClosed() && (Date.now() - startTime) < minDurationMs);

  // Return to game dashboard
  if (!page.isClosed()) {
    await page.goto(GAME_URL, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000).catch(() => {});
  }
}

/**
 * Main session
 */
async function runSession(profile, state) {
  const { botId } = profile;
  console.log(`[Bot ${botId}] Starting session (mode: ${PROXY_MODE})`);

  const proxy = getProxyForBot(profile);
  const launchConfig = getLaunchConfig(proxy);
  console.log(`[Bot ${botId}] Proxy type: ${proxy.type}, country: ${proxy.country}`);

  const browser = await chromium.launch(launchConfig);

  const context = await browser.newContext({ ...getContextOptions(profile) });
  const page = await context.newPage();

  await page.evaluate(() => {
    document.addEventListener('mousemove', e => { window.mouseX = e.screenX; window.mouseY = e.screenY; }, { passive: true });
    window.mouseX = 200; window.mouseY = 400;
  });

  await page.addInitScript(getCanvasNoiseScript(botId));

  // Hide automation flags
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // If Urban VPN mode, connect after browser launch
  if (proxy.type === 'urban') {
    console.log(`[Bot ${botId}] Connecting Urban VPN to ${proxy.label}...`);
    try {
      const connected = await connectUrbanVpn(browser, proxy);
      console.log(`[Bot ${botId}] Urban VPN ${connected ? 'connected' : 'connection failed'}`);
    } catch (err) {
      console.log(`[Bot ${botId}] VPN error: ${err.message} — continuing without VPN`);
    }
  }

  // Pacing state for this session
  const pacing = createPacingState();

  // Use clicksPerSession from orchestrator state, or env, default to 0 for safety
  const maxAds = (state && state.clicksPerSession !== undefined)
    ? state.clicksPerSession
    : parseInt(process.env.MAX_ADS || '0');
  let adsConsumed = 0;

  try {
    await page.goto(GAME_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000 + Math.random() * 2000).catch(() => {});
    console.log(`[Bot ${botId}] Game loaded`);

    // Initial browse
    await browseGame(page);

    // Sequential ad cycles with pacing
    for (let round = 0; round < maxAds; round++) {
      if (page.isClosed()) break;
      if (state && state.adsToday >= (state.dailyCap || 20)) break;

      // Hourly cap: max 6 ads per hour
      checkHourlyReset(pacing);
      if (pacing.adsThisHour >= MAX_ADS_PER_HOUR) {
        const forcedWaitSec = MAX_HOURLY_COOLDOWN_MS / 1000;
        console.log(`[Bot ${botId}] Hourly cap (${MAX_ADS_PER_HOUR}) reached. Playing ${forcedWaitSec}s organically...`);
        await browseGame(page, forcedWaitSec);
        pacing.adsThisHour = 0;
        pacing.hourStart = Date.now();
        // Re-check daily cap after long break
        if (state && state.adsToday >= (state.dailyCap || 20)) break;
      }

      // Cooldown: 5 min minimum between ads
      const elapsedSinceLastAd = Date.now() - pacing.lastAdTime;
      if (pacing.lastAdTime > 0 && elapsedSinceLastAd < COOLDOWN_MS) {
        const remainingSec = Math.ceil((COOLDOWN_MS - elapsedSinceLastAd) / 1000);
        console.log(`[Bot ${botId}] Cooldown: playing ${remainingSec}s before next ad...`);
        await browseGame(page, remainingSec);
      }

      console.log(`[Bot ${botId}] --- Ad cycle ${round + 1}/${maxAds} ---`);
      const consumed = await runAdCycle(page, botId, pacing);
      if (consumed) adsConsumed++;

      // Browse between cycles (cooldown starts automatically from pacing.lastAdTime)
      if (round < maxAds - 1 && !page.isClosed()) {
        await browseGame(page);
      }
    }

    console.log(`[Bot ${botId}] Session complete — ${adsConsumed}/${maxAds} ads`);
  } catch (err) {
    console.log(`[Bot ${botId}] Error: ${err.message}`);
  } finally {
    if (state) state.adsToday += adsConsumed;
    try { await page.waitForTimeout(300).catch(() => {}); } catch {}
    await browser.close().catch(() => {});
  }
}

module.exports = { runSession };