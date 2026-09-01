/**
 * retrieve.test.mjs — unit tests for the retrieval core.
 *
 *   node --test retrieve.test.mjs
 *
 * Two halves:
 *   - `rankMatches`, pure, no I/O. It had no coverage at all, including the
 *     silent drop of undated records that bites whenever --since is set.
 *   - `loadIndex`, which touches the disk. Real index files are written to a
 *     temp dir; no Ollama needed. `retrieve()` itself is not covered here —
 *     it embeds the question, which needs a live model.
 */

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rankMatches, loadIndex, clearIndexCache } from "./retrieve.mjs";

// ────────────────────────────────────────────────────────────────
// rankMatches
// ────────────────────────────────────────────────────────────────

// Unit vectors along the axes: cosine against [1,0,0] is exactly the first
// component, so expected scores are obvious by inspection.
const rec = (file, created, vector) => ({ file, created, vector, text: file });
const QUERY = [1, 0, 0];

test("rankMatches: sorts by similarity, honours k", () => {
  const records = [
    rec("far", "2026-01-01", [0, 1, 0]), // 0.0
    rec("near", "2026-01-01", [1, 0, 0]), // 1.0
    rec("mid", "2026-01-01", [1, 1, 0]), // ~0.707
  ];
  const { top, dropped } = rankMatches(records, QUERY, null, 2);
  assert.deepEqual(
    top.map((t) => t.rec.file),
    ["near", "mid"],
  );
  assert.equal(dropped, 0);
});

test("rankMatches: ties break on the most recent created", () => {
  const records = [
    rec("old", "2020-01-01", [1, 0, 0]),
    rec("new", "2026-06-01", [1, 0, 0]),
    rec("middle", "2023-01-01", [1, 0, 0]),
  ];
  const { top } = rankMatches(records, QUERY, null, 3);
  assert.deepEqual(
    top.map((t) => t.rec.file),
    ["new", "middle", "old"],
  );
});

test("rankMatches: a real score gap wins over recency", () => {
  const records = [
    rec("recent-but-irrelevant", "2026-06-01", [0, 1, 0]),
    rec("old-but-relevant", "2001-01-01", [1, 0, 0]),
  ];
  const { top } = rankMatches(records, QUERY, null, 2);
  assert.equal(top[0].rec.file, "old-but-relevant");
});

test("rankMatches: no cutoff drops nothing, not even undated records", () => {
  const records = [rec("dated", "2026-01-01", [1, 0, 0]), rec("undated", "", [1, 0, 0])];
  const { top, dropped } = rankMatches(records, QUERY, null, 10);
  assert.equal(dropped, 0);
  assert.equal(top.length, 2);
});

test("rankMatches: a cutoff drops out-of-window AND undated records", () => {
  const records = [
    rec("in-window", "2026-05-01", [1, 0, 0]),
    rec("too-old", "2020-01-01", [1, 0, 0]),
    rec("undated", "", [1, 0, 0]),
    rec("garbage-date", "not-a-date", [1, 0, 0]),
  ];
  const { top, dropped } = rankMatches(records, QUERY, new Date("2026-01-01"), 10);
  assert.deepEqual(
    top.map((t) => t.rec.file),
    ["in-window"],
  );
  // The undated ones are the reason loadVault will fall back to mtime later.
  assert.equal(dropped, 3);
});

test("rankMatches: Float32Array vectors score the same as plain arrays", () => {
  const plain = [rec("a", "2026-01-01", [1, 1, 0]), rec("b", "2026-01-01", [1, 0, 0])];
  const typed = plain.map((r) => ({ ...r, vector: Float32Array.from(r.vector) }));

  const a = rankMatches(plain, QUERY, null, 2);
  const b = rankMatches(typed, QUERY, null, 2);

  assert.deepEqual(
    a.top.map((t) => t.rec.file),
    b.top.map((t) => t.rec.file),
  );
  for (let i = 0; i < a.top.length; i++) {
    assert.ok(Math.abs(a.top[i].score - b.top[i].score) < 1e-6);
  }
});

test("rankMatches: empty records is not an error", () => {
  const { top, dropped } = rankMatches([], QUERY, null, 8);
  assert.deepEqual(top, []);
  assert.equal(dropped, 0);
});

// ────────────────────────────────────────────────────────────────
// loadIndex — caching and vector conversion
// ────────────────────────────────────────────────────────────────

let dir;
const written = [];

async function writeIndex(name, records) {
  if (!dir) dir = await mkdtemp(join(tmpdir(), "retrieve-test-"));
  const path = join(dir, name);
  await writeFile(path, JSON.stringify({ embedder: "test:1", dims: 3, records }), "utf-8");
  written.push(path);
  return path;
}

