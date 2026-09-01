#!/usr/bin/env node
/**
 * ask.mjs — ask your vault a question, scoped by recency (terminal frontend).
 *
 * Usage:
 *   node ask.mjs "<question>" [--since 30d|6m|2y|YYYY-MM-DD] [--k 8]
 *                             [--no-llm] [--provider NAME] [--model NAME]
 *
 * Retrieval lives in retrieve.mjs; this file owns the CLI, the local-LLM
 * synthesis, and the terminal formatting. Answers cite sources by number
 * ([1], [2]) and the Sources block lists each one with a bare, copy-pasteable
 * URL on its own line (cmd-clickable in most terminals).
 *
 *   --since   only consider resources created on/after this point
 *             (relative: 30d/2w/6m/2y, or an ISO date like 2026-01-01)
 *   --k       how many chunks to retrieve (default 8)
 *   --no-llm  skip synthesis — print ranked, dated matches (no model needed)
 *
 * The embedding model is fixed by the index; only --model (generation) is free.
 */

import { argv, exit } from "node:process";
import { pathToFileURL } from "node:url";

import { retrieve } from "./retrieve.mjs";
import { getGenerator, DEFAULTS } from "./providers.mjs";

function parseArgs(args) {
  const out = {
    question: null,
    since: null,
    k: 8,
    noLlm: false,
    provider: DEFAULTS.provider,
    embedModel: DEFAULTS.embedModel,
    genModel: DEFAULTS.genModel,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--since") out.since = args[++i];
    else if (a === "--k") out.k = Number(args[++i]) || 8;
    else if (a === "--no-llm") out.noLlm = true;
    else if (a === "--provider") out.provider = args[++i];
    else if (a === "--model") out.genModel = args[++i];
    else if (a === "--embed-model") out.embedModel = args[++i];
    else if (a === "-h" || a === "--help") {
      console.log(
        `Usage: node ask.mjs "<question>" [--since 30d|6m|2y|YYYY-MM-DD] [--k 8]\n` +
          `                                 [--no-llm] [--provider NAME] [--model NAME]`,
      );
      exit(0);
    } else if (!out.question && !a.startsWith("--")) out.question = a;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// Formatting (pure — exported for tests)
// ────────────────────────────────────────────────────────────────

export function fmtDate(iso) {
  return iso ? String(iso).slice(0, 10) : "undated";
}

// Assign a stable citation number per unique source (by file), in the order
// they first appear in the ranked results. Multiple chunks of the same capture
// share one number, so the answer's [n] markers line up with the Sources list.
export function uniqueSources(top) {
  const numByFile = new Map();
  const list = [];
  for (const { rec } of top) {
    if (!numByFile.has(rec.file)) {
      numByFile.set(rec.file, list.length + 1);
      list.push(rec);
    }
  }
  return { list, numByFile };
}

// Numbered Sources block; bare URL on its own line for easy copy / cmd-click.
export function formatSources(top) {
  const { list } = uniqueSources(top);
  return list
    .map((r, i) => {
      const who = r.author || r.author_name || "unknown";
      const url = r.source || r.file;
      return `[${i + 1}] ${fmtDate(r.created)} · ${who}\n    ${url}`;
    })
    .join("\n");
}

// Context handed to the local model — each chunk tagged with its citation
// number + date so the model can cite [n] and prefer recent sources.
function buildContext(top) {
  const { numByFile } = uniqueSources(top);
  return top
    .map(({ rec }) => {
      const who = rec.author || rec.author_name || "unknown";
      return `[${numByFile.get(rec.file)}] (${fmtDate(rec.created)}) ${who}\n${rec.text}`;
    })
    .join("\n\n");
}

const SYSTEM_PROMPT =
  "You answer questions using ONLY the provided sources, which are personal " +
  "knowledge-vault captures. Each source is numbered and tagged with its " +
  "publication date. Rules:\n" +
  "- Ground every claim in the sources; do not invent facts.\n" +
  "- Cite sources by their number in brackets, e.g. [1], [2] — do NOT repeat " +
  "the date on every line.\n" +
  "- When sources conflict or overlap, prefer the most recent.\n" +
  "- If the sources don't actually answer the question, say so plainly.\n" +
  "- Be concise and practical.";

function scopeNote(cutoff, dropped) {
  return cutoff
    ? ` (scope: since ${fmtDate(cutoff.toISOString())}, ${dropped} out-of-window chunk${dropped === 1 ? "" : "s"} skipped)`
    : "";
}

function printMatches(top, note) {
  const { numByFile } = uniqueSources(top);
  console.log(`Top ${top.length} matches${note}:\n`);
  top.forEach(({ rec, score }) => {
    const who = rec.author || rec.author_name || "unknown";
    const snippet = rec.text.replace(/\s+/g, " ").slice(0, 200);
    console.log(`[${numByFile.get(rec.file)}] (${score.toFixed(3)}) ${fmtDate(rec.created)} · ${who}`);
    console.log(`    ${snippet}${rec.text.length > 200 ? "…" : ""}`);
    console.log(`    ${rec.source || rec.file}\n`);
  });
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (!opts.question) {
    console.error('Ask something: node ask.mjs "what are the latest Claude Code tips?"');
    exit(1);
  }

  let result;
  try {
    result = await retrieve({
      question: opts.question,
      since: opts.since,
      k: opts.k,
      provider: opts.provider,
      embedModel: opts.embedModel,
    });
  } catch (e) {
    console.error(e.message);
    exit(1);
  }

  const { top, dropped, cutoff } = result;
  const note = scopeNote(cutoff, dropped);

  if (!top.length) {
    console.log(
      cutoff
        ? `No captures in scope${note}. Try a wider --since window.`
        : `No matches found. Is the vault empty? (\`node index.mjs\`)`,
    );
    return;
  }

  if (opts.noLlm) {
    printMatches(top, note);
    return;
  }

  // Synthesis via the local model.
  const generator = getGenerator({ provider: opts.provider, model: opts.genModel });
  const userPrompt =
    `Question: ${opts.question}\n\n` +
    `Sources (most relevant first):\n\n${buildContext(top)}`;

  let answer;
  try {
    answer = await generator.generate({ system: SYSTEM_PROMPT, user: userPrompt });
  } catch (e) {
    console.error(`\n${e.message}`);
    console.error(`\nFalling back to retrieval-only (re-run with --no-llm to silence this):\n`);
    printMatches(top, note);
    exit(1);
  }

  console.log(answer);
  console.log(`\n— Sources${note} —`);
  console.log(formatSources(top));
  console.log(`\n(answered by ${generator.id})`);
}

// Run the CLI only when invoked directly, so tests can import the helpers.
if (import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    exit(1);
  });
}
