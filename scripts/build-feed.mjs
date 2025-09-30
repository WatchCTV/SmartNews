// scripts/build-feed.mjs — Generic, validator-friendly RSS (aggressive namespace & HTML sanitizing)
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ---------------- CONFIG ---------------- */
const SOURCE_FEED_URL = "https://www.cabletv.com/feed";
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed.xml";

// MUST match the published URL exactly (case-sensitive!):
const FEED_SELF_URL = "https://ctv-clearlink.github.io/RSS-Feed/feed.xml";

const UA = "Mozilla/5.0 (compatible; Feed-Builder/4.1; +https://ctv-clearlink.github.io)";

// Emit plain text in description/content:encoded to avoid HTML validator errors
const FORCE_NO_LINKS = true;

// Limits to keep feed small and validators happy
const ITEM_LIMIT = 30;           // newest N items
const CONTENT_MAX_CHARS = 8000;  // per-item text cap

// Thumbnails
const ALLOWED_IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;
const DEFAULT_THUMB_URL = "https://i.ibb.co/V0FWL4m9/CTV-Logo.png";

// Allowed namespaces we keep
const ALLOWED_NS_PREFIXES = ["media","content","dc","atom"];
/** ---------------------------------------- */

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await fetch(SOURCE_FEED_URL, {
    headers: { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8", "User-Agent": UA }
  });
  if (!res.ok) throw new Error(`Fetch ${SOURCE_FEED_URL} failed: ${res.status} ${res.statusText}`);

  let xml = await res.text();
  if (!/<rss\b/i.test(xml)) throw new Error("Origin did not return RSS/XML (no <rss> tag)");

  // Normalize XML declaration to a single header
  xml = xml.replace(/^\uFEFF/, "").replace(/^\s*<\?xml[^>]*\?>\s*/i, "");
  xml = `<?xml version="1.0" encoding="UTF-8"?>\n` + xml;

  // --- Brutally remove SmartNews namespace and elements regardless of prefix case/alias ---
  // Remove any xmlns:* whose value contains the SmartNews URI
  xml = xml.replace(/\s+xmlns:([a-z0-9_-]+)="([^"]*)"/gi, (m, pfx, uri) => {
    return /smartnews\.be\/snf/i.test(uri) ? "" : m;
  });
  // Remove any elements with prefix "snf:" (blocks and self-closing)
  xml = xml.replace(/<snf:[^>]*>[\s\S]*?<\/snf:[^>]*>/gi, "");
  xml = xml.replace(/<snf:[^>]*\/\s*>/gi, "");

  // --- Rebuild the <rss> root cleanly (prevents duplicate attributes & unknown xmlns) ---
  xml = xml.replace(
    /<rss[^>]*>/i,
    '<rss version="2.0" ' +
      'xmlns:media="http://search.yahoo.com/mrss/" ' +
      'xmlns:content="http://purl.org/rss/1.0/modules/content/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:atom="http://www.w3.org/2005/Atom">'
  );

  // --- Remove ANY namespaced elements we do not explicitly allow (robust) ---
  // 1) Remove full blocks: <x:foo ...>...</x:foo>
  xml = xml.replace(/<([a-zA-Z0-9_-]+):([a-zA-Z0-9._-]+)(\s[^>]*)?>[\s\S]*?<\/\1:\2\s*>/g, (m, pfx) => {
    return ALLOWED_NS_PREFIXES.includes(pfx.toLowerCase()) ? m : "";
  });
  // 2) Remove self-closing: <x:foo ... />
  xml = xml.replace(/<([a-zA-Z0-9_-]+):([a-zA-Z0-9._-]+)(\s[^>]*)?\/\s*>/g, (m, pfx) => {
    return ALLOWED_NS_PREFIXES.includes(pfx.toLowerCase()) ? m : "";
  });

  // Ensure exactly one correct atom:link rel="self"
  xml = xml
    .replace(/<atom:link[^>]+rel=["']self["'][^>]*\/>\s*/gi, "")
    .replace(/<channel>(?![\s\S]*?<atom:link[^>]+rel=["']self["'])/i, `<channel>
    <atom:link href="${FEED_SELF_URL}" rel="self" type="application/rss+xml" />`);

  // Limit items early
  xml = limitItems(xml, ITEM_LIMIT);

  // Per-item rewrites
  xml = await rewriteItems(xml);

  writeFileSync(OUTPUT, xml, "utf8");
  console.log("Wrote", OUTPUT);
}

function limitItems(xml, limit) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (items.length <= limit) return xml;
  const keep = items.slice(0, limit).join("\n");
  return xml.replace(/<channel>[\s\S]*?<\/channel>/, (m) => {
    const header = m.split(/<item>/)[0];
    return header + keep + "\n</channel>";
  });
}

async function rewriteItems(xmlStr) {
  const items = xmlStr.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items) {
    let out = item;

    // Title → cleaned CDATA
    out = out.replace(/<title>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/title>/i, (_m, c, p) => {
      let t = (c ?? p ?? "").trim();
      t = t.replace(/\[[^\]]+\]/g, "")
           .replace(/&#124;/g, "|")
           .replace(/\s{2,}/g, " ")
           .trim();
      if (/\bin\s*$/i.test(t)) t += new Date().getFullYear();
      return `<title><![CDATA[${t}]]></title>`;
    });

    // DESCRIPTION → unconditional plain text CDATA (handles CDATA or raw HTML)
    out = replaceBlock(out, "description", (inner) => {
      let txt = stripAllTagsPreservingBreaks(unwrapCdata(inner));
      txt = decodeEntities(txt).trim();
      if (txt.length > CONTENT_MAX_CHARS) {
        txt = txt.slice(0, CONTENT_MAX_CHARS).replace(/\s+\S*$/, "") + "…";
      }
      return `<![CDATA[${txt}]]>`;
    });

    // CONTENT:ENCODED → unconditional cleaned, plain-text CDATA (handles CDATA or raw)
    out = replaceBlock(out, "content:encoded", (inner) => {
      let body = stripJunk(unwrapCdata(inner));
      if (FORCE_NO_LINKS) body = body.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1");
      body = htmlToText(body);
      if (body.length > CONTENT_MAX_CHARS) {
        body = body.slice(0, CONTENT_MAX_CHARS).replace(/\s+\S*$/, "") + "…";
      }
      return `<![CDATA[<p>${escapeCdata(body)}</p>]]>`;
    });

    // THUMBNAIL: prefer existing, else og:image, else default
    if (!/<media:thumbnail\b/i.test(out)) {
      let thumb =
        out.match(/<media:content[^>]+url=["']([^"']+)["']/i)?.[1] ||
        out.match(/<enclosure[^>]+url=["']([^"']+)["']/i)?.[1] ||
        null;

      if (!thumb) {
        const link = (out.match(/<link>([^<]+)<\/link>/)?.[1] || "").split("?")[0];
        if (link) {
          try {
            const pageRes = await fetch(link, { headers: { Accept: "text/html", "User-Agent": UA } });
            if (pageRes.ok) {
              const html = await pageRes.text();
              const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
              if (og) thumb = og;
              out = ensureAuthor(out, html); // also try to add author if missing
            }
          } catch {}
        }
      }

      if (!thumb) thumb = DEFAULT_THUMB_URL;

      const s = sanitizeUrl(thumb);
      if (s && ALLOWED_IMG_EXT.test(s)) {
        out = out.replace("</item>", `<media:thumbnail url="${s}" /></item>`);
      }
    } else {
      // sanitize existing thumbnail URL
      out = out.replace(/<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*\/>/i, (m, u) => {
        const s = sanitizeUrl(u);
        return (s && ALLOWED_IMG_EXT.test(s)) ? `<media:thumbnail url="${s}" />` : "";
      });

      // ensure author if missing
      const link = (out.match(/<link>([^<]+)<\/link>/)?.[1] || "").split("?")[0];
      if (link) {
        try {
          const pageRes = await fetch(link, { headers: { Accept: "text/html", "User-Agent": UA } });
          if (pageRes.ok) {
            const html = await pageRes.text();
            out = ensureAuthor(out, html);
          }
        } catch {}
      }
    }

    // Strip UTM params in <link>
    out = out.replace(/<link>([^<]+)<\/link>/i, (_, u) => `<link>${stripUtm(u)}</link>`);

    xmlStr = xmlStr.replace(item, out);
  }
  return xmlStr;
}

/* ---------------- HELPERS ---------------- */

// Replace a simple element block with a callback for its inner content.
// Handles multiple instances by replacing the first one only (RSS uses one).
function replaceBlock(xml, tagName, fn) {
  const re = new RegExp(`<${escapeReg(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeReg(tagName)}\\s*>`, "i");
  return xml.replace(re, (_m, inner) => `<${tagName}>${fn(inner)}</${tagName}>`);
}

function escapeReg(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function unwrapCdata(s) {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i);
  return m ? m[1] : s;
}

function stripAllTagsPreservingBreaks(html) {
  let out = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n");
  return out.replace(/<[^>]+>/g, "");
}

function htmlToText(html) {
  let out = stripAllTagsPreservingBreaks(html);
  out = decodeEntities(out);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeCdata(s){ return s.replace(/\]\]>/g, "]]&gt;"); }

function ensureAuthor(itemXml, articleHtml) {
  const hasDc = /<dc:creator>[\s\S]*?<\/dc:creator>/i.test(itemXml);
  const hasAuthor = /<author>[\s\S]*?<\/author>/i.test(itemXml);
  if (hasDc || hasAuthor) return itemXml;

  // Try meta name="author"
  let name = articleHtml?.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)?.[1];

  // Fallback: JSON-LD
  if (!name) {
    const ldMatches = articleHtml?.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of ldMatches) {
      try {
        const json = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/gi, "").trim());
        const found = findAuthorName(json);
        if (found) { name = found; break; }
      } catch {}
    }
  }

  if (name) {
    const inject =
      `\n      <dc:creator><![CDATA[${name}]]></dc:creator>\n` +
      `      <author><![CDATA[${name}]]></author>\n`;
    return itemXml.replace(/<\/item>/i, inject + "</item>");
  }
  return itemXml;
}

function findAuthorName(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const el of obj) {
      const v = findAuthorName(el);
      if (v) return v;
    }
  }
  if (obj.author) {
    const a = obj.author;
    if (typeof a === "string") return a;
    if (Array.isArray(a)) {
      for (const e of a) if (e && (e.name || typeof e === "string")) return e.name || e;
    } else if (a.name) return a.name;
  }
  if (obj["@type"] && /Article/i.test(obj["@type"]) && obj.author) {
    const a = obj.author;
    if (typeof a === "string") return a;
    if (Array.isArray(a)) for (const e of a) if (e && e.name) return e.name;
    if (a.name) return a.name;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const found = typeof v === "object" ? findAuthorName(v) : null;
    if (found) return found;
  }
  return null;
}

function stripJunk(html) {
  return html
    .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<div[^>]+class=(["']).*?\b(related|share|social|subscribe|breadcrumbs|tags|tag-?cloud|promo|newsletter|author|bio|widget|sidebar|footer|cta|read-?more)\b.*?\1[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<section[^>]+class=(["']).*?\b(related|share|social|subscribe|tags|newsletter|sources|references)\b.*?\1[^>]*>[\s\S]*?<\/section>/gi, "")
    .replace(/<ul[^>]+class=(["']).*?\b(related|share|social|tags|sources|references)\b.*?\1[^>]*>[\s\S]*?<\/ul>/gi, "")
    .replace(/<a\b[^>]*>\s*(<img[\s\S]*?>)\s*<\/a>/gi, "$1")
    .replace(/<sup[^>]*>\s*\[?\d+\]?\s*<\/sup>/gi, "");
}

function stripUtm(u) {
  try {
    const url = new URL(u);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(p => url.searchParams.delete(p));
    return url.toString();
  } catch { return u; }
}

function sanitizeUrl(u) {
  if (!u) return null;
  let s = u.trim().replace(/\s/g, "%20");
  if (/^(data:|mailto:|tel:|javascript:)/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  s = s.replace(/^http:\/\//i, "https://");
  try { return new URL(s).toString(); }
  catch { try { return encodeURI(s); } catch { return null; } }
}

// MAIN
main().catch(err => {
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

function escapeXml(s){ return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }
