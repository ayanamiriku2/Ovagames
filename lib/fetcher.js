/**
 * Fetcher Module
 *
 * Routes all requests through the persistent Chrome browser
 * to preserve TLS fingerprint that matches cf_clearance.
 *
 * Falls back to native fetch() if browser is not available.
 */

const { browserFetch, isBrowserReady } = require("./cf-solver");

/**
 * Make a request using the browser or native fetch fallback.
 */
async function smartFetch(url, options = {}) {
  if (isBrowserReady()) {
    try {
      return await browserFetch(url, options);
    } catch (err) {
      console.error(`[Fetcher] Browser fetch failed: ${err.message}, trying native fetch`);
    }
  }

  // Fallback to native fetch
  return nativeFetch(url, options);
}

/**
 * Native fetch fallback (without CF bypass)
 */
async function nativeFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "manual",
  });

  const body = Buffer.from(await response.arrayBuffer());
  const responseHeaders = new Map();
  const setCookieHeaders = [];

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      setCookieHeaders.push(value);
    }
    responseHeaders.set(key.toLowerCase(), value);
  });

  if (response.headers.getSetCookie) {
    setCookieHeaders.push(...response.headers.getSetCookie());
  }

  if (setCookieHeaders.length > 0) {
    responseHeaders.set("set-cookie-array", setCookieHeaders);
  }

  return {
    status: response.status,
    headers: responseHeaders,
    body,
    setCookieHeaders,
  };
}

module.exports = {
  smartFetch,
};
