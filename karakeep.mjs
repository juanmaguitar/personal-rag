/**
 * karakeep.mjs — read the Karakeep bookmark collection as indexable documents.
 *
 * A source adapter, nothing more. It returns exactly the shape `loadVault()`
 * returns — `{ file, meta, body }` — so index.mjs, retrieve.mjs and the MCP
 * server never learn where the text came from. Swapping the vault for Karakeep
 * is choosing a different loader, not a different pipeline.
 *
 * `file` carries the bookmark id (not a filename). It is the dedupe key for
 * incremental indexing and the citation key in mcp-server.mjs, and Karakeep ids
 * are stable across edits — so re-running the indexer only re-embeds bookmarks
 * whose content actually changed.
 *
 * Config (env, or explicit args):
 *   KARAKEEP_URL      base URL, e.g. https://karakeep.example.com
 *   KARAKEEP_API_KEY  from Settings → API Keys in the Karakeep web UI
 *
 * Errors are typed via `err.code`, same convention as retrieve.mjs:
 *   NO_API_KEY            KARAKEEP_API_KEY unset
 *   KARAKEEP_UNREACHABLE  network/DNS failure
 *   KARAKEEP_HTTP         non-2xx (message carries the status)
 */

import { env } from "node:process";
import TurndownService from "turndown";

const PAGE_SIZE = 50;

// Same options as article.mjs — duplicated rather than shared, following the
// convention that file already documents ("to avoid coupling").
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Karakeep inlines images as base64 data URIs inside the stored content, and
// they are enormous: measured on this collection, 8 bookmarks carried ~4.8 MB
// of base64 between them — one X post came to 418 KB of "markdown", 99% of it
// binary. Left in, those few bookmarks would be ~40% of every chunk in the
// index and would poison retrieval. None of it is embeddable anyway.
//
// `remove()` does NOT work for images: turndown's built-in `image` rule wins,
// and the node comes back as `![alt](data:image/png;base64,…)`. An explicit
// addRule overrides it. remove() is right for the rest.
turndown.addRule("dropMedia", {
  filter: ["img", "picture", "source", "svg", "video", "audio", "iframe", "canvas"],
  replacement: () => "",
});
turndown.remove(["style", "script", "noscript"]);

// Belt and braces: catches base64 that survives as text (srcset leftovers,
// inline blobs in attributes turndown flattened). A 200-char run of base64
// alphabet with no separators is never prose — real long tokens (URLs, paths)
// carry ':', '.', '/' or '-'.
const BASE64_RUN = /\b[A-Za-z0-9+/]{200,}={0,2}/g;

