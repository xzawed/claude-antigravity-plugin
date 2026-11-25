import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureBridgeDirs,
  ensureDefaultConfig,
  ensureGitignoreEntry,
  hasSymlinkInChain,
  IgnoreFile,
  syncHandoffTemplate,
} from './bridge-fs.js';

export interface CliInitOptions {
  workspaceRoot: string;
  silent: boolean;
  forceTemplate: boolean;
  pluginRoot?: string;
}

export function getDefaultPluginRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  // server/dist/cli-init.js (or server/src/cli-init.ts) -> plugin root is ../..
  return path.resolve(path.dirname(currentFile), '..', '..');
}

export function runCliInit(options: CliInitOptions): {
  configCreated: boolean;
  /** An ignore entry was added — to `.git/info/exclude` in a git work tree, else `.gitignore`. */
  ignoreUpdated: boolean;
  ignoreFile: IgnoreFile;
  syncedTemplates: string[];
  skippedCustomTemplates: string[];
} {
  const pluginRoot = options.pluginRoot ?? getDefaultPluginRoot();
  const ignoreRes = ensureGitignoreEntry(options.workspaceRoot);

  // Inside a git repo whose `.git/info/exclude` is unsafe/unwritable, avoid creating untracked files
  // that would dirty `git status`, and never write through a symlinked `.ag-bridge/`.
  if (
    (ignoreRes.file === 'git-info-exclude' && !ignoreRes.protected) ||
    hasSymlinkInChain(options.workspaceRoot, ['.ag-bridge'])
  ) {
    return {
      configCreated: false,
      ignoreUpdated: ignoreRes.updated,
      ignoreFile: ignoreRes.file,
      syncedTemplates: [],
      skippedCustomTemplates: [],
    };
  }

  ensureBridgeDirs(options.workspaceRoot);
  const configRes = ensureDefaultConfig(options.workspaceRoot);
  const templateRes = syncHandoffTemplate(options.workspaceRoot, pluginRoot, {
    force: options.forceTemplate,
  });

  return {
    configCreated: configRes.created,
    ignoreUpdated: ignoreRes.updated,
    ignoreFile: ignoreRes.file,
    syncedTemplates: templateRes.syncedPaths,
    skippedCustomTemplates: templateRes.skippedCustomPaths,
  };
}

function parseArgs(argv: string[]): CliInitOptions {
  let workspaceRoot = process.cwd();
  let silent = false;
  let forceTemplate = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--silent') {
      silent = true;
    } else if (arg === '--force-template') {
      forceTemplate = true;
    } else if (arg === '--workspace' && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      workspaceRoot = path.resolve(argv[i + 1]);
      i += 1;
    }
  }

  return { workspaceRoot, silent, forceTemplate };
}

function canonicalScriptPath(p: string): string {
  const resolved = path.resolve(p);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // keep resolved form
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  canonicalScriptPath(process.argv[1]) === canonicalScriptPath(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const result = runCliInit(opts);
    if (!opts.silent) {
      console.error(
        `[antigravity-delegate] Initialized workspace ${opts.workspaceRoot} (configCreated=${result.configCreated}, ignoreUpdated=${result.ignoreUpdated} in ${result.ignoreFile}, templatesSynced=${result.syncedTemplates.length})`,
      );
    }
    process.exit(0);
  } catch (err) {
    if (!opts.silent) {
      console.error(
        `[antigravity-delegate] Initialization error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    // SessionStart hook must never block Claude Code startup in --silent mode
    process.exit(0);
  }
}
