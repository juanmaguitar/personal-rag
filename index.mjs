#!/usr/bin/env node
/**
 * index.mjs — build / refresh the embedding index over the vault.
 *
 * Usage:
 *   node index.mjs [--vault PATH] [--force]
 *                  [--source vault|karakeep] [--index PATH]
 *                  [--provider NAME] [--embed-model NAME]
 *
 * Reads every document from the chosen source, splits it into chunks, embeds
 * each chunk, and writes a flat JSON index. The index is a derived cache —
 * delete it anytime and rebuild from the source.
 *
 * Two sources, same document shape (`{ file, meta, body }`), so everything
 * below the loader is identical:
 *   vault     .md captures on disk        (vault.mjs)
 *   karakeep  the Karakeep REST API       (karakeep.mjs) — needs .env, so run
 *             it as `node --env-file=.env index.mjs --source karakeep`
 *
 * Each source gets its own index file (--index / RAG_INDEX) so they don't
 * clobber each other; the default keeps the vault where it has always been.
 *
 * Incremental by default: a per-file content hash is stored, and only
 * changed / new files are re-embedded. --force rebuilds everything. Changing
 * the embedding model also forces a full rebuild (the old vectors are
 * incomparable), which ask.mjs enforces too.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, env, exit } from "node:process";

import { DEFAULT_VAULT, loadVault, cleanBody, chunk } from "./vault.mjs";
import { loadKarakeep } from "./karakeep.mjs";
import { getEmbedder, DEFAULTS } from "./providers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX = join(HERE, ".index", "embeddings.json");
const INDEX_VERSION = 1;
const SOURCES = ["vault", "karakeep"];

function parseArgs(args) {
  const out = {
    vault: DEFAULT_VAULT,
    force: false,
    source: env.RAG_SOURCE || "vault",
    indexPath: env.RAG_INDEX || DEFAULT_INDEX,
    provider: DEFAULTS.provider,
    embedModel: DEFAULTS.embedModel,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force" || a === "-f") out.force = true;
    else if (a === "--vault") out.vault = args[++i];
    else if (a === "--source") out.source = args[++i];
    else if (a === "--index") out.indexPath = args[++i];
    else if (a === "--provider") out.provider = args[++i];
    else if (a === "--embed-model") out.embedModel = args[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        `Usage: node index.mjs [--vault PATH] [--force]\n` +
          `                      [--source vault|karakeep] [--index PATH]\n` +
          `                      [--provider NAME] [--embed-model NAME]`,
      );
      exit(0);
    }
  }
  if (!SOURCES.includes(out.source)) {
    console.error(`Unknown --source "${out.source}". Use one of: ${SOURCES.join(", ")}.`);
    exit(1);
  }
  // Resolve relative --index against the cwd, absolute paths untouched.
  out.indexPath = resolve(out.indexPath);
  return out;
}

function hashContent(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function loadExistingIndex(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function main() {
  const { vault, force, source, indexPath, provider, embedModel } = parseArgs(argv.slice(2));
  const embedder = getEmbedder({ provider, model: embedModel });

  let docs;
  try {
    docs =
      source === "karakeep"
        ? await loadKarakeep({
            onProgress: (n) => process.stdout.write(`\r  fetched ${n} bookmark(s)…`),
          })
        : await loadVault(vault);
  } catch (e) {
    const where = source === "karakeep" ? "Karakeep" : `vault ${vault}`;
    console.error(`Cannot read ${where} (${e.code ?? "ERROR"}): ${e.message}`);
    exit(1);
  }
  if (source === "karakeep") process.stdout.write("\n");
  if (!docs.length) {
    console.error(
      source === "karakeep"
        ? `Karakeep returned no bookmarks. Nothing to index.`
        : `No .md captures found in ${vault}. Nothing to index.`,
    );
    exit(1);
  }

  const existing = await loadExistingIndex(indexPath);
  // A changed embedder makes every cached vector incomparable — rebuild all.
  const reuseOk =
    !force && existing && existing.embedder === embedder.id && existing.version === INDEX_VERSION;
  const cachedByFile = new Map();
  if (reuseOk) {
    for (const r of existing.records) {
      if (!cachedByFile.has(r.file)) cachedByFile.set(r.file, []);
      cachedByFile.get(r.file).push(r);
    }
  } else if (existing && existing.embedder !== embedder.id) {
    console.error(
      `Embedder changed (${existing.embedder} → ${embedder.id}) — rebuilding the whole index.`,
    );
  }

  const records = [];
  let reused = 0;
  let embedded = 0;
  let chunksTotal = 0;

  for (const doc of docs) {
    // cleanBody strips the tweet boilerplate ("# Tweet by @x", the [Original
    // tweet] footer). Karakeep bodies are built by karakeep.mjs and their
    // leading "# Title" is real content — stripping it would lose the title.
    const cleaned = source === "vault" ? cleanBody(doc.body) : doc.body.trim();
    if (!cleaned) continue;
    const hash = hashContent(cleaned);

    const cached = cachedByFile.get(doc.file);
    if (cached && cached.length && cached[0].hash === hash) {
      records.push(...cached);
      reused++;
      chunksTotal += cached.length;
      continue;
    }

    const chunks = chunk(cleaned);
    if (!chunks.length) continue;
    let vectors;
    try {
      vectors = await embedder.embed(chunks);
    } catch (e) {
      console.error(`\n${e.message}`);
      exit(1);
    }

    chunks.forEach((text, idx) => {
      records.push({
        file: doc.file,
        source: doc.meta.source || "",
        author: doc.meta.author || doc.meta.site || "",
        author_name: doc.meta.author_name || "",
        created: doc.meta.created || doc.meta.captured || "",
        captured: doc.meta.captured || "",
        type: doc.meta.type || "",
        tags: Array.isArray(doc.meta.tags) ? doc.meta.tags : [],
        chunkIndex: idx,
        hash,
        text,
        vector: vectors[idx],
      });
    });
    embedded++;
    chunksTotal += chunks.length;
    process.stdout.write(`  embedded ${doc.file} (${chunks.length} chunk${chunks.length === 1 ? "" : "s"})\n`);
  }

  const dims = records.find((r) => Array.isArray(r.vector))?.vector.length ?? 0;
  const index = {
    embedder: embedder.id,
    dims,
    source,
    version: INDEX_VERSION,
    generated: new Date().toISOString(),
    records,
  };

  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify(index), "utf-8");

  const unit = source === "karakeep" ? "bookmark" : "file";
  console.log(
    `\nIndexed ${docs.length} ${unit}${docs.length === 1 ? "" : "s"} ` +
      `(${embedded} embedded, ${reused} reused) → ${chunksTotal} chunks, ` +
      `${dims}-dim vectors via ${embedder.id}.`,
  );
  console.log(`Wrote ${indexPath}`);
}

main().catch((e) => {
  console.error(e);
  exit(1);
});
