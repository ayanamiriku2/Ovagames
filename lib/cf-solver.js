/**
 * Cloudflare Bypass - puppeteer-extra + stealth plugin
 *
 * Strategy:
 * 1. Launch Chrome (non-headless via Xvfb) with stealth plugin
 * 2. Navigate to target site, solve CF challenge ONCE
 * 3. Use in-page fetch() for ALL subsequent requests (inherits cookies/TLS)
 * 4. No Chrome restarts — single persistent instance
 *
 * This replaces the old rebrowser-playwright-core + chrome-launcher approach
 * which was unstable (session closed errors, protocol crashes).
 */

const { addExtra } = require("puppeteer-extra");
const puppeteerCore = require("puppeteer-core");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { execSync, spawn } = require("child_process");

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ─── Config ──────────────────────────────────────────────────────
const SOURCE_DOMAIN = process.env.SOURCE_DOMAIN || "www.ovagames.com";
const SOURCE_PROTOCOL = process.env.SOURCE_PROTOCOL || "https";
const SOURCE_ORIGIN = `${SOURCE_PROTOCOL}://${SOURCE_DOMAIN}`;

// ─── State ───────────────────────────────────────────────────────
let browser = null;
let mainPage = null;
let xvfbProcess = null;
let isStarting = false;
let startPromise = null;
let recovering = false;

// ─── Content Cache ───────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CACHE = 1000;

function cacheGet(url) {
  const key = url.split("#")[0];
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    cache.delete(key);
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
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, {
    time: Date.now(),
    data: {
      status: response.status,
      headers: [...response.headers],
      body: Buffer.from(response.body),
    },
  });
}

