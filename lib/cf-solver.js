/**
 * Cloudflare Challenge Solver & Browser Proxy
 *
 * Uses rebrowser-playwright-core + chrome-launcher (botasaurus approach)
 * to solve Cloudflare managed challenges.
 *
 * Navigation strategy:
 * 1. First page.goto() in a fresh Chrome session always passes CF challenge
 * 2. Sub-pages: inject <a> + Playwright.click() (trusted OS-level event)
 *    → Browser sends Sec-Fetch-User: ?1 which CF accepts for user-initiated nav
 * 3. If click-nav gets CF challenged: restart Chrome, navigate fresh to target
 * 4. Assets (CSS/JS/images): fetch() from within the solved page context
 * 5. All responses cached with 30-minute TTL
 *
 * NOT Puppeteer - uses real Chrome via CDP with anti-detection patches.
 * Uses Xvfb virtual display instead of --headless to avoid CF detection.
 */

const { chromium } = require("rebrowser-playwright-core");
const ChromeLauncher = require("chrome-launcher");
const { execSync, spawn } = require("child_process");

// ─── State ───────────────────────────────────────────────────────
let browserInstance = null;
let xvfbInstance = null;
let isStarting = false;
let startPromise = null;
let restartPromise = null; // tracks ongoing _fastRestart

// ─── Content Cache ───────────────────────────────────────────────
const pageCache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CACHE_ENTRIES = 1000;

// Pending asset captures from CDP Network events (shared across browser sessions)
const pendingAssetCaptures = new Map();

function cacheGet(url) {
  const key = url.split("#")[0];
  const entry = pageCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    pageCache.delete(key);
    return null;
  }
  return {
    status: entry.data.status,
    headers: new Map(entry.data.headers),
    body: Buffer.from(entry.data.body),
    setCookieHeaders: [],
  };
}

function cacheSet(url, response) {
  const key = url.split("#")[0];
  if (pageCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = pageCache.keys().next().value;
    pageCache.delete(oldest);
  }
  pageCache.set(key, {
    time: Date.now(),
    data: {
      status: response.status,
      headers: new Map(response.headers),
      body: Buffer.from(response.body),
    },
  });
}

