import * as fs from 'node:fs';
import { analyzeSources, type AnalyzerOptions } from './analyzer/astAnalyzer.js';
import {
  buildSarifLog,
  formatJson,
  formatReport,
  formatSarif,
  formatText,
  type SarifLevel,
  type SarifLog,
  severityToSarifLevel,
} from './formatters/index.js';
import {
  exceedsFailOnThreshold,
  RULE_MAP,
  RULES,
  SEVERITY_RANK,
  summarizeFindings,
} from './rules.js';
import {
  type DiscoveredSourceFile,
  type DiscoverOptions,
  discoverProjectFiles,
  hasInvalidPathChars,
  hasPosixBackslashTraversal,
  isSupportedSourceFile,
  isTestFileName,
  isWithinRoot,
  resolveSafePath,
} from './security/pathGuard.js';
import {
  type CheckOptions,
  type CheckReport,
  type FailOnThreshold,
  type Finding,
  type OutputFormat,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PathSecurityError,
  type RuleId,
  type RuleMetadata,
  type Severity,
  type SeveritySummary,
  type SourceInput,
  SseStreamLabError,
  UsageError,
} from './types.js';

export function checkProject(options: CheckOptions = {}): CheckReport {
  const target = options.target ?? '.';
  const failOn: FailOnThreshold = options.failOn ?? 'medium';
  const includeTests = options.includeTests ?? false;

  const discovered = discoverProjectFiles(target, {
    cwd: options.cwd,
    rootDir: options.rootDir,
    includeTests,
  });

  const sources: SourceInput[] = [];
  for (const file of discovered.files) {
    const content = fs.readFileSync(file.absolutePath, 'utf8');
    sources.push({
      absolutePath: file.absolutePath,
      displayPath: file.displayPath,
      content,
    });
  }

  const findings = analyzeSources(sources);
  const summary = summarizeFindings(findings);

  return {
    tool: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    target: target.replaceAll('\\', '/'),
    scannedFiles: sources.length,
    options: {
      failOn,
      includeTests,
    },
    summary,
    findings,
  };
}

export {
  analyzeSources,
  buildSarifLog,
  discoverProjectFiles,
  exceedsFailOnThreshold,
  formatJson,
  formatReport,
  formatSarif,
  formatText,
  hasInvalidPathChars,
  hasPosixBackslashTraversal,
  isSupportedSourceFile,
  isTestFileName,
  isWithinRoot,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PathSecurityError,
  resolveSafePath,
  RULE_MAP,
  RULES,
  SEVERITY_RANK,
  severityToSarifLevel,
  SseStreamLabError,
  summarizeFindings,
  UsageError,
};

export type {
  AnalyzerOptions,
  CheckOptions,
  CheckReport,
  DiscoveredSourceFile,
  DiscoverOptions,
  FailOnThreshold,
  Finding,
  OutputFormat,
  RuleId,
  RuleMetadata,
  SarifLevel,
  SarifLog,
  Severity,
  SeveritySummary,
  SourceInput,
};
