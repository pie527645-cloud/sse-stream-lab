import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { CheckReport, SarifLog } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli.js');

interface CliExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function invokeCli(args: readonly string[], cwd: string = REPO_ROOT): CliExecResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      shell: false,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: typeof e.status === 'number' ? e.status : 2,
      stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf8') ?? ''),
    };
  }
}

describe('CLI integration & exit code contract', () => {
  it('ensures dist/cli.js has LF line endings and #!/usr/bin/env node shebang', () => {
    const raw = fs.readFileSync(CLI_PATH, 'utf8');
    assert.equal(raw.startsWith('#!/usr/bin/env node\n'), true);
    assert.equal(raw.includes('\r\n'), false);
  });

  it('supports --help and --version with exit code 0', () => {
    const helpRes = invokeCli(['--help']);
    assert.equal(helpRes.status, 0);
    assert.ok(helpRes.stdout.includes('sse-stream-lab check [target]'));

    const verRes = invokeCli(['--version']);
    assert.equal(verRes.status, 0);
    assert.equal(verRes.stdout.trim(), '1.0.0');
  });

  it('returns exit code 0 on clean self-check and respects --fail-on thresholds and --include-tests', () => {
    const selfRes = invokeCli(['check', '.', '--format', 'json']);
    assert.equal(selfRes.status, 0);
    const selfReport = JSON.parse(selfRes.stdout) as CheckReport;
    assert.equal(selfReport.summary.total, 0);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-cli-threshold-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

      // Medium finding in src/sse.ts (missing Cache-Control -> SSE001 medium)
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'sse.ts'),
        `
        export function handler(_req: any, res: any) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.write('data: hi\\n\\n');
        }
        `,
        'utf8'
      );

      // Additional finding in test/fixture.test.ts (skipped unless --include-tests)
      fs.writeFileSync(
        path.join(tmpDir, 'test', 'fixture.test.ts'),
        `
        export async function badLoop(reader: any) {
          const decoder = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            decoder.decode(value);
          }
        }
        `,
        'utf8'
      );

      // Default --fail-on medium -> exits 1 with 1 finding (test/ excluded)
      const defaultRes = invokeCli(['check', tmpDir, '--format', 'json']);
      assert.equal(defaultRes.status, 1);
      const defaultReport = JSON.parse(defaultRes.stdout) as CheckReport;
      assert.equal(defaultReport.summary.total, 1);
      assert.equal(defaultReport.findings[0]?.ruleId, 'SSE001');

      // --include-tests -> scans test/fixture.test.ts too -> 2 findings
      const withTestsRes = invokeCli([
        'check',
        tmpDir,
        '--include-tests',
        '--format',
        'sarif',
      ]);
      assert.equal(withTestsRes.status, 1);
      const sarif = JSON.parse(withTestsRes.stdout) as SarifLog;
      assert.equal(sarif.version, '2.1.0');
      assert.equal(sarif.runs[0].results.length, 2);

      // --fail-on high -> medium finding is below threshold -> exits 0
      const highThresholdRes = invokeCli(['check', tmpDir, '--fail-on', 'high']);
      assert.equal(highThresholdRes.status, 0);

      // --fail-on none -> always exits 0
      const noneThresholdRes = invokeCli(['check', tmpDir, '--fail-on=none']);
      assert.equal(noneThresholdRes.status, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns exit code 2 on invalid CLI arguments, missing target, or symlink escape', () => {
    assert.equal(invokeCli([]).status, 2);
    assert.equal(invokeCli(['unknown']).status, 2);
    assert.equal(invokeCli(['check', '.', '--unknown-flag']).status, 2);
    assert.equal(invokeCli(['check', '.', '--format', 'xml']).status, 2);
    assert.equal(invokeCli(['check', '.', '--fail-on', 'critical']).status, 2);
    assert.equal(invokeCli(['check', '.', 'extra-arg']).status, 2);
    assert.equal(invokeCli(['check', './missing-target-dir-99999']).status, 2);

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-cli-symroot-'));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-cli-symout-'));
    try {
      fs.writeFileSync(path.join(outDir, 'leak.ts'), 'export const a = 1;\n', 'utf8');
      const linkPath = path.join(rootDir, 'escape-junction');
      fs.symlinkSync(outDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

      const escapeRes = invokeCli(['check', rootDir]);
      assert.equal(escapeRes.status, 2);
      assert.ok(escapeRes.stderr.includes('SYMLINK_ESCAPE_BLOCKED'));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
