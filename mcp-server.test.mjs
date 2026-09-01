/**
 * mcp-server.test.mjs — the MCP frontend, over both transports.
 *
 *   node --test mcp-server.test.mjs
 *
 * Everything here runs against a tiny index written to a temp dir, so no Ollama
 * is needed for the parts that don't embed. `search_vault` DOES embed the
 * question, so its happy path is not covered here — what is covered is that the
 * tools are registered, that failures come back as typed MCP errors rather than
 * crashes, that `list_recent_captures` works end to end, and that vectors never
 * reach the wire.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, startHttpServer, parseArgs } from "./mcp-server.mjs";
import { clearIndexCache } from "./retrieve.mjs";

let dir;
let indexPath;

const record = (file, created, extra = {}) => ({
  file,
  created,
  source: `https://example.test/${file}`,
  author: "@someone",
  type: "tweet",
  chunkIndex: 0,
  hash: "deadbeef",
  text: `the body of ${file}`,
  vector: [1, 0, 0],
  ...extra,
});

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-test-"));
  indexPath = join(dir, "index.json");
  await writeFile(
    indexPath,
    JSON.stringify({
      embedder: "test:1",
      dims: 3,
      records: [
        record("oldest.md", "2024-01-01"),
        record("newest.md", "2026-08-30"),
        record("middle.md", "2025-05-05"),
        // Two chunks of the same capture must collapse into one listing entry.
        record("newest.md", "2026-08-30", { chunkIndex: 1, text: "second chunk" }),
      ],
    }),
    "utf-8",
  );
  clearIndexCache();
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// Connect a client to an in-memory pair — exercises the real tool handlers
// without a socket.
async function connectInMemory(opts = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ indexPath, ...opts });
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server };
}

// ────────────────────────────────────────────────────────────────
// createServer / tools
// ────────────────────────────────────────────────────────────────

test("createServer: registers both tools with their schemas", async () => {
  const { client, server } = await connectInMemory();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["list_recent_captures", "search_vault"]);

  const search = tools.find((t) => t.name === "search_vault");
  assert.deepEqual(Object.keys(search.inputSchema.properties).sort(), ["k", "question", "since"]);
  assert.deepEqual(search.inputSchema.required, ["question"]);

  await client.close();
  await server.close();
});

test("createServer: two servers over the same index are independent", async () => {
  const a = await connectInMemory();
  const b = await connectInMemory();
  assert.equal((await a.client.listTools()).tools.length, 2);
  assert.equal((await b.client.listTools()).tools.length, 2);
  await Promise.all([a.client.close(), b.client.close(), a.server.close(), b.server.close()]);
});

test("list_recent_captures: newest first, one entry per capture", async () => {
  const { client, server } = await connectInMemory();
  const res = await client.callTool({ name: "list_recent_captures", arguments: {} });
  const text = res.content[0].text;

  // 3 captures, not 4 records: the two chunks of newest.md collapse.
  assert.match(text, /^3 capture\(s\)/);
  const order = ["newest.md", "middle.md", "oldest.md"].map((f) => text.indexOf(f));
  assert.ok(order[0] < order[1] && order[1] < order[2], `wrong order in:\n${text}`);

  await client.close();
  await server.close();
});

test("list_recent_captures: honours limit", async () => {
  const { client, server } = await connectInMemory();
  const res = await client.callTool({ name: "list_recent_captures", arguments: { limit: 1 } });
  const text = res.content[0].text;
  assert.match(text, /newest\.md/);
  assert.doesNotMatch(text, /oldest\.md/);
  await client.close();
  await server.close();
});

test("tool output never leaks vectors", async () => {
  const { client, server } = await connectInMemory();
  const res = await client.callTool({ name: "list_recent_captures", arguments: {} });
  const text = res.content[0].text;
  // 1024 floats per chunk would be both useless to the model and huge.
  assert.doesNotMatch(text, /vector/i);
  assert.doesNotMatch(text, /\[1,\s*0,\s*0\]/);
  await client.close();
  await server.close();
});

test("a missing index comes back as an MCP error, not a crash", async () => {
  const { client, server } = await connectInMemory({
    indexPath: join(dir, "does-not-exist.json"),
  });
  const res = await client.callTool({ name: "list_recent_captures", arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NO_INDEX/);
  await client.close();
  await server.close();
});

test("search_vault reports a missing index as an error too (no Ollama needed)", async () => {
  const { client, server } = await connectInMemory({
    indexPath: join(dir, "does-not-exist.json"),
  });
  const res = await client.callTool({
    name: "search_vault",
    arguments: { question: "anything", since: "not-a-real-date-or-shorthand" },
  });
  // parseSince throws before any embedding happens, so this stays offline.
  assert.equal(res.isError, true);
  await client.close();
  await server.close();
});

// ────────────────────────────────────────────────────────────────
// HTTP transport
// ────────────────────────────────────────────────────────────────

// Keep-alive sockets from the SDK client outlive close(), and the test process
// then never exits. Drop them explicitly.
function shutdown(http) {
  http.closeAllConnections();
  http.close();
}

// A raw request, so the Host header can actually be forged. `fetch` will not
// let us set it.
function rawPost(port, { host, path = "/mcp", body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(host ? { host } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

test("HTTP transport: a real MCP client can list and call tools", async () => {
  const http = await startHttpServer({ port: 0, host: "127.0.0.1", indexPath });
  const { port } = http.address();
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  const client = new Client({ name: "test-http", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["list_recent_captures", "search_vault"]);

  const res = await client.callTool({ name: "list_recent_captures", arguments: { limit: 2 } });
  assert.match(res.content[0].text, /newest\.md/);

  await client.close();
  shutdown(http);
});

test("HTTP transport: /health answers without touching the index", async () => {
  const http = await startHttpServer({ port: 0, host: "127.0.0.1", indexPath });
  const { port } = http.address();
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  shutdown(http);
});

test("HTTP transport: unknown paths are 404, not the MCP endpoint", async () => {
  const http = await startHttpServer({ port: 0, host: "127.0.0.1", indexPath });
  const { port } = http.address();
  const r = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(r.status, 404);
  shutdown(http);
});

// Both halves matter. Asserting only the rejection passes just as happily when
// the allowlist is broken and everything is rejected — which is exactly the bug
// this test caught the first time it ran.
test("HTTP transport: the expected Host is accepted", async () => {
  const http = await startHttpServer({ port: 0, host: "127.0.0.1", indexPath });
  const { port } = http.address();
  const r = await rawPost(port, { host: `127.0.0.1:${port}`, body: INIT });
  assert.equal(r.status, 200);
  assert.match(r.text, /"protocolVersion"/);
  shutdown(http);
});

test("HTTP transport: an unexpected Host header is rejected (DNS rebinding)", async () => {
  const http = await startHttpServer({ port: 0, host: "127.0.0.1", indexPath });
  const { port } = http.address();
  const r = await rawPost(port, { host: "evil.example.com", body: INIT });
  assert.equal(r.status, 403);
  assert.match(r.text, /Invalid Host header/);
  shutdown(http);
});

test("HTTP transport: allowedHosts can be set explicitly (the Coolify service name)", async () => {
  const http = await startHttpServer({
    port: 0,
    host: "127.0.0.1",
    indexPath,
    allowedHosts: ["mcp:8770"],
  });
  const { port } = http.address();

  const ok = await rawPost(port, { host: "mcp:8770", body: INIT });
  assert.equal(ok.status, 200);

  const nope = await rawPost(port, { host: `127.0.0.1:${port}`, body: INIT });
  assert.equal(nope.status, 403);

  shutdown(http);
});

// ────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────

test("parseArgs: stdio is the default, --http opts in", () => {
  assert.equal(parseArgs([]).http, false);
  assert.equal(parseArgs(["--http"]).http, true);
});

test("parseArgs: port, host and index", () => {
  const o = parseArgs(["--http", "--port", "9999", "--host", "0.0.0.0", "--index", "/tmp/x.json"]);
  assert.equal(o.port, 9999);
  assert.equal(o.host, "0.0.0.0");
  assert.equal(o.indexPath, "/tmp/x.json");
});

test("parseArgs: a nonsense port throws rather than binding something random", () => {
  assert.throws(() => parseArgs(["--http", "--port", "banana"]), /Invalid --port/);
  assert.throws(() => parseArgs(["--http", "--port", "70000"]), /Invalid --port/);
});
