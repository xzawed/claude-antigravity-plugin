import {
  AgErrorCode,
  AgyCliOptions,
  BridgeConfig,
  BridgeManifest,
  EnvironmentDetectionResult,
  ExecutionMetrics,
  ResolvedExecutionMode,
} from '../types.js';

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
}

export interface ExecutionResult {
  status: 'VERIFIED' | 'FAILED';
  reportMarkdown: string;
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
