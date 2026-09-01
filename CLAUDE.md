# personal-rag — project context

Index personal corpora and query them semantically over MCP. Two sources today
(the Obsidian vault's markdown, and Karakeep bookmarks over its REST API), one
retrieval core, several frontends. Fully local embeddings via Ollama.

Split out of `tweet-process` on 1 Sep 2026, which is now archived as
`~/PROJECTS/2026/tweet-capture` (tweet + web-article capture, superseded by
Karakeep and Obsidian). The two halves never shared an import.

Operational notes (deployment, roadmap, working preferences) live outside
this repo in `CLAUDE.local.md`, which is gitignored.

## Architecture decisions already made

- **Source of truth is flat markdown files** plus Karakeep. No DB. Portable and
  grep-able by design. The index is a *derived cache*: delete it and rebuild.
- **Privacy-first.** Tailscale over ngrok. Self-hosted over cloud. Local
  embeddings over API embeddings.
- **Progressive build.** Don't try to ship the whole system at once.

## The pipeline

- **`vault.mjs`** — pure, side-effect-free helpers (unit-tested): `loadVault`,
  a richer `parseFrontmatter` (handles block lists like `media:` / `tags:`),
  `cleanBody` (strips the `# Tweet by` heading + `[Original tweet]` footer),
  `chunk` (paragraph-aware, ~800 char windows w/ 100 overlap), `parseSince`,
  `cosine`.
- **`karakeep.mjs`** — the Karakeep REST source adapter. Returns the *same*
  `{ file, meta, body }` shape `loadVault()` returns, so everything downstream
  is untouched. **Adding a source is writing a loader, not a pipeline.**
- **`providers.mjs`** — pluggable backends. **Two layers, different
  lifecycles:** the *embedder* is STICKY (changing it invalidates every vector →
  re-index; retrieval enforces id match), the *generator* is FREE to swap per
  query. Precedence: CLI flag > env (`RAG_PROVIDER`, `RAG_EMBED_MODEL`,
  `RAG_GEN_MODEL`) > defaults (`ollama` / `bge-m3` / `qwen2.5:7b`).
  `claude` / `openai` are stubbed seams — **fill the Claude generator from the
  claude-api skill, not from memory.**
- **`index.mjs`** — chunks + embeds every document → a flat JSON index.
  Incremental by per-file content **hash** (only changed files re-embed;
  `--force` rebuilds). The header records `embedder` id + `dims`; a changed
  embedder forces a full rebuild. `--source vault|karakeep` picks the loader,
  `--index PATH` (env `RAG_INDEX`) the output. Index lives in the **project,
  gitignored** — NOT in the vault.
- **`retrieve.mjs`** — the reusable retrieval core: index-load + embedder-match
  guard + query-embed + date-filter + cosine rank. Throws typed errors
  (`err.code`: `NO_INDEX`, `BAD_INDEX`, `EMBEDDER_MISMATCH`, `NO_QUERY`) so each
  frontend formats them its own way. *Retrieval is the reusable core; who
  synthesizes is the frontend's choice.*
- **`ask.mjs`** (terminal) — `retrieve()` then local-LLM synthesis. Cites by
  **source number `[n]`** and prints a numbered Sources block with the **bare
  URL on its own line**. Pure `formatSources` / `uniqueSources` / `fmtDate` are
  exported + unit-tested; the CLI is guarded by `import.meta.url ===
  pathToFileURL(argv[1]).href` so tests can import without executing `main()`.
- **`mcp-server.mjs`** — MCP server over **stdio** (Claude Code) or
  **Streamable HTTP** (`--http`, for remote clients). Tools `search_vault`
  and `list_recent_captures` are **retrieval-only by design**: the client's
  frontier model synthesizes from the returned passages — the local Ollama model
  is NOT in this loop (Ollama still embeds the query). stdout is the protocol
  channel — diagnostics go to **stderr only**.

Setup: `ollama pull bge-m3` (1024-dim multilingual embedder — see gotcha 4 for
why NOT nomic-embed-text).

Register the stdio server: `claude mcp add vault-rag --scope user -- node
<abs>/mcp-server.mjs`. Two servers are registered today, `vault-rag` and
`karakeep-rag`, differing only in `RAG_INDEX`.

Karakeep config lives in `.env` (gitignored, chmod 600): `KARAKEEP_URL`,
`KARAKEEP_API_KEY`. Node reads it natively:
`node --env-file=.env index.mjs --source karakeep --index .index/karakeep.json`
The API key needs only **Bookmarks: Read** and **Assets: Read**.

## Gotchas / rules learned (do not re-discover these)

1. **Karakeep inlines images as base64 data URIs inside the stored content.**
   Raw turndown produced **6.2 MB** of "markdown" for 216 bookmarks; stripping
   media brought it to **1.4 MB**. One X post was 418 KB, 99% of it binary.
   Always strip before chunking.
2. **`turndown.remove(["img"])` does NOT drop images.** Turndown's built-in
   `image` rule wins and you get `![alt](data:image/png;base64,…)`. You need
   `addRule` with an empty replacement. `remove()` is fine for
   `style`/`script`/`noscript`.
3. **Readability is useless here.** Karakeep already stores extracted content.
   The bloat is inside the article, not around it.
4. **The embedder must be MULTILINGUAL, and this was the single worst bug found.**
   The corpus is 85% English / 9% Spanish, but the user asks in Spanish.
   `nomic-embed-text` clusters by *language*, not meaning: a Spanish question
   returned 10/10 Spanish documents, and the overlap between results for the
   same question in Spanish vs English was **0-2 out of 8**. Asking in Spanish
   silently hid 85% of the collection. **`bge-m3`** (568M, 1024-dim,
   cross-lingual) took that overlap to **4-8 of 8**. Do not go back to a
   monolingual embedder.
   - Corollary: **proper nouns mask the bug.** "bookmarks de WordPress" works on
     a monolingual embedder because "WordPress" is the same token in both
     languages. **Test cross-lingual retrieval with concept queries.**
   - Absolute similarity scores are NOT comparable across models. `bge-m3`
     scores ~0.52 where nomic scored ~0.67 on the same (better) result.
     **Compare rankings, never raw cosine values.**
   - `nomic-embed-text` (if ever used again) needs task prefixes:
     `search_document: ` when indexing, `search_query: ` when searching. The
     embedder id carries `+task` so the mismatch guard forces a rebuild.
5. **`content.datePublished` is unreliable for X.** One tweet came back dated
   2019 (the account's date, not the post's). Do not trust `--since` to be exact
   on x.com sources.
6. **The API does inline asset-backed content** when `includeContent=true`, so
   the `/api/v1/assets/{id}` fallback in `loadKarakeep` never fires in practice.
   Kept because it is cheap and the failure mode without it is silent.
7. Retrieval quality looked broken at first and was not: the test questions had
   no answer in the corpus. **Test a RAG with questions the corpus can answer.**
8. **Date scope filters `created:` (the resource's own date), not `captured:`.**
   Undated records are **dropped entirely** whenever `--since` is set.
9. `cleanBody` does NOT strip the `## Media` section, so image-only tweets put
   media markdown into a chunk. Minor embedding noise, left for later.

### Learned 1 Sep 2026, building the HTTP transport

10. **Loading an index costs ~5x the file size as a transient RSS spike.**
    Measured on `karakeep.json` (37 MB, 2682 chunks): idle RSS 47 MB, **peak
    231 MB during load**, 95 MB steady after. `JSON.parse` holds the raw string,
    the boxed number arrays and the `Float32Array` at once. Fine for one corpus;
    a ~230 MB index projects to a **>1 GB spike**, which matters on a small
    server. Stagger the loads, or move to JSONL, when that lands.
11. **Cache the parsed index.** `loadIndex` re-read and re-parsed the whole file
    on every question: 1968 ms cold vs **103 ms** warm. Invalidated by
    `mtimeMs` + `size`, so replacing the file (an `scp` from the Mac) is picked
    up on the next question with no restart.
12. **Copy an index atomically.** Writing over the file the server is reading
    can hand a query half a JSON. That now raises a typed `BAD_INDEX` (and is
    not cached, so the next call recovers), but the real fix is `scp` to
    `.tmp` then `mv` on the far side.
13. **`allowedHosts` must be built from the port actually bound**, not the one
    requested. With `port: 0` the list said `127.0.0.1:0` and the server
    rejected *everything*, legitimate traffic included.
14. **A rejection-only security test passes on a fully broken server.** The DNS
    rebinding test must assert **both** that the expected Host is accepted and
    that an unexpected one is 403. This is how bug 13 was caught.
15. **`localhost` is `::1` on Alpine** and the connection is refused. Container
    healthchecks must hit `127.0.0.1`.

## Files

- `vault.mjs` — pure helpers (loadVault, parseFrontmatter, chunk, parseSince, cosine)
- `karakeep.mjs` — Karakeep REST source adapter; same doc shape as loadVault
- `providers.mjs` — pluggable embed/generate backends (Ollama; Claude/OpenAI seams)
- `index.mjs` — build/refresh the embedding index (`--source vault|karakeep`, `--index PATH`)
- `retrieve.mjs` — retrieval core (loadIndex + cache, rankMatches, retrieve)
- `ask.mjs` — terminal frontend: date-scoped Q&A with `[n]` citations
- `mcp-server.mjs` — MCP server, stdio or `--http`
- `rag.test.mjs` — pure logic (parseSince / cosine / chunk / frontmatter / ask formatting)
- `karakeep.test.mjs` — the Karakeep mapping + binary stripping
- `retrieve.test.mjs` — rankMatches + the index cache
- `mcp-server.test.mjs` — both transports, the tools, and the Host allowlist
- `Dockerfile`, `docker-compose.yml`, `.dockerignore` — container deployment
- `CLAUDE.md` — this file
