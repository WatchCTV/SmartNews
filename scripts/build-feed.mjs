// scripts/build-feed.mjs — generic RSS builder (validator-clean, no SmartNews tags)
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ---------------- CONFIG ---------------- */
const SOURCE_FEED_URL = "https://www.cabletv.com/feed";
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed.xml";

// MUST match the published URL exactly (case-sensitive)
const FEED_SELF_URL = "https://CTV-Clearlink.github.io/RSS-Feed/feed.xml";

const UA = "Mozilla/5.0 (compatible; Feed-Builder/3.3; +https://CTV-Clearlink.github.io)";

// Content policy: remove inline links and emit plain text (avoid HTML errors)
const FORCE_NO_LINKS = true;

// Size limits to keep validators happy
const ITEM_LIMIT = 30;           // newest N items
const CONTENT_MAX_CHARS = 8000;  // per-item text cap

// Thumbnails
const ALLOWED_IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;
const DEFAULT_THUMB_URL = "https://i.ibb.co/V0FWL4m9/CTV-Logo.png"; // PNG/JPG recommended
/** ---------------------------------------- */

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await fetch(SOURCE_FEED_URL, {
    headers: { Accept: "application/rss+xml", "User-Agent": UA }
  });
  if (!res.ok) throw new Error(`Fetch ${SOURCE_FEED_URL} failed: ${res.status} ${res.statusText}`);

  let xml = await res.text();
  if (!xml.includes("<rss")) throw new Error("Origin did not return RSS/XML (no <rss> tag)");

  // 1) Strip any SmartNews artifacts (generic feed must not include them)
  xml = xml
    .replace(/xmlns:snf="[^"]*"/gi, "")
    .replace(/<snf:logo>[\s\S]*?<\/snf:logo>/gi, "")
    .replace(/<snf:[^>]+>[\s\S]*?<\/snf:[^>]+>/gi, "");

  // 2) Normalize the <rss> tag to avoid duplicate attributes
  //    a) Reduce whatever is there to just "<rss>"
  xml = xml.replace(/<rss[^>]*>/i, "<rss>");
  //    b) Replace that with a single clean tag with only standard namespaces
  xml = xml.replace(
    /<rss>/i,
    '<rss version="2.0" ' +
      'xmlns:media="http://search.yahoo.com/mrss/" ' +
      'xmlns:content="http://purl.org/rss/1.0/modules/content/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:atom="http://www.w3.org/2005/Atom">'
  );

  // 3) Ensure a correct atom:link rel="self" (exactly once, matching FEED_SELF_URL)
  xml = xml
    .replace(/<atom:link[^>]+rel=["']self["'][^>]*\/>\s*/i, "")
    .replace(/<channel>(?![\s\S]*?<atom:link)/i, `<channel>
    <atom:link href="${FEED_SELF_URL}" rel="self" type="application/rss+xml" />`);

  // 4) Limit items early to keep file size small
  xml = limitItems(xml, ITEM_LIMIT);

  // 5) Per-item rewrites (plain-text bodies, thumbnails, author fallback, UTM strip)
  xml = await rewriteItems(xml);

  writeFileSync(OUTPUT, xml, "utf8");
  console.log("Wrote", OUTPUT);
}

function limitItems(xml, limit) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (items.length <= limit) return xml;
  const keep = items.slice(0, limit).join("\n");
  return xml.replace(/<channel>[\s\S]*?<\/channel>/, (m) => {
    const header = m.split(/<item>/)[0]; // includes <channel> ... up to first item
    return header + keep + "\n</channel>";
  });
}

async function rewriteItems(xmlStr) {
  const items = xmlStr.match(/<item>[\s\S]*?<\/item>/g) || [];
  console.log(`Processing ${items.length} <item> elements`);

  for (const item of items) {
    let out = item;

    // Title cleanup: remove shortcodes, decode pipe, trim; fix dangling "in"
    out = out.replace(/<title>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/title>/i, (_m, c, p) => {
      let t = (c ?? p ?? "").trim();
      t = t.replace(/\[[^\]]]+\]/g, "")
           .replace(/&#124;/g, "|")
           .replace(/\s{2,}/g, " ")
           .trim();
      if (/\bin\s*$/i.test(t)) t += new Date().getFullYear();
      return `<title><![CDATA[${t}]]></title>`;
    });

    // CONTENT: strip junk, remove links, convert to plain text, trim, wrap
    out = out.replace(
      /(<content:encoded><!\[CDATA\[)([\s\S]*?)(\]\]><\/content:encoded>)/,
      (_, open, body, close) => {
        body = stripJunk(body);
        if (FORCE_NO_LINKS) body = body.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1");
        body = htmlToText(body); // HTML -> plain text
        if (body.length > CONTENT_MAX_CHARS) {
          body = body.slice(0, CONTENT_MAX_CHARS).replace(/\s+\S*$/, "") + "…";
        }
        const safe = escapeCdata(body);
        return open + `<p>${safe}</p>` + close;
      }
    );

    // THUMBNAIL: media/enclosure → page og:image → default
    if (!/<media:thumbnail\b/.test(out)) {
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
              out = ensureAuthor(out, html); // also ensure author if missing
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
    out = out.replace(/<link>([^<]+)<\/link>/, (_, u) => `<link>${stripUtm(u)}</link>`);

    xmlStr = xmlStr.replace(item, out);
  }
  return xmlStr;
}

/* ---------------- HELPERS ---------------- */

function htmlToText(html) {
  // Preserve basic line breaks, then strip tags
  let out = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n");
  out = out.replace(/<[^>]+>/g, ""); // strip ALL tags
  out = decodeEntities(out);
  // collapse whitespace
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

function escapeXml(s){ return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }
