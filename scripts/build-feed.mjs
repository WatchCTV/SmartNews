// Build a clean RSS 2.0 feed from scratch (no SmartNews, no vendor namespaces)
// Node 18+ (uses global fetch). Outputs to dist/feed.xml

import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ---------------- CONFIG ---------------- */
const SOURCE_FEED_URL = "http://www.cabletv.com/blog/feed"; // exactly this
const OUTPUT_DIR = new URL("../dist", import.meta.url).pathname || __dirname + "/../dist"; // or your existing resolve()
const OUTPUT = /* path to */ OUTPUT_DIR + "/feed.xml";

// MUST match your live URL, case-sensitive:
const FEED_SELF_URL = "https://CTV-Clearlink.github.io/RSS-Feed/feed.xml";

// Limits
const ITEM_LIMIT = 30;
const CONTENT_MAX_CHARS = 8000;

// Allowed image extensions for <media:thumbnail>
const ALLOWED_IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;
/** ---------------------------------------- */

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const srcXml = await fetchText(SOURCE_FEED_URL);

  // Extract channel-level metadata from the source (fallbacks provided)
  const chTitle = getCdataOrText(getTag(srcXml, "title")) || "CableTV.com";
  const chLink  = text(getTag(srcXml, "link")) || "https://www.cabletv.com/";
  const chDesc  = getCdataOrText(getTag(srcXml, "description")) || "TV Tech and Entertainment";
  const chLang  = text(getTag(srcXml, "language")) || "en-US";

  // Extract items from the source and rebuild them cleanly
  const itemsXml = (srcXml.match(/<item>[\s\S]*?<\/item>/g) || [])
    .slice(0, ITEM_LIMIT)
    .map(rewriteItem)
    .join("\n");

  const lastBuildDate =
    toRfc822(text(getTag(srcXml, "lastBuildDate"))) ||
    toRfc822(extractFirstPubDate(srcXml)) ||
    toRfc822(new Date().toUTCString());

  // Build the whole feed from scratch with only standard namespaces
  const out =
`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:media="http://search.yahoo.com/mrss/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <atom:link href="${FEED_SELF_URL}" rel="self" type="application/rss+xml" />
    <title>${escapeXml(chTitle)}</title>
    <link>${escapeXml(chLink)}</link>
    <description>${escapeXml(chDesc)}</description>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <language>${escapeXml(chLang)}</language>

${itemsXml}

  </channel>
</rss>
`;

  // Guards (won't publish bad vendor tags)
  if (/(xmlns:\s*snf|<snf:|smartnews\.be\/snf)/i.test(out)) {
    throw new Error("SmartNews tags/namespace detected after rewrite.");
  }

  writeFileSync(OUTPUT, out, "utf8");
  console.log("Wrote:", OUTPUT);
}

