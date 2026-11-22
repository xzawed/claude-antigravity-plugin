import { GoogleGenAI, Type, type Content, type FunctionDeclaration } from '@google/genai';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  listTaskArtifacts,
  writeManifest,
  writeReportMarkdown,
} from '../bridge-fs.js';
import { maskSecrets, resolveApiKey } from '../config.js';
import { listGitChangedFiles } from '../git-guard.js';
import { assertReadablePath, assertWritablePath } from '../path-guard.js';
import { AgPluginError, BridgeManifest } from '../types.js';
import { ExecutionContext, ExecutionEngine, ExecutionResult } from './base.js';

const MAX_READ_BYTES = 64 * 1024;
const MAX_CMD_OUTPUT_BYTES = 16 * 1024;
const MAX_LIST_ENTRIES = 200;

export interface ModelFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ModelTurnResponse {
  text?: string;
  functionCalls?: ModelFunctionCall[];
}

export interface GeminiAdapter {
  generateTurn(params: {
    model: string;
    systemInstruction: string;
    contents: Content[];
    tools: FunctionDeclaration[];
  }): Promise<ModelTurnResponse>;
}

export interface CommandExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (
  command: string,
  cwd: string,
  timeoutSec: number,
) => Promise<CommandExecResult>;

export interface ApiWorkerOptions {
  adapterFactory?: (apiKey: string) => GeminiAdapter;
  commandRunner?: CommandRunner;
  retryBaseDelayMs?: number;
}

