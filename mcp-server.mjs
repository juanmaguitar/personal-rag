#!/usr/bin/env node
/**
 * mcp-server.mjs — expose the vault to Claude Code (and any MCP client) as tools.
 *
 * Two transports, same tools:
 *
 *   stdio (default)  Claude Code spawns it as a subprocess on the Mac. Nothing
 *                    leaves the machine (Ollama is still used, but only to
 *                    embed the query, never to generate).
 *   --http           a Streamable HTTP server, which is how LibreChat on the
 *                    VPS connects. Runs in its own container on the Coolify
 *                    network with no published port, so it is unreachable from
 *                    outside by construction rather than by firewall rule.
 *
 * Both tools are RETRIEVAL-ONLY by design: the client's frontier model does the
 * synthesis, so we hand it the ranked, date-scoped source chunks (with dates +
 * URLs) and let it write the answer with clickable citations.
 *
 * Register the stdio one once (user scope → every Claude Code session):
 *   claude mcp add vault-rag --scope user -- node /ABS/PATH/mcp-server.mjs
 *
 * Run the HTTP one:
 *   node mcp-server.mjs --http [--port 8770] [--host 127.0.0.1] [--index PATH]
 *
 * Tools:
 *   search_vault          semantic + date-scoped retrieval over the vault
 *   list_recent_captures  newest captures by date (no query)
 */

import { createServer as createHttpServer } from "node:http";
import { argv, env, exit } from "node:process";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { retrieve, loadIndex, INDEX_PATH } from "./retrieve.mjs";

const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : "undated");
const whoOf = (r) => r.author || r.author_name || "unknown";

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

// Number unique sources (by file) in rank order; multiple chunks of the same
// capture share one number so citations line up.
function numberSources(top) {
  const numByFile = new Map();
  for (const { rec } of top) {
    if (!numByFile.has(rec.file)) numByFile.set(rec.file, numByFile.size + 1);
  }
  return numByFile;
}

/**
 * createServer — build a fresh McpServer over one index.
 *
 * A factory, not a module-level singleton, for two reasons: the stateless HTTP
 * transport wants a new server per request, and phase 4 registers one tool per
 * corpus off the same code. Cheap to call: the parsed index is cached inside
 * retrieve.mjs, so a new server does NOT re-read the index file.
 */
export function createServer({ indexPath = INDEX_PATH, name = "vault-rag" } = {}) {
  const server = new McpServer({ name, version: "0.1.0" });

  server.registerTool(
    "search_vault",
    {
      title: "Search the knowledge vault",
      description:
        "Semantic search over the user's personal knowledge vault (captured " +
        "tweets, threads, articles), optionally scoped by recency. Returns the " +
        "most relevant source passages with their publication date and URL. " +
        "YOU synthesize the answer from these passages: cite sources by their " +
        "[n] number, prefer the most recent when they conflict, and include the " +
        "URLs so the user can open or copy them.",
      inputSchema: {
        question: z.string().describe("What to look for, in natural language."),
        since: z
          .string()
          .optional()
          .describe('Recency scope: relative "30d"/"2w"/"6m"/"2y" or an ISO date like "2026-01-01".'),
        k: z.number().int().min(1).max(50).optional().describe("Max passages to return (default 8)."),
      },
    },
    async ({ question, since, k }) => {
      let res;
      try {
        res = await retrieve({ question, since, k: k ?? 8, indexPath });
      } catch (e) {
        return textResult(`Vault search failed (${e.code ?? "ERROR"}): ${e.message}`, true);
      }
      const { top, dropped, cutoff } = res;
      const scope = cutoff
        ? ` Scope: since ${fmtDate(cutoff.toISOString())} (${dropped} out-of-window passage(s) skipped).`
        : "";

      if (!top.length) {
        return textResult(
          cutoff
            ? `No captures match "${question}" in the requested window.${scope} Suggest a wider --since.`
            : `No captures match "${question}". The vault may be empty or not indexed (\`node index.mjs\`).`,
        );
      }

      const numByFile = numberSources(top);
      const blocks = top.map(({ rec, score }) => {
        const n = numByFile.get(rec.file);
        return (
          `[${n}] ${fmtDate(rec.created)} · ${whoOf(rec)} · ${rec.source || rec.file} ` +
          `(relevance ${score.toFixed(3)})\n${rec.text}`
        );
      });
      const header = `Found ${numByFile.size} relevant source(s) for "${question}".${scope}\n` +
        `Synthesize an answer and cite by [n]:\n`;
      return textResult(`${header}\n${blocks.join("\n\n")}`);
    },
  );

  server.registerTool(
    "list_recent_captures",
    {
      title: "List recent captures",
      description:
        "List the most recently published captures in the vault (newest first), " +
        "regardless of topic. Use for 'what did I save recently?'. Returns date, " +
        "author, type, and URL per capture.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("How many to return (default 15)."),
      },
    },
    async ({ limit }) => {
      let index;
      try {
        index = await loadIndex(indexPath);
      } catch (e) {
        return textResult(`Could not read the index (${e.code ?? "ERROR"}): ${e.message}`, true);
      }
      // One entry per file (dedup chunks), newest `created` first.
      const byFile = new Map();
      for (const r of index.records) if (!byFile.has(r.file)) byFile.set(r.file, r);
      const recs = [...byFile.values()].sort((a, b) =>
        String(b.created).localeCompare(String(a.created)),
      );
      if (!recs.length) return textResult("The vault index is empty (`node index.mjs`).");

      const lines = recs.slice(0, limit ?? 15).map((r, i) => {
        const type = r.type ? ` · ${r.type}` : "";
        return `${i + 1}. ${fmtDate(r.created)} · ${whoOf(r)}${type}\n   ${r.source || r.file}`;
      });
      return textResult(`${recs.length} capture(s) in the vault. Most recent:\n\n${lines.join("\n")}`);
    },
  );

  return server;
}

