/**
 * Cookie Manager Module
 * Manages cookies from source server to maintain sessions
 * and help with Cloudflare challenge persistence.
 */

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  /**
   * Parse Set-Cookie headers from response and store them
   */
  addFromResponse(response) {
    // fetch() returns headers, getSetCookie() returns all Set-Cookie values
    const setCookieHeaders = response.headers.getSetCookie
      ? response.headers.getSetCookie()
      : [];

    // Fallback: try raw header
    if (setCookieHeaders.length === 0) {
      const raw = response.headers.get("set-cookie");
      if (raw) {
        // Simple split on comma followed by cookie name pattern
        const parts = raw.split(/,(?=\s*[a-zA-Z_][a-zA-Z0-9_]*=)/);
        for (const part of parts) {
          this._parseCookie(part.trim());
        }
        return;
      }
    }

    for (const header of setCookieHeaders) {
      this._parseCookie(header);
    }
  }

  _parseCookie(setCookieStr) {
    if (!setCookieStr) return;

    const parts = setCookieStr.split(";");
    const nameValue = parts[0].trim();
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx === -1) return;

    const name = nameValue.substring(0, eqIdx).trim();
    const value = nameValue.substring(eqIdx + 1).trim();

    if (!name) return;

    // Check for expiry
    let expired = false;
    for (const part of parts.slice(1)) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed.startsWith("max-age=")) {
        const maxAge = parseInt(trimmed.split("=")[1], 10);
        if (maxAge <= 0) expired = true;
      }
      if (trimmed.startsWith("expires=")) {
        const expiresDate = new Date(part.trim().split("=").slice(1).join("="));
        if (expiresDate < new Date()) expired = true;
      }
    }

    if (expired) {
      this.cookies.delete(name);
    } else {
      this.cookies.set(name, value);
    }
  }

  /**
   * Get Cookie header string for requests
   */
  getCookieHeader() {
    if (this.cookies.size === 0) return "";
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  /**
   * Merge with incoming request cookies
   */
  mergeRequestCookies(requestCookieHeader) {
    if (!requestCookieHeader) return;
    const pairs = requestCookieHeader.split(";");
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const name = pair.substring(0, eqIdx).trim();
      const value = pair.substring(eqIdx + 1).trim();
      if (name) {
        this.cookies.set(name, value);
      }
    }
  }
}

module.exports = { CookieJar };