// ─── Xvfb ────────────────────────────────────────────────────────
function startXvfb() {
  const display = `:${99 + Math.floor(Math.random() * 100)}`;
  try {
    execSync("which Xvfb", { stdio: "pipe" });
    const proc = spawn(
      "Xvfb",
      [display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
      { stdio: "ignore", detached: true }
    );
    proc.unref();
    execSync("sleep 1");
    console.log(`[Browser] Xvfb started on ${display}`);
    return { display, process: proc };
  } catch {
    console.log("[Browser] Xvfb not available, using headless mode");
    return null;
  }
}

// ─── Chrome Flags ────────────────────────────────────────────────
const CHROME_FLAGS = [
  "--start-maximized",
  "--remote-allow-origins=*",
  "--no-first-run",
  "--no-service-autorun",
  "--homepage=about:blank",
  "--no-pings",
  "--password-store=basic",
  "--disable-infobars",
  "--disable-breakpad",
  "--disable-dev-shm-usage",
  "--disable-session-crashed-bubble",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-search-engine-choice-screen",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-gpu",
  "--disable-blink-features=AutomationControlled",
  "--window-size=1920,1080",
];

// ─── Browser Lifecycle ───────────────────────────────────────────
async function startBrowser(targetUrl, options = {}) {
  if (browserInstance) return browserInstance;
  if (isStarting && startPromise) {
    await startPromise;
    return browserInstance;
  }
  isStarting = true;
  startPromise = _doStartBrowser(targetUrl, options);
  try {
    await startPromise;
  } finally {
    isStarting = false;
    startPromise = null;
  }
  return browserInstance;
}

async function _doStartBrowser(targetUrl, options = {}) {
  const timeout = options.timeout || 90000;
  console.log("[Browser] Starting Chrome with Xvfb...");

  if (!xvfbInstance) xvfbInstance = startXvfb();
  const flags = [...CHROME_FLAGS];
  if (!xvfbInstance) flags.push("--headless=new");

  const envVars = { ...process.env };
  if (xvfbInstance) envVars.DISPLAY = xvfbInstance.display;

  let chrome, browser;
  try {
    chrome = await ChromeLauncher.launch({
      chromeFlags: flags,
      chromePath: process.env.CHROME_PATH || undefined,
      envVars,
    });
    browser = await chromium.connectOverCDP(`http://localhost:${chrome.port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    try {
      await page.evaluate(() =>
        Object.defineProperty(navigator, "webdriver", { get: () => false })
      );
    } catch {}
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Set up CDP to capture sub-resource responses (CSS/JS/images)
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    pendingAssetCaptures.clear();

    cdp.on("Network.responseReceived", (event) => {
      const { requestId, response } = event;
      if (response.status === 200 || response.status === 304) {
        const ct = (
          response.headers["content-type"] ||
          response.headers["Content-Type"] ||
          response.mimeType ||
          ""
        ).toLowerCase();
        if (!ct.includes("text/html")) {
          pendingAssetCaptures.set(requestId, {
            url: response.url,
            contentType: ct,
          });
        }
      }
    });

    console.log(`[Browser] Navigating to ${targetUrl} to solve CF challenge...`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout });
    try {
      await page.evaluate(() =>
        Object.defineProperty(navigator, "webdriver", { get: () => false })
      );
    } catch {}

    const solved = await waitForChallengeSolved(page, timeout);
    console.log(
      `[Browser] ${solved ? "✅ Challenge solved! Browser ready for proxying." : "⚠ Challenge timeout"}`
    );

    // After challenge solved, wait for all sub-resources to load
    if (solved) {
      try {
        await page.waitForLoadState("load", { timeout: 15000 });
      } catch {}
      await sleep(1000);

      // Harvest all sub-resource response bodies into cache
      const cachedCount = await _harvestCapturedAssets(cdp);
      if (cachedCount > 0) {
        console.log(`[Browser] Cached ${cachedCount} sub-resource assets`);
      }
    }

    browserInstance = { browser, context, page, chrome, cdp };
    return browserInstance;
  } catch (err) {
    try {
      if (browser) await browser.close();
    } catch {}
    try {
      if (chrome) await chrome.kill();
    } catch {}
    throw err;
  }
}

// ─── Challenge Detection ─────────────────────────────────────────
function isChallengeTitleText(title) {
  const t = title.toLowerCase();
  return (
    t.includes("just a moment") ||
    t.includes("attention required") ||
    t.includes("checking your")
  );
}

function isChallengeHtml(html) {
  return html.includes("_cf_chl_opt") || html.includes("challenge-platform");
}

/**
 * Check if HTML content is a CF challenge page by looking at the <title> tag.
 * More reliable than isChallengeHtml which gives false positives on real pages
 * (CF injects scripts on all protected pages).
 */
function isChallengeContent(html) {
  return (
    html.includes("<title>Just a moment") ||
    html.includes("<title>Checking your") ||
    html.includes("<title>Attention Required")
  );
}

async function waitForChallengeSolved(page, timeout) {
  const start = Date.now();
  let lastTitle = "";
  let clearanceFound = false;

  while (Date.now() - start < timeout) {
    try {
      const title = await page.title();
      const url = page.url();

      if (title !== lastTitle) {
        console.log(`[Browser] Page title: "${title}" | URL: ${url}`);
        lastTitle = title;
      }

      const isChallenge = isChallengeTitleText(title) || url.includes("__cf_chl");
      if (title && !isChallenge) {
        await sleep(200);
        return true;
      }

      if (!clearanceFound) {
        const cookies = await page.context().cookies();
        if (cookies.some((c) => c.name === "cf_clearance")) {
          console.log("[Browser] cf_clearance found, waiting for reload...");
          clearanceFound = true;
        }
      }
    } catch {}
    await sleep(500);
  }

  if (clearanceFound) {
    try {
      console.log("[Browser] Forcing reload after cf_clearance...");
      await page.reload({ waitUntil: "load", timeout: 15000 });
      const title = await page.title();
      if (title && !isChallengeTitleText(title)) return true;
    } catch {}
  }
  return false;
}

// ─── Request Queue (pages only) ──────────────────────────────────
let requestQueue = Promise.resolve();
let pageNavInProgress = null; // resolves when current page nav ends

const ASSET_EXTS = new Set([
  "css", "js", "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
  "woff", "woff2", "ttf", "eot", "mp4", "webm", "pdf", "zip", "rar",
]);

/**
 * Fetch a URL through the persistent Chrome browser.
 * Pages are serialized (one at a time). Assets run in parallel.
 */
async function browserFetch(url, options = {}) {
  // Wait for any in-progress restart to finish first
  if (restartPromise) await restartPromise;

  if (!browserInstance) throw new Error("Browser not started. Call startBrowser() first.");

  // 1. Check cache first (fast path)
  const cached = cacheGet(url);
  if (cached) return cached;

  // 2. Route by type
  const ext = getUrlExtension(url);
  if (ASSET_EXTS.has(ext)) {
    // Assets: wait for any ongoing page nav, then fetch in parallel
    if (pageNavInProgress) await pageNavInProgress;
    return _fetchAsset(url);
  }

  // Pages: serialize through queue (only one page nav at a time)
  return new Promise((resolve, reject) => {
    requestQueue = requestQueue
      .then(() => _fetchPageWithLock(url))
      .then(resolve)
      .catch(reject);
  });
}

async function _fetchPageWithLock(url) {
  // Re-check cache (may have been cached while queued)
  const cached = cacheGet(url);
  if (cached) return cached;

  let unlockNav;
  pageNavInProgress = new Promise((r) => { unlockNav = r; });
  try {
    return await _fetchPage(url);
  } finally {
    pageNavInProgress = null;
    unlockNav();
  }
}

// ─── Page Fetching (HTML) ────────────────────────────────────────
async function _fetchPage(url) {
  const { page } = browserInstance;

  // If already on this URL, return current content
  const currentNorm = page.url().split("?")[0].split("#")[0].replace(/\/$/, "");
  const targetNorm = url.split("?")[0].split("#")[0].replace(/\/$/, "");

  if (currentNorm === targetNorm) {
    console.log(`[Browser] Already on ${url}, returning content`);
    const html = await page.content();
    const resp = makeHtmlResp(html, 200);
    cacheSet(url, resp);
    return resp;
  }

  // Only fresh Chrome process passes CF. Do a fast restart (optimized for speed).
  return _fastRestart(url);
}

// ─── Fast Restart (optimized sub-page fetch) ────────────────────
async function _fastRestart(url) {
  const startTime = Date.now();
  console.log(`[Browser] Fast-restart for ${url}...`);

  // Set restartPromise so concurrent requests wait
  let resolveRestart;
  restartPromise = new Promise((r) => { resolveRestart = r; });

  try {
    // Kill Chrome process quickly (keep Xvfb)
    if (browserInstance) {
      const oldChrome = browserInstance.chrome;
      const oldBrowser = browserInstance.browser;
      browserInstance = null;
      try { await oldChrome.kill(); } catch {}
      try { await oldBrowser.close(); } catch {}
    }

    // Launch fresh Chrome directly to target URL
    if (!xvfbInstance) xvfbInstance = startXvfb();
    const flags = [...CHROME_FLAGS];
    if (!xvfbInstance) flags.push("--headless=new");
    const envVars = { ...process.env };
    if (xvfbInstance) envVars.DISPLAY = xvfbInstance.display;

    const chrome = await ChromeLauncher.launch({
      chromeFlags: flags,
      chromePath: process.env.CHROME_PATH || undefined,
      envVars,
    });

    const browser = await chromium.connectOverCDP(`http://localhost:${chrome.port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    try {
      await page.evaluate(() =>
        Object.defineProperty(navigator, "webdriver", { get: () => false })
      );
    } catch {}

    // Set up CDP for asset capture
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    pendingAssetCaptures.clear();

    cdp.on("Network.responseReceived", (event) => {
      const { requestId, response } = event;
      if (response.status === 200 || response.status === 304) {
        const ct = (
          response.headers["content-type"] ||
          response.headers["Content-Type"] ||
          response.mimeType || ""
        ).toLowerCase();
        if (!ct.includes("text/html")) {
          pendingAssetCaptures.set(requestId, { url: response.url, contentType: ct });
        }
      }
    });

    // Navigate — use domcontentloaded (faster than load, we only need HTML)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Quick challenge check — fresh Chrome should pass immediately
    const title = await page.title().catch(() => "");
    if (isChallengeTitleText(title)) {
      const solved = await waitForChallengeSolved(page, 30000);
      if (!solved) {
        console.log("[Browser] ⚠ Even fresh browser got challenged");
        browserInstance = { browser, context, page, chrome, cdp };
        restartPromise = null;
        resolveRestart();
        const html = await page.content();
        return makeHtmlResp(html, 503);
      }
    }

    browserInstance = { browser, context, page, chrome, cdp };
    restartPromise = null;
    resolveRestart();

    // Get HTML immediately
    const html = await page.content();
    const resp = makeHtmlResp(html, 200);
    cacheSet(url, resp);

    const elapsed = Date.now() - startTime;
    console.log(`[Browser] ✅ Fast-restart ${url} (${elapsed}ms)`);

    // Harvest assets in background (non-blocking)
    _backgroundHarvest();

    return resp;
  } catch (err) {
    // Ensure restart promise is resolved even on error
    restartPromise = null;
    resolveRestart();
    throw err;
  }
}

// Harvest assets after page load without blocking the response
function _backgroundHarvest() {
  setTimeout(async () => {
    if (!browserInstance) return;
    try {
      const { page } = browserInstance;
      await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
      const count = await _harvestCapturedAssets(browserInstance.cdp);
      if (count > 0) console.log(`[Browser] Background-cached ${count} assets`);
    } catch {}
  }, 100);
}

// Legacy full restart (used by refreshChallenge fallback)
async function _restartBrowserAndFetch(url) {
  return _fastRestart(url);
}

// ─── Asset Fetching (served from CDP cache populated during page load) ───
async function _fetchAsset(url) {
  if (!browserInstance) throw new Error("Browser not started");

  // Assets should already be cached from CDP capture during page navigation
  const cached = cacheGet(url);
  if (cached) {
    console.log(`[Cache] Asset HIT: ${url}`);
    return cached;
  }

  // Cache miss - try injecting a tag to trigger browser sub-resource load
  // and capture via CDP
  console.log(`[Browser] Asset cache miss, trying injection: ${url}`);
  const { page, cdp } = browserInstance;

  try {
    // Set up a one-shot CDP capture for this specific URL
    const capturePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 10000);
      const handler = async (event) => {
        if (event.response.url !== url) return;
        if (event.response.status !== 200) {
          clearTimeout(timer);
          cdp.off("Network.responseReceived", handler);
          reject(new Error(`HTTP ${event.response.status}`));
          return;
        }
        // Wait for loading to finish, then get body
        const finishHandler = async (finishEvent) => {
          if (finishEvent.requestId !== event.requestId) return;
          cdp.off("Network.loadingFinished", finishHandler);
          clearTimeout(timer);
          try {
            const bodyResult = await cdp.send("Network.getResponseBody", {
              requestId: event.requestId,
            });
            const body = bodyResult.base64Encoded
              ? Buffer.from(bodyResult.body, "base64")
              : Buffer.from(bodyResult.body, "utf-8");
            const ct = (
              event.response.headers["content-type"] ||
              event.response.mimeType ||
              "application/octet-stream"
            ).toLowerCase();
            resolve({ status: 200, contentType: ct, body });
          } catch (err) {
            reject(err);
          }
        };
        cdp.on("Network.loadingFinished", finishHandler);
        cdp.off("Network.responseReceived", handler);
      };
      cdp.on("Network.responseReceived", handler);
    });

    // Inject appropriate tag to trigger sub-resource request
    const ext = getUrlExtension(url);
    if (ext === "css") {
      await page.evaluate((cssUrl) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = cssUrl;
        document.head.appendChild(link);
      }, url);
    } else if (ext === "js") {
      await page.evaluate((jsUrl) => {
        const s = document.createElement("script");
        s.src = jsUrl;
        s.defer = true;
        document.head.appendChild(s);
      }, url);
    } else {
      await page.evaluate((imgUrl) => {
        const img = new Image();
        img.src = imgUrl;
      }, url);
    }

    const result = await capturePromise;
    const resp = {
      status: result.status,
      headers: new Map([["content-type", result.contentType]]),
      body: result.body,
      setCookieHeaders: [],
    };
    cacheSet(url, resp);
    console.log(`[Browser] ✅ Asset captured: ${url} (${result.body.length} bytes)`);
    return resp;
  } catch (err) {
    console.log(`[Browser] Asset fetch failed: ${err.message}`);
    return {
      status: 502,
      headers: new Map([["content-type", "text/plain"]]),
      body: Buffer.from("Asset not available"),
      setCookieHeaders: [],
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────
function makeHtmlResp(html, status) {
  return {
    status,
    headers: new Map([["content-type", "text/html; charset=utf-8"]]),
    body: Buffer.from(html, "utf-8"),
    setCookieHeaders: [],
  };
}

function getUrlExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop() || "";
    const dotIdx = lastSegment.lastIndexOf(".");
    return dotIdx >= 0 ? lastSegment.slice(dotIdx + 1).toLowerCase() : "";
  } catch {
    return "";
  }
}

