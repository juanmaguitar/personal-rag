/**
 * karakeep.test.mjs — unit tests for the Karakeep source adapter.
 *
 *   node --test karakeep.test.mjs
 *
 * Only bookmarkToDoc is tested: it's the whole mapping, it's pure, and it runs
 * without an API key or network. loadKarakeep is thin transport around it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { bookmarkToDoc } from "./karakeep.mjs";

// A full link bookmark, shaped like the API's documented response.
const LINK = {
  id: "bk_abc123",
  createdAt: "2026-08-23T10:00:00.000Z",
  title: "Why microservices get expensive",
  summary: "Network hops and operational overhead dominate past a certain size.",
  note: "Relevant to the platform rewrite.",
  tags: [
    { id: "t1", name: "architecture", attachedBy: "ai" },
    { id: "t2", name: "costs", attachedBy: "human" },
  ],
  content: {
    type: "link",
    url: "https://example.com/microservices",
    title: "Why microservices get expensive",
    description: "A short lede that repeats the opening paragraph.",
    author: "Jane Roe",
    publisher: "Example Weekly",
    datePublished: "2026-08-20T00:00:00.000Z",
    htmlContent: "<h2>The hidden bill</h2><p>Every call becomes a <strong>network</strong> call.</p>",
  },
};

test("bookmarkToDoc: maps a full link bookmark", () => {
  const doc = bookmarkToDoc(LINK);

  assert.equal(doc.file, "bk_abc123");
  assert.equal(doc.meta.source, "https://example.com/microservices");
  assert.equal(doc.meta.author, "Jane Roe");
  assert.equal(doc.meta.type, "link");
  assert.deepEqual(doc.meta.tags, ["architecture", "costs"]);
});

test("bookmarkToDoc: datePublished wins over createdAt for `created`", () => {
  const doc = bookmarkToDoc(LINK);
  assert.equal(doc.meta.created, "2026-08-20T00:00:00.000Z");
  assert.equal(doc.meta.captured, "2026-08-23T10:00:00.000Z");
});

test("bookmarkToDoc: falls back to createdAt when datePublished is missing", () => {
  const { datePublished, ...content } = LINK.content;
  const doc = bookmarkToDoc({ ...LINK, content });
  assert.equal(doc.meta.created, "2026-08-23T10:00:00.000Z");
});

test("bookmarkToDoc: html becomes markdown, title survives as a heading", () => {
  const doc = bookmarkToDoc(LINK);
  assert.match(doc.body, /^# Why microservices get expensive/);
  assert.match(doc.body, /## The hidden bill/);
  assert.match(doc.body, /\*\*network\*\*/);
  assert.doesNotMatch(doc.body, /<p>/);
});

test("bookmarkToDoc: summary and note are embedded, description is not when there's an article", () => {
  const doc = bookmarkToDoc(LINK);
  assert.match(doc.body, /Network hops and operational overhead/);
  assert.match(doc.body, /Relevant to the platform rewrite/);
  assert.doesNotMatch(doc.body, /A short lede/);
});

test("bookmarkToDoc: separately fetched asset html overrides the (absent) inline content", () => {
  const { htmlContent, ...content } = LINK.content;
  const doc = bookmarkToDoc({ ...LINK, content }, { html: "<p>From the asset.</p>" });
  assert.match(doc.body, /From the asset\./);
});

