/**
 * SEO Enhancement Module
 * Handles sitemap rewriting, robots.txt generation, redirect fixing,
 * and other SEO-critical functionality.
 */
const { replaceAllDomains } = require("./html-rewriter");

/**
 * Generate/rewrite robots.txt for the mirror domain
 */
function generateRobotsTxt(config) {
  const { mirrorDomain, mirrorProto } = config;
  const mirrorOrigin = `${mirrorProto}://${mirrorDomain}`;

  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${mirrorOrigin}/sitemap.xml`,
    "",
    "# Mirror site - all content allowed for indexing",
    `Host: ${mirrorDomain}`,
  ].join("\n");
}

/**
 * Rewrite sitemap XML - replace source domain with mirror domain
 */
function rewriteSitemap(xml, config) {
  const { sourceDomain, mirrorDomain, sourceProto, mirrorProto } = config;
  return replaceAllDomains(xml, sourceDomain, mirrorDomain, sourceProto, mirrorProto);
}

/**
 * Rewrite RSS/Atom feed
 */
function rewriteFeed(xml, config) {
  const { sourceDomain, mirrorDomain, sourceProto, mirrorProto } = config;
  return replaceAllDomains(xml, sourceDomain, mirrorDomain, sourceProto, mirrorProto);
}

/**
 * Rewrite CSS content
 */
function rewriteCss(css, config) {
  const { sourceDomain, mirrorDomain, sourceProto, mirrorProto } = config;
  return replaceAllDomains(css, sourceDomain, mirrorDomain, sourceProto, mirrorProto);
}

/**
 * Rewrite JavaScript content
 */
function rewriteJs(js, config) {
  const { sourceDomain, mirrorDomain, sourceProto, mirrorProto } = config;
  return replaceAllDomains(js, sourceDomain, mirrorDomain, sourceProto, mirrorProto);
}

/**
 * Fix redirect Location header
 */
function fixRedirectLocation(location, config) {
  if (!location) return location;
  const { sourceDomain, mirrorDomain, sourceProto, mirrorProto } = config;
  return replaceAllDomains(location, sourceDomain, mirrorDomain, sourceProto, mirrorProto);
}

/**
 * Determine content type category from Content-Type header
 */
function getContentCategory(contentType) {
  if (!contentType) return "binary";

  const ct = contentType.toLowerCase();

  if (ct.includes("text/html") || ct.includes("application/xhtml")) return "html";
  if (ct.includes("text/css")) return "css";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "js";
  if (ct.includes("text/xml") || ct.includes("application/xml")) return "xml";
  if (ct.includes("application/rss") || ct.includes("application/atom")) return "feed";
  if (ct.includes("application/json")) return "json";
  if (ct.includes("text/plain")) return "text";

  return "binary";
}

/**
 * Build proper cache headers based on content type
 */
function getCacheHeaders(contentCategory, originalHeaders) {
  const headers = {};

  switch (contentCategory) {
    case "html":
      // Don't cache HTML aggressively - allow revalidation
      headers["Cache-Control"] = "public, max-age=300, s-maxage=600, stale-while-revalidate=86400";
      break;
    case "css":
    case "js":
      // Cache static assets longer
      headers["Cache-Control"] = "public, max-age=86400, s-maxage=604800";
      break;
    case "xml":
    case "feed":
      // Sitemaps and feeds - moderate cache
      headers["Cache-Control"] = "public, max-age=3600, s-maxage=7200";
      break;
    default:
      // Images and other binary assets
      headers["Cache-Control"] = "public, max-age=604800, s-maxage=2592000";
      break;
  }

  return headers;
}

module.exports = {
  generateRobotsTxt,
  rewriteSitemap,
  rewriteFeed,
  rewriteCss,
  rewriteJs,
  fixRedirectLocation,
  getContentCategory,
  getCacheHeaders,
};
