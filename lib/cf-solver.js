/**
 * Cloudflare Bypass - puppeteer-extra + stealth plugin
 *
 * Strategy:
 * 1. Launch Chrome (non-headless via Xvfb) with stealth plugin
 * 2. Navigate to target site, solve CF challenge ONCE
 * 3. HTML pages: in-page fetch() (inherits cookies/TLS fingerprint)
 * 4. Assets (CSS/JS/images): native Node.js fetch with stolen CF cookies
 *    → fast, no Chrome memory pressure, correct MIME types
 *    → falls back to in-page fetch if CF-challenged
 * 5. Single persistent Chrome instance — no restarts
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

// Stolen from browser after CF solve
let cfCookieString = "";
let browserUserAgent = "";

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

// ─── MIME type inference from URL ─────────────────────────────────
const MIME_MAP = {
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  zip: "application/zip",
  rar: "application/x-rar-compressed",
};

const ASSET_EXTS = new Set(Object.keys(MIME_MAP));

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

function getMimeType(url) {
  // Handle PHP-generated assets (e.g. css.php?styles=...)
  if (url.includes("css.php")) return "text/css";
  if (url.includes("js.php")) return "application/javascript";
  const ext = getUrlExtension(url);
  return MIME_MAP[ext] || null;
}

function isAssetUrl(url) {
  if (url.includes("css.php") || url.includes("js.php")) return true;
  return ASSET_EXTS.has(getUrlExtension(url));
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

// ─── Cookie Extraction ───────────────────────────────────────────
async function _extractCookiesAndUA() {
  if (!mainPage) return;
  try {
    const cookies = await mainPage.cookies();
    cfCookieString = cookies
      .filter((c) => c.domain.includes(SOURCE_DOMAIN.replace("www.", "")))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    browserUserAgent = await mainPage.evaluate(() => navigator.userAgent);
    console.log(
      `[Browser] Extracted ${cookies.length} cookies, UA: ${browserUserAgent.slice(0, 50)}...`
    );
  } catch (e) {
    console.log(`[Browser] Cookie extraction failed: ${e.message}`);
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

  const headless = xvfbProcess ? false : "new";

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless,
    args,
    ignoreDefaultArgs: ["--enable-automation"],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const pages = await browser.pages();
  mainPage = pages[0] || (await browser.newPage());

  await mainPage.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  console.log(`[Browser] Navigating to ${SOURCE_ORIGIN}...`);
  await mainPage.goto(SOURCE_ORIGIN, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const solved = await waitForChallengeSolved(mainPage, 60000);
  if (solved) {
    console.log("[Setup] ✅ Browser ready, CF challenge solved");
    try {
      await mainPage
        .waitForNavigation({ waitUntil: "load", timeout: 10000 })
        .catch(() => {});
    } catch {}
    // Extract cookies and UA for native asset fetching
    await _extractCookiesAndUA();
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

// ─── Native Asset Fetch (uses stolen CF cookies) ─────────────────

/**
 * Fetch an asset using native Node.js fetch with CF cookies from browser.
 * This avoids page.evaluate and handles concurrency gracefully.
 * Falls back to in-page fetch if CF challenges the request.
 */
async function _nativeAssetFetch(url) {
  const headers = {
    "User-Agent": browserUserAgent || "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: SOURCE_ORIGIN + "/",
    Origin: SOURCE_ORIGIN,
  };

  if (cfCookieString) {
    headers.Cookie = cfCookieString;
  }

  try {
    const response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    const body = Buffer.from(await response.arrayBuffer());
    const ct = response.headers.get("content-type") || "";

    // Check for CF challenge
    if (
      (response.status === 403 || response.status === 503) &&
      body.length < 100000
    ) {
      const text = body.toString("utf-8");
      if (isChallengeContent(text)) {
        console.log(`[Native] CF challenge for ${url}, falling back to browser`);
        return null; // Signal to use browser fetch
      }
    }

    // Fix MIME type: ensure CSS/JS have correct content-type
    let contentType = ct;
    const inferredMime = getMimeType(url);
    if (
      inferredMime &&
      (ct.includes("text/html") || ct.includes("text/plain") || !ct)
    ) {
      contentType = inferredMime;
    }

    const responseHeaders = new Map();
    response.headers.forEach((value, key) => {
      responseHeaders.set(key.toLowerCase(), value);
    });
    // Override with correct content-type
    if (contentType !== ct) {
      responseHeaders.set("content-type", contentType);
    }

    const resp = {
      status: response.status,
      headers: responseHeaders,
      body,
      setCookieHeaders: [],
    };

    if (response.status === 200) {
      cacheSet(url, resp);
    }

    console.log(
      `[Native] ✅ ${url.split("/").pop().split("?")[0]} (${response.status}, ${body.length}b)`
    );
    return resp;
  } catch (err) {
    console.log(`[Native] Fetch error for ${url}: ${err.message}`);
    return null; // Fall back to browser
  }
}

