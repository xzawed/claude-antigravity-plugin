import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/cli-init.ts
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// src/bridge-fs.ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// src/types.ts
var TEMPLATE_VERSION = "1.0.0";
var AgPluginError = class extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.name = "AgPluginError";
    this.code = code;
    this.details = details;
  }
};
var DEFAULT_BRIDGE_CONFIG = {
  execution_mode: "auto",
  git_guard: "best_effort",
  subscription: {
    app_path: "auto",
    trigger_method: "cli_or_ipc",
    timeout_sec: 300,
    poll_interval_ms: 2e3,
    agy_mode: "accept-edits",
    agy_sandbox: true,
    agy_dangerously_skip_permissions: false,
    agy_stream_heartbeat: true
  },
  api: {
    api_key_env: "GEMINI_API_KEY",
    model: "gemini-2.5-pro",
    max_turns: 15,
    command_timeout_sec: 60
  }
};

// src/bridge-fs.ts
var BRIDGE_DIR_NAME = ".ag-bridge";
var SAFE_TASK_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
function assertSafeTaskId(taskId) {
  const trimmed = taskId.trim();
  if (!trimmed || !SAFE_TASK_ID_RE.test(trimmed) || trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    throw new AgPluginError(
      "PATH_TRAVERSAL_BLOCKED",
      `Invalid taskId "${taskId}": must match ${SAFE_TASK_ID_RE.source} without path traversal segments.`
    );
  }
  return trimmed;
}
function getBridgeDir(workspaceRoot) {
  return path.join(workspaceRoot, BRIDGE_DIR_NAME);
}
function getArtifactsDir(workspaceRoot, taskId) {
  const base = path.join(getBridgeDir(workspaceRoot), "artifacts");
  return taskId ? path.join(base, assertSafeTaskId(taskId)) : base;
}
function getHistoryDir(workspaceRoot) {
  return path.join(getBridgeDir(workspaceRoot), "history");
}
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
  }
}
function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  fs.writeFileSync(tmpPath, content, "utf8");
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = err?.code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        sleepSync(50 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  try {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  } catch {
  }
  throw lastErr;
}
function ensureBridgeDirs(workspaceRoot) {
  fs.mkdirSync(getBridgeDir(workspaceRoot), { recursive: true });
  fs.mkdirSync(getArtifactsDir(workspaceRoot), { recursive: true });
  fs.mkdirSync(getHistoryDir(workspaceRoot), { recursive: true });
}
function isGitignoreProtected(workspaceRoot) {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    return false;
  }
  const lines = fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/).map((line) => line.trim());
  return lines.some((line) => line === ".ag-bridge" || line === ".ag-bridge/" || line === "/.ag-bridge/");
}
function ensureGitignoreEntry(workspaceRoot) {
  if (isGitignoreProtected(workspaceRoot)) {
    return { updated: false, protected: true };
  }
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  const block = "# Antigravity Claude Bridge (local session artifacts)\n.ag-bridge/\n";
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, block, "utf8");
    return { updated: true, protected: true };
  }
  const existing = fs.readFileSync(gitignorePath, "utf8");
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const addition = `${needsLeadingNewline ? "\n\n" : existing.length > 0 ? "\n" : ""}${block}`;
  fs.appendFileSync(gitignorePath, addition, "utf8");
  return { updated: true, protected: true };
}
function ensureDefaultConfig(workspaceRoot) {
  ensureBridgeDirs(workspaceRoot);
  const configPath = path.join(getBridgeDir(workspaceRoot), "config.json");
  if (fs.existsSync(configPath)) {
    return { created: false, path: configPath };
  }
  const initialConfig = {
    execution_mode: DEFAULT_BRIDGE_CONFIG.execution_mode,
    git_guard: DEFAULT_BRIDGE_CONFIG.git_guard,
    subscription: { ...DEFAULT_BRIDGE_CONFIG.subscription },
    api: { ...DEFAULT_BRIDGE_CONFIG.api }
  };
  atomicWriteFile(configPath, `${JSON.stringify(initialConfig, null, 2)}
`);
  return { created: true, path: configPath };
}
function extractTemplateVersion(content) {
  const match = content.match(/<!--\s*ag-plugin-template-version:\s*([^\s>]+)\s*-->/);
  return match ? match[1] : null;
}
function syncHandoffTemplate(workspaceRoot, pluginRoot, options = {}) {
  const templatePath = path.join(pluginRoot, "templates", "claude-handoff.md");
  if (!fs.existsSync(templatePath)) {
    return { syncedPaths: [], skippedCustomPaths: [] };
  }
  const templateContent = fs.readFileSync(templatePath, "utf8");
  const templateVer = extractTemplateVersion(templateContent) ?? TEMPLATE_VERSION;
  const targets = [path.join(workspaceRoot, ".agent", "workflows", "claude-handoff.md")];
  if (fs.existsSync(path.join(workspaceRoot, ".agents"))) {
    targets.push(path.join(workspaceRoot, ".agents", "workflows", "claude-handoff.md"));
  }
  const syncedPaths = [];
  const skippedCustomPaths = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      atomicWriteFile(target, templateContent);
      syncedPaths.push(target);
      continue;
    }
    const existing = fs.readFileSync(target, "utf8");
    const existingVer = extractTemplateVersion(existing);
    if (options.force) {
      atomicWriteFile(target, templateContent);
      syncedPaths.push(target);
      continue;
    }
    if (!existingVer) {
      skippedCustomPaths.push(target);
      continue;
    }
    if (existingVer !== templateVer) {
      atomicWriteFile(target, templateContent);
      syncedPaths.push(target);
    }
  }
  return { syncedPaths, skippedCustomPaths };
}

// src/cli-init.ts
function getDefaultPluginRoot() {
  const currentFile = fileURLToPath(import.meta.url);
  return path2.resolve(path2.dirname(currentFile), "..", "..");
}
function runCliInit(options) {
  const pluginRoot = options.pluginRoot ?? getDefaultPluginRoot();
  ensureBridgeDirs(options.workspaceRoot);
  const configRes = ensureDefaultConfig(options.workspaceRoot);
  const gitignoreRes = ensureGitignoreEntry(options.workspaceRoot);
  const templateRes = syncHandoffTemplate(options.workspaceRoot, pluginRoot, {
    force: options.forceTemplate
  });
  return {
    configCreated: configRes.created,
    gitignoreUpdated: gitignoreRes.updated,
    syncedTemplates: templateRes.syncedPaths,
    skippedCustomTemplates: templateRes.skippedCustomPaths
  };
}
function parseArgs(argv) {
  let workspaceRoot = process.cwd();
  let silent = false;
  let forceTemplate = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--silent") {
      silent = true;
    } else if (arg === "--force-template") {
      forceTemplate = true;
    } else if (arg === "--workspace" && argv[i + 1]) {
      workspaceRoot = path2.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return { workspaceRoot, silent, forceTemplate };
}
var isDirectExecution = process.argv[1] !== void 0 && path2.resolve(process.argv[1]) === path2.resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const result = runCliInit(opts);
    if (!opts.silent) {
      console.error(
        `[antigravity-delegate] Initialized workspace ${opts.workspaceRoot} (configCreated=${result.configCreated}, gitignoreUpdated=${result.gitignoreUpdated}, templatesSynced=${result.syncedTemplates.length})`
      );
    }
    process.exit(0);
  } catch (err) {
    if (!opts.silent) {
      console.error(
        `[antigravity-delegate] Initialization error: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
    process.exit(0);
  }
}
export {
  getDefaultPluginRoot,
  runCliInit
};
