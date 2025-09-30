// --- CONFIG ---
const FEED_URL = "https://www.cabletv.com/feed";
const LOGO_URL = "https://i.ibb.co/sptKgp34/CTV-Feed-Logo.png"; // 700x100 PNG
const MAX_LINKS = 4;                    // very tight cap
const MAX_LINKS = 2;                    // ultra-tight cap
const OUTPUT_DIR = __dirname + "/../dist";
const OUTPUT = OUTPUT_DIR + "/feed-smartnews.xml";
const UA = "Mozilla/5.0 (compatible; SmartNews-Feed-Builder/1.3; +https://CTV-Clearlink.github.io)";
const UA = "Mozilla/5.0 (compatible; SmartNews-Feed-Builder/1.4; +https://CTV-Clearlink.github.io)";
const ALLOWED_IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|#|$)/i;

async function main() {
mkdirSync(OUTPUT_DIR, { recursive: true });

  const res = await fetch(FEED_URL, {
    headers: { "Accept": "application/rss+xml", "User-Agent": UA }
  });
  const res = await fetch(FEED_URL, { headers: { "Accept": "application/rss+xml", "User-Agent": UA } });
if (!res.ok) throw new Error(`Fetch ${FEED_URL} failed: ${res.status} ${res.statusText}`);

let xml = await res.text();
@@ -52,29 +50,44 @@ async function rewriteItems(xmlStr) {
for (let item of items) {
let out = item;

    // 0) Fix titles: strip WP shortcodes like [current_date ...]
    // 0) Fix titles: remove WP shortcodes and decode simple pipe entity
out = out.replace(/<title>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/title>/i, (_m, cdata, plain) => {
      const raw = (cdata ?? plain ?? "").trim();
      const cleaned = stripShortcodes(raw).replace(/\s+\|\s+/g, " | ").trim();
      return `<title><![CDATA[${cleaned}]]></title>`;
      let raw = (cdata ?? plain ?? "").trim();
      raw = raw.replace(/\[[^\]]+\]/g, "").replace(/&#124;/g, "|").replace(/\s{2,}/g, " ").trim();
      // If a title ends with " in" due to shortcode removal, append the current year
      if (/\bin\s*$/i.test(raw)) raw = raw + new Date().getFullYear();
      return `<title><![CDATA[${raw}]]></title>`;
});

// Remove any existing analytics blocks (optional in SmartNews)
out = out.replace(/<snf:analytics>[\s\S]*?<\/snf:analytics>/gi, "");

    // 1) Clean + cap links inside content:encoded
    // 1) Clean + cap links inside content:encoded (very aggressive)
out = out.replace(
/(<content:encoded><!\[CDATA\[)([\s\S]*?)(\]\]><\/content:encoded>)/,
(_, open, body, close) => {
body = stripJunk(body);
body = removeUnsafeAnchors(body);
body = unwrapLowValueAnchors(body);

        // remove anchors inside headings
        body = body.replace(/<(h1|h2|h3|h4|h5|h6)[^>]*>[\s\S]*?<\/\1>/gi, m =>
          m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
        );

        // soft cap
body = capAnchors(body, MAX_LINKS);

        // Hard cap: if still over MAX_LINKS, unwrap ALL remaining <a> tags
        // hard cap (belt & suspenders): if still too many, unwrap ALL
if (anchorCount(body) > MAX_LINKS) {
body = body.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1");
}

        // also unwrap anchors in the last 25% of content (often sources/footers)
        const cut = Math.floor(body.length * 0.75);
        body = body.slice(0, cut) +
               body.slice(cut).replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1");

return open + body + close;
}
);
@@ -92,14 +105,28 @@ async function rewriteItems(xmlStr) {
if (thumb && ALLOWED_IMG_EXT.test(thumb)) {
out = out.replace("</item>", `<media:thumbnail url="${thumb}" /></item>`);
}
            // 2a) Ensure author if missing
            out = ensureAuthor(out, html);
}
} catch { /* ignore per-item errors */ }
}
} else {
      // sanitize provided thumbnail URL
out = out.replace(/<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*\/>/i, (m, u) => {
const s = sanitizeUrl(u);
return (s && ALLOWED_IMG_EXT.test(s)) ? `<media:thumbnail url="${s}" />` : "";
});
      // 2a) ensure author if missing (fetch page for author)
      const link = (out.match(/<link>([^<]+)<\/link>/)?.[1] || "").split("?")[0];
      if (link) {
        try {
          const pageRes = await fetch(link, { headers: { "Accept": "text/html", "User-Agent": UA } });
          if (pageRes.ok) {
            const html = await pageRes.text();
            out = ensureAuthor(out, html);
          }
        } catch {}
      }
}

