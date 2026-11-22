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

export interface SubscriptionConfig {
  app_path: string;
  trigger_method: TriggerMethod;
  timeout_sec: number;
  poll_interval_ms: number;
  agy_mode: AgyExecutionMode;
  agy_sandbox: boolean;
  agy_stream_heartbeat: boolean;
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
  bridge: {
    initialized: boolean;
    gitignoreProtected: boolean;
    currentStatus: TaskStatus;
    lastTaskId?: string;
    lastUpdatedAt?: string;
  };
}

export interface DelegateToolInput {
  title: string;
  instructions: string;
  lockedPaths: string[];
  verifyUrl?: string;
  acceptanceCriteria: string[];
  modeOverride?: ExecutionMode;
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
