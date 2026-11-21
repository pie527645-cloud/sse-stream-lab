import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeSources,
  buildSarifLog,
  type CheckReport,
  formatJson,
  formatReport,
  formatSarif,
  formatText,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  RULES,
  summarizeFindings,
} from '../src/index.js';

function createSampleReport(): CheckReport {
  const findings = analyzeSources([
    {
      absolutePath: '/virtual/src/server.ts',
      displayPath: 'src/server.ts',
      content: `
        export function handler(_req: any, res: any) {
          res.setHeader('Content-Type', 'text/event-stream');
          fetch('https://api.example.com/events');
        }
      `,
    },
  ]);

  return {
    tool: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    target: '.',
    scannedFiles: 1,
    options: {
      failOn: 'medium',
      includeTests: false,
    },
    summary: summarizeFindings(findings),
    findings,
  };
}

describe('Output formatters: Text, JSON, and SARIF v2.1.0', () => {
  it('formats human-readable text output for both finding reports and clean reports', () => {
    const report = createSampleReport();
    const text = formatText(report);
    assert.ok(text.includes('src/server.ts:'));
    assert.ok(text.includes('[medium] SSE001:'));
    assert.ok(text.includes('[medium] SSE004:'));
    assert.ok(text.includes('sse-stream-lab: 2 finding(s) (0 high, 2 medium, 0 low, 0 info) across 1 scanned file(s).'));

    const cleanReport: CheckReport = {
      ...report,
      summary: { total: 0, high: 0, medium: 0, low: 0, info: 0 },
      findings: [],
    };
    const cleanText = formatReport(cleanReport, 'text');
    assert.equal(cleanText, 'sse-stream-lab: 0 findings across 1 scanned file(s).');
  });

  it('formats deterministic JSON output matching CheckReport schema', () => {
    const report = createSampleReport();
    const raw = formatJson(report);
    const parsed = JSON.parse(raw) as CheckReport;
    assert.equal(parsed.tool, '@pie527645-cloud/sse-stream-lab');
    assert.equal(parsed.version, '1.0.0');
    assert.equal(parsed.summary.total, 2);
    assert.equal(parsed.summary.medium, 2);
    assert.equal(parsed.findings.length, 2);
  });

  it('produces valid SARIF v2.1.0 output with driver rules, regions, and warning level mapping', () => {
    const report = createSampleReport();
    const sarifRaw = formatSarif(report);
    const sarif = JSON.parse(sarifRaw) as ReturnType<typeof buildSarifLog>;

    assert.equal(sarif.$schema, 'https://json.schemastore.org/sarif-2.1.0.json');
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs.length, 1);

    const run = sarif.runs[0];
    assert.equal(run.tool.driver.name, PACKAGE_NAME);
    assert.equal(run.tool.driver.version, PACKAGE_VERSION);
    assert.equal(run.tool.driver.rules.length, RULES.length);
    assert.deepEqual(
      run.tool.driver.rules.map((r) => r.id),
      ['SSE001', 'SSE002', 'SSE003', 'SSE004']
    );

    assert.equal(run.results.length, 2);
    for (const res of run.results) {
      assert.equal(res.level, 'warning');
      assert.equal(res.properties.severity, 'medium');
      const loc = res.locations[0].physicalLocation;
      assert.equal(loc.artifactLocation.uri, 'src/server.ts');
      assert.equal(loc.artifactLocation.uriBaseId, '%SRCROOT%');
      assert.ok(loc.region.startLine >= 1);
      assert.ok(loc.region.startColumn >= 1);
      assert.ok(loc.region.endLine >= loc.region.startLine);
    }
  });
});