function isBrowserReady() {
  return browserInstance !== null || restartPromise !== null;
}

async function refreshChallenge(targetUrl) {
  if (!browserInstance) return false;
  try {
    console.log("[Browser] Refreshing CF challenge...");
    const { page } = browserInstance;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    const solved = await waitForChallengeSolved(page, 60000);
    console.log(`[Browser] Refresh: ${solved ? "✅" : "❌"}`);
    return solved;
  } catch (err) {
    console.error("[Browser] Refresh error:", err.message);
    return false;
  }
}

async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.context.close().catch(() => {});
    } catch {}
    try {
      await browserInstance.browser.close().catch(() => {});
    } catch {}
    try {
      await browserInstance.chrome.kill().catch(() => {});
    } catch {}
    browserInstance = null;
  }
  if (xvfbInstance) {
    try {
      xvfbInstance.process.kill("SIGTERM");
    } catch {}
    xvfbInstance = null;
  }
}

/**
 * Harvest pending CDP asset captures into the cache.
 * Called after page navigations to pre-cache sub-resources.
 */
async function _harvestCapturedAssets(cdp) {
  let count = 0;
  const entries = [...pendingAssetCaptures.entries()];
  pendingAssetCaptures.clear();
  for (const [requestId, info] of entries) {
    if (cacheGet(info.url)) continue;
    try {
      const bodyResult = await cdp.send("Network.getResponseBody", { requestId });
      const body = bodyResult.base64Encoded
        ? Buffer.from(bodyResult.body, "base64")
        : Buffer.from(bodyResult.body, "utf-8");
      cacheSet(info.url, {
        status: 200,
        headers: new Map([["content-type", info.contentType]]),
        body,
        setCookieHeaders: [],
      });
      count++;
    } catch {
      // Body may have been evicted from Chrome's cache
    }
  }
  return count;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  startBrowser,
  browserFetch,
  isBrowserReady,
  refreshChallenge,
  closeBrowser,
};
