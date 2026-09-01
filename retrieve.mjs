/**
 * retrieve.mjs — the reusable retrieval core.
 *
 * Loads the index, embeds the query with the matching model, filters by date
 * scope, and ranks by cosine similarity. This is the shared heart of every
 * frontend: the terminal `ask.mjs`, the `mcp-server.mjs` (Claude synthesizes),
 * and any future phone/web interface. Frontends decide *who* writes the
 * answer; this module only decides *what* the relevant, in-scope sources are.
 *
 * Errors are typed via `err.code` so each frontend can format them its own way:
 *   NO_INDEX            index file missing — run `node index.mjs`
 *   BAD_INDEX           index file present but not parseable (half-written?)
 *   EMBEDDER_MISMATCH   query embedder ≠ index embedder — re-index or match
 *   (others bubble up from providers.mjs, e.g. Ollama unreachable)
 *
 * Indexes are cached in memory per path, invalidated by the file's mtime+size,
 * because this module now runs inside a long-lived HTTP server: re-parsing a
 * 37 MB (and eventually ~250 MB) JSON on every question is not an option.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "node:process";

import { parseSince, cosine } from "./vault.mjs";
import { getEmbedder, DEFAULTS } from "./providers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// RAG_INDEX picks which index this process reads — that's how one mcp-server.mjs
// serves several sources (vault, karakeep) as separate registered MCP servers.
export const INDEX_PATH = env.RAG_INDEX
  ? resolve(env.RAG_INDEX)
  : join(HERE, ".index", "embeddings.json");

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Parsed indexes, keyed by absolute path. An entry is reused only while the
// file's mtime and size are unchanged, so replacing the index on disk (an
// `scp` from the Mac) is picked up on the next question without a restart.
const indexCache = new Map();

export function clearIndexCache() {
  indexCache.clear();
}

export async function loadIndex(path = INDEX_PATH) {
  const abs = resolve(path);

  let st;
  try {
    st = await stat(abs);
  } catch {
    throw fail("NO_INDEX", `No index found at ${abs}. Build it first: \`node index.mjs\``);
  }

  const hit = indexCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.index;

  let raw;
  try {
    raw = await readFile(abs, "utf-8");
  } catch {
    throw fail("NO_INDEX", `No index found at ${abs}. Build it first: \`node index.mjs\``);
  }

  let index;
  try {
    index = JSON.parse(raw);
  } catch (e) {
    // A half-written file (an `scp` still in flight) lands here. Don't cache it
    // — the next call re-reads and will succeed once the copy finishes.
    throw fail("BAD_INDEX", `Index at ${abs} is not valid JSON: ${e.message}`);
  }

  // Vectors as Float32Array: half the bytes of a JS number array and no boxing.
  // `cosine` only indexes and reads .length, so it works on either. Done once
  // here rather than per query.
  for (const r of index.records ?? []) {
    if (Array.isArray(r.vector)) r.vector = Float32Array.from(r.vector);
  }

  indexCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, index });
  return index;
}

// Pure: filter records by date scope, score by cosine, sort (similarity first,
// recency as tie-break so "latest" wins when relevance is close), take top-k.
export function rankMatches(records, queryVec, cutoff, k) {
  let dropped = 0;
  const scored = [];
  for (const r of records) {
    if (cutoff) {
      const created = r.created ? new Date(r.created) : null;
      if (!created || Number.isNaN(created.getTime()) || created < cutoff) {
        dropped++;
        continue;
      }
    }
    scored.push({ rec: r, score: cosine(queryVec, r.vector) });
  }
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-6) return b.score - a.score;
    return String(b.rec.created).localeCompare(String(a.rec.created));
  });
  return { top: scored.slice(0, k), dropped };
}

/**
 * retrieve — the one call every frontend makes.
 *
 * `indexPath` picks the corpus per call, so one process can serve several
 * (bookmarks, ai-brain, digital-brain) as separate tools. It defaults to
 * INDEX_PATH, which keeps the RAG_INDEX-per-process setup working unchanged.
 *
 * @returns { top: [{rec, score}], dropped, cutoff: Date|null, embedderId }
 */
export async function retrieve({
  question,
  since = null,
  k = 8,
  indexPath = INDEX_PATH,
  provider = DEFAULTS.provider,
  embedModel = DEFAULTS.embedModel,
} = {}) {
  if (!question || !question.trim()) throw fail("NO_QUERY", "Empty question.");

  const cutoff = parseSince(since); // throws on garbage (BAD_SINCE-ish message)
  const index = await loadIndex(indexPath);

  // The query MUST be embedded with the same model that built the index —
  // vectors from different models are not comparable.
  const embedder = getEmbedder({ provider, model: embedModel });
  if (embedder.id !== index.embedder) {
    throw fail(
      "EMBEDDER_MISMATCH",
      `Embedder mismatch: index was built with "${index.embedder}" but you asked for "${embedder.id}". ` +
        `Either match it (--provider/--embed-model) or rebuild: \`node index.mjs\``,
    );
  }

  // "query" side of the task prefix — the index was built with "document".
  const [queryVec] = await embedder.embed(question, "query");
  const { top, dropped } = rankMatches(index.records, queryVec, cutoff, k);
  return { top, dropped, cutoff, embedderId: embedder.id };
}