// The cache is module-level state — reset it so tests don't leak into each other.
beforeEach(() => clearIndexCache());

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("loadIndex: a missing file throws NO_INDEX", async () => {
  await assert.rejects(() => loadIndex(join(tmpdir(), "definitely-not-here-9e3f.json")), (e) => {
    assert.equal(e.code, "NO_INDEX");
    return true;
  });
});

test("loadIndex: invalid JSON throws BAD_INDEX and is not cached", async () => {
  if (!dir) dir = await mkdtemp(join(tmpdir(), "retrieve-test-"));
  const path = join(dir, "half-written.json");
  await writeFile(path, '{"records": [{"vec', "utf-8"); // an scp still in flight

  await assert.rejects(() => loadIndex(path), (e) => {
    assert.equal(e.code, "BAD_INDEX");
    return true;
  });

  // Once the copy finishes, the very next call succeeds — nothing bad was cached.
  await writeFile(path, JSON.stringify({ embedder: "test:1", records: [] }), "utf-8");
  const index = await loadIndex(path);
  assert.deepEqual(index.records, []);
});

test("loadIndex: vectors come back as Float32Array", async () => {
  const path = await writeIndex("vectors.json", [rec("a", "2026-01-01", [0.5, 0.25, 0])]);
  const index = await loadIndex(path);
  assert.ok(index.records[0].vector instanceof Float32Array);
  assert.equal(index.records[0].vector.length, 3);
  assert.ok(Math.abs(index.records[0].vector[0] - 0.5) < 1e-6);
});

test("loadIndex: a second call reuses the parsed index, it does not re-read", async () => {
  const path = await writeIndex("cached.json", [rec("a", "2026-01-01", [1, 0, 0])]);
  const first = await loadIndex(path);
  const second = await loadIndex(path);
  // Same object identity: the file was parsed once.
  assert.equal(first, second);
});

test("loadIndex: a changed file invalidates the cache", async () => {
  const path = await writeIndex("changing.json", [rec("before", "2026-01-01", [1, 0, 0])]);
  const first = await loadIndex(path);
  assert.equal(first.records[0].file, "before");

  await writeFile(
    path,
    JSON.stringify({
      embedder: "test:1",
      records: [rec("after", "2026-01-01", [1, 0, 0]), rec("extra", "2026-01-01", [0, 1, 0])],
    }),
    "utf-8",
  );
  // Force a distinct mtime: two writes can land in the same millisecond.
  const future = new Date(Date.now() + 5000);
  await utimes(path, future, future);

  const second = await loadIndex(path);
  assert.notEqual(first, second);
  assert.equal(second.records[0].file, "after");
  assert.equal(second.records.length, 2);
});

test("loadIndex: a same-size rewrite is still noticed via mtime", async () => {
  const path = await writeIndex("samesize.json", [rec("aaa", "2026-01-01", [1, 0, 0])]);
  const first = await loadIndex(path);
  const before = await stat(path);

  // "bbb" is the same length as "aaa", so size alone would not spot the change.
  await writeFile(
    path,
    JSON.stringify({ embedder: "test:1", dims: 3, records: [rec("bbb", "2026-01-01", [1, 0, 0])] }),
    "utf-8",
  );
  const after = await stat(path);
  assert.equal(after.size, before.size);
  const future = new Date(Date.now() + 5000);
  await utimes(path, future, future);

  const second = await loadIndex(path);
  assert.notEqual(first, second);
  assert.equal(second.records[0].file, "bbb");
});

test("loadIndex: different paths are cached independently", async () => {
  const one = await writeIndex("corpus-one.json", [rec("one", "2026-01-01", [1, 0, 0])]);
  const two = await writeIndex("corpus-two.json", [rec("two", "2026-01-01", [0, 1, 0])]);

  const a = await loadIndex(one);
  const b = await loadIndex(two);
  assert.notEqual(a, b);
  assert.equal(a.records[0].file, "one");
  assert.equal(b.records[0].file, "two");

  // And both stay cached: this is what lets one process serve several corpora.
  assert.equal(await loadIndex(one), a);
  assert.equal(await loadIndex(two), b);
});

test("loadIndex: an index with no records array does not blow up", async () => {
  if (!dir) dir = await mkdtemp(join(tmpdir(), "retrieve-test-"));
  const path = join(dir, "no-records.json");
  await writeFile(path, JSON.stringify({ embedder: "test:1" }), "utf-8");
  const index = await loadIndex(path);
  assert.equal(index.embedder, "test:1");
});
