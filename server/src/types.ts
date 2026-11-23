export type ExecutionMode = 'auto' | 'subscription' | 'api';
export type ResolvedExecutionMode = 'subscription' | 'api';
export type TaskStatus = 'IDLE' | 'DISPATCHED' | 'RUNNING' | 'VERIFIED' | 'FAILED';
export type GitGuardPolicy = 'best_effort' | 'required';
export type TriggerMethod = 'cli_or_ipc' | 'cli_only' | 'clipboard';

export const TEMPLATE_VERSION = '1.0.0';

export type AgErrorCode =
  | 'NO_ANTIGRAVITY_PROVIDER'
  | 'SUBSCRIPTION_UNAVAILABLE'
  | 'API_KEY_MISSING'
  | 'BRIDGE_BUSY'
  | 'INVALID_LOCKED_PATHS'
  | 'PATH_OUTSIDE_LOCKED_SCOPE'
  | 'PATH_TRAVERSAL_BLOCKED'
  | 'PROTECTED_PATH_BLOCKED'
  | 'COMMAND_NOT_ALLOWED'
  | 'GIT_CHECKPOINT_FAILED'
  | 'ROLLBACK_NO_CHECKPOINT'
  | 'TASK_TIMEOUT'
  | 'MAX_TURNS_EXCEEDED'
  | 'GEMINI_API_ERROR'
  | 'INVALID_CONFIG'
  | 'AGY_CLI_NOT_FOUND'
  | 'AUTH_LOGIN_FAILED'
  | 'AUTH_SESSION_NOT_FOUND'
  | 'AUTH_TIMEOUT'
  | 'TASK_CANCELLED'
  | 'JOB_NOT_FOUND'
  | 'INTERNAL_ERROR';

export class AgPluginError extends Error {
  public readonly code: AgErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: AgErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AgPluginError';
    this.code = code;
    this.details = details;
  }
}

export type AgyExecutionMode = 'accept-edits' | 'auto' | 'plan';
export type AgyEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface ExecutionMetrics {
  conversationId?: string;
  model?: string;
  durationSeconds?: number;
  numTurns?: number;
  permissionMode?: string;
  usage?: TokenUsage;
}

export interface AgyCliOptions {
  model?: string;
  effort?: AgyEffortLevel;
  agent?: string;
  agyMode?: AgyExecutionMode;
  sandbox?: boolean;
  dangerouslySkipPermissions?: boolean;
  addDirs?: string[];
  continueConversation?: boolean;
  conversationId?: string;
  project?: string;
  newProject?: boolean;
  remoteAgent?: boolean;
  jsonSchema?: string;
  disableSlashCommands?: boolean;
  settings?: string;
  rawPrompt?: boolean;
}

export interface SubscriptionConfig {
  app_path: string;
  trigger_method: TriggerMethod;
  timeout_sec: number;
  poll_interval_ms: number;
  agy_mode: AgyExecutionMode;
  agy_sandbox: boolean;
  agy_dangerously_skip_permissions: boolean;
  agy_stream_heartbeat: boolean;
  agy_model?: string;
  agy_effort?: AgyEffortLevel;
  agy_agent?: string;
  agy_project?: string;
  agy_remote_agent?: boolean;
  agy_disable_slash_commands?: boolean;
  agy_settings?: string;
}

export interface ApiConfig {
  api_key_env: string;
  apiKey?: string;
  model: string;
  max_turns: number;
  command_timeout_sec: number;
}

export interface BridgeConfig {
  execution_mode: ExecutionMode;
  git_guard: GitGuardPolicy;
  subscription: SubscriptionConfig;
  api: ApiConfig;
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  execution_mode: 'auto',
  git_guard: 'best_effort',
  subscription: {
    app_path: 'auto',
    trigger_method: 'cli_or_ipc',
    timeout_sec: 300,
    poll_interval_ms: 2000,
    agy_mode: 'accept-edits',
    agy_sandbox: true,
    agy_dangerously_skip_permissions: false,
    agy_stream_heartbeat: true,
  },
  api: {
    api_key_env: 'GEMINI_API_KEY',
    model: 'gemini-2.5-pro',
    max_turns: 15,
    command_timeout_sec: 60,
  },
};