const SHELL_METACHAR_REGEX = /[;&|`$<>^%!\r\n]/;

const DENIED_BINARIES = new Set([
  'rm',
  'del',
  'erase',
  'rmdir',
  'rd',
  'git',
  'curl',
  'wget',
  'powershell',
  'pwsh',
  'cmd',
  'cmd.exe',
  'bash',
  'sh',
  'zsh',
  'sudo',
  'su',
  'chmod',
  'chown',
  'dd',
  'mkfs',
  'shutdown',
  'reboot',
]);

const ALLOWED_BINARIES = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'tsc',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'next',
  'vite',
]);

const ALLOWED_NPX_TOOLS = new Set(['tsc', 'eslint', 'prettier', 'vitest', 'jest', 'next', 'vite']);
const ALLOWED_NPM_SUBCOMMANDS = new Set(['run', 'test']);

export function tokenizeSimpleCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (quote) {
    throw new AgPluginError('COMMAND_NOT_ALLOWED', 'Unclosed quote in command.');
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function validateCommandPolicy(command: string): { bin: string; args: string[] } {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new AgPluginError('COMMAND_NOT_ALLOWED', 'Empty command is not allowed.');
  }
  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    throw new AgPluginError(
      'COMMAND_NOT_ALLOWED',
      'Shell chaining, piping, redirection, and subshell metacharacters are blocked.',
    );
  }

  const tokens = tokenizeSimpleCommand(trimmed);
  if (tokens.length === 0) {
    throw new AgPluginError('COMMAND_NOT_ALLOWED', 'Empty command is not allowed.');
  }

  const binRaw = tokens[0];
  const binLower = path.basename(binRaw).toLowerCase().replace(/\.(cmd|exe|bat)$/, '');

  if (DENIED_BINARIES.has(binLower)) {
    throw new AgPluginError(
      'COMMAND_NOT_ALLOWED',
      `Executable "${binRaw}" is explicitly denied by security policy.`,
    );
  }

  if (!ALLOWED_BINARIES.has(binLower)) {
    throw new AgPluginError(
      'COMMAND_NOT_ALLOWED',
      `Executable "${binRaw}" is not in the allowed build/typecheck/lint/test allowlist.`,
    );
  }

  const args = tokens.slice(1);
  if (binLower === 'npm') {
    const sub = args[0]?.toLowerCase();
    if (!sub || !ALLOWED_NPM_SUBCOMMANDS.has(sub)) {
      throw new AgPluginError(
        'COMMAND_NOT_ALLOWED',
        'Only "npm run <script>" and "npm test" are allowed.',
      );
    }
  } else if (binLower === 'npx') {
    const tool = args[0]?.toLowerCase();
    if (!tool || !ALLOWED_NPX_TOOLS.has(tool)) {
      throw new AgPluginError(
        'COMMAND_NOT_ALLOWED',
        `npx tool "${args[0] ?? ''}" is not in the allowed verification tool list.`,
      );
    }
  }

  return { bin: binLower, args };
}

function truncateTail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  const omitted = buf.byteLength - maxBytes;
  const tail = buf.subarray(buf.byteLength - maxBytes).toString('utf8');
  return `[... truncated ${omitted} leading bytes ...]\n${tail}`;
}

function createSanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

function killProcessTree(pid: number | undefined, isWin: boolean): void {
  if (!pid) return;
  try {
    if (isWin) {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5000,
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Process may have already exited
  }
}

export async function defaultCommandRunner(
  command: string,
  cwd: string,
  timeoutSec: number,
): Promise<CommandExecResult> {
  const { bin, args } = validateCommandPolicy(command);
  const env = createSanitizedEnv();
  const isWin = process.platform === 'win32';
  const execBin = isWin ? 'cmd.exe' : bin;
  const execArgs = isWin ? ['/d', '/s', '/c', bin, ...args] : args;

  return new Promise<CommandExecResult>((resolve) => {
    const child = spawn(execBin, execArgs, {
      cwd,
      env,
      shell: false,
      detached: !isWin,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const MAX_CAPTURE = 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: truncateTail(stdout, MAX_CMD_OUTPUT_BYTES),
        stderr: truncateTail(stderr, MAX_CMD_OUTPUT_BYTES),
        timedOut,
      });
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < MAX_CAPTURE) {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_CAPTURE) {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, isWin);
      finish(1);
    }, Math.max(1, timeoutSec) * 1000);

    child.once('error', (err) => {
      stderr += err.message;
      finish(1);
    });

    child.once('close', (code) => {
      finish(typeof code === 'number' ? code : 1);
    });
  });
}

function createDefaultGeminiAdapter(apiKey: string): GeminiAdapter {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async generateTurn({ model, systemInstruction, contents, tools }) {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: tools }],
        },
      });

      const functionCalls: ModelFunctionCall[] = (response.functionCalls ?? [])
        .filter((fc): fc is { name: string; args?: Record<string, unknown> } => Boolean(fc.name))
        .map((fc) => ({
          name: fc.name,
          args: (fc.args ?? {}) as Record<string, unknown>,
        }));

      return {
        text: response.text,
        functionCalls,
      };
    },
  };
}

const WORKER_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'read_file',
    description: 'Read a text file inside the workspace to inspect existing code, types, or config.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Workspace-relative file path.' },
        startLine: { type: Type.INTEGER, description: 'Optional 1-based start line.' },
        endLine: { type: Type.INTEGER, description: 'Optional 1-based inclusive end line.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file strictly within the allowed lockedPaths scope. Parent directories are created automatically.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Workspace-relative file path inside lockedPaths.' },
        content: { type: Type.STRING, description: 'Complete file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories inside the workspace (ignores node_modules, .git, .ag-bridge).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: 'Workspace-relative directory path (defaults to ".").' },
        maxDepth: { type: Type.INTEGER, description: 'Maximum recursion depth (1 to 4, default 2).' },
      },
    },
  },
  {
    name: 'run_command',
    description:
      'Run an allowed verification command (e.g., "npx tsc --noEmit", "npm run build", "npm test") inside the workspace.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: { type: Type.STRING, description: 'Single verification command without shell chaining.' },
      },
      required: ['command'],
    },
  },
];

function listWorkspaceDir(workspaceRoot: string, relDir: string, maxDepth: number): string[] {
  const safeDir = assertReadablePath(workspaceRoot, relDir || '.');
  const results: string[] = [];
  const ignored = new Set(['node_modules', '.git', '.ag-bridge', 'dist']);

  const walk = (dir: string, depth: number): void => {
    if (results.length >= MAX_LIST_ENTRIES || depth > maxDepth) return;
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= MAX_LIST_ENTRIES) break;
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspaceRoot, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        results.push(`${rel}/`);
        if (depth < maxDepth) {
          walk(full, depth + 1);
        }
      } else {
        results.push(rel);
      }
    }
  };

  walk(safeDir, 1);
  return results;
}

function isRetryableApiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|ECONNRESET|ETIMEDOUT)\b/i.test(msg);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSystemInstruction(ctx: ExecutionContext): string {
  return [
    'You are an autonomous frontend/engineering worker delegated by Claude Code (API Fallback Mode).',
    'You have 4 tools: list_dir, read_file, write_file, run_command.',
    `Allowed write scope (lockedPaths): ${ctx.manifest.lockedPaths.join(', ')}`,
    'RULES:',
    '1. NEVER attempt to write outside lockedPaths or modify .git/, .env*, or .ag-bridge/config.json.',
    '2. Inspect existing project files and types first using list_dir and read_file.',
    '3. Implement clean, complete, production-ready code using write_file.',
    '4. Always verify your work with run_command (e.g. `npx tsc --noEmit` or `npm run build`) when package.json exists.',
    '5. Browser visual E2E verification is unavailable in API mode; report Build/Typecheck results clearly and mark Browser E2E as SKIPPED (API mode).',
    '6. When finished, return a concise Markdown report summarizing changes, verification results, and follow-up notes for Claude.',
  ].join('\n');
}

function buildInitialUserPrompt(ctx: ExecutionContext): string {
  const criteria = ctx.acceptanceCriteria.map((c, idx) => `${idx + 1}. ${c}`).join('\n');
  return [
    `# Task: ${ctx.manifest.title} (${ctx.manifest.taskId})`,
    '',
    '## Locked Paths',
    ...ctx.manifest.lockedPaths.map((p) => `- ${p}`),
    '',
    '## Instructions',
    ctx.instructions,
    '',
    '## Acceptance Criteria',
    criteria,
  ].join('\n');
}

