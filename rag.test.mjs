/**
 * rag.test.mjs — unit tests for the RAG pipeline's pure logic.
 *
 *   node --test rag.test.mjs
 *
 * Covers the deterministic, side-effect-free pieces (parseSince, cosine,
 * chunk, frontmatter parsing) without touching the filesystem or Ollama.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSince, cosine, chunk, parseFrontmatter, cleanBody } from "./vault.mjs";
import { formatSources, uniqueSources, fmtDate } from "./ask.mjs";

// ────────────────────────────────────────────────────────────────
// parseSince
// ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-17T12:00:00.000Z");

test("parseSince: null/empty means no filter", () => {
  assert.equal(parseSince(null, NOW), null);
  assert.equal(parseSince("", NOW), null);
});

test("parseSince: relative days/weeks/months/years", () => {
  assert.equal(parseSince("30d", NOW).toISOString().slice(0, 10), "2026-05-18");
  assert.equal(parseSince("2w", NOW).toISOString().slice(0, 10), "2026-06-03");
  assert.equal(parseSince("6m", NOW).toISOString().slice(0, 10), "2025-12-17");
  assert.equal(parseSince("2y", NOW).toISOString().slice(0, 10), "2024-06-17");
});

test("parseSince: absolute ISO date", () => {
  assert.equal(parseSince("2026-01-01", NOW).toISOString().slice(0, 10), "2026-01-01");
});

test("parseSince: garbage throws", () => {
  assert.throws(() => parseSince("banana", NOW), /Invalid --since/);
});

// ────────────────────────────────────────────────────────────────
// cosine
// ────────────────────────────────────────────────────────────────

test("cosine: identical vectors → 1", () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});

test("cosine: orthogonal vectors → 0", () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test("cosine: opposite vectors → -1", () => {
  assert.ok(Math.abs(cosine([1, 1], [-1, -1]) + 1) < 1e-9);
});

test("cosine: zero vector → 0 (no NaN)", () => {
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

// ────────────────────────────────────────────────────────────────
// chunk
// ────────────────────────────────────────────────────────────────

test("chunk: short text is a single chunk", () => {
  const c = chunk("a short tweet", { size: 800 });
  assert.deepEqual(c, ["a short tweet"]);
});

test("chunk: empty text → no chunks", () => {
  assert.deepEqual(chunk("   "), []);
});

test("chunk: long text splits into multiple overlapping chunks", () => {
  const para = "word ".repeat(60).trim(); // ~300 chars
  const text = [para, para, para, para].join("\n\n"); // ~1200 chars
  const c = chunk(text, { size: 400, overlap: 50 });
  assert.ok(c.length > 1, "expected multiple chunks");
  assert.ok(c.every((x) => x.length <= 500), "chunks roughly bounded by size");
});

test("chunk: a single oversized paragraph is hard-split", () => {
  const big = "x".repeat(2000);
  const c = chunk(big, { size: 500, overlap: 50 });
  assert.ok(c.length >= 4, "oversized paragraph splits on char boundaries");
});

// ────────────────────────────────────────────────────────────────
// parseFrontmatter
// ────────────────────────────────────────────────────────────────

const SAMPLE = `---
type: tweet
source: https://x.com/dmokafa/status/2066400400308154773
author: "@dmokafa"
created: 2026-06-15T06:00:21.000Z
tweet_id: '2066400400308154773'
long_form: true
media:
  - https://pbs.twimg.com/media/HK1UNqlWAAArGSH.jpg
tags: []
---

# Tweet by @dmokafa

Some content here.

---
[Original tweet](https://x.com/dmokafa/status/2066400400308154773)
`;

test("parseFrontmatter: scalars, quotes, block lists, empty lists", () => {
  const { meta } = parseFrontmatter(SAMPLE);
  assert.equal(meta.type, "tweet");
  assert.equal(meta.author, "@dmokafa"); // quotes stripped
  assert.equal(meta.created, "2026-06-15T06:00:21.000Z");
  assert.deepEqual(meta.media, ["https://pbs.twimg.com/media/HK1UNqlWAAArGSH.jpg"]);
  assert.deepEqual(meta.tags, []);
});

test("cleanBody: strips heading and footer", () => {
  const { body } = parseFrontmatter(SAMPLE);
  const cleaned = cleanBody(body);
  assert.equal(cleaned, "Some content here.");
});

test("parseFrontmatter: no frontmatter returns body as-is", () => {
  const { meta, body } = parseFrontmatter("just text, no fm");
  assert.deepEqual(meta, {});
  assert.equal(body, "just text, no fm");
});

// ────────────────────────────────────────────────────────────────
// Source numbering / formatting (ask.mjs)
// ────────────────────────────────────────────────────────────────

const TOP = [
  { rec: { file: "a.md", created: "2026-06-15T06:00:00.000Z", author: "@dmokafa", source: "https://x.com/dmokafa/1" }, score: 0.8 },
  { rec: { file: "a.md", created: "2026-06-15T06:00:00.000Z", author: "@dmokafa", source: "https://x.com/dmokafa/1" }, score: 0.7 },
  { rec: { file: "b.md", created: "2026-06-14T06:00:00.000Z", author: "@satyanadella", source: "https://x.com/satyanadella/2" }, score: 0.4 },
];

test("fmtDate: ISO → date only; empty → 'undated'", () => {
  assert.equal(fmtDate("2026-06-15T06:00:00.000Z"), "2026-06-15");
  assert.equal(fmtDate(""), "undated");
});

test("uniqueSources: dedups by file, numbers in rank order", () => {
  const { list, numByFile } = uniqueSources(TOP);
  assert.equal(list.length, 2); // two chunks of a.md collapse to one source
  assert.equal(numByFile.get("a.md"), 1);
  assert.equal(numByFile.get("b.md"), 2);
});

test("formatSources: numbered, deduped, bare URL on its own line", () => {
  const out = formatSources(TOP);
  const lines = out.split("\n");
  // [1] header, indented URL, [2] header, indented URL → 4 lines, no dup of a.md
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^\[1\] 2026-06-15 · @dmokafa$/);
  assert.equal(lines[1], "    https://x.com/dmokafa/1");
  assert.match(lines[2], /^\[2\] 2026-06-14 · @satyanadella$/);
  assert.equal(lines[3], "    https://x.com/satyanadella/2");
});
