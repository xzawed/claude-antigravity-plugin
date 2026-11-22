import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureBridgeDirs,
  ensureDefaultConfig,
  ensureGitignoreEntry,
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
  gitignoreUpdated: boolean;
  syncedTemplates: string[];
  skippedCustomTemplates: string[];
} {
  const pluginRoot = options.pluginRoot ?? getDefaultPluginRoot();
  ensureBridgeDirs(options.workspaceRoot);
  const configRes = ensureDefaultConfig(options.workspaceRoot);
  const gitignoreRes = ensureGitignoreEntry(options.workspaceRoot);
  const templateRes = syncHandoffTemplate(options.workspaceRoot, pluginRoot, {
    force: options.forceTemplate,
  });

  return {
    configCreated: configRes.created,
    gitignoreUpdated: gitignoreRes.updated,
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
    } else if (arg === '--workspace' && argv[i + 1]) {
      workspaceRoot = path.resolve(argv[i + 1]);
      i += 1;
    }
  }

  return { workspaceRoot, silent, forceTemplate };
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const result = runCliInit(opts);
    if (!opts.silent) {
      console.error(
        `[antigravity-delegate] Initialized workspace ${opts.workspaceRoot} (configCreated=${result.configCreated}, gitignoreUpdated=${result.gitignoreUpdated}, templatesSynced=${result.syncedTemplates.length})`,
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
