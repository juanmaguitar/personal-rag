/**
 * vault.mjs — shared helpers for reading the vault and the RAG pipeline.
 *
 * Pure, dependency-free utilities used by index.mjs and ask.mjs:
 *   - loadVault   read every .md capture into { file, meta, body }
 *   - chunk       split a body into overlapping char windows
 *   - parseSince  turn "30d" / "6m" / "2y" / "2026-01-01" into a cutoff Date
 *   - cosine      cosine similarity between two equal-length vectors
 *
 * Kept separate (and side-effect free) so the logic can be unit-tested with
 * `node --test rag.test.mjs` without touching the filesystem or Ollama.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_VAULT = join(homedir(), "OBSIDIAN", "AI-BRAIN", "Bookmarks");

// ────────────────────────────────────────────────────────────────
// Frontmatter parsing
// ────────────────────────────────────────────────────────────────

// Parse the YAML frontmatter block. Handles the subset capture.mjs emits:
// scalars (`key: value`), block lists (`key:` followed by `  - item` lines),
// and inline empty lists (`tags: []`). Anything fancier is out of scope — our
// own writer controls the format.
export function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };

  const meta = {};
  const lines = m[1].split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    const rawVal = kv[2];

    if (rawVal === "" || rawVal === undefined) {
      // Possible block list: gather following "  - item" lines.
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(stripQuotes(lines[j].replace(/^\s+-\s+/, "").trim()));
        j++;
      }
      meta[key] = items; // empty array if no list items followed
      i = j;
    } else if (rawVal === "[]") {
      meta[key] = [];
      i++;
    } else {
      meta[key] = stripQuotes(rawVal.trim());
      i++;
    }
  }
  return { meta, body: m[2] };
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, "");
}

// ────────────────────────────────────────────────────────────────
// Vault loading
// ────────────────────────────────────────────────────────────────

export async function loadVault(vaultPath = DEFAULT_VAULT) {
  const names = (await readdir(vaultPath)).filter((f) => f.endsWith(".md"));
  const out = [];
  for (const file of names) {
    const content = await readFile(join(vaultPath, file), "utf-8");
    const { meta, body } = parseFrontmatter(content);
    out.push({ file, meta, body, content });
  }
  return out;
}

// Strip the boilerplate heading and footer so we embed the actual content,
// not "# Tweet by @x" or "[Original tweet](…)". Mirrors search.mjs:preview.
export function cleanBody(body) {
  return body
    .replace(/^#\s+.*\n+/m, "") // leading "# Tweet by @x"
    .replace(/\n+---\n\[(?:Original tweet|Shared tweet)\][\s\S]*$/, "") // footer
    .trim();
}

// ────────────────────────────────────────────────────────────────
// Chunking
// ────────────────────────────────────────────────────────────────

// Split text into overlapping windows, preferring paragraph boundaries.
// Short captures (most tweets) come back as a single chunk. Long ones
// (threads, pasted articles) split into a handful with `overlap` chars of
// context carried across the boundary so a claim spanning a split is still
// retrievable from either side.
export function chunk(text, { size = 800, overlap = 100 } = {}) {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const paras = clean.split(/\n{2,}/);
  const chunks = [];
  let buf = "";

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed) chunks.push(trimmed);
    // Carry the tail of this chunk into the next for context overlap.
    buf = overlap > 0 ? buf.slice(-overlap) : "";
  };

  for (const para of paras) {
    if (para.length > size) {
      // A single oversized paragraph: hard-split it on char boundaries.
      if (buf.trim()) flush();
      for (let i = 0; i < para.length; i += size - overlap) {
        chunks.push(para.slice(i, i + size).trim());
      }
      buf = "";
      continue;
    }
    if ((buf + "\n\n" + para).length > size) flush();
    buf = buf ? buf + "\n\n" + para : para;
  }
  if (buf.trim()) chunks.push(buf.trim());

  return chunks.filter(Boolean);
}

// ────────────────────────────────────────────────────────────────
// Date scope
// ────────────────────────────────────────────────────────────────

// Parse a --since value into a cutoff Date. Accepts relative shorthand
// (`30d`, `6m`, `2y`, `2w`) measured back from `now`, or an absolute ISO
// date. Returns null for falsy input (no filter). Throws on garbage so the
// CLI can report it rather than silently dropping the filter.
export function parseSince(value, now = new Date()) {
  if (!value) return null;

  const rel = String(value).trim().match(/^(\d+)\s*([dwmy])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const d = new Date(now.getTime());
    if (unit === "d") d.setDate(d.getDate() - n);
    else if (unit === "w") d.setDate(d.getDate() - n * 7);
    else if (unit === "m") d.setMonth(d.getMonth() - n);
    else if (unit === "y") d.setFullYear(d.getFullYear() - n);
    return d;
  }

  const abs = new Date(value);
  if (Number.isNaN(abs.getTime())) {
    throw new Error(
      `Invalid --since value: "${value}". Use 30d, 6m, 2y, or an ISO date like 2026-01-01.`,
    );
  }
  return abs;
}

// ────────────────────────────────────────────────────────────────
// Vector math
// ────────────────────────────────────────────────────────────────

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
