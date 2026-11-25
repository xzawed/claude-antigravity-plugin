import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/cli-init.ts
import fs2 from "node:fs";
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
var WINDOWS_RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
function assertSafeTaskId(taskId) {
  const trimmed = taskId.trim();
  if (!trimmed || !SAFE_TASK_ID_RE.test(trimmed) || trimmed === "." || trimmed === ".." || trimmed.includes("..") || trimmed.startsWith(".") || trimmed.endsWith(".") || trimmed.toLowerCase().endsWith(".lock") || WINDOWS_RESERVED_DEVICE_RE.test(trimmed)) {
    throw new AgPluginError(
      "PATH_TRAVERSAL_BLOCKED",
      `Invalid taskId "${taskId}": must match ${SAFE_TASK_ID_RE.source} without path traversal, leading/trailing dots, .lock suffix, or reserved device names.`
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
function hasSymlinkInChain(baseDir, relSegments) {
  let cursor = path.resolve(baseDir);
  for (const seg of relSegments) {
    cursor = path.join(cursor, seg);
    const st = lstatOrNull(cursor);
    if (!st) {
      return false;
    }
    if (st.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}
function assertNoSymlinkChain(baseDir, relSegments, label) {
  if (hasSymlinkInChain(baseDir, relSegments)) {
    throw new AgPluginError(
      "PATH_TRAVERSAL_BLOCKED",
      `Refusing to traverse symbolic link at ${label ?? relSegments.join("/")}.`
    );
  }
}
function ensureBridgeDirs(workspaceRoot) {
  assertNoSymlinkChain(workspaceRoot, [BRIDGE_DIR_NAME], ".ag-bridge");
  assertNoSymlinkChain(workspaceRoot, [BRIDGE_DIR_NAME, "artifacts"], ".ag-bridge/artifacts");
  assertNoSymlinkChain(workspaceRoot, [BRIDGE_DIR_NAME, "history"], ".ag-bridge/history");
  fs.mkdirSync(getBridgeDir(workspaceRoot), { recursive: true });
  fs.mkdirSync(getArtifactsDir(workspaceRoot), { recursive: true });
  fs.mkdirSync(getHistoryDir(workspaceRoot), { recursive: true });
}
var GIT_EXCLUDE_HEADER = "# antigravity-delegate: local session artifacts (kept out of the tracked .gitignore)";
var GIT_EXCLUDE_PATTERNS = [
  `${BRIDGE_DIR_NAME}/`,
  "**/.agent/workflows/claude-handoff.md",
  "**/.agents/workflows/claude-handoff.md"
];
function readTrimmedLines(file) {
  const st = lstatOrNull(file);
  if (!st || !st.isFile()) {
    return [];
  }
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim());
  } catch {
    return [];
  }
}
function hasBridgeEntry(lines) {
  return lines.some((line) => line === ".ag-bridge" || line === ".ag-bridge/" || line === "/.ag-bridge/");
}
function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}
function isGitDir(dir) {
  return Boolean(lstatOrNull(dir)?.isDirectory()) && Boolean(lstatOrNull(path.join(dir, "HEAD"))?.isFile());
}
function hasRelativeSymlinkEscape(rootDir, rawRelative) {
  if (path.isAbsolute(rawRelative)) {
    return false;
  }
  const normalized = path.normalize(rawRelative);
  const parts = normalized.split(path.sep).filter((p) => p.length > 0 && p !== ".");
  let cursor = path.resolve(rootDir);
  for (const part of parts) {
    if (part === "..") {
      cursor = path.dirname(cursor);
      continue;
    }
    cursor = path.join(cursor, part);
    if (lstatOrNull(cursor)?.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}
function commonDirFromGitFile(dotGitFile) {
  let raw;
  try {
    raw = fs.readFileSync(dotGitFile, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
  if (!match) {
    return null;
  }
  const rawGitDir = match[1];
  const baseDir = path.dirname(dotGitFile);
  if (hasRelativeSymlinkEscape(baseDir, rawGitDir)) {
    return null;
  }
  const gitDir = path.resolve(baseDir, rawGitDir);
  if (!isGitDir(gitDir)) {
    return null;
  }
  const commondirFile = path.join(gitDir, "commondir");
  const commondirStat = lstatOrNull(commondirFile);
  if (!commondirStat) {
    return gitDir;
  }
  if (!commondirStat.isFile()) {
    return null;
  }
  let rawCommon;
  try {
    rawCommon = fs.readFileSync(commondirFile, "utf8").trim();
  } catch {
    return null;
  }
  if (hasRelativeSymlinkEscape(gitDir, rawCommon)) {
    return null;
  }
  const commonDir = path.resolve(gitDir, rawCommon);
  return isGitDir(commonDir) ? commonDir : null;
}
function findEnclosingDotGit(workspaceRoot) {
  const caseFold = (p) => process.platform === "win32" ? p.toLowerCase() : p;
  const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? "").split(path.delimiter).filter(Boolean).map((dir) => caseFold(path.resolve(dir)));
  for (let dir = path.resolve(workspaceRoot); ; ) {
    const dotGit = path.join(dir, ".git");
    const stat = lstatOrNull(dotGit);
    if (stat) {
      return { dotGit, stat };
    }
    const parent = path.dirname(dir);
    if (parent === dir || ceilings.includes(caseFold(parent))) {
      return null;
    }
    dir = parent;
  }
}
function isRealGitWorkTree(workspaceRoot) {
  const found = findEnclosingDotGit(workspaceRoot);
  if (!found) return false;
  if (found.stat.isDirectory()) return isGitDir(found.dotGit);
  if (found.stat.isFile()) return commonDirFromGitFile(found.dotGit) !== null;
  return false;
}
function resolveGitExcludePath(workspaceRoot) {
  const found = findEnclosingDotGit(workspaceRoot);
  let commonDir = null;
  if (found) {
    if (found.stat.isDirectory()) {
      commonDir = isGitDir(found.dotGit) ? found.dotGit : null;
    } else if (found.stat.isFile()) {
      commonDir = commonDirFromGitFile(found.dotGit);
    }
  }
  if (!commonDir) {
    return null;
  }
  const infoDir = path.join(commonDir, "info");
  const infoStat = lstatOrNull(infoDir);
  if (infoStat && !infoStat.isDirectory()) {
    return null;
  }
  const excludePath = path.join(infoDir, "exclude");
  const excludeStat = lstatOrNull(excludePath);
  if (excludeStat && !excludeStat.isFile()) {
    return null;
  }
  return excludePath;
}
function isGitignoreProtected(workspaceRoot) {
  if (hasBridgeEntry(readTrimmedLines(path.join(workspaceRoot, ".gitignore")))) {
    return true;
  }
  const excludePath = resolveGitExcludePath(workspaceRoot);
  return excludePath !== null && hasBridgeEntry(readTrimmedLines(excludePath));
}
function ensureGitignoreEntry(workspaceRoot) {
  const excludePath = resolveGitExcludePath(workspaceRoot);
  if (excludePath) {
    const lines = readTrimmedLines(excludePath);
    const missing = GIT_EXCLUDE_PATTERNS.filter((pattern) => !lines.includes(pattern));
    if (missing.length === 0) {
      return { updated: false, protected: true, file: "git-info-exclude" };
    }
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing2 = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const separator = existing2.length === 0 ? "" : existing2.endsWith("\n") ? "\n" : "\n\n";
    const header = lines.includes(GIT_EXCLUDE_HEADER) ? [] : [GIT_EXCLUDE_HEADER];
    fs.appendFileSync(excludePath, `${separator}${[...header, ...missing].join("\n")}
`, "utf8");
    return { updated: true, protected: true, file: "git-info-exclude" };
  }
  if (isRealGitWorkTree(workspaceRoot)) {
    return { updated: false, protected: false, file: "git-info-exclude" };
  }
  if (isGitignoreProtected(workspaceRoot)) {
    return { updated: false, protected: true, file: "gitignore" };
  }
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  const block = "# Antigravity Claude Bridge (local session artifacts)\n.ag-bridge/\n";
  const gitignoreStat = lstatOrNull(gitignorePath);
  if (gitignoreStat && !gitignoreStat.isFile()) {
    return { updated: false, protected: false, file: "gitignore" };
  }
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, block, "utf8");
    return { updated: true, protected: true, file: "gitignore" };
  }
  const existing = fs.readFileSync(gitignorePath, "utf8");
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const addition = `${needsLeadingNewline ? "\n\n" : existing.length > 0 ? "\n" : ""}${block}`;
  fs.appendFileSync(gitignorePath, addition, "utf8");
  return { updated: true, protected: true, file: "gitignore" };
}
function ensureDefaultConfig(workspaceRoot) {
  ensureBridgeDirs(workspaceRoot);
  assertNoSymlinkChain(workspaceRoot, [BRIDGE_DIR_NAME, "config.json"], ".ag-bridge/config.json");
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
var MAX_TAIL_READ_BYTES = 256 * 1024;
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
  const targetChains = [[".agent", "workflows", "claude-handoff.md"]];
  const agentsStat = lstatOrNull(path.join(workspaceRoot, ".agents"));
  if (agentsStat?.isDirectory() && !agentsStat.isSymbolicLink()) {
    targetChains.push([".agents", "workflows", "claude-handoff.md"]);
  }
  const syncedPaths = [];
  const skippedCustomPaths = [];
  for (const chain of targetChains) {
    if (hasSymlinkInChain(workspaceRoot, chain)) {
      continue;
    }
    const target = path.join(workspaceRoot, ...chain);
    const targetStat = lstatOrNull(target);
    if (!targetStat) {
      atomicWriteFile(target, templateContent);
      syncedPaths.push(target);
      continue;
    }
    if (!targetStat.isFile()) {
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
  const ignoreRes = ensureGitignoreEntry(options.workspaceRoot);
  if (ignoreRes.file === "git-info-exclude" && !ignoreRes.protected || hasSymlinkInChain(options.workspaceRoot, [".ag-bridge"])) {
    return {
      configCreated: false,
      ignoreUpdated: ignoreRes.updated,
      ignoreFile: ignoreRes.file,
      syncedTemplates: [],
      skippedCustomTemplates: []
    };
  }
  ensureBridgeDirs(options.workspaceRoot);
  const configRes = ensureDefaultConfig(options.workspaceRoot);
  const templateRes = syncHandoffTemplate(options.workspaceRoot, pluginRoot, {
    force: options.forceTemplate
  });
  return {
    configCreated: configRes.created,
    ignoreUpdated: ignoreRes.updated,
    ignoreFile: ignoreRes.file,
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
    } else if (arg === "--workspace" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      workspaceRoot = path2.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return { workspaceRoot, silent, forceTemplate };
}
function canonicalScriptPath(p) {
  const resolved = path2.resolve(p);
  let canonical = resolved;
  try {
    canonical = fs2.realpathSync.native(resolved);
  } catch {
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
var isDirectExecution = process.argv[1] !== void 0 && canonicalScriptPath(process.argv[1]) === canonicalScriptPath(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const result = runCliInit(opts);
    if (!opts.silent) {
      console.error(
        `[antigravity-delegate] Initialized workspace ${opts.workspaceRoot} (configCreated=${result.configCreated}, ignoreUpdated=${result.ignoreUpdated} in ${result.ignoreFile}, templatesSynced=${result.syncedTemplates.length})`
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