// ─── In-Page Browser Fetch (for HTML / fallback) ─────────────────

// Semaphore to limit concurrent page.evaluate calls
let activeEvaluates = 0;
const MAX_CONCURRENT_EVALUATES = 3;
const evaluateQueue = [];

function _acquireEvaluateSlot() {
  return new Promise((resolve) => {
    if (activeEvaluates < MAX_CONCURRENT_EVALUATES) {
      activeEvaluates++;
      resolve();
    } else {
      evaluateQueue.push(resolve);
    }
  });
}

function _releaseEvaluateSlot() {
  activeEvaluates--;
  if (evaluateQueue.length > 0) {
    activeEvaluates++;
    evaluateQueue.shift()();
  }
}

async function _browserPageFetch(url, isRetry = false) {
  if (!browser || !mainPage) {
    throw new Error("Browser not started");
  }

  await _acquireEvaluateSlot();
  try {
    return await _doBrowserFetch(url, isRetry);
  } finally {
    _releaseEvaluateSlot();
  }
}

async function _doBrowserFetch(url, isRetry = false) {
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
        return _doBrowserFetch(url, true);
      }
      return _errorResp(url, 502, "Fetch failed");
    }

    // Detect redirect
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

    // Detect CF challenge in response
    if (
      (result.status === 403 || result.status === 503) &&
      typeof result.body === "string" &&
      isChallengeContent(result.body)
    ) {
      console.log(`[Browser] CF challenge in response for ${url}`);
      if (!isRetry) {
        await _recoverBrowser();
        return _doBrowserFetch(url, true);
      }
      return _errorResp(url, 502, "CF challenge not bypassed");
    }

    // Build response
    const body = result.binary
      ? Buffer.from(result.body, "base64")
      : Buffer.from(result.body || "", "utf-8");

    const headers = new Map();
    for (const [k, v] of Object.entries(result.headers || {})) {
      headers.set(k.toLowerCase(), v);
    }

    // Fix MIME type if needed
    const ct = headers.get("content-type") || "";
    const inferredMime = getMimeType(url);
    if (
      inferredMime &&
      (ct.includes("text/html") || ct.includes("text/plain") || !ct)
    ) {
      headers.set("content-type", inferredMime);
    }

    const resp = {
      status: result.status,
      headers,
      body,
      setCookieHeaders: [],
    };

    if (result.status === 200) {
      cacheSet(url, resp);
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[Browser] ✅ Fetched ${url} (${result.status}, ${body.length}b, ${elapsed}ms)`
    );
    return resp;
  } catch (err) {
    console.log(`[Browser] Fetch crashed: ${err.message}`);
    if (!isRetry) {
      await _recoverBrowser();
      return _doBrowserFetch(url, true);
    }
    return _errorResp(url, 502, err.message);
  }
}

function _errorResp(url, status, msg) {
  // Use correct MIME type even for errors, so browser doesn't reject
  const mime = getMimeType(url) || "text/plain";
  return {
    status,
    headers: new Map([["content-type", mime]]),
    body: Buffer.from(mime.includes("javascript") ? "/* error */" : mime.includes("css") ? "/* error */" : msg),
    setCookieHeaders: [],
  };
}

// ─── Main Entry Point ────────────────────────────────────────────

/**
 * Fetch a URL through Chrome browser.
 * - Assets (CSS/JS/images): native fetch with CF cookies (fast, no Chrome pressure)
 * - HTML pages: in-page browser fetch (full CF bypass)
 */
async function browserFetch(url) {
  const cached = cacheGet(url);
  if (cached) return cached;

  if (!browser || !mainPage) {
    throw new Error("Browser not started");
  }

  // Route: assets via native fetch, HTML via browser
  if (isAssetUrl(url)) {
    // Try native fetch first (fast, doesn't pressure Chrome)
    const nativeResult = await _nativeAssetFetch(url);
    if (nativeResult) return nativeResult;
    // Native failed (CF challenge) → fall back to browser with concurrency limit
    console.log(`[Browser] Asset fallback to browser: ${url}`);
    return _browserPageFetch(url);
  }

  // HTML pages go through browser evaluate
  return _browserPageFetch(url);
}

// ─── Recovery ────────────────────────────────────────────────────
async function _recoverBrowser() {
  if (recovering) return;
  recovering = true;
  console.log("[Browser] Attempting recovery...");
  try {
    await mainPage.goto(SOURCE_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const solved = await waitForChallengeSolved(mainPage, 30000);
    if (solved) {
      await _extractCookiesAndUA();
      console.log("[Browser] ✅ Recovery successful");
      recovering = false;
      return;
    }
  } catch (e) {
    console.log(`[Browser] Navigation recovery failed: ${e.message}`);
  }

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
    if (solved) {
      await _extractCookiesAndUA();
    }
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
