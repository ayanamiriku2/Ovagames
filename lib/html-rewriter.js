/**
 * HTML Rewriter Module
 * Rewrites all URLs, canonical tags, structured data, meta tags, etc.
 * to point to the mirror domain instead of the source domain.
 */
const cheerio = require("cheerio");

/**
 * Rewrite all occurrences of source domain to mirror domain in a string
 */
function replaceAllDomains(text, sourceDomain, mirrorDomain, sourceProto, mirrorProto) {
  if (!text) return text;

  const sourceOrigin = `${sourceProto}://${sourceDomain}`;
  const mirrorOrigin = `${mirrorProto}://${mirrorDomain}`;

  // Replace full URLs (https://source -> https://mirror)
  let result = text.split(sourceOrigin).join(mirrorOrigin);

  // Replace protocol-relative URLs (//source -> //mirror)
  result = result.split(`//${sourceDomain}`).join(`//${mirrorDomain}`);

  // Replace escaped URLs commonly found in JSON/inline scripts
  const escapedSource = sourceOrigin.replace(/\//g, "\\/");
  const escapedMirror = mirrorOrigin.replace(/\//g, "\\/");
  result = result.split(escapedSource).join(escapedMirror);

  // Replace double-escaped (\\/) URLs sometimes found in deeply nested JSON
  const doubleEscapedSource = sourceOrigin.replace(/\//g, "\\\\/");
  const doubleEscapedMirror = mirrorOrigin.replace(/\//g, "\\\\/");
  result = result.split(doubleEscapedSource).join(doubleEscapedMirror);
  // Replace http:// variant (mixed content, IE conditional comments)
  if (sourceProto === "https") {
    result = result.split(`http://${sourceDomain}`).join(mirrorOrigin);
  }

  // Replace bare domain references (in JS strings, JSON, etc.)
  // Done last to catch only remaining unreplaced references
  result = result.split(sourceDomain).join(mirrorDomain);
  return result;
}

/**
 * Fix canonical URL - ensure there's exactly one canonical pointing to mirror
 */
function fixCanonical($, mirrorOrigin, requestPath) {
  const canonicalUrl = `${mirrorOrigin}${requestPath}`;

  // Remove all existing canonical links
  $('link[rel="canonical"]').remove();

  // Add single correct canonical
  $("head").append(`<link rel="canonical" href="${canonicalUrl}" />`);
}

/**
 * Fix meta tags (og:url, twitter:url, etc.)
 */
function fixMetaTags($, mirrorOrigin, requestPath) {
  const fullUrl = `${mirrorOrigin}${requestPath}`;

  // Fix Open Graph URL
  $('meta[property="og:url"]').attr("content", fullUrl);

  // Fix Twitter URL
  $('meta[name="twitter:url"]').attr("content", fullUrl);

  // Fix og:image, og:site_name etc - domain replacement
  $('meta[property="og:image"]').each(function () {
    const content = $(this).attr("content");
    if (content) {
      $(this).attr("content", replaceAllDomains(
        content,
        process.env.SOURCE_DOMAIN || "www.ovagames.com",
        process.env.MIRROR_DOMAIN || "localhost",
        process.env.SOURCE_PROTOCOL || "https",
        process.env.MIRROR_PROTOCOL || "https"
      ));
    }
  });
}

/**
 * Fix structured data (JSON-LD) - critical for Google indexing
 */
function fixStructuredData($, sourceDomain, mirrorDomain, sourceProto, mirrorProto) {
  $('script[type="application/ld+json"]').each(function () {
    try {
      let jsonText = $(this).html();
      if (!jsonText || !jsonText.trim()) {
        // Remove empty/invalid structured data blocks
        $(this).remove();
        return;
      }

      // Clean up common issues that make JSON unparseable
      // Remove BOM characters
      jsonText = jsonText.replace(/^\uFEFF/, "");
      // Remove HTML comments that sometimes appear
      jsonText = jsonText.replace(/<!--[\s\S]*?-->/g, "");
      // Trim whitespace
      jsonText = jsonText.trim();

      let data;
      try {
        data = JSON.parse(jsonText);
      } catch {
        // If JSON is invalid, remove the block entirely to avoid
        // "Data terstruktur tidak dapat diurai" error
        $(this).remove();
        return;
      }

      // Recursively fix all URLs in structured data
      data = fixStructuredDataUrls(data, sourceDomain, mirrorDomain, sourceProto, mirrorProto);

      // Fix breadcrumb structured data specifically
      if (data["@type"] === "BreadcrumbList" || data["@type"] === "breadcrumblist") {
        data = fixBreadcrumbData(data, mirrorDomain, mirrorProto);
      }

      // Handle @graph arrays (common in Yoast SEO)
      if (data["@graph"] && Array.isArray(data["@graph"])) {
        data["@graph"] = data["@graph"].map((item) => {
          if (item["@type"] === "BreadcrumbList") {
            return fixBreadcrumbData(item, mirrorDomain, mirrorProto);
          }
          return item;
        });
      }

      $(this).html(JSON.stringify(data));
    } catch {
      // If anything goes wrong, remove the structured data to prevent indexing issues
      $(this).remove();
    }
  });
}

/**
 * Recursively fix URLs in structured data objects
 */
function fixStructuredDataUrls(obj, sourceDomain, mirrorDomain, sourceProto, mirrorProto) {
  if (typeof obj === "string") {
    return replaceAllDomains(obj, sourceDomain, mirrorDomain, sourceProto, mirrorProto);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      fixStructuredDataUrls(item, sourceDomain, mirrorDomain, sourceProto, mirrorProto)
    );
  }
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = fixStructuredDataUrls(value, sourceDomain, mirrorDomain, sourceProto, mirrorProto);
    }
    return result;
  }
  return obj;
}

/**
 * Fix breadcrumb structured data to ensure valid format
 */
function fixBreadcrumbData(data, mirrorDomain, mirrorProto) {
  const mirrorOrigin = `${mirrorProto}://${mirrorDomain}`;

  if (!data.itemListElement || !Array.isArray(data.itemListElement)) {
    return data;
  }

  // Ensure proper @type
  data["@type"] = "BreadcrumbList";

  // Fix each breadcrumb item
  data.itemListElement = data.itemListElement.map((item, index) => {
    // Ensure required fields
    item["@type"] = "ListItem";
    item.position = index + 1;

    // Ensure item has an id or url
    if (item.item) {
      if (typeof item.item === "string") {
        // item is just a URL string - valid format
      } else if (typeof item.item === "object") {
        // Ensure @id is set
        if (!item.item["@id"] && item.item.url) {
          item.item["@id"] = item.item.url;
        }
        if (!item.item["@id"] && !item.item.url) {
          item.item["@id"] = `${mirrorOrigin}/`;
        }
      }
    }

    return item;
  });

  return data;
}

/**
 * Fix all href/src attributes in HTML
 */
function fixLinks($, sourceDomain, mirrorDomain, sourceProto, mirrorProto) {
  const sourceOrigin = `${sourceProto}://${sourceDomain}`;
  const mirrorOrigin = `${mirrorProto}://${mirrorDomain}`;

  // Fix all href attributes
  $("[href]").each(function () {
    const href = $(this).attr("href");
    if (href) {
      $(this).attr("href", replaceAllDomains(href, sourceDomain, mirrorDomain, sourceProto, mirrorProto));
    }
  });

  // Fix all src attributes
  $("[src]").each(function () {
    const src = $(this).attr("src");
    if (src) {
      $(this).attr("src", replaceAllDomains(src, sourceDomain, mirrorDomain, sourceProto, mirrorProto));
    }
  });

  // Fix srcset attributes
  $("[srcset]").each(function () {
    const srcset = $(this).attr("srcset");
    if (srcset) {
      $(this).attr("srcset", replaceAllDomains(srcset, sourceDomain, mirrorDomain, sourceProto, mirrorProto));
    }
  });

  // Fix action attributes (forms)
  $("[action]").each(function () {
    const action = $(this).attr("action");
    if (action) {
      $(this).attr("action", replaceAllDomains(action, sourceDomain, mirrorDomain, sourceProto, mirrorProto));
    }
  });

  // Fix data-* attributes that might contain URLs
  $("[data-src], [data-href], [data-url], [data-image], [data-lazy-src]").each(function () {
    const attrs = ["data-src", "data-href", "data-url", "data-image", "data-lazy-src"];
    for (const attr of attrs) {
      const val = $(this).attr(attr);
      if (val) {
        $(this).attr(attr, replaceAllDomains(val, sourceDomain, mirrorDomain, sourceProto, mirrorProto));
      }
    }
  });

  // Fix poster attribute (video)
  $("[poster]").each(function () {
    const poster = $(this).attr("poster");
    if (poster) {
      $(this).attr("poster", replaceAllDomains(poster, sourceDomain, mirrorDomain, sourceProto, mirrorProto));
    }
  });
}

/**
 * Fix inline styles that may contain URLs
 */
function fixInlineStyles($, sourceDomain, mirrorDomain, sourceProto, mirrorProto) {
  $("[style]").each(function () {
    const style = $(this).attr("style");
    if (style && style.includes(sourceDomain)) {
      $(this).attr("style", replaceAllDomains(style, sourceDomain, mirrorDomain, sourceProto, mirrorProto));
    }
  });

  $("style").each(function () {
    const css = $(this).html();
    if (css && css.includes(sourceDomain)) {
      $(this).html(replaceAllDomains(css, sourceDomain, mirrorDomain, sourceProto, mirrorProto));
    }
  });
}

/**
 * Fix inline scripts that may contain URLs
 */
function fixInlineScripts($, sourceDomain, mirrorDomain, sourceProto, mirrorProto) {
  $("script:not([type='application/ld+json'])").each(function () {
    const content = $(this).html();
    if (content && content.includes(sourceDomain)) {
      $(this).html(replaceAllDomains(content, sourceDomain, mirrorDomain, sourceProto, mirrorProto));
    }
  });
}

/**
 * Remove problematic elements
 */
function cleanupHtml($) {
  // Remove any duplicate canonical tags (keep only our added one)
  const canonicals = $('link[rel="canonical"]');
  if (canonicals.length > 1) {
    canonicals.slice(0, -1).remove(); // Keep only the last one (ours)
  }

  // Remove alternate hreflang tags pointing to source (prevents confusion)
  $('link[rel="alternate"][hreflang]').each(function () {
    const href = $(this).attr("href");
    if (href && href.includes(process.env.SOURCE_DOMAIN || "www.ovagames.com")) {
      $(this).remove();
    }
  });

  // ─── Strip WordPress emoji detection (causes TypeError in console) ─────
  $("script").each(function () {
    const content = $(this).html() || "";
    if (content.includes("_wpemojiSettings") || content.includes("wp-emoji-release")) {
      $(this).remove();
    }
  });
  $('script[src*="wp-emoji-release"]').remove();

  // ─── Inject jQuery .live() polyfill ────────────────────────────────────
  // Divi theme uses .live() which was removed in jQuery 1.9.
  // jQuery Migrate 3.x does NOT restore .live().
  // Must run after jQuery loads but before DOMContentLoaded handlers fire.
  const jqScript = $('script[src*="jquery.min.js"], script[src*="jquery.js"]').first();
  if (jqScript.length) {
    jqScript.after('<script>document.addEventListener("DOMContentLoaded",function(){if(window.jQuery&&!jQuery.fn.live){jQuery.fn.live=function(t,d,f){jQuery(this.selector||this).on(t,d,f);return this;}}},true);</script>');
  }

  // ─── Strip Cloudflare challenge artifacts ─────────────────
  // These cause 502 errors, SyntaxError, and are not needed on the mirror.

  // Remove inline scripts that load CF challenge platform
  $("script").each(function () {
    const content = $(this).html() || "";
    const src = $(this).attr("src") || "";
    if (
      content.includes("cdn-cgi/challenge-platform") ||
      content.includes("__CF$cv$params") ||
      content.includes("_cf_chl_opt") ||
      content.includes("challenge-platform/scripts") ||
      src.includes("cdn-cgi/challenge-platform") ||
      src.includes("challenges.cloudflare.com")
    ) {
      $(this).remove();
      return;
    }
    // Remove scripts that use CF-specific patterns causing SyntaxError/TypeError
    if (
      content.includes("document.createElement('iframe')") &&
      content.includes("visibility:hidden")
    ) {
      $(this).remove();
    }
  });

  // Remove CF-injected hidden iframes
  $('iframe[style*="visibility: hidden"][height="1"]').remove();
  $('iframe[style*="visibility:hidden"][height="1"]').remove();

  // Remove CF noscript blocks
  $("noscript").each(function () {
    const content = $(this).html() || "";
    if (content.includes("challenge") || content.includes("cf-")) {
      $(this).remove();
    }
  });
}

/**
 * Strip remaining Cloudflare challenge artifacts from raw HTML string.
 * Catches anything that survived cheerio parsing (e.g., scripts injected at the end of body).
 */
function stripCfArtifacts(html) {
  // Remove <script> blocks containing CF challenge code
  html = html.replace(
    /<script[^>]*>[\s\S]*?(?:__CF\$cv\$params|cdn-cgi\/challenge-platform|_cf_chl_opt|challenge-platform\/scripts)[\s\S]*?<\/script>/gi,
    ""
  );

  // Remove scripts that create hidden iframes (CF injection pattern)
  html = html.replace(
    /<script[^>]*>[\s\S]*?createElement\s*\(\s*['"]iframe['"]\s*\)[\s\S]*?visibility[\s\S]*?hidden[\s\S]*?<\/script>/gi,
    ""
  );

  // Remove external CF scripts
  html = html.replace(
    /<script[^>]*src="[^"]*(?:cdn-cgi\/challenge-platform|challenges\.cloudflare\.com)[^"]*"[^>]*>[\s\S]*?<\/script>/gi,
    ""
  );

  // Remove CF-injected hidden 1x1 iframes
  html = html.replace(
    /<iframe[^>]*height="1"[^>]*width="1"[^>]*style="[^"]*visibility:\s*hidden[^"]*"[^>]*>[\s\S]*?<\/iframe>/gi,
    ""
  );
  html = html.replace(
    /<iframe[^>]*style="[^"]*visibility:\s*hidden[^"]*"[^>]*height="1"[^>]*>[\s\S]*?<\/iframe>/gi,
    ""
  );

  // Remove wp-emoji inline detection script
  html = html.replace(
    /<script[^>]*>[\s\S]*?_wpemojiSettings[\s\S]*?<\/script>/gi,
    ""
  );

  return html;
}

/**
 * Main HTML rewriting function
 */
function rewriteHtml(html, config) {
  const {
    sourceDomain,
    mirrorDomain,
    sourceProto,
    mirrorProto,
    requestPath,
  } = config;

  const mirrorOrigin = `${mirrorProto}://${mirrorDomain}`;

  const $ = cheerio.load(html, {
    decodeEntities: false,
    xmlMode: false,
  });

  // 1. Fix canonical URL (most important for duplicate content)
  fixCanonical($, mirrorOrigin, requestPath);

  // 2. Fix meta tags
  fixMetaTags($, mirrorOrigin, requestPath);

  // 3. Fix structured data (JSON-LD) - fixes breadcrumb & unparseable issues
  fixStructuredData($, sourceDomain, mirrorDomain, sourceProto, mirrorProto);

  // 4. Fix all links and resource URLs
  fixLinks($, sourceDomain, mirrorDomain, sourceProto, mirrorProto);

  // 5. Fix inline styles
  fixInlineStyles($, sourceDomain, mirrorDomain, sourceProto, mirrorProto);

  // 6. Fix inline scripts
  fixInlineScripts($, sourceDomain, mirrorDomain, sourceProto, mirrorProto);

  // 7. Cleanup
  cleanupHtml($);

  // 8. Final pass: catch remaining domain references (IE conditional comments, etc.)
  let output = $.html();
  output = replaceAllDomains(output, sourceDomain, mirrorDomain, sourceProto, mirrorProto);

  // 9. Strip any remaining CF challenge artifacts from raw HTML
  output = stripCfArtifacts(output);

  return output;
}

module.exports = {
  rewriteHtml,
  replaceAllDomains,
};
