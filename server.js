/**
 * Ovagames Mirror - Full Reverse Proxy Server
 *
 * Features:
 * - Cloudflare bypass using persistent Chrome browser (rebrowser-playwright-core + chrome-launcher)
 * - All requests routed through Chrome to preserve TLS fingerprint
 * - Xvfb virtual display for non-headless operation
 * - Complete URL rewriting (HTML, CSS, JS, JSON, XML)
 * - Canonical URL management (prevents duplicate content)
 * - Structured data (JSON-LD) fixing (fixes breadcrumb & parse errors)
 * - Proper redirect handling (rewrites Location headers)
 * - Sitemap & robots.txt rewriting
 * - RSS/Atom feed rewriting
 * - Compression support
 * - SEO-optimized caching headers
 *
 * Deploy on: Railway, Render, VPS, Docker, etc.
 */

const express = require("express");
const compression = require("compression");
const { rewriteHtml, replaceAllDomains } = require("./lib/html-rewriter");
const {
  generateRobotsTxt,
  rewriteSitemap,
  rewriteFeed,
  rewriteCss,
  rewriteJs,
  fixRedirectLocation,
  getContentCategory,
  getCacheHeaders,
} = require("./lib/seo");
const { smartFetch } = require("./lib/fetcher");
const {
  startBrowser,
  isBrowserReady,
  refreshChallenge,
  closeBrowser,
} = require("./lib/cf-solver");

// ─── Configuration ───────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const SOURCE_DOMAIN = process.env.SOURCE_DOMAIN || "www.ovagames.com";
const FALLBACK_MIRROR_DOMAIN = process.env.MIRROR_DOMAIN || "ovagames.onl";
const SOURCE_PROTOCOL = process.env.SOURCE_PROTOCOL || "https";
const FALLBACK_MIRROR_PROTOCOL = process.env.MIRROR_PROTOCOL || "https";

const SOURCE_ORIGIN = `${SOURCE_PROTOCOL}://${SOURCE_DOMAIN}`;

// CF session refresh interval (15 minutes)
const CF_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Auto-detect mirror domain & protocol from incoming request headers.
 * Works behind Codespaces, Railway, Render, Nginx, Cloudflare, etc.
 * Falls back to MIRROR_DOMAIN / MIRROR_PROTOCOL env vars.
 */
function getRequestConfig(req) {
  // Detect the real host from the request (supports reverse proxies)
  const host = req.get("x-forwarded-host") || req.get("host") || FALLBACK_MIRROR_DOMAIN;
  // Strip port from host if present (e.g., "localhost:3000" → "localhost")
  const mirrorDomain = host.split(":")[0];

  // Detect protocol (Express sets req.protocol correctly when trust proxy is on)
  const mirrorProto = req.protocol || FALLBACK_MIRROR_PROTOCOL;

  return {
    sourceDomain: SOURCE_DOMAIN,
    mirrorDomain,
    sourceProto: SOURCE_PROTOCOL,
    mirrorProto,
  };
}

// ─── Express App Setup ───────────────────────────────────────────
const app = express();

// Trust proxy (Railway, Render, etc. use reverse proxies)
app.set("trust proxy", true);

// Compression
app.use(compression());

// ─── Custom robots.txt ──────────────────────────────────────────
app.get("/robots.txt", (req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.set("Cache-Control", "public, max-age=3600");
  res.send(generateRobotsTxt(getRequestConfig(req)));
});

// ─── Health check endpoint ──────────────────────────────────────
app.get("/_health", (req, res) => {
  const cfg = getRequestConfig(req);
  res.json({
    status: "ok",
    mirror: cfg.mirrorDomain,
    mirrorProto: cfg.mirrorProto,
    source: SOURCE_DOMAIN,
    browserReady: isBrowserReady(),
  });
});

