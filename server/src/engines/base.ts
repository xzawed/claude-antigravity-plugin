import {
  AgErrorCode,
  BridgeConfig,
  BridgeManifest,
  EnvironmentDetectionResult,
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
}

export interface ExecutionResult {
  status: 'VERIFIED' | 'FAILED';
  reportMarkdown: string;
  changedFiles: string[];
  artifacts: string[];
  warnings: string[];
  errorCode?: AgErrorCode;
  errorMessage?: string;
}

export interface ExecutionEngine {
  readonly mode: ResolvedExecutionMode;
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
}