// ────────────────────────────────────────────────────────────────
// HTTP transport
// ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8770;

/**
 * startHttpServer — serve MCP over Streamable HTTP.
 *
 * Stateless (`sessionIdGenerator: undefined`): a fresh server + transport per
 * request, nothing kept between them. No sessions to leak, no state to lose on
 * restart, and any request is self-contained. `enableJsonResponse` returns
 * plain JSON instead of an SSE stream, which is what makes this curl-testable.
 *
 * Binds 127.0.0.1 by default. In the container it is given 0.0.0.0, which is
 * safe there because the port is never published to the host.
 */
export function startHttpServer({
  port = DEFAULT_PORT,
  host = "127.0.0.1",
  indexPath = INDEX_PATH,
  allowedHosts,
} = {}) {
  // DNS-rebinding protection: only serve requests whose Host header we expect.
  // In Coolify that is the service name (MCP_ALLOWED_HOSTS); locally, loopback.
  //
  // Resolved lazily, from the port actually bound: with `port: 0` the real port
  // is only known after listen(), and building the list up front rejects every
  // request including the legitimate ones.
  let hosts;
  const hostsFor = () => {
    if (hosts) return hosts;
    const bound = http.address()?.port ?? port;
    hosts = allowedHosts ?? [
      `localhost:${bound}`,
      `127.0.0.1:${bound}`,
      `[::1]:${bound}`,
      ...(env.MCP_ALLOWED_HOSTS ? env.MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim()) : []),
    ];
    return hosts;
  };

  const http = createHttpServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    // Liveness for the container healthcheck. Hit it on 127.0.0.1, not
    // "localhost", which resolves to ::1 on Alpine and refuses the connection.
    if (path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, index: indexPath }));
      return;
    }

    if (path !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: hostsFor(),
    });
    const server = createServer({ indexPath });

    // Per-request lifecycle: tear both down when the response ends, or they
    // accumulate one leaked server per question.
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error(`[vault-rag] request failed: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => resolve(http));
  });
}

// ────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────

export function parseArgs(args) {
  const out = {
    http: false,
    port: Number(env.MCP_HTTP_PORT || DEFAULT_PORT),
    host: env.MCP_HTTP_HOST || "127.0.0.1",
    indexPath: INDEX_PATH,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--http") out.http = true;
    else if (a === "--port") out.port = Number(args[++i]);
    else if (a === "--host") out.host = args[++i];
    else if (a === "--index") out.indexPath = args[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        `Usage: node mcp-server.mjs                       # stdio (Claude Code)\n` +
          `       node mcp-server.mjs --http [--port N] [--host H] [--index PATH]`,
      );
      exit(0);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    throw new Error(`Invalid --port: ${out.port}`);
  }
  return out;
}

async function main() {
  const { http, port, host, indexPath } = parseArgs(argv.slice(2));

  if (http) {
    await startHttpServer({ port, host, indexPath });
    console.error(`[vault-rag] MCP server ready on http://${host}:${port}/mcp (index: ${indexPath})`);
    return;
  }

  const server = createServer({ indexPath });
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel — log to stderr only.
  console.error("[vault-rag] MCP server ready on stdio.");
}

// Guarded so the tests can import createServer/startHttpServer without booting.
if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`[vault-rag] fatal: ${e.message}`);
    exit(1);
  });
}
