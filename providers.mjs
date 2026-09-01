/**
 * providers.mjs — pluggable embedding + generation backends.
 *
 * Two layers, deliberately separate because they have different lifecycles:
 *
 *   - Embedder  (getEmbedder)  is STICKY. Changing the embedding model means
 *     every vector in the index was produced by a different function, so the
 *     index must be rebuilt. The index records the embedder id + dims and
 *     ask.mjs refuses to run on a mismatch.
 *   - Generator (getGenerator) is FREE to swap per query — it only reads the
 *     retrieved chunks, it doesn't touch the index.
 *
 * v1 ships Ollama (local, private, zero-auth) via raw fetch — same hand-rolled
 * HTTP style as capture.mjs. `claude` and `openai` are seams: the dispatch is
 * in place; flip them on when you want frontier-model answers.
 *
 * Selection precedence (both layers): CLI flag > env var > default.
 *   provider:  --provider   RAG_PROVIDER       (default: ollama)
 *   embed:     --embed-model RAG_EMBED_MODEL    (default: bge-m3)
 *   generate:  --model       RAG_GEN_MODEL      (default: qwen2.5:7b)
 */

import { env } from "node:process";

const OLLAMA_HOST = env.OLLAMA_HOST || "http://localhost:11434";

export const DEFAULTS = {
  provider: env.RAG_PROVIDER || "ollama",
  embedModel: env.RAG_EMBED_MODEL || "bge-m3",
  genModel: env.RAG_GEN_MODEL || "qwen2.5:7b",
};

// ────────────────────────────────────────────────────────────────
// Ollama transport
// ────────────────────────────────────────────────────────────────

async function ollamaFetch(path, payload) {
  let res;
  try {
    res = await fetch(`${OLLAMA_HOST}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(
      `Cannot reach Ollama at ${OLLAMA_HOST} (${e.message}).\n` +
        `  Start it with \`ollama serve\` or launch the Ollama app.`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 404 && /model/i.test(text)) {
      const m = text.match(/"([\w.:-]+)"/);
      const model = m ? m[1] : payload.model;
      throw new Error(
        `Ollama model "${model}" not found. Pull it first: \`ollama pull ${model}\``,
      );
    }
    throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ────────────────────────────────────────────────────────────────
// Embedders
// ────────────────────────────────────────────────────────────────

// nomic-embed-text is trained with task prefixes and expects them: the corpus
// side gets "search_document: ", the query side "search_query: ". Measured on
// this vault, adding them widens the gap between a relevant and an irrelevant
// document by ~12%. Models that weren't trained this way must NOT get them,
// hence the name check.
const NOMIC_PREFIX = { document: "search_document: ", query: "search_query: " };
const usesTaskPrefix = (model) => /nomic-embed/i.test(model);

export function getEmbedder({ provider = DEFAULTS.provider, model = DEFAULTS.embedModel } = {}) {
  switch (provider) {
    case "ollama":
      return {
        // The id encodes the prefixing, not just the model: vectors built
        // without prefixes aren't comparable to vectors built with them, so
        // this makes retrieve.mjs force a rebuild instead of ranking garbage.
        id: `ollama:${model}${usesTaskPrefix(model) ? "+task" : ""}`,
        /**
         * @param texts  one string or an array
         * @param task   "document" when indexing, "query" when searching
         */
        async embed(texts, task = "document") {
          const raw = Array.isArray(texts) ? texts : [texts];
          if (raw.length === 0) return [];
          const prefix = usesTaskPrefix(model) ? NOMIC_PREFIX[task] ?? NOMIC_PREFIX.document : "";
          const input = prefix ? raw.map((t) => prefix + t) : raw;
          const data = await ollamaFetch("/api/embed", { model, input });
          const vecs = data.embeddings;
          if (!Array.isArray(vecs) || vecs.length !== input.length) {
            throw new Error(`Ollama returned ${vecs?.length ?? 0} embeddings for ${input.length} inputs`);
          }
          return vecs;
        },
      };
    case "claude":
    case "openai":
      // Seam: Claude has no first-party embeddings API (use Voyage), OpenAI
      // does. Wire when the frontier path is needed — see plan Phase B.
      throw new Error(
        `Embedder provider "${provider}" not wired yet. Use --provider ollama, ` +
          `or implement it in providers.mjs (getEmbedder).`,
      );
    default:
      throw new Error(`Unknown embedder provider "${provider}".`);
  }
}

// ────────────────────────────────────────────────────────────────
// Generators
// ────────────────────────────────────────────────────────────────

export function getGenerator({ provider = DEFAULTS.provider, model = DEFAULTS.genModel } = {}) {
  switch (provider) {
    case "ollama":
      return {
        id: `ollama:${model}`,
        async generate({ system, user }) {
          const data = await ollamaFetch("/api/generate", {
            model,
            system,
            prompt: user,
            stream: false,
            options: { temperature: 0.2 },
          });
          return (data.response ?? "").trim();
        },
      };
    case "claude":
    case "openai":
      // Seam: implemented in Phase B using current model IDs/endpoints from
      // the claude-api skill (Claude) — not coded from memory here.
      throw new Error(
        `Generator provider "${provider}" not wired yet. Use --provider ollama, ` +
          `or implement it in providers.mjs (getGenerator).`,
      );
    default:
      throw new Error(`Unknown generator provider "${provider}".`);
  }
}
