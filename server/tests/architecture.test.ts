import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// ARC-001 §3: imports point only to the same or a lower layer, without cycles, and the SessionStart
// hook entry (cli-init) reaches nothing but bridge-fs — so the hook bundle never pulls in git-guard
// or exec-path (it runs no program, TC-S08). A new module must be given a layer here.
const LAYERS: Record<string, number> = {
  // 0 Foundation
  types: 0,
  'exec-path': 0,
  'path-guard': 0,
  // 1 Core services
  'bridge-fs': 1,
  'git-guard': 1,
  config: 1,
  detector: 1,
  // 2 Engines
  'engines/base': 2,
  'engines/subscription': 2,
  'engines/api-worker': 2,
  // 3 Tool handlers
  auth: 3,
  jobs: 3,
  sessions: 3,
  artifacts: 3,
  'cli-admin': 3,
  // 4 Entrypoints
  index: 4,
  'cli-init': 4,
};

const srcDir = path.resolve(import.meta.dirname, '..', 'src');

function readModules(): Map<string, string[]> {
  const modules = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const id = path.relative(srcDir, full).split(path.sep).join('/').replace(/\.ts$/, '');
      const code = fs.readFileSync(full, 'utf8');
      const deps = [...code.matchAll(/from\s+'(\.{1,2}\/[^']+)\.js'/g)].map((m) =>
        path.posix.normalize(path.posix.join(path.posix.dirname(id), m[1])),
      );
      modules.set(id, [...new Set(deps)]);
    }
  };
  walk(srcDir);
  return modules;
}

describe('module layering (ARC-001 §3, TC-U33)', () => {
  it('TC-U33: every import points to the same or a lower layer, with no cycle; the hook reaches only bridge-fs', () => {
    const modules = readModules();
    const problems: string[] = [];

    for (const [id, deps] of modules) {
      if (LAYERS[id] === undefined) problems.push(`${id} has no layer (add it to LAYERS and ARC-001 §3)`);
      for (const dep of deps) {
        if (LAYERS[dep] !== undefined && LAYERS[id] !== undefined && LAYERS[dep] > LAYERS[id]) {
          problems.push(`${id} (layer ${LAYERS[id]}) imports ${dep} (layer ${LAYERS[dep]})`);
        }
      }
    }

    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'visiting') {
        problems.push(`import cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' -> ')}`);
        return;
      }
      state.set(id, 'visiting');
      for (const dep of modules.get(id) ?? []) visit(dep, [...trail, id]);
      state.set(id, 'done');
    };
    for (const id of modules.keys()) visit(id, []);

    expect(modules.get('cli-init')).toEqual(['bridge-fs']);
    expect(problems).toEqual([]);
  });
});