// 3) Strip UTM in <link>
@@ -112,9 +139,69 @@ async function rewriteItems(xmlStr) {

// --- helpers ---

function stripShortcodes(str) {
  // Remove any [shortcode ...] blocks
  return str.replace(/\[[^\]]+\]/g, "").replace(/\s{2,}/g, " ").trim();
function ensureAuthor(itemXml, articleHtml) {
  const hasDc = /<dc:creator>[\s\S]*?<\/dc:creator>/i.test(itemXml);
  const hasAuthor = /<author>[\s\S]*?<\/author>/i.test(itemXml); // RSS 2.0 email format, we’ll use name only
  if (hasDc || hasAuthor) return itemXml;

  // Try to find author from meta tags or JSON-LD
  let name = articleHtml?.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)?.[1];

  if (!name) {
    // JSON-LD: "author": {"@type":"Person","name":"..."} or array
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
    // Add both dc:creator and author (name only). Wrap in CDATA to be safe.
    const inject =
      `\n      <dc:creator><![CDATA[${name}]]></dc:creator>\n` +
      `      <author><![CDATA[${name}]]></author>\n`;
    return itemXml.replace(/<\/item>/i, inject + "</item>");
  }
  return itemXml;
}
function findAuthorName(obj) {
  if (!obj || typeof obj !== "object") return null;
  // If array, search elements
  if (Array.isArray(obj)) {
    for (const el of obj) {
      const v = findAuthorName(el);
      if (v) return v;
    }
  }
  // Direct author field
  if (obj.author) {
    if (typeof obj.author === "string") return obj.author;
    if (Array.isArray(obj.author)) {
      for (const a of obj.author) {
        const v = findAuthorName(a);
        if (v) return v;
      }
    } else if (obj.author.name) return obj.author.name;
  }
  // Article schema
  if (obj["@type"] && /Article/i.test(obj["@type"]) && obj.author) {
    const a = obj.author;
    if (typeof a === "string") return a;
    if (Array.isArray(a)) {
      for (const e of a) if (e && e.name) return e.name;
    } else if (a.name) return a.name;
  }
  // Recurse other props
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const found = typeof v === "object" ? findAuthorName(v) : null;
    if (found) return found;
  }
  return null;
}

function stripJunk(html) {
@@ -128,9 +215,9 @@ function stripJunk(html) {
.replace(/<div[^>]+class=(["']).*?\b(related|share|social|subscribe|breadcrumbs|tags|tag-?cloud|promo|newsletter|author|bio|widget|sidebar|footer|cta|read-?more)\b.*?\1[^>]*>[\s\S]*?<\/div>/gi, "")
.replace(/<section[^>]+class=(["']).*?\b(related|share|social|subscribe|tags|newsletter|sources|references)\b.*?\1[^>]*>[\s\S]*?<\/section>/gi, "")
.replace(/<ul[^>]+class=(["']).*?\b(related|share|social|tags|sources|references)\b.*?\1[^>]*>[\s\S]*?<\/ul>/gi, "")
    // unwrap image-only anchors (linked images)
    // unwrap image-only anchors
.replace(/<a\b[^>]*>\s*(<img[\s\S]*?>)\s*<\/a>/gi, "$1")
    // drop footnotes/sup links like [1], [2]
    // drop footnote marks like [1]
.replace(/<sup[^>]*>\s*\[?\d+\]?\s*<\/sup>/gi, "");
}

@@ -143,15 +230,14 @@ function removeUnsafeAnchors(html) {
}

function unwrapLowValueAnchors(html) {
  // unwrap anchors inside low-value containers: figcaption, caption, small
  // unwrap anchors inside low-value containers: figcaption, caption, small, lists, tables
html = html.replace(/<(figcaption|caption|small)[^>]*>[\s\S]*?<\/\1>/gi, (m) =>
m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
);
  // unwrap anchors inside lists and tables (often sources/TOC)
html = html.replace(/<(ul|ol|table)[^>]*>[\s\S]*?<\/\1>/gi, (m) =>
m.replace(/<a\b[^>]*>(.*?)<\/a>/gis, "$1")
);
  // remove “read more”, “continue”, “back to top”, “view sources”
  // remove “read more / continue / back to top / view sources”
html = html.replace(
/<a\b[^>]*>(\s*(read\s*more|continue|back\s*to\s*top|view\s*sources?|sources?|references?)\s*)<\/a>/gi,
(m, inner) => inner
@@ -173,9 +259,7 @@ function anchorCount(html) {
function stripUtm(u) {
try {
const url = new URL(u);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(p =>
      url.searchParams.delete(p)
    );
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(p => url.searchParams.delete(p));
return url.toString();
} catch { return u; }
}
