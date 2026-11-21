#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatReport } from './formatters/index.js';
import { checkProject } from './index.js';
import { exceedsFailOnThreshold } from './rules.js';
import {
  type FailOnThreshold,
  type OutputFormat,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SseStreamLabError,
  UsageError,
} from './types.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_IO: CliIo = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

const VALID_FORMATS = new Set<string>(['text', 'json', 'sarif']);
const VALID_FAIL_ON = new Set<string>(['high', 'medium', 'low', 'info', 'none']);

function getHelpText(): string {
  return `${PACKAGE_NAME} v${PACKAGE_VERSION}
Static TypeScript/JavaScript AST auditor for Server-Sent Events (SSE) caching headers, compression buffering, UTF-8 chunk decoding, and disconnect cleanup.

Usage:
  sse-stream-lab check [target] [options]

Options:
  --format <text|json|sarif>              Output format (default: text)
  --fail-on <high|medium|low|info|none>   Minimum severity causing exit code 1 (default: medium)
  --include-tests                         Include test directories and *.test.* / *.spec.* files
  -h, --help                              Show help text and exit
  -v, --version                           Show package version and exit

Exit codes:
  0  Clean or all findings strictly below --fail-on threshold (or --fail-on none)
  1  One or more findings at or above --fail-on threshold
  2  Invalid CLI arguments, missing target, or symlink escape blocked`;
}

interface ParsedCliArgs {
  readonly kind: 'help' | 'version' | 'check';
  readonly target: string;
  readonly format: OutputFormat;
  readonly failOn: FailOnThreshold;
  readonly includeTests: boolean;
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  flagName: string
): { readonly value: string; readonly nextIndex: number } {
  const token = argv[index]!;
  const eqIdx = token.indexOf('=');
  if (eqIdx !== -1) {
    const inlineVal = token.slice(eqIdx + 1);
    if (inlineVal.length === 0) {
      throw new UsageError(`Missing value for option ${flagName}.`, 'INVALID_CLI_ARGS');
    }
    return { value: inlineVal, nextIndex: index };
  }

  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new UsageError(`Missing value for option ${flagName}.`, 'INVALID_CLI_ARGS');
  }
  return { value: next, nextIndex: index + 1 };
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  if (argv.length === 0) {
    throw new UsageError(
      'Missing command. Expected: sse-stream-lab check [target] [options].',
      'MISSING_COMMAND'
    );
  }

  const first = argv[0]!;
  if (first === '-h' || first === '--help') {
    return {
      kind: 'help',
      target: '.',
      format: 'text',
      failOn: 'medium',
      includeTests: false,
    };
  }
  if (first === '-v' || first === '--version') {
    return {
      kind: 'version',
      target: '.',
      format: 'text',
      failOn: 'medium',
      includeTests: false,
    };
  }

  if (first !== 'check') {
    throw new UsageError(
      `Unknown command "${first}". Expected "check".`,
      'UNKNOWN_COMMAND'
    );
  }

  let target: string | undefined;
  let format: OutputFormat = 'text';
  let failOn: FailOnThreshold = 'medium';
  let includeTests = false;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === '-h' || arg === '--help') {
      return {
        kind: 'help',
        target: '.',
        format: 'text',
        failOn: 'medium',
        includeTests: false,
      };
    }
    if (arg === '-v' || arg === '--version') {
      return {
        kind: 'version',
        target: '.',
        format: 'text',
        failOn: 'medium',
        includeTests: false,
      };
    }

    if (arg === '--include-tests') {
      includeTests = true;
      continue;
    }
    if (arg.startsWith('--include-tests=')) {
      const val = arg.slice('--include-tests='.length);
      if (val === 'true') {
        includeTests = true;
      } else if (val === 'false') {
        includeTests = false;
      } else {
        throw new UsageError(
          `Invalid value for --include-tests: "${val}".`,
          'INVALID_CLI_ARGS'
        );
      }
      continue;
    }

    if (arg === '--format' || arg.startsWith('--format=')) {
      const { value, nextIndex } = readOptionValue(argv, i, '--format');
      i = nextIndex;
      if (!VALID_FORMATS.has(value)) {
        throw new UsageError(
          `Invalid --format "${value}". Expected one of: text, json, sarif.`,
          'INVALID_FORMAT'
        );
      }
      format = value as OutputFormat;
      continue;
    }

    if (arg === '--fail-on' || arg.startsWith('--fail-on=')) {
      const { value, nextIndex } = readOptionValue(argv, i, '--fail-on');
      i = nextIndex;
      if (!VALID_FAIL_ON.has(value)) {
        throw new UsageError(
          `Invalid --fail-on "${value}". Expected one of: high, medium, low, info, none.`,
          'INVALID_FAIL_ON'
        );
      }
      failOn = value as FailOnThreshold;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new UsageError(`Unknown option "${arg}".`, 'UNKNOWN_OPTION');
    }

    if (target !== undefined) {
      throw new UsageError(
        `Unexpected extra positional argument "${arg}". Only one [target] is supported.`,
        'EXTRA_TARGET'
      );
    }
    target = arg;
  }

  return {
    kind: 'check',
    target: target ?? '.',
    format,
    failOn,
    includeTests,
  };
}

export function runCli(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
  cwd: string = process.cwd()
): number {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.kind === 'help') {
      io.stdout(getHelpText());
      return 0;
    }
    if (parsed.kind === 'version') {
      io.stdout(PACKAGE_VERSION);
      return 0;
    }

    const report = checkProject({
      target: parsed.target,
      cwd,
      format: parsed.format,
      failOn: parsed.failOn,
      includeTests: parsed.includeTests,
    });

    io.stdout(formatReport(report, parsed.format));
    return exceedsFailOnThreshold(report.findings, parsed.failOn) ? 1 : 0;
  } catch (err) {
    if (err instanceof SseStreamLabError) {
      io.stderr(`sse-stream-lab error [${err.code}]: ${err.message}`);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`sse-stream-lab error: ${message}`);
    return 2;
  }
}

export function isMainModule(
  metaUrl: string,
  argv1: string | undefined = process.argv[1]
): boolean {
  if (!argv1) {
    return false;
  }
  const selfPath = fileURLToPath(metaUrl);
  try {
    const invokedReal = fs.realpathSync.native(path.resolve(argv1));
    const selfReal = fs.realpathSync.native(selfPath);
    return invokedReal === selfReal;
  } catch {
    return path.resolve(argv1) === path.resolve(selfPath);
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
