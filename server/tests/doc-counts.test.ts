import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDocCounts, findCountClaims } from '../scripts/check-doc-counts.mjs';

// G7: the README / SVG counts of slash commands and MCP tools are checked against their sources
// (commands/*.md and the server.tool( registrations in server/src/index.ts).

const pluginRoot = path.resolve(import.meta.dirname, '..', '..');

describe('doc counts (G7)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-doccounts-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads every phrasing the READMEs and SVGs use, in both languages', () => {
    const cases: Array<[string, 'commands' | 'tools', number]> = [
      ['[![x](https://img.shields.io/badge/Slash%20Commands-21-0EA5E9)]', 'commands', 21],
      ['](#visual-map-of-all-21-commands)', 'commands', 21],
      ['| **`21`** Slash Commands |', 'commands', 21],
      ['### Visual Map of All 21 Commands', 'commands', 21],
      ['# 21 slash commands (/ag-login .. /ag-update)', 'commands', 21],
      ['>21 Slash Commands<', 'commands', 21],
      ['[![x](https://img.shields.io/badge/MCP%20Tools-12-6B4FBB)]', 'tools', 12],
      ['| **`12`** MCP Tools |', 'tools', 12],
      ['### 12 Exposed MCP Tools (`antigravity-delegate` v1.4.0)', 'tools', 12],
      ['# Live healthcheck & Stdio MCP verifier (all 12 MCP tools)', 'tools', 12],
      ['](#한눈에-보는-21개-슬래시-커맨드-지도)', 'commands', 21],
      ['| 슬래시 커맨드 **`21`종** |', 'commands', 21],
      ['21개 커맨드를 외울 필요 없습니다.', 'commands', 21],
      ['# 21종 슬래시 커맨드 (/ag-login .. /ag-update)', 'commands', 21],
      ['| 내장 MCP Tool **`12`종** |', 'tools', 12],
      ['12개 MCP Tool이 출력되면', 'tools', 12],
      ['### 노출 MCP Tools 12종 (`antigravity-delegate` v1.4.0)', 'tools', 12],
      ['# 라이브 헬스체크 및 Stdio MCP 검증 스크립트 (MCP Tool 12종)', 'tools', 12],
      ['| `SPC-001` | MCP Tool 12종 입출력 스키마 |', 'tools', 12],
      // the genitive particle (Grok leg): "21개의 …", "12개의 …"
      ['21개의 슬래시 커맨드를 제공합니다', 'commands', 21],
      ['12개의 MCP Tool이 노출됩니다', 'tools', 12],
    ];
    for (const [text, kind, value] of cases) {
      expect(findCountClaims(text), text).toEqual([{ kind, value }]);
    }
    // One line, both kinds
    expect(findCountClaims('🔌 플러그인<br/>MCP 12종 · 커맨드 21종')).toEqual([
      { kind: 'tools', value: 12 },
      { kind: 'commands', value: 21 },
    ]);
  });

  it('ignores numbers that are not counts of commands or tools', () => {
    for (const text of [
      'Ubuntu · macOS · Windows × Node 20/22',
      '/ag-jobs ag-20261123-133015-a57f',
      'vitest 5.1 · zod 4.6 · MCP 1.27',
      '1. Auto Git Snapshot (Undo Safe)',
      'Step 2: run the commands below',
      'MCP SDK 1.27 tools',
      // other nouns that share the words: the API worker's functions, a code block, an ordinal
      'Embedded `@google/genai` 4-tool autonomous loop (`read_file`, `write_file`)',
      '`@google/genai` SDK와 4개 Tool(`read_file`, `write_file`, `list_dir`, `run_command`)',
      'Copy-paste 1 command block',
      '### 2.1 Tool 1: `delegate_to_antigravity`',
      // instructions, not totals (Grok leg)
      'Run these 3 commands to reset it',
      'the following 2 commands fix it',
    ]) {
      expect(findCountClaims(text), text).toEqual([]);
    }
  });

  it('passes on this repository: every stated count matches its source', () => {
    const res = checkDocCounts(pluginRoot);
    expect(res.mismatches).toEqual([]);
    expect(res.actual.commands).toBe(fs.readdirSync(path.join(pluginRoot, 'commands')).filter((f) => f.endsWith('.md')).length);
    expect(res.claims.commands).toBeGreaterThanOrEqual(res.minimum);
    expect(res.claims.tools).toBeGreaterThanOrEqual(res.minimum);
  });

  it('reports a stale count with its file and line', () => {
    fs.mkdirSync(path.join(tmpRoot, 'commands'));
    for (const name of ['a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(tmpRoot, 'commands', name), '');
    fs.mkdirSync(path.join(tmpRoot, 'server', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'server', 'src', 'index.ts'), 'server.tool(\n"a");\nserver.tool(\n"b");\n');
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), 'intro\nAll 3 slash commands and 2 MCP tools.\nNow 4 slash commands!\n');

    const res = checkDocCounts(tmpRoot, { minimum: 1 });
    expect(res.actual).toEqual({ commands: 3, tools: 2 });
    expect(res.mismatches).toEqual(['README.md:3 states 4 commands; the source has 3']);
  });
});
