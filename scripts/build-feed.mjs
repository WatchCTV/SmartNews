// scripts/build-feed.mjs — Minimal, validator-friendly sanitizer with hard guards
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SOURCE_FEED_URL = "https://www.cabletv.com/blog/feed"; // you shared this origin URL
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed.xml";

// MUST MATCH EXACTLY (case-sensitive) where this file will be published:
const FEED_SELF_URL = "https://CTV-Clearlink.github.io/RSS-Feed/feed.xml";

const UA = "Mozilla/5.0 (compatible; Feed-Builder/5.0; +https://CTV-Clearlink.github.io)";
const ITEM_LIMIT = 30;
const CONTENT_MAX_CHARS = 8000;

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await fetch(SOURCE_FEED_URL, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml;q=0.9,*/*;q=0.8" },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  let xml = await res.text();

  // 0) Normalize header, strip BOM
  xml = xml.replace(/^\uFEFF/, "").replace(/^\s*<\?xml[^>]*\?>\s*/i, "");
  // 1) Hard-remove SmartNews namespace declarations anywhere
  xml = xml.replace(/\s+xmlns:snf="[^"]*"/gi, "");
  // 2) Hard-remove any element with snf: prefix (both block and self-closing)
  xml = xml.replace(/<snf:[^>]*>[\s\S]*?<\/snf:[^>]*>/gi, "");
  xml = xml.replace(/<snf:[^>]*\/\s*>/gi, "");

  // 3) Rebuild <rss> start tag cleanly (prevents unknown/duplicate namespaces)
  xml = xml.replace(
    /<rss[^>]*>/i,
    '<rss version="2.0" ' +
      'xmlns:media="http://search.yahoo.com/mrss/" ' +
      'xmlns:content="http://purl.org/rss/1.0/modules/content/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:atom="http://www.w3.org/2005/Atom">'
  );

  // 4) Ensure exactly one correct <atom:link rel="self">
  xml = xml.replace(/<atom:link[^>]+rel=["']self["'][^>]*\/>\s*/gi, "");
  xml = xml.replace(/<channel>/i, `<channel>
    <atom:link href="${FEED_SELF_URL}" rel="self" type="application/rss+xml" />`);

  // 5) Limit items (keep most recent N)
  xml = limitItems(xml, ITEM_LIMIT);

  // 6) Sanitize item content (plain text CDATA to avoid HTML parse errors)
  xml = sanitizeItems(xml);

  // 7) Re-add a single XML declaration
  xml = `<?xml version="1.0" encoding="UTF-8"?>\n` + xml.trim() + "\n";

  // 8) GUARDS — fail if anything bad remains
  if (/xmlns:\s*snf\s*=|<snf:/i.test(xml)) {
    throw new Error("Guard failed: SmartNews namespace/elements still present.");
  }
  const selfHref = xml.match(/<atom:link[^>]+rel=["']self["'][^>]+href=["']([^"']+)["']/i)?.[1] || "";
  if (selfHref !== FEED_SELF_URL) {
    throw new Error(`Guard failed: rel=self is "${selfHref}" (expected "${FEED_SELF_URL}")`);
  }

  writeFileSync(OUTPUT, xml, "utf8");
  console.log("Wrote", OUTPUT);
}

function limitItems(xml, n) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (items.length <= n) return xml;
  const header = xml.replace(/<item>[\s\S]*$/s, "");
  const keep = items.slice(0, n).join("\n");
  return header + keep + "\n</channel>\n</rss>";
}

function sanitizeItems(xml) {
  return xml.replace(/<item>[\s\S]*?<\/item>/g, (item) => {
    let out = item;

    // Description → plain text CDATA
    out = replaceBlock(out, "description", (inner) => `<![CDATA[${toPlain(inner)}]]>`);

    // content:encoded → plain text CDATA (wrapped in <p> to keep readers happy)
    out = replaceBlock(out, "content:encoded", (inner) => `<![CDATA[<p>${escapeCdata(toPlain(inner))}</p>]]>`);

    return out;
  });
}

function replaceBlock(xml, tag, replacer) {
  const re = new RegExp(`<${escapeReg(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeReg(tag)}\\s*>`, "i");
  return xml.replace(re, (_m, inner) => `<${tag}>${replacer(inner)}</${tag}>`);
}

function toPlain(s) {
  s = unwrapCdata(s);
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<\/h[1-6]>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, ""); // strip all tags
  s = decodeHtml(s).trim();
  if (s.length > CONTENT_MAX_CHARS) s = s.slice(0, CONTENT_MAX_CHARS).
