export const PACKAGE_NAME = '@pie527645-cloud/sse-stream-lab';
export const PACKAGE_VERSION = '1.0.0';

export type RuleId = 'SSE001' | 'SSE002' | 'SSE003' | 'SSE004';

export type Severity = 'high' | 'medium' | 'low' | 'info';

export type FailOnThreshold = Severity | 'none';

export type OutputFormat = 'text' | 'json' | 'sarif';

export interface RuleMetadata {
  readonly id: RuleId;
  readonly name: string;
  readonly defaultSeverity: Severity;
  readonly shortDescription: string;
  readonly fullDescription: string;
  readonly helpText: string;
}

export interface Finding {
  readonly ruleId: RuleId;
  readonly severity: Severity;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface CheckOptions {
  readonly target?: string;
  readonly cwd?: string;
  readonly rootDir?: string;
  readonly format?: OutputFormat;
  readonly failOn?: FailOnThreshold;
  readonly includeTests?: boolean;
}

export interface SeveritySummary {
  readonly total: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
}

export interface CheckReport {
  readonly tool: string;
  readonly version: string;
  readonly target: string;
  readonly scannedFiles: number;
  readonly options: {
    readonly failOn: FailOnThreshold;
    readonly includeTests: boolean;
  };
  readonly summary: SeveritySummary;
  readonly findings: readonly Finding[];
}

export interface SourceInput {
  readonly absolutePath: string;
  readonly displayPath: string;
  readonly content: string;
}

export class SseStreamLabError extends Error {
  public readonly code: string;
  public readonly exitCode: number;

  constructor(message: string, code = 'SSE_STREAM_LAB_ERROR', exitCode = 2) {
    super(message);
    this.name = 'SseStreamLabError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class PathSecurityError extends SseStreamLabError {
  constructor(message: string, code = 'PATH_SECURITY_ERROR') {
    super(message, code, 2);
    this.name = 'PathSecurityError';
  }
}

export class UsageError extends SseStreamLabError {
  constructor(message: string, code = 'INVALID_CLI_ARGS') {
    super(message, code, 2);
    this.name = 'UsageError';
  }
}
