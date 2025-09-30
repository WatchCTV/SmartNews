// scripts/build-feed.mjs (provider-agnostic)
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ---------------- CONFIG ---------------- */
const SOURCE_FEED_URL = "https://www.cabletv.com/feed";
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed.xml";

const UA = "Mozilla/5.0 (compatible; Feed-Builder/3.0; +https://CTV-Clearlink.github.io)";

// Keep article bodies but remove all inline links to satisfy strict validators
const FORCE_NO_LINKS = true;

// Hard limits to avoid “Too large content size”
const ITEM_LIMIT = 30;          // include only the newest N items
const CONTENT_MAX_CHARS = 8000; // trim content:encoded to this length (per item)

// Thumbnail policy
const ALLOWED_IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;
const DEFAULT_THUMB_URL = "https://www.cabletv.com/app/themes/bifrost-child/dist/images/brands/logo-generic-horz-outline.svg"; // replace with a PNG/JPG if you prefer

// Optional SmartNews extensions (leave true while validating there)
const ENABLE_SMARTNEWS_EXTRAS = true;
const SMARTNEWS_LOGO_URL = "https://i.ibb.co/sptKgp34/CTV-Feed-Logo.png"; // 700x100 PNG
/** ---------------------------------------- */

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await fetch(SOURCE_FEED_URL, {
    headers: { Accept: "application/rss+xml", "User-Agent": UA }
  });
  if (!res.ok) throw new Error(`Fetch ${SOURCE_FEED_URL} failed: ${res.status} ${res.statusText}`);

  let xml = await res.text();
  if (!xml.includes("<rss")) throw new Error("Origin did not return RSS/XML (no <rss> tag)");

  // Ensure namespaces (media always; snf only if enabled)
  if (!/xmlns:media=/.test(xml) || (ENABLE_SMARTNEWS_EXTRAS && !/xmlns:snf=/.test(xml))) {
    xml = xml.replace(
      /<rss([^>]*)>/,
      `<rss$1 xmlns:media="http://search.yahoo.com/mrss/"` +
        (ENABLE_SMARTNEWS_EXTRAS ? ` xmlns:snf="http://www.smartnews.be/snf"` : "") +
      `>`
    );
  }

  // Inject SmartNews logo ONLY if that mode is on and logo is missing
  if (ENABLE_SMARTNEWS_EXTRAS && !/<snf:logo>/.test(xml)) {
    xml = xml.replace("<channel>", `<channel>
    <snf:logo><url>${SMARTNEWS_LOGO_URL}</url></snf:logo>`);
  }

  // Strip any existing snf:analytics (optional & can be flagged if malformed)
  xml = xml.replace(/<snf:analytics>[\s\S]*?<\/snf:analytics>/gi, "");

  // Limit item count early to keep the file small
  xml = limitItems(xml, ITEM_LIMIT);

  // Per-item rewrites (content trimming, thumbnails, authors, UTM strip)
  xml = await rewriteItems(xml);

  writeFileSync(OUTPUT, xml, "utf8");
  console.log("Wrote", OUTPUT);
}

function limitItems(xml, limit) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  if (items.length <= limit) return xml;
  const keep = items.slice(0, limit).join("\n");
  return xml.replace(/<channel>[\s\S]*?<\/channel>/, (m) => {
    const before = m.split(/<item>/)[0]; // header up to first item (still contains <channel>)
    return before + keep + "\n</channel>";
  });
}

