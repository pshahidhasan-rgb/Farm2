// Identity profiles for bots — device emulation, VPN region, and persona

const DEVICES = [
  'Samsung Galaxy S24',
  'iPhone 15 Pro',
  'Google Pixel 9',
  'OnePlus 12',
  'Xiaomi 14 Pro',
  'iPhone 14',
  'Samsung Galaxy S23 FE',
  'Google Pixel 8 Pro',
];

const VPN_REGIONS = [
  'United States - New York',
  'United States - California',
  'United States - Texas',
  'United States - Florida',
  'United States - Illinois',
  'United Kingdom - London',
  'United Kingdom - Manchester',
];

const USER_AGENTS = {
  'Samsung Galaxy S24': 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36',
  'iPhone 15 Pro': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Google Pixel 9': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36',
  'OnePlus 12': 'Mozilla/5.0 (Linux; Android 14; CPH2581) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36',
  'Xiaomi 14 Pro': 'Mozilla/5.0 (Linux; Android 14; 23116PN5BC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36',
  'iPhone 14': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Samsung Galaxy S23 FE': 'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36',
  'Google Pixel 8 Pro': 'Mozilla/5.0 (Linux; Android 15; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36',
};

const VIEWPORTS = {
  'Samsung Galaxy S24': { width: 412, height: 915, isMobile: true, hasTouch: true },
  'iPhone 15 Pro': { width: 393, height: 852, isMobile: true, hasTouch: true },
  'Google Pixel 9': { width: 412, height: 915, isMobile: true, hasTouch: true },
  'OnePlus 12': { width: 412, height: 915, isMobile: true, hasTouch: true },
  'Xiaomi 14 Pro': { width: 412, height: 915, isMobile: true, hasTouch: true },
  'iPhone 14': { width: 390, height: 844, isMobile: true, hasTouch: true },
  'Samsung Galaxy S23 FE': { width: 412, height: 915, isMobile: true, hasTouch: true },
  'Google Pixel 8 Pro': { width: 412, height: 915, isMobile: true, hasTouch: true },
};

/**
 * Generate a complete identity profile for a bot
 * @param {number} botId - 1 to 150
 * @returns {object} profile
 */
function generateProfile(botId) {
  const deviceIndex = botId % DEVICES.length;
  const regionIndex = Math.floor(botId / DEVICES.length) % VPN_REGIONS.length;
  const device = DEVICES[deviceIndex];
  
  return {
    botId,
    device,
    userAgent: USER_AGENTS[device],
    viewport: VIEWPORTS[device],
    vpnRegion: VPN_REGIONS[regionIndex],
    seed: `bot-${botId}-${device}-${VPN_REGIONS[regionIndex]}`,
  };
}

/**
 * Generate all 150 profiles
 * @returns {Array<object>}
 */
function generateAllProfiles() {
  const profiles = [];
  for (let i = 1; i <= 150; i++) {
    profiles.push(generateProfile(i));
  }
  return profiles;
}

const TIMEZONE_MAP = {
  'United States - New York': 'America/New_York',
  'United States - California': 'America/Los_Angeles',
  'United States - Texas': 'America/Chicago',
  'United States - Florida': 'America/New_York',
  'United States - Illinois': 'America/Chicago',
  'United Kingdom - London': 'Europe/London',
  'United Kingdom - Manchester': 'Europe/London',
};

const LOCALE_MAP = {
  'United States - New York': 'en-US',
  'United States - California': 'en-US',
  'United States - Texas': 'en-US',
  'United States - Florida': 'en-US',
  'United States - Illinois': 'en-US',
  'United Kingdom - London': 'en-GB',
  'United Kingdom - Manchester': 'en-GB',
};

/**
 * Get Playwright context options for a profile
 */
function getContextOptions(profile) {
  return {
    userAgent: profile.userAgent,
    viewport: profile.viewport,
    isMobile: profile.viewport.isMobile,
    hasTouch: profile.viewport.hasTouch,
    locale: LOCALE_MAP[profile.vpnRegion] || 'en-US',
    timezoneId: TIMEZONE_MAP[profile.vpnRegion] || 'America/New_York',
    permissions: ['geolocation'],
    geolocation: profile.vpnRegion.includes('United Kingdom')
      ? { latitude: 51.5074, longitude: -0.1278 }
      : { latitude: 40.7128, longitude: -74.0060 },
  };
}

module.exports = { generateProfile, generateAllProfiles, getContextOptions, DEVICES, VPN_REGIONS };