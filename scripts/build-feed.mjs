import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ---------------- CONFIG ---------------- */
const SOURCE_FEED_URL = "https://www.cabletv.com/feed";
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed.xml";

// This MUST match the final, public, case-sensitive URL of this feed:
const FEED_SELF_URL = "https://CTV-Clearlink.github.io/RSS-Feed/feed.xml";

const UA = "Mozilla/5.0 (compatible; Feed-Builder/3.1; +https://CTV-Clearlink.github.io)";

// Content policy: remove inline links and emit plain text to avoid HTML validator errors
const FORCE_NO_LINKS = true;
const CONTENT_MAX_CHARS = 8000; // trim per item (on text, not HTML)

// Limit item count to keep total file size small
const ITEM_LIMIT = 30;

// Thumbnails
const ALLOWED_IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;
const DEFAULT_THUMB_URL = "https://i.ibb.co/V0FWL4m9/CTV-Logo.png"; // PNG/JPG recommended

// SmartNews extras are DISABLED for this generic feed
const ENABLE_SMARTNEWS_EXTRAS = false;
/** ---------------------------------------- */

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await fetch(SOURCE_FEED_URL, {
    headers: { Accept: "application/rss+xml", "User-Agent": UA }
  });
  if (!res.ok) throw new Error(`Fetch ${SOURCE_FEED_URL} failed: ${res.status} ${res.statusText}`);

  let xml = await res.text();
  if (!xml.includes("<rss")) throw new Error("Origin did not return RSS/XML (no <rss> tag)");

  // Ensure namespaces: media + content + dc + atom (NO snf here)
  xml = xml.replace(
    /<rss([^>]*)>/,
    '<rss$1 version="2.0" ' +
      'xmlns:media="http://search.yahoo.com/mrss/" ' +
      'xmlns:content="http://purl.org/rss/1.0/modules/content/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:atom="http://www.w3.org/2005/Atom">'
  );

  // Remove any SmartNews blocks if present in source
  xml = xml
    .replace(/xmlns:snf="[^"]*"/gi, "")
    .replace(/<snf:logo>[\s\S]*?<\/snf:logo>/gi, "")
    .replace(/<snf:analytics>[\s\S]*?<\/snf:analytics>/gi, "");

  // Insert atom:link rel="self" (exactly once, with exact URL)
  xml = xml.replace(/<channel>(?![\s\S]*?<atom:link)/i, `<channel>
    <atom:link href="${FEED_SELF_URL}" rel="self" type="application/rss+xml" />`);

  // Limit items to keep overall size small
  xml = limitItems(xml, ITEM_LIMIT);

  // Per-item rewrites (plain-text bodies, thumbnails, author, UTM strip)
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
      t = t.replace(/\[[^\]]+\]/g, "")
           .replace(/&#124;/g, "|")
           .replace(/\s{2,}/g, " ")
           .trim();
      if (/\bin\s*$/i.test(t)) t += new Date().getFullYear();
      return `<title><![CDATA[${t}]]></title>`;
    });

    // CONTENT: transform to plain text (no tags), remove links, trim
    out = out.replace(
      /(<content:encoded><!\[CDATA\[)([\s\S]*?)(\]\]><\/content:encoded>)/,
      (_, open, body, close) => {
        // Optional: remove obvious junk first
        body = stripJunk(body);

        // Remove all anchors but keep inner text
        if (FORCE_NO_LINKS) {
          body = body.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1");
        }

        // Convert HTML -> plain text to avoid “Invalid HTML” warnings
        body = htmlToText(body);

        // Trim by characters on plain text (won't break attributes)
        if (body.length > CONTENT_MAX_CHARS) {
          body = body.slice(0, CONTENT_MAX_CHARS).replace(/\s+\S*$/, "") + "…";
        }

        // Wrap in a simple paragraph so readers show something tidy
        const safe = escapeCdata(body);
        return open + `<p>${safe}</p>` + close;
      }
    );

    // THUMBNAIL: keep any valid one; else derive; else default
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
              out = ensureAuthor(out, html); // also ensure author
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
  out = out.replace(/<[^>]+>/g, "");         // strip ALL tags
  out = decodeEntities(out);
  // collapse whitespace
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeEntities(s) {
  // Just a few common ones; validators don't require perfection here
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeCdata(s) {
  // Avoid closing the CDATA by accident
  return s.replace(/\]\]>/g, "]]&gt;");
}

function ensureAuthor(itemXml, articleHtml) {
  const hasDc = /<dc:creator>[\s\S]*?<\/dc:creator>/i.test(itemXml);
  const hasAuthor = /<author>[\s\S]*?<\/author>/i.test(itemXml);
  if (hasDc || hasAuthor) return itemXml;

  let name = articleHtml?.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)?.[1];

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
    for (const el of obj) { const v = findAuthorName(el); if (v) return v; }
  }
  if (obj.author) {
    const a = obj.author;
    if (typeof a === "string") return a;
    if (Array.isArray(a)) { for (const e of a) if (e && (e.name || typeof e === "string")) return e.name || e; }
    else if (a.name) return a.name;
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

function removeUnsafeAnchors(html) {
  return html.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gis,
    (m, href, inner) => (/^(mailto:|tel:|javascript:|#)/i.test(href) ? inner : m)
  );
}

function unwrapLowValueAnchors(html) {
  let out = html.replace(/<(figcaption|caption|small)[^>]*>[\s\S]*?<\/\1>/gi, (m) =>
    m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
  );
  out = out.replace(/<(ul|ol|table)[^>]*>[\s\S]*?<\/\1>/gi, (m) =>
    m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
  );
  out = out.replace(
    /<a\b[^>]*>(\s*(read\s*more|continue|view\s*sources?|sources?|references?|back\s*to\s*top)\s*)<\/a>/gi,
    (_m, inner) => inner
  );
  return out;
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