// ─── Chrome Path Detection ───────────────────────────────────────
function getChromePath() {
  const paths = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  for (const p of paths) {
    if (p && require("fs").existsSync(p)) return p;
  }
  throw new Error("Chrome not found. Set CHROME_PATH environment variable.");
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

// ─── Browser Lifecycle ───────────────────────────────────────────
async function startBrowser() {
  if (browser && mainPage) return;
  if (isStarting && startPromise) {
    await startPromise;
    return;
  }
  isStarting = true;
  startPromise = _doStart();
  try {
    await startPromise;
  } finally {
    isStarting = false;
    startPromise = null;
  }
}

async function _doStart() {
  console.log("[Setup] Starting Chrome browser and solving CF challenge...");
  console.log("[Browser] Starting Chrome with Xvfb...");

  // Start Xvfb for non-headless mode
  if (!xvfbProcess) {
    const xvfb = startXvfb();
    if (xvfb) {
      xvfbProcess = xvfb.process;
      process.env.DISPLAY = xvfb.display;
    }
  }

  const chromePath = getChromePath();
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-zygote",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--disable-default-apps",
    "--mute-audio",
    "--window-size=1920,1080",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--disable-breakpad",
    "--disable-session-crashed-bubble",
    "--disable-search-engine-choice-screen",
  ];

  // Use headless if no Xvfb
  const headless = xvfbProcess ? false : "new";

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless,
    args,
    ignoreDefaultArgs: ["--enable-automation"],
    defaultViewport: { width: 1920, height: 1080 },
  });

  // Use the default tab
  const pages = await browser.pages();
  mainPage = pages[0] || (await browser.newPage());

  // Extra stealth: override navigator.webdriver
  await mainPage.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  // Navigate to homepage and solve CF
  console.log(`[Browser] Navigating to ${SOURCE_ORIGIN}...`);
  await mainPage.goto(SOURCE_ORIGIN, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const solved = await waitForChallengeSolved(mainPage, 60000);
  if (solved) {
    console.log("[Setup] ✅ Browser ready, CF challenge solved");
    // Wait for full page load to establish all cookies
    try {
      await mainPage.waitForNavigation({ waitUntil: "load", timeout: 10000 }).catch(() => {});
    } catch {}
  } else {
    console.log("[Setup] ⚠ CF challenge timeout, will retry on requests");
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

  while (Date.now() - start < timeout) {
    try {
      const title = await page.title();
      if (title !== lastTitle) {
        console.log(`[Browser] Page title: "${title}"`);
        lastTitle = title;
      }

      if (title && !isChallengeTitleText(title)) {
        await sleep(500);
        // Double-check
        const t2 = await page.title();
        if (t2 && !isChallengeTitleText(t2)) {
          return true;
        }
      }
    } catch {}
    await sleep(500);
  }
  return false;
}

// ─── In-Page Fetch ───────────────────────────────────────────────

/**
 * Fetch a URL through the browser's in-page fetch() API.
 * This inherits all CF cookies and the browser's TLS fingerprint.
 * No Chrome restarts, no CDP protocol crashes.
 */
async function browserFetch(url) {
  // Check cache first
  const cached = cacheGet(url);
  if (cached) return cached;

  if (!browser || !mainPage) {
    throw new Error("Browser not started");
  }

  return _doFetch(url);
}

async function _doFetch(url, isRetry = false) {
  // Re-check cache
  const cached = cacheGet(url);
  if (cached) return cached;

  const startTime = Date.now();

  try {
    const result = await mainPage.evaluate(async (fetchUrl) => {
      try {
        const resp = await fetch(fetchUrl, {
          credentials: "include",
          redirect: "follow",
        });

        const contentType = resp.headers.get("content-type") || "";
        const isText =
          contentType.includes("text") ||
          contentType.includes("json") ||
          contentType.includes("xml") ||
          contentType.includes("javascript") ||
          contentType.includes("css") ||
          contentType.includes("svg");

        let body;
        let binary = false;

        if (isText) {
          body = await resp.text();
        } else {
          // Binary content → base64
          const buf = await resp.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let str = "";
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
            str += String.fromCharCode.apply(null, chunk);
          }
          body = btoa(str);
          binary = true;
        }

        const headers = {};
        resp.headers.forEach((v, k) => {
          headers[k] = v;
        });

        return {
          status: resp.status,
          headers,
          body,
          binary,
          finalUrl: resp.url,
        };
      } catch (e) {
        return { error: e.message };
      }
    }, url);

    if (result.error) {
      console.log(`[Browser] In-page fetch error for ${url}: ${result.error}`);
      if (!isRetry) {
        await _recoverBrowser();
        return _doFetch(url, true);
      }
      return _error502("Fetch failed: " + result.error);
    }

    // Detect redirect (browser followed it, we report to caller)
    const urlNorm = url.replace(/\/$/, "");
    const finalNorm = (result.finalUrl || "").replace(/\/$/, "");
    if (result.finalUrl && finalNorm !== urlNorm) {
      return {
        status: 301,
        headers: new Map([
          ["content-type", result.headers["content-type"] || "text/html"],
          ["location", result.finalUrl],
        ]),
        body: Buffer.from(""),
        setCookieHeaders: [],
      };
    }

    // Detect CF challenge in response body
    if (
      (result.status === 403 || result.status === 503) &&
      typeof result.body === "string" &&
      isChallengeContent(result.body)
    ) {
      console.log(`[Browser] CF challenge in response for ${url}`);
      if (!isRetry) {
        await _recoverBrowser();
        return _doFetch(url, true);
      }
      return _error502("CF challenge not bypassed");
    }

    // Build response object
    const body = result.binary
      ? Buffer.from(result.body, "base64")
      : Buffer.from(result.body || "", "utf-8");

    const headers = new Map();
    for (const [k, v] of Object.entries(result.headers || {})) {
      headers.set(k.toLowerCase(), v);
    }

    const resp = {
      status: result.status,
      headers,
      body,
      setCookieHeaders: [],
    };

    // Cache successful responses
    if (result.status === 200) {
      cacheSet(url, resp);
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[Browser] ✅ Fetched ${url} (${result.status}, ${body.length} bytes, ${elapsed}ms)`
    );
    return resp;
  } catch (err) {
    console.log(`[Browser] Fetch crashed: ${err.message}`);
    if (!isRetry) {
      await _recoverBrowser();
      return _doFetch(url, true);
    }
    return _error502("Browser error: " + err.message);
  }
}

function _error502(msg) {
  return {
    status: 502,
    headers: new Map([["content-type", "text/plain"]]),
    body: Buffer.from(msg),
    setCookieHeaders: [],
  };
}

// ─── Recovery ────────────────────────────────────────────────────
async function _recoverBrowser() {
  if (recovering) return;
  recovering = true;
  console.log("[Browser] Attempting recovery...");
  try {
    // Try navigating back to homepage to re-solve CF
    await mainPage.goto(SOURCE_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const solved = await waitForChallengeSolved(mainPage, 30000);
    if (solved) {
      console.log("[Browser] ✅ Recovery successful");
      recovering = false;
      return;
    }
  } catch (e) {
    console.log(`[Browser] Navigation recovery failed: ${e.message}`);
  }

  // Full restart
  console.log("[Browser] Full browser restart...");
  await closeBrowser();
  try {
    await _doStart();
  } catch (e) {
    console.log(`[Browser] Restart failed: ${e.message}`);
  }
  recovering = false;
}

// ─── Public API ──────────────────────────────────────────────────
function isBrowserReady() {
  return browser !== null && mainPage !== null;
}

async function refreshChallenge() {
  if (!mainPage) return false;
  try {
    console.log("[Browser] Refreshing CF challenge...");
    await mainPage.goto(SOURCE_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const solved = await waitForChallengeSolved(mainPage, 60000);
    console.log(`[Browser] Refresh: ${solved ? "✅" : "❌"}`);
    return solved;
  } catch (err) {
    console.error("[Browser] Refresh error:", err.message);
    return false;
  }
}

async function closeBrowser() {
  try {
    if (browser) await browser.close();
  } catch {}
  try {
    if (xvfbProcess) xvfbProcess.kill("SIGTERM");
  } catch {}
  browser = null;
  mainPage = null;
  xvfbProcess = null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  startBrowser,
  browserFetch,
  isBrowserReady,
  refreshChallenge,
  closeBrowser,
};
