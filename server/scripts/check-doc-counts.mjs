// G7 — every count of slash commands or MCP tools stated in the repository's Markdown and SVG
// files must equal its source: commands/*.md, and the server.tool( registrations in
// server/src/index.ts. Built-ins only; runs in CI's docs job without `npm ci`.
//
//   node server/scripts/check-doc-counts.mjs [repoRoot]
//
// A claim is a number written next to the noun ("21 slash commands", "Slash%20Commands-21",
// "**`12`** MCP Tools", "12-tool", "커맨드 21종", "12개 MCP Tool"). If a rewrite makes the patterns
// stop matching, the claim total drops under MINIMUM_CLAIMS and the check fails instead of
// silently checking nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MINIMUM_CLAIMS = 8;

/** Dated records: their counts were true when written, so they are not current claims. */
const HISTORICAL = new Set([
  'claude_antigravity_plugin_spec_md.md', // the original v1.0.0 specification the repo started from
  'docs/04-implementation/implementation-plan.md', // the v1.0 Phase 1-4 plan
  'docs/04-implementation/task-checklist.md', // the dated execution log
]);

const GAP = '(?:[\\s*`-]|%20)*';
// A whole number: not part of a longer number, a decimal such as "1.27", or a URL escape "%20".
const NUM = '(?<![\\d.%])(\\d+)(?!\\.?\\d)';
const COUNTER = '(?:개|종)?';

// Only slash commands and MCP tools are counted: "4-tool loop" (the API worker's functions),
// "1 command block" and "Tool 1:" (an ordinal) are other things.
const PATTERNS = [
  // "21 slash commands", "21-commands", "**`21`** Slash Commands", "21개 슬래시 커맨드"
  ['commands', new RegExp(`${NUM}${COUNTER}${GAP}(?:(?:slash|슬래시)${GAP}(?:commands?\\b|커맨드)|commands\\b|커맨드)`, 'gid')],
  // "Slash%20Commands-21", "커맨드 **`21`종**" (no \b: in "%20Commands" a digit precedes the noun)
  ['commands', new RegExp(`(?:(?<![a-z])commands|커맨드)${GAP}${NUM}`, 'gid')],
  // "12 MCP Tools", "12 Exposed MCP Tools", "12개 MCP Tool"
  ['tools', new RegExp(`${NUM}${COUNTER}${GAP}(?:exposed${GAP})?mcp${GAP}tools?\\b`, 'gid')],
  // "MCP%20Tools-12", "MCP 12종", "MCP Tool **`12`종**", "노출 MCP Tools 12종"
  ['tools', new RegExp(`(?<![a-z])mcp${GAP}(?:tools?${GAP})?${NUM}`, 'gid')],
];

/** The count claims in `text`, in order of appearance: [{ kind, value }]. */
export function findCountClaims(text) {
  const found = new Map();
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const at = m.indices[1][0];
      const key = `${kind}@${at}`;
      if (!found.has(key)) found.set(key, { kind, value: Number(m[1]), at });
    }
  }
  return [...found.values()].sort((a, b) => a.at - b.at).map(({ kind, value }) => ({ kind, value }));
}

function listDocFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(md|svg)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Count claims across the repository's .md/.svg files against the sources. */
export function checkDocCounts(root, { minimum = MINIMUM_CLAIMS } = {}) {
  const commandsDir = path.join(root, 'commands');
  const actual = {
    commands: fs.existsSync(commandsDir) ? fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md')).length : 0,
    tools: (fs.readFileSync(path.join(root, 'server', 'src', 'index.ts'), 'utf8').match(/\bserver\.tool\(/g) ?? []).length,
  };
  const claims = { commands: 0, tools: 0 };
  const mismatches = [];
  for (const file of listDocFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (HISTORICAL.has(rel)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { kind, value } of findCountClaims(line)) {
        claims[kind] += 1;
        if (value !== actual[kind]) {
          mismatches.push(`${rel}:${i + 1} states ${value} ${kind}; the source has ${actual[kind]}`);
        }
      }
    });
  }
  return { actual, claims, mismatches, minimum };
}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const res = checkDocCounts(root);
  const problems = [...res.mismatches];
  for (const kind of ['commands', 'tools']) {
    if (res.claims[kind] < res.minimum) {
      problems.push(`only ${res.claims[kind]} ${kind} claims were read (minimum ${res.minimum}) — did a rewrite outgrow the patterns?`);
    }
  }
  if (problems.length > 0) {
    console.error(`[doc-counts] FAIL\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(
      `[doc-counts] OK: ${res.claims.commands} command and ${res.claims.tools} tool counts match the sources (${res.actual.commands} commands, ${res.actual.tools} tools)`,
    );
  }
}