test("bookmarkToDoc: no article falls back to description, still yields a body", () => {
  const doc = bookmarkToDoc({
    id: "bk_empty",
    createdAt: "2026-08-23T10:00:00.000Z",
    title: "Uncrawled page",
    tags: [{ id: "t3", name: "todo" }],
    content: { type: "link", url: "https://example.com/x", description: "Only a lede." },
  });
  assert.match(doc.body, /# Uncrawled page/);
  assert.match(doc.body, /Only a lede\./);
  assert.match(doc.body, /Tags: todo/);
});

test("bookmarkToDoc: a bookmark with nothing at all yields an empty body, not a crash", () => {
  const doc = bookmarkToDoc({ id: "bk_bare", createdAt: "2026-08-23T10:00:00.000Z" });
  assert.equal(doc.file, "bk_bare");
  assert.equal(doc.body, "");
  assert.deepEqual(doc.meta.tags, []);
  assert.equal(doc.meta.type, "bookmark");
});

test("bookmarkToDoc: malformed html does not throw", () => {
  const doc = bookmarkToDoc({
    id: "bk_bad",
    createdAt: "2026-08-23T10:00:00.000Z",
    title: "Broken",
    content: { type: "link", url: "https://example.com/y", htmlContent: "<div><p>unclosed" },
  });
  assert.match(doc.body, /# Broken/);
});

test("bookmarkToDoc: publisher stands in when the author is unknown", () => {
  const { author, ...content } = LINK.content;
  const doc = bookmarkToDoc({ ...LINK, content });
  assert.equal(doc.meta.author, "Example Weekly");
});

// ────────────────────────────────────────────────────────────────
// Binary stripping
//
// Karakeep inlines images as base64 data URIs. Measured on the real
// collection these are ~77% of all content by volume, so this is the
// difference between a usable index and one drowned in binary.
// ────────────────────────────────────────────────────────────────

const B64 = "iVBORw0KGgoAAAANSUhEUg" + "QUJDRUZHSElKS0xNTk9QUVJTVFVWV1hZWg".repeat(8);

test("bookmarkToDoc: base64 images are dropped, surrounding prose survives", () => {
  const doc = bookmarkToDoc({
    id: "bk_img",
    createdAt: "2026-08-23T10:00:00.000Z",
    title: "Post",
    content: {
      type: "link",
      url: "https://x.com/someone/status/1",
      htmlContent: `<p>The actual point of the post.</p><img src="data:image/png;base64,${B64}"><p>And the follow-up.</p>`,
    },
  });
  assert.match(doc.body, /The actual point of the post\./);
  assert.match(doc.body, /And the follow-up\./);
  assert.doesNotMatch(doc.body, /iVBORw0KGgo/);
  assert.ok(doc.body.length < 200, `body should be prose-sized, got ${doc.body.length}`);
});

test("bookmarkToDoc: a bare base64 run in the text is stripped too", () => {
  const doc = bookmarkToDoc({
    id: "bk_blob",
    createdAt: "2026-08-23T10:00:00.000Z",
    title: "Blob",
    content: { type: "link", url: "https://example.com/z", htmlContent: `<p>before ${B64} after</p>` },
  });
  assert.match(doc.body, /before/);
  assert.match(doc.body, /after/);
  assert.doesNotMatch(doc.body, /iVBORw0KGgo/);
});

test("bookmarkToDoc: ordinary long URLs and prose are NOT stripped", () => {
  const url = "https://example.com/a/very/long/path/that-goes-on-and-on/with-many-segments/and-a-query?x=1&y=2";
  const doc = bookmarkToDoc({
    id: "bk_url",
    createdAt: "2026-08-23T10:00:00.000Z",
    title: "Links",
    content: {
      type: "link",
      url: "https://example.com/w",
      htmlContent: `<p>See <a href="${url}">${url}</a> for details.</p>`,
    },
  });
  assert.match(doc.body, /very\/long\/path/);
  assert.match(doc.body, /for details\./);
});

test("bookmarkToDoc: script and style content never reaches the index", () => {
  const doc = bookmarkToDoc({
    id: "bk_js",
    createdAt: "2026-08-23T10:00:00.000Z",
    title: "Page",
    content: {
      type: "link",
      url: "https://example.com/v",
      htmlContent: `<style>.a{color:red}</style><p>Real text.</p><script>alert(1)</script>`,
    },
  });
  assert.match(doc.body, /Real text\./);
  assert.doesNotMatch(doc.body, /color:red/);
  assert.doesNotMatch(doc.body, /alert\(1\)/);
});

test("bookmarkToDoc: an image inside a link leaves no data: URI residue", () => {
  // turndown's built-in `image` rule beats remove(); this covers the addRule fix.
  const doc = bookmarkToDoc({
    id: "bk_linkimg",
    createdAt: "2026-08-23T10:00:00.000Z",
    title: "Repo",
    content: {
      type: "link",
      url: "https://github.com/x/y",
      htmlContent:
        `<p><a href="https://github.com/x/y/banner"><img alt="Banner" src="data:image/webp;base64,${B64}"></a></p>` +
        `<p>The readme text.</p>`,
    },
  });
  assert.match(doc.body, /The readme text\./);
  assert.doesNotMatch(doc.body, /data:image/);
  assert.doesNotMatch(doc.body, /base64/);
});