function rewriteItem(itemXml) {
  // Basic source fields
  const title = cleanTitle(getCdataOrText(getTag(itemXml, "title")));
  const link  = stripUtm(text(getTag(itemXml, "link")));
  const guid  = getCdataOrText(getTag(itemXml, "guid")) || link;
  const pub   = toRfc822(text(getTag(itemXml, "pubDate"))) || toRfc822(new Date().toUTCString());

  // Prefer content:encoded; else description; convert to plain text inside CDATA
  const rawContent = getTag(itemXml, "content:encoded") || getTag(itemXml, "description") || "";
  let body = toPlain(getCdataOrText(rawContent));
  if (body.length > CONTENT_MAX_CHARS) body = body.slice(0, CONTENT_MAX_CHARS).replace(/\s+\S*$/, "") + "…";
  const safeBodyCdata = escapeCdata(body);

  // Author (dc:creator) if present
  const creator = getCdataOrText(getTag(itemXml, "dc:creator")) || "";

  // Categories (carry forward as-is text)
  const cats = Array.from(itemXml.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)).map((m) => {
    const c = getCdataOrText(m[1]);
    return c ? `    <category><![CDATA[${escapeCdata(c)}]]></category>\n` : "";
  }).join("");

  // Thumbnail: accept existing media:* or enclosure from source if it looks like an image URL
  let thumb =
    attr(itemXml, /<media:thumbnail[^>]+url=["']([^"']+)["']/i) ||
    attr(itemXml, /<media:content[^>]+url=["']([^"']+)["']/i) ||
    attr(itemXml, /<enclosure[^>]+url=["']([^"']+)["']/i) || "";

  thumb = sanitizeUrl(thumb);
  const thumbTag = (thumb && ALLOWED_IMG_EXT.test(thumb)) ? `\n    <media:thumbnail url="${escapeAttr(thumb)}" />` : "";

  // Build item
  return (
`    <item>
      <title><![CDATA[${escapeCdata(title)}]]></title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="${/^https?:\/\//i.test(guid) ? "true" : "false"}">${escapeXml(guid)}</guid>
      <pubDate>${pub}</pubDate>
${creator ? `      <dc:creator><![CDATA[${escapeCdata(creator)}]]></dc:creator>\n` : ""}${cats}      <description><![CDATA[${escapeCdata(summaryFrom(body))}]]></description>
      <content:encoded><![CDATA[<p>${safeBodyCdata}</p>]]></content:encoded>${thumbTag}
    </item>`
  );
}

/* ---------------- HELPERS ---------------- */

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "FeedBuilder/1.0 (+https://CTV-Clearlink.github.io)" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

function getTag(xml, tag) {
  const re = new RegExp(`<${escapeReg(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeReg(tag)}\\s*>`, "i");
  const m = xml.match(re);
  return m ? m[1] : "";
}

function attr(xml, re) {
  const m = xml.match(re);
  return m ? m[1] : "";
}

function getCdataOrText(s) {
  if (!s) return "";
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i);
  return (m ? m[1] : s).trim();
}

function text(s) {
  return (s || "").replace(/<[^>]*>/g, "").trim();
}

function cleanTitle(t) {
  return (t || "").replace(/\s{2,}/g, " ").trim();
}

function toPlain(html) {
  if (!html) return "";
  // Preserve some structure → text
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|section|tr)>/gi, "\n\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, ""); // strip remaining tags

  out = decodeEntities(out);
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function summaryFrom(body) {
  // First ~320 chars for <description>
  const max = 320;
  const s = body.split(/\n{2,}/)[0] || body; // first paragraph
  return (s.length > max) ? s.slice(0, max).replace(/\s+\S*$/, "") + "…" : s;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

function escapeXml(s) {
  return (s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}
function escapeAttr(s) { return escapeXml(s); }
function escapeCdata(s) { return (s ?? "").replace(/\]\]>/g, "]]&gt;"); }
function escapeReg(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function stripUtm(u) {
  try {
    const url = new URL(u);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(p => url.searchParams.delete(p));
    return url.toString();
  } catch { return u; }
}

function sanitizeUrl(u) {
  if (!u) return "";
  let s = u.trim().replace(/\s/g, "%20");
  if (!/^https?:\/\//i.test(s)) return "";
  s = s.replace(/^http:\/\//i, "https://");
  try { return new URL(s).toString(); } catch { return ""; }
}

function toRfc822(d) {
  if (!d) return "";
  const date = new Date(d);
  return isNaN(date.getTime()) ? "" : date.toUTCString();
}

function extractFirstPubDate(xml) {
  const m = xml.match(/<pubDate>([^<]+)<\/pubDate>/i);
  return m ? m[1] : "";
}

// MAIN
main().catch((err) => {
  console.error("BUILD FAILED:", err.stack || err.message);
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(
      OUTPUT,
      `<?xml version="1.0" encoding="UTF-8"?><error>${escapeXml(err.stack || err.message)}</error>`,
      "utf8"
    );
    console.log("Wrote diagnostic XML to", OUTPUT);
  } catch {}
  process.exit(1);
});
