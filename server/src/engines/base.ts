import {
  AgErrorCode,
  AgyCliOptions,
  BridgeConfig,
  BridgeManifest,
  EnvironmentDetectionResult,
  ExecutionMetrics,
  ResolvedExecutionMode,
} from '../types.js';

export interface ExecutionProgressEvent {
  progress: number;
  total?: number;
  message: string;
}

export type ProgressCallback = (event: ExecutionProgressEvent) => void;

export interface ExecutionContext {
  workspaceRoot: string;
  pluginRoot: string;
  manifest: BridgeManifest;
  config: BridgeConfig;
  instructions: string;
  acceptanceCriteria: string[];
  detection: EnvironmentDetectionResult;
  agyOptions?: AgyCliOptions;
  timeoutSecOverride?: number;
  abortSignal?: AbortSignal;
  onProgress?: ProgressCallback;
}

export interface ExecutionResult {
  status: 'VERIFIED' | 'FAILED';
  reportMarkdown: string;
  structuredOutput?: unknown;
  changedFiles: string[];
  artifacts: string[];
  metrics?: ExecutionMetrics;
  warnings: string[];
  errorCode?: AgErrorCode;
  errorMessage?: string;
}

export interface ExecutionEngine {
  readonly mode: ResolvedExecutionMode;
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
}