export interface BridgeManifest {
  schemaVersion: 1;
  taskId: string;
  title: string;
  mode: ResolvedExecutionMode;
  status: TaskStatus;
  lockedPaths: string[];
  verifyUrl?: string;
  createdAt: string;
  updatedAt: string;
  gitCheckpointRef?: string;
  gitCheckpointIsStash?: boolean;
  gitUntrackedBaseline?: string[];
  artifacts: string[];
  changedFiles?: string[];
  metrics?: ExecutionMetrics;
  errorCode?: AgErrorCode;
  error?: string;
}

export interface SubscriptionDetection {
  detected: boolean;
  cliBinary?: string;
  cliPath?: string;
  appPath?: string;
  triggerMethod: TriggerMethod;
}

export interface ApiDetection {
  configured: boolean;
  source: 'env' | 'config' | 'none';
  envVarName: string;
  model: string;
  maxTurns: number;
}

export interface EnvironmentDetectionResult {
  configuredMode: ExecutionMode;
  resolvedMode: ResolvedExecutionMode | 'unavailable';
  platform: NodeJS.Platform;
  subscription: SubscriptionDetection;
  api: ApiDetection;
  recommendations: string[];
}

export interface GitStatusInfo {
  isGitRepo: boolean;
  currentBranch?: string;
  isDirty?: boolean;
}

export interface CheckEnvironmentOutput extends EnvironmentDetectionResult {
  git: GitStatusInfo;
  agyConfig: {
    mode: AgyExecutionMode;
    sandbox: boolean;
    dangerouslySkipPermissions: boolean;
    streamHeartbeat: boolean;
    model?: string;
    effort?: AgyEffortLevel;
    agent?: string;
  };
  bridge: {
    initialized: boolean;
    gitignoreProtected: boolean;
    currentStatus: TaskStatus;
    lastTaskId?: string;
    lastUpdatedAt?: string;
    lastConversationId?: string;
    lastUsage?: TokenUsage;
  };
}

export interface DelegateToolInput extends AgyCliOptions {
  title: string;
  instructions: string;
  lockedPaths?: string[];
  verifyUrl?: string;
  acceptanceCriteria?: string[];
  modeOverride?: ExecutionMode;
  timeoutSec?: number;
  workspaceRoot?: string;
}

export interface DelegateToolOutput {
  ok: boolean;
  taskId: string;
  mode: ResolvedExecutionMode;
  status: 'VERIFIED' | 'FAILED';
  gitCheckpointRef?: string;
  changedFiles: string[];
  artifacts: string[];
  reportMarkdown: string;
  structuredOutput?: unknown;
  metrics?: ExecutionMetrics;
  warnings: string[];
  errorCode?: AgErrorCode;
  errorMessage?: string;
}

export interface RollbackToolInput {
  taskId?: string;
  workspaceRoot?: string;
}

export interface RollbackToolOutput {
  ok: boolean;
  taskId: string;
  restoredCheckpointRef?: string;
  revertedTrackedFiles: string[];
  removedUntrackedFiles: string[];
  errorCode?: AgErrorCode;
  errorMessage?: string;
}

export interface AgyModelInfo {
  id: string;
  label: string;
}

export interface ListCapabilitiesOutput {
  subscriptionDetected: boolean;
  cliBinary?: string;
  cliPath?: string;
  models: AgyModelInfo[];
  agents: string[];
  supportedPermissionModes: string[];
  supportedEffortLevels: AgyEffortLevel[];
  supportedFlags: string[];
  currentDefaults: {
    agyMode: AgyExecutionMode;
    sandbox: boolean;
    dangerouslySkipPermissions: boolean;
    streamHeartbeat: boolean;
    model?: string;
    effort?: AgyEffortLevel;
    agent?: string;
  };
  warnings: string[];
}