async function rewriteItems(xmlStr) {
  let items = xmlStr.match(/<item>[\s\S]*?<\/item>/g) || [];
  console.log(`Processing ${items.length} <item> elements`);

  for (const item of items) {
    let out = item;

    // Title cleanup: remove [shortcodes], decode pipe, trim; fix dangling "in"
    out = out.replace(/<title>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/title>/i, (_m, cdata, plain) => {
      let t = (cdata ?? plain ?? "").trim();
      t = t.replace(/\[[^\]]+\]/g, "") // remove shortcodes like [current_date …]
           .replace(/&#124;/g, "|")
           .replace(/\s{2,}/g, " ")
           .trim();
      if (/\bin\s*$/i.test(t)) t += new Date().getFullYear();
      return `<title><![CDATA[${t}]]></title>`;
    });

    // Remove any existing (possibly invalid) analytics blocks
    out = out.replace(/<snf:analytics>[\s\S]*?<\/snf:analytics>/gi, "");

    // CONTENT: clean, remove links, and TRIM length to avoid oversized feed
    out = out.replace(
      /(<content:encoded><!\[CDATA\[)([\s\S]*?)(\]\]><\/content:encoded>)/,
      (_, open, body, close) => {
        body = stripJunk(body);
        body = unwrapLowValueAnchors(body);
        body = removeUnsafeAnchors(body);
        if (FORCE_NO_LINKS) {
          body = body.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1");
        }
        // Trim content to max chars (works fine in CDATA)
        if (body.length > CONTENT_MAX_CHARS) {
          body = body.slice(0, CONTENT_MAX_CHARS) + "…";
        }
        // Also unwrap anchors inside headings (extra safety)
        body = body.replace(/<(h1|h2|h3|h4|h5|h6)[^>]*>[\s\S]*?<\/\1>/gi, m =>
          m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
        );
        return open + body + close;
      }
    );

    // THUMBNAIL: prefer existing; else derive from page; else RSS media/enclosure; else default
    if (!/<media:thumbnail\b/.test(out)) {
      let thumb = null;

      // 1) RSS media:content or enclosure in item
      thumb = thumb || out.match(/<media:content[^>]+url=["']([^"']+)["']/i)?.[1] || null;
      thumb = thumb || out.match(/<enclosure[^>]+url=["']([^"']+)["']/i)?.[1] || null;

      // 2) Fetch article page, read og:image
      if (!thumb) {
        const link = (out.match(/<link>([^<]+)<\/link>/)?.[1] || "").split("?")[0];
        if (link) {
          try {
            const pageRes = await fetch(link, { headers: { Accept: "text/html", "User-Agent": UA } });
            if (pageRes.ok) {
              const html = await pageRes.text();
              const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
              if (og) thumb = og;
              // Also ensure author if missing
              out = ensureAuthor(out, html);
            }
          } catch {}
        }
      }

      // 3) Fallback default
      if (!thumb) thumb = DEFAULT_THUMB_URL;

      // sanitize + ensure allowed extension (or skip if not acceptable)
      const s = sanitizeUrl(thumb);
      if (s && ALLOWED_IMG_EXT.test(s)) {
        out = out.replace("</item>", `<media:thumbnail url="${s}" /></item>`);
      }
    } else {
      // sanitize provided thumbnail URL
      out = out.replace(/<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*\/>/i, (m, u) => {
        const s = sanitizeUrl(u);
        return (s && ALLOWED_IMG_EXT.test(s)) ? `<media:thumbnail url="${s}" />` : "";
      });
      // Ensure author if missing (fetch page)
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

    // Replace in the global XML
    xmlStr = xmlStr.replace(item, out);
  }
  return xmlStr;
}

/* ---------------- HELPERS ---------------- */

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
    // structural junk
    .replace(/<(nav|footer|aside)[\s\S]*?<\/\1>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // common widget/related/social blocks
    .replace(/<div[^>]+class=(["']).*?\b(related|share|social|subscribe|breadcrumbs|tags|tag-?cloud|promo|newsletter|author|bio|widget|sidebar|footer|cta|read-?more)\b.*?\1[^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<section[^>]+class=(["']).*?\b(related|share|social|subscribe|tags|newsletter|sources|references)\b.*?\1[^>]*>[\s\S]*?<\/section>/gi, "")
    .replace(/<ul[^>]+class=(["']).*?\b(related|share|social|tags|sources|references)\b.*?\1[^>]*>[\s\S]*?<\/ul>/gi, "")
    // unwrap linked images
    .replace(/<a\b[^>]*>\s*(<img[\s\S]*?>)\s*<\/a>/gi, "$1")
    // drop footnote marks like [1]
    .replace(/<sup[^>]*>\s*\[?\d+\]?\s*<\/sup>/gi, "");
}

function unwrapLowValueAnchors(html) {
  // unwrap anchors inside low-value containers: figcaption, caption, small, lists, tables
  html = html.replace(/<(figcaption|caption|small)[^>]*>[\s\S]*?<\/\1>/gi, m =>
    m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
  );
  html = html.replace(/<(ul|ol|table)[^>]*>[\s\S]*?<\/\1>/gi, m =>
    m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
  );
  // remove “read more / continue / view sources / references / back to top”
  html = html.replace(
    /<a\b[^>]*>(\s*(read\s*more|continue|view\s*sources?|sources?|references?|back\s*to\s*top)\s*)<\/a>/gi,
    (_m, inner) => inner
  );
  return html;
}

function removeUnsafeAnchors(html) {
  // unwrap non-editorial schemes and hash anchors
  return html.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gis,
    (m, href, inner) => (/^(mailto:|tel:|javascript:|#)/i.test(href) ? inner : m)
  );
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

function escapeXml(s){ return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c])); }