// ─── Force CF cookie refresh ────────────────────────────────────
app.get("/_refresh-cf", async (_req, res) => {
  try {
    if (isBrowserReady()) {
      const ok = await refreshChallenge();
      res.json({ status: ok ? "ok" : "failed", browserReady: isBrowserReady() });
    } else {
      await startBrowser();
      res.json({ status: "ok", browserReady: isBrowserReady() });
    }
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// ─── Main proxy handler ─────────────────────────────────────────
app.use(async (req, res) => {
  try {
    const config = getRequestConfig(req);
    const MIRROR_ORIGIN = `${config.mirrorProto}://${config.mirrorDomain}`;
    const requestPath = req.originalUrl; // includes query string
    const targetUrl = `${SOURCE_ORIGIN}${requestPath}`;

    // Build headers for the request
    const proxyHeaders = {
      Host: SOURCE_DOMAIN,
      Referer: `${SOURCE_ORIGIN}/`,
    };

    // Forward content-type for POST requests
    if (req.headers["content-type"]) {
      proxyHeaders["Content-Type"] = req.headers["content-type"];
    }

    // Collect request body for non-GET methods
    let body = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      if (chunks.length > 0) {
        body = Buffer.concat(chunks);
      }
    }

    // Fetch through Chrome browser (preserves TLS fingerprint)
    const sourceResponse = await smartFetch(targetUrl, {
      method: req.method,
      headers: proxyHeaders,
      body: body,
    });

    const statusCode = sourceResponse.status;
    const contentType = sourceResponse.headers.get("content-type") || "";

    // ─── Detect CF challenge and auto-solve ─────────────────
    if (statusCode === 403 || statusCode === 503) {
      const bodyText = sourceResponse.body.toString("utf-8");
      // Only detect actual challenge pages (title-based), not CF scripts on real pages
      if (
        bodyText.includes("<title>Just a moment</title>") ||
        bodyText.includes("<title>Checking your") ||
        bodyText.includes("<title>Attention Required")
      ) {
        console.log(`[CF-Detect] Cloudflare challenge on ${req.originalUrl}, retrying...`);

        // Retry through the browser — smartFetch will trigger _fastRestart
        try {
          const retryResponse = await smartFetch(targetUrl, {
            method: req.method,
            headers: proxyHeaders,
            body: body,
          });

          // If retry is also a challenge, don't loop — just serve what we got
          const retryBody = retryResponse.body.toString("utf-8");
          if (
            retryResponse.status === 403 &&
            retryBody.includes("<title>Just a moment</title>")
          ) {
            console.log(`[CF-Detect] Retry also challenged, returning 503`);
            res.status(503).send("Service temporarily unavailable - Cloudflare challenge");
            return;
          }

          return processResponse(req, res, retryResponse, config);
        } catch (err) {
          console.error(`[CF-Detect] Retry failed: ${err.message}`);
          res.status(503).send("Service temporarily unavailable");
          return;
        }
      }
    }

    // ─── Handle Redirects ──────────────────────────────────
    if (statusCode >= 300 && statusCode < 400) {
      let location = sourceResponse.headers.get("location");
      if (location) {
        location = fixRedirectLocation(location, config);

        if (location.startsWith(MIRROR_ORIGIN)) {
          location = location.slice(MIRROR_ORIGIN.length) || "/";
        }

        res.redirect(statusCode, location);
        return;
      }
    }

    // Process the response
    processResponse(req, res, sourceResponse, config);
  } catch (error) {
    console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, error.message);

    res.status(502).json({
      error: "Bad Gateway",
      message: "Unable to fetch content from source",
    });
  }
});

/**
 * Process and rewrite the upstream response
 */
function processResponse(req, res, sourceResponse, config) {
  const statusCode = sourceResponse.status;
  const contentType = sourceResponse.headers.get("content-type") || "";
  const contentCategory = getContentCategory(contentType);

  // ─── Set Response Headers ──────────────────────────────
  const safeHeaders = [
    "content-type",
    "last-modified",
    "etag",
    "content-disposition",
    "vary",
  ];
  for (const header of safeHeaders) {
    const value = sourceResponse.headers.get(header);
    if (value) {
      res.set(header, value);
    }
  }

  // Set cache headers based on content type
  const cacheHeaders = getCacheHeaders(contentCategory);
  for (const [key, value] of Object.entries(cacheHeaders)) {
    res.set(key, value);
  }

  // Security headers
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");

  // Remove problematic headers
  res.removeHeader("content-security-policy");
  res.removeHeader("x-powered-by");

  // ─── Process Response Body ─────────────────────────────
  const responseBuffer = sourceResponse.body;

  // Only rewrite text-based content
  if (contentCategory === "binary") {
    res.status(statusCode).send(responseBuffer);
    return;
  }

  let responseText = responseBuffer.toString("utf-8");

  switch (contentCategory) {
    case "html": {
      responseText = rewriteHtml(responseText, {
        ...config,
        requestPath: req.path,
      });
      break;
    }
    case "css": {
      responseText = rewriteCss(responseText, config);
      break;
    }
    case "js": {
      responseText = rewriteJs(responseText, config);
      break;
    }
    case "xml": {
      responseText = rewriteSitemap(responseText, config);
      break;
    }
    case "feed": {
      responseText = rewriteFeed(responseText, config);
      break;
    }
    case "json": {
      responseText = replaceAllDomains(
        responseText,
        config.sourceDomain,
        config.mirrorDomain,
        config.sourceProto,
        config.mirrorProto
      );
      break;
    }
    case "text": {
      responseText = replaceAllDomains(
        responseText,
        config.sourceDomain,
        config.mirrorDomain,
        config.sourceProto,
        config.mirrorProto
      );
      break;
    }
  }

  res.set("Content-Length", Buffer.byteLength(responseText, "utf-8").toString());
  res.status(statusCode).send(responseText);
}

// ─── Start Server ────────────────────────────────────────────────
async function startServer() {
  // Start browser and solve CF challenge on startup
  console.log("\n[Setup] Starting Chrome browser and solving CF challenge...");
  try {
    await startBrowser();
    console.log(`[Setup] Browser: ${isBrowserReady() ? "✅ ready" : "❌ failed"}`);
    console.log(`[Setup] Fallback mirror: ${FALLBACK_MIRROR_PROTOCOL}://${FALLBACK_MIRROR_DOMAIN} (auto-detected from request headers)`);
  } catch (error) {
    console.error(`[Setup] Browser start failed: ${error.message}`);
    console.log("[Setup] Server will start anyway, will retry when requests come in");
  }

  // Periodic CF session refresh
  setInterval(async () => {
    if (isBrowserReady()) {
      console.log("[CF-Refresh] Refreshing Cloudflare session...");
      try {
        await refreshChallenge();
      } catch (error) {
        console.error("[CF-Refresh] Failed:", error.message);
      }
    }
  }, CF_REFRESH_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[Shutdown] Closing browser...");
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 Mirror proxy server started`);
    console.log(`   Listening on:  http://0.0.0.0:${PORT}`);
    console.log(`   Source:        ${SOURCE_ORIGIN}`);
    console.log(`   Mirror:        auto-detect from request (fallback: ${FALLBACK_MIRROR_PROTOCOL}://${FALLBACK_MIRROR_DOMAIN})`);
    console.log(`   Browser:       ${isBrowserReady() ? "✅" : "⏳ pending"}`);
    console.log("");
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