export interface TaskUsageRecord {
  taskId: string;
  title: string;
  mode: ResolvedExecutionMode;
  status: TaskStatus;
  model?: string;
  conversationId?: string;
  durationSeconds?: number;
  numTurns?: number;
  usage: TokenUsage;
  updatedAt: string;
}

export interface UsageSummaryOutput {
  totalTasks: number;
  tasksWithUsage: number;
  totals: TokenUsage;
  totalDurationSeconds: number;
  byMode: {
    subscription: { tasks: number; usage: TokenUsage };
    api: { tasks: number; usage: TokenUsage };
  };
  recentTasks: TaskUsageRecord[];
}

export type AgAuthAction = 'status' | 'login' | 'complete' | 'cancel' | 'logout';
export type AgLoginFlow = 'auto' | 'browser' | 'manual';
export type AgAuthMethod = 'google-oauth' | 'gemini-api-key' | 'adc' | 'none' | 'unknown';
export type AgAuthStatus =
  | 'AUTHENTICATED'
  | 'UNAUTHENTICATED'
  | 'AWAITING_CODE'
  | 'CANCELLED'
  | 'CLI_NOT_INSTALLED'
  | 'LOGOUT_INSTRUCTIONS'
  | 'FAILED';

export interface AgAuthToolInput {
  action?: AgAuthAction;
  flow?: AgLoginFlow;
  force?: boolean;
  code?: string;
  sessionId?: string;
  timeoutSec?: number;
  workspaceRoot?: string;
}

export interface AgAuthToolOutput {
  ok: boolean;
  action: AgAuthAction;
  status: AgAuthStatus;
  authenticated: boolean;
  authMethod: AgAuthMethod;
  cliDetected: boolean;
  cliBinary?: string;
  cliPath?: string;
  modelCount?: number;
  sessionId?: string;
  authUrl?: string;
  message: string;
  nextSteps: string[];
  warnings: string[];
  errorCode?: AgErrorCode;
  errorMessage?: string;
}

export type BackgroundJobState = 'RUNNING' | 'VERIFIED' | 'FAILED' | 'CANCELLED';

export interface BackgroundJobSummary {
  jobId: string;
  taskId: string;
  title: string;
  mode: ResolvedExecutionMode;
  status: BackgroundJobState;
  active: boolean;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  gitCheckpointRef?: string;
  conversationId?: string;
  model?: string;
  metrics?: ExecutionMetrics;
  changedFiles?: string[];
  artifacts?: string[];
  reportMarkdown?: string;
  structuredOutput?: unknown;
  logTail?: string;
  warnings: string[];
  errorCode?: AgErrorCode;
  errorMessage?: string;
}

export interface StartJobToolOutput {
  ok: boolean;
  jobId: string;
  taskId: string;
  mode: ResolvedExecutionMode;
  status: 'RUNNING';
  gitCheckpointRef?: string;
  warnings: string[];
  nextSteps: string[];
}

export interface GetJobToolInput {
  jobId?: string;
  workspaceRoot?: string;
  includeLogTail?: boolean;
  limit?: number;
}

export interface GetJobToolOutput {
  ok: boolean;
  job?: BackgroundJobSummary;
  jobs?: BackgroundJobSummary[];
  activeCount: number;
  errorCode?: AgErrorCode;
  errorMessage?: string;
}

export interface CancelJobToolInput {
  jobId?: string;
  workspaceRoot?: string;
}

export interface CancelJobToolOutput {
  ok: boolean;
  jobId?: string;
  status: 'CANCELLED' | 'NOT_RUNNING';
  gitCheckpointRef?: string;
  message: string;
  nextSteps: string[];
  errorCode?: AgErrorCode;
  errorMessage?: string;
}