function stripBinary(md) {
  return md.replace(BASE64_RUN, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ────────────────────────────────────────────────────────────────
// Mapping (pure — unit-tested without network)
// ────────────────────────────────────────────────────────────────

function collapse(s) {
  return String(s ?? "").trim();
}

function isoDate(s) {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function htmlToMarkdown(html) {
  const clean = collapse(html);
  if (!clean) return "";
  try {
    return stripBinary(turndown.turndown(clean));
  } catch {
    // Malformed HTML shouldn't cost us the whole bookmark — fall back to the
    // metadata-only body the caller builds around it.
    return "";
  }
}

/**
 * bookmarkToDoc — one Karakeep bookmark → one indexable document.
 *
 * @param bookmark  the API object (GET /api/v1/bookmarks)
 * @param opts.html content fetched separately from an asset, when the API
 *                  didn't inline `content.htmlContent`
 * @returns { file, meta, body } — body is "" when there is nothing worth
 *          embedding, and index.mjs skips those.
 */
export function bookmarkToDoc(bookmark, { html = "" } = {}) {
  const content = bookmark?.content ?? {};
  const tags = Array.isArray(bookmark?.tags)
    ? bookmark.tags.map((t) => collapse(t?.name)).filter(Boolean)
    : [];

  const title = collapse(bookmark?.title) || collapse(content.title);
  const summary = collapse(bookmark?.summary);
  const note = collapse(bookmark?.note);
  const description = collapse(content.description);
  const article = htmlToMarkdown(html || content.htmlContent);

  // Order matters for chunking: the most concentrated signal first, so a
  // single-chunk bookmark still carries title + summary. `description` is only
  // worth embedding when there's no article — otherwise it just repeats the lede.
  const parts = [];
  if (title) parts.push(`# ${title}`);
  if (summary) parts.push(summary);
  if (note) parts.push(note);
  if (article) parts.push(article);
  else if (description) parts.push(description);
  // Tags are the user's own vocabulary for this bookmark — cheap, high-signal,
  // and the only body some of the 5 content-less bookmarks will have.
  if (tags.length) parts.push(`Tags: ${tags.join(", ")}`);

  return {
    file: collapse(bookmark?.id),
    meta: {
      source: collapse(content.url),
      author: collapse(content.author) || collapse(content.publisher),
      author_name: collapse(content.publisher),
      created: isoDate(content.datePublished) || isoDate(bookmark?.createdAt),
      captured: isoDate(bookmark?.createdAt),
      type: collapse(content.type) || "bookmark",
      title,
      tags,
    },
    body: parts.join("\n\n"),
  };
}

// ────────────────────────────────────────────────────────────────
// API transport
// ────────────────────────────────────────────────────────────────

function config({ url, apiKey } = {}) {
  const base = collapse(url || env.KARAKEEP_URL).replace(/\/+$/, "");
  const key = collapse(apiKey || env.KARAKEEP_API_KEY);
  if (!base) {
    throw fail("NO_API_KEY", "KARAKEEP_URL is not set. Put it in .env and run with `node --env-file=.env`.");
  }
  if (!key) {
    throw fail(
      "NO_API_KEY",
      "KARAKEEP_API_KEY is not set. Generate one in Karakeep → Settings → API Keys, " +
        "put it in .env, and run with `node --env-file=.env`.",
    );
  }
  return { base, key };
}

async function apiGet({ base, key }, path, { raw = false } = {}) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: raw ? "*/*" : "application/json" },
    });
  } catch (e) {
    throw fail("KARAKEEP_UNREACHABLE", `Cannot reach Karakeep at ${base} (${e.message}).`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401 ? " — the API key is wrong or was revoked." : "";
    throw fail("KARAKEEP_HTTP", `Karakeep HTTP ${res.status}${hint} ${text.slice(0, 200)}`);
  }
  return raw ? res.text() : res.json();
}

// Content can live in the DB column (`content.htmlContent`) or in an asset on
// disk (`content.contentAssetId`). `includeContent=true` is supposed to inline
// both; this is the fallback for when it doesn't, so coverage doesn't silently
// drop to metadata-only for those bookmarks.
async function fetchAssetHtml(cfg, assetId) {
  try {
    return await apiGet(cfg, `/api/v1/assets/${assetId}`, { raw: true });
  } catch {
    return "";
  }
}

/**
 * loadKarakeep — every bookmark, as indexable documents.
 * @returns Array<{ file, meta, body }>
 */
export async function loadKarakeep({ url, apiKey, onProgress } = {}) {
  const cfg = config({ url, apiKey });
  const docs = [];
  let cursor = null;
  let assetFetches = 0;

  do {
    const qs = new URLSearchParams({
      includeContent: "true",
      limit: String(PAGE_SIZE),
      sortOrder: "desc",
    });
    if (cursor) qs.set("cursor", cursor);

    const page = await apiGet(cfg, `/api/v1/bookmarks?${qs}`);
    const bookmarks = Array.isArray(page?.bookmarks) ? page.bookmarks : [];

    for (const b of bookmarks) {
      const c = b?.content ?? {};
      let html = "";
      if (!collapse(c.htmlContent) && c.contentAssetId) {
        html = await fetchAssetHtml(cfg, c.contentAssetId);
        if (html) assetFetches++;
      }
      const doc = bookmarkToDoc(b, { html });
      if (doc.file) docs.push(doc);
    }

    onProgress?.(docs.length);
    cursor = page?.nextCursor ?? null;
  } while (cursor);

  if (assetFetches) {
    console.error(`  (fetched ${assetFetches} content asset(s) the API didn't inline)`);
  }
  return docs;
}
