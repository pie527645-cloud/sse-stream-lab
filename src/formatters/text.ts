import type { CheckReport } from '../types.js';

export function formatText(report: CheckReport): string {
  const lines: string[] = [];

  for (const finding of report.findings) {
    lines.push(
      `${finding.file}:${finding.line}:${finding.column} [${finding.severity}] ${finding.ruleId}: ${finding.message}`
    );
  }

  if (report.findings.length === 0) {
    lines.push(
      `sse-stream-lab: 0 findings across ${report.scannedFiles} scanned file(s).`
    );
  } else {
    const s = report.summary;
    lines.push(
      `sse-stream-lab: ${s.total} finding(s) (${s.high} high, ${s.medium} medium, ${s.low} low, ${s.info} info) across ${report.scannedFiles} scanned file(s).`
    );
  }

  return lines.join('\n');
}