function formatFinalReport(params: {
  taskId: string;
  status: 'VERIFIED' | 'FAILED';
  model: string;
  summaryBody: string;
  changedFiles: string[];
  blockedWrites: number;
  commandsRun: Array<{ command: string; exitCode: number }>;
  errorMessage?: string;
}): string {
  const filesList =
    params.changedFiles.length > 0
      ? params.changedFiles.map((f) => `- \`${f}\``).join('\n')
      : '- (none)';

  const cmdSummary =
    params.commandsRun.length > 0
      ? params.commandsRun
          .map((c) => `- \`${c.command}\` → ${c.exitCode === 0 ? 'PASS' : `FAIL (exit ${c.exitCode})`}`)
          .join('\n')
      : '- No verification commands executed';

  return [
    '# Antigravity Task Report',
    '',
    `- **Task ID:** \`${params.taskId}\``,
    `- **Status:** ${params.status}`,
    `- **Engine:** api (\`${params.model}\`)`,
    `- **Completed At:** \`${new Date().toISOString()}\``,
    '',
    '## Summary',
    params.summaryBody.trim() || '(No summary returned by worker.)',
    params.errorMessage ? `\n**Error:** ${params.errorMessage}` : '',
    '',
    '## Modified / Created Files',
    filesList,
    '',
    '## Verification Results',
    cmdSummary,
    '- **Browser E2E / Visual Check:** SKIPPED (API mode)',
    params.blockedWrites > 0
      ? `- **Security Guard:** Blocked ${params.blockedWrites} out-of-scope write attempt(s)`
      : '',
    '',
    '## Artifacts',
    '- (none — headless API mode)',
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export class ApiWorkerEngine implements ExecutionEngine {
  public readonly mode = 'api' as const;
  private readonly adapterFactory: (apiKey: string) => GeminiAdapter;
  private readonly commandRunner: CommandRunner;
  private readonly retryBaseDelayMs: number;

  constructor(options: ApiWorkerOptions = {}) {
    this.adapterFactory = options.adapterFactory ?? createDefaultGeminiAdapter;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  }

  public async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const warnings: string[] = [];
    const { key: apiKey, source } = resolveApiKey(ctx.config);
    if (!apiKey) {
      throw new AgPluginError(
        'API_KEY_MISSING',
        `API key is missing. Set environment variable ${ctx.config.api.api_key_env}.`,
      );
    }
    if (source === 'config') {
      warnings.push(
        `API key was loaded from .ag-bridge/config.json. Prefer setting ${ctx.config.api.api_key_env} as an environment variable.`,
      );
    }

    const adapter = this.adapterFactory(apiKey);
    const maxTurns = ctx.config.api.max_turns;
    const model = ctx.config.api.model;
    const systemInstruction = buildSystemInstruction(ctx);
    const hasPackageJson = fs.existsSync(path.join(ctx.workspaceRoot, 'package.json'));

    // Transition manifest -> RUNNING
    const runningManifest: BridgeManifest = {
      ...ctx.manifest,
      status: 'RUNNING',
      updatedAt: new Date().toISOString(),
    };
    writeManifest(ctx.workspaceRoot, runningManifest);

    const contents: Content[] = [
      { role: 'user', parts: [{ text: buildInitialUserPrompt(ctx) }] },
    ];

    const writtenFiles = new Set<string>();
    const commandsRun: Array<{ command: string; exitCode: number }> = [];
    let blockedWrites = 0;
    let nudgedForVerification = false;
    let lastModelText = '';

    const callModelWithRetry = async (): Promise<ModelTurnResponse> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
          return await adapter.generateTurn({
            model,
            systemInstruction,
            contents,
            tools: WORKER_TOOL_DECLARATIONS,
          });
        } catch (err) {
          lastErr = err;
          if (attempt < 3 && isRetryableApiError(err)) {
            await sleep(this.retryBaseDelayMs * Math.pow(2, attempt));
            continue;
          }
          break;
        }
      }
      const safeErr = maskSecrets(
        lastErr instanceof Error ? lastErr.message : String(lastErr),
        [apiKey],
      );
      throw new AgPluginError('GEMINI_API_ERROR', `Gemini API call failed: ${safeErr}`);
    };

    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        const turnResp = await callModelWithRetry();
        if (turnResp.text) {
          lastModelText = turnResp.text;
        }

        const calls = turnResp.functionCalls ?? [];

        if (calls.length === 0) {
          // Enforce build/typecheck verification once if package.json exists and turns remain
          if (
            hasPackageJson &&
            writtenFiles.size > 0 &&
            commandsRun.length === 0 &&
            !nudgedForVerification &&
            maxTurns - turn >= 2
          ) {
            nudgedForVerification = true;
            contents.push({ role: 'model', parts: [{ text: turnResp.text ?? '' }] });
            contents.push({
              role: 'user',
              parts: [
                {
                  text: 'Before finalizing, please run `npx tsc --noEmit` or the project build script via `run_command` to verify your changes compile cleanly.',
                },
              ],
            });
            continue;
          }

          // Completed cleanly
          const changedFiles = Array.from(
            new Set([...writtenFiles, ...listGitChangedFiles(ctx.workspaceRoot)]),
          ).sort();
          const report = maskSecrets(
            formatFinalReport({
              taskId: ctx.manifest.taskId,
              status: 'VERIFIED',
              model,
              summaryBody: lastModelText,
              changedFiles,
              blockedWrites,
              commandsRun,
            }),
            [apiKey],
          );
          writeReportMarkdown(ctx.workspaceRoot, report);

          const verifiedManifest: BridgeManifest = {
            ...runningManifest,
            status: 'VERIFIED',
            changedFiles,
            artifacts: listTaskArtifacts(ctx.workspaceRoot, ctx.manifest.taskId),
            updatedAt: new Date().toISOString(),
          };
          writeManifest(ctx.workspaceRoot, verifiedManifest);

          return {
            status: 'VERIFIED',
            reportMarkdown: report,
            changedFiles,
            artifacts: verifiedManifest.artifacts,
            warnings,
          };
        }

        // Record model function calls in history
        contents.push({
          role: 'model',
          parts: calls.map((c) => ({
            functionCall: { name: c.name, args: c.args },
          })),
        });

        // Execute each requested tool with strict security guards
        const responseParts: Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = [];

        for (const call of calls) {
          let toolResult: Record<string, unknown>;
          try {
            if (call.name === 'read_file') {
              const filePath = String(call.args.path ?? '');
              const absPath = assertReadablePath(ctx.workspaceRoot, filePath);
              if (!fs.existsSync(absPath)) {
                toolResult = { error: `File not found: ${filePath}` };
              } else {
                const raw = fs.readFileSync(absPath, 'utf8');
                const lines = raw.split(/\r?\n/);
                const start = Math.max(1, Number(call.args.startLine ?? 1));
                const end = Math.min(lines.length, Number(call.args.endLine ?? lines.length));
                const sliced = lines.slice(start - 1, end).join('\n');
                toolResult = {
                  path: filePath,
                  totalLines: lines.length,
                  content: maskSecrets(truncateTail(sliced, MAX_READ_BYTES), [apiKey]),
                };
              }
            } else if (call.name === 'write_file') {
              const filePath = String(call.args.path ?? '');
              const content = String(call.args.content ?? '');
              const absPath = assertWritablePath(
                ctx.workspaceRoot,
                filePath,
                ctx.manifest.lockedPaths,
              );
              fs.mkdirSync(path.dirname(absPath), { recursive: true });
              fs.writeFileSync(absPath, content, 'utf8');
              const relWritten = path
                .relative(ctx.workspaceRoot, absPath)
                .split(path.sep)
                .join('/');
              writtenFiles.add(relWritten);
              toolResult = { ok: true, path: relWritten, bytesWritten: Buffer.byteLength(content, 'utf8') };
            } else if (call.name === 'list_dir') {
              const dirPath = String(call.args.path ?? '.');
              const depth = Math.min(4, Math.max(1, Number(call.args.maxDepth ?? 2)));
              const entries = listWorkspaceDir(ctx.workspaceRoot, dirPath, depth);
              toolResult = { path: dirPath, entries };
            } else if (call.name === 'run_command') {
              const cmd = String(call.args.command ?? '');
              const execRes = await this.commandRunner(
                cmd,
                ctx.workspaceRoot,
                ctx.config.api.command_timeout_sec,
              );
              commandsRun.push({ command: cmd, exitCode: execRes.exitCode });
              toolResult = {
                exitCode: execRes.exitCode,
                timedOut: execRes.timedOut,
                stdout: maskSecrets(execRes.stdout, [apiKey]),
                stderr: maskSecrets(execRes.stderr, [apiKey]),
              };
            } else {
              toolResult = { error: `Unknown tool: ${call.name}` };
            }
          } catch (err) {
            if (err instanceof AgPluginError) {
              if (
                err.code === 'PATH_OUTSIDE_LOCKED_SCOPE' ||
                err.code === 'PATH_TRAVERSAL_BLOCKED' ||
                err.code === 'PROTECTED_PATH_BLOCKED'
              ) {
                blockedWrites += 1;
              }
              toolResult = { errorCode: err.code, error: maskSecrets(err.message, [apiKey]) };
            } else {
              toolResult = {
                error: maskSecrets(err instanceof Error ? err.message : String(err), [apiKey]),
              };
            }
          }

          responseParts.push({
            functionResponse: {
              name: call.name,
              response: toolResult,
            },
          });
        }

        // Inject wrap-up warning at turn === maxTurns - 2
        const userParts: Content['parts'] = [...responseParts];
        if (maxTurns >= 4 && turn === maxTurns - 2) {
          userParts.push({
            text: `Warning: Only 2 turns remaining (turn ${turn}/${maxTurns}). Complete any final verification and return your final summary report.`,
          });
        }
        contents.push({ role: 'user', parts: userParts });

        // Heartbeat manifest updatedAt
        runningManifest.updatedAt = new Date().toISOString();
        writeManifest(ctx.workspaceRoot, runningManifest);
      }

      // Max turns exceeded
      const changedFiles = Array.from(
        new Set([...writtenFiles, ...listGitChangedFiles(ctx.workspaceRoot)]),
      ).sort();
      const errMsg = `API worker exceeded max_turns (${maxTurns}) without completing.`;
      const report = maskSecrets(
        formatFinalReport({
          taskId: ctx.manifest.taskId,
          status: 'FAILED',
          model,
          summaryBody: lastModelText || 'Task reached turn limit before producing a final report.',
          changedFiles,
          blockedWrites,
          commandsRun,
          errorMessage: errMsg,
        }),
        [apiKey],
      );
      writeReportMarkdown(ctx.workspaceRoot, report);

      const failedManifest: BridgeManifest = {
        ...runningManifest,
        status: 'FAILED',
        changedFiles,
        updatedAt: new Date().toISOString(),
        errorCode: 'MAX_TURNS_EXCEEDED',
        error: errMsg,
      };
      writeManifest(ctx.workspaceRoot, failedManifest);

      return {
        status: 'FAILED',
        reportMarkdown: report,
        changedFiles,
        artifacts: [],
        warnings,
        errorCode: 'MAX_TURNS_EXCEEDED',
        errorMessage: errMsg,
      };
    } catch (err) {
      const code = err instanceof AgPluginError ? err.code : 'GEMINI_API_ERROR';
      const safeMsg = maskSecrets(err instanceof Error ? err.message : String(err), [apiKey]);
      const changedFiles = Array.from(
        new Set([...writtenFiles, ...listGitChangedFiles(ctx.workspaceRoot)]),
      ).sort();
      const report = formatFinalReport({
        taskId: ctx.manifest.taskId,
        status: 'FAILED',
        model,
        summaryBody: lastModelText || 'Execution aborted due to an error.',
        changedFiles,
        blockedWrites,
        commandsRun,
        errorMessage: safeMsg,
      });
      writeReportMarkdown(ctx.workspaceRoot, report);

      const failedManifest: BridgeManifest = {
        ...runningManifest,
        status: 'FAILED',
        changedFiles,
        updatedAt: new Date().toISOString(),
        errorCode: code,
        error: safeMsg,
      };
      writeManifest(ctx.workspaceRoot, failedManifest);

      return {
        status: 'FAILED',
        reportMarkdown: report,
        changedFiles,
        artifacts: [],
        warnings,
        errorCode: code,
        errorMessage: safeMsg,
      };
    }
  }
}
