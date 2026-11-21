import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  discoverProjectFiles,
  hasPosixBackslashTraversal,
  PathSecurityError,
  resolveSafePath,
} from '../src/index.js';

function createDirectoryLink(targetDir: string, linkPath: string): void {
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(targetDir, linkPath, linkType);
}

describe('pathGuard security invariants & file discovery', () => {
  it('explicitly rejects Windows-style ..\\ traversal on POSIX while preserving valid relative paths', () => {
    assert.equal(hasPosixBackslashTraversal('..\\etc\\passwd', 'linux'), true);
    assert.equal(hasPosixBackslashTraversal('sub\\..\\..\\secret.ts', 'darwin'), true);
    assert.equal(hasPosixBackslashTraversal('\\etc\\hosts', 'linux'), true);
    assert.equal(hasPosixBackslashTraversal('src/server.ts', 'linux'), false);
    assert.equal(hasPosixBackslashTraversal('..\\neighbor', 'win32'), false);

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-posix-guard-'));
    try {
      assert.throws(
        () => resolveSafePath('..\\outside.ts', tmpRoot, { platform: 'linux' }),
        (err: unknown) =>
          err instanceof PathSecurityError && err.code === 'PATH_TRAVERSAL_BLOCKED'
      );
      assert.throws(
        () => resolveSafePath('../outside.ts', tmpRoot),
        (err: unknown) =>
          err instanceof PathSecurityError && err.code === 'PATH_TRAVERSAL_BLOCKED'
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('canonicalizes both resolvedRoot and path.dirname(resolvedInput) safely across aliased/8.3 parent dirs', () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-83-outer-'));
    try {
      const realWorkspace = path.join(outer, 'long-workspace-directory-name');
      const aliasWorkspace = path.join(outer, 'ws-alias');
      fs.mkdirSync(path.join(realWorkspace, 'src'), { recursive: true });
      const serverFile = path.join(realWorkspace, 'src', 'server.ts');
      fs.writeFileSync(serverFile, 'export const ok = true;\n', 'utf8');

      createDirectoryLink(realWorkspace, aliasWorkspace);

      const resolvedViaAlias = resolveSafePath('src/server.ts', aliasWorkspace);
      assert.equal(resolvedViaAlias, fs.realpathSync.native(serverFile));

      const discovered = discoverProjectFiles('.', { cwd: aliasWorkspace });
      assert.equal(discovered.files.length, 1);
      assert.equal(discovered.files[0]?.displayPath, 'src/server.ts');
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it('blocks symlink escapes with SYMLINK_ESCAPE_BLOCKED both directly and inside scanned directories', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-sym-root-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-sym-outside-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'secret.ts'), 'export const s = 1;\n', 'utf8');
      const escapeLink = path.join(rootDir, 'escaped-dir');
      createDirectoryLink(outsideDir, escapeLink);

      assert.throws(
        () => resolveSafePath('escaped-dir', rootDir),
        (err: unknown) =>
          err instanceof PathSecurityError &&
          err.code === 'SYMLINK_ESCAPE_BLOCKED' &&
          err.exitCode === 2
      );

      assert.throws(
        () => discoverProjectFiles(rootDir),
        (err: unknown) =>
          err instanceof PathSecurityError &&
          err.code === 'SYMLINK_ESCAPE_BLOCKED' &&
          err.exitCode === 2
      );

      assert.throws(
        () => discoverProjectFiles(escapeLink, { cwd: rootDir }),
        (err: unknown) =>
          err instanceof PathSecurityError &&
          err.code === 'SYMLINK_ESCAPE_BLOCKED' &&
          err.exitCode === 2
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('excludes .d.ts, build/node_modules, dist-tests/, framework build dirs, and test files unless --include-tests or targeted directly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-walk-'));
    try {
      const layout: Record<string, string> = {
        'src/index.ts': 'export const x = 1;\n',
        'src/helper.mjs': 'export const h = 2;\n',
        'src/types.d.ts': 'export interface T { a: string }\n',
        'src/index.test.ts': 'export const t = 1;\n',
        'src/index.spec.js': 'export const s = 1;\n',
        'test/unit.ts': 'export const u = 1;\n',
        'tests/e2e.ts': 'export const e = 1;\n',
        '__tests__/integ.tsx': 'export const i = 1;\n',
        'dist/index.js': 'export const d = 1;\n',
        'dist-test/index.js': 'export const dt = 1;\n',
        'dist-tests/index.js': 'export const dts = 1;\n',
        'build/out.js': 'export const b = 1;\n',
        'coverage/lcov.js': 'export const c = 1;\n',
        'out/server.js': 'export const o = 1;\n',
        '.next/server.js': 'export const nx = 1;\n',
        '.nuxt/server.mjs': 'export const nu = 1;\n',
        '.svelte-kit/index.js': 'export const sk = 1;\n',
        '.turbo/cache.js': 'export const tb = 1;\n',
        'node_modules/pkg/index.js': 'export const n = 1;\n',
      };
      for (const [rel, body] of Object.entries(layout)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf8');
      }

      const defaultWalk = discoverProjectFiles(dir, { includeTests: false });
      assert.deepEqual(
        defaultWalk.files.map((f) => f.displayPath),
        ['src/helper.mjs', 'src/index.ts']
      );

      const withTestsWalk = discoverProjectFiles(dir, { includeTests: true });
      assert.deepEqual(
        withTestsWalk.files.map((f) => f.displayPath),
        [
          '__tests__/integ.tsx',
          'src/helper.mjs',
          'src/index.spec.js',
          'src/index.test.ts',
          'src/index.ts',
          'test/unit.ts',
          'tests/e2e.ts',
        ]
      );

      const directTestTarget = discoverProjectFiles(path.join(dir, 'src', 'index.test.ts'), {
        includeTests: false,
      });
      assert.equal(directTestTarget.files.length, 1);
      assert.equal(directTestTarget.files[0]?.displayPath, 'index.test.ts');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces static-only audit invariants across src/ (zero home-dir, zero shell-mode, zero network modules)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const srcDir = path.join(repoRoot, 'src');
    const discovered = discoverProjectFiles(srcDir, { includeTests: true });
    assert.ok(discovered.files.length >= 8);

    const forbiddenHomeFn = `${'home'}${'dir'}`;
    const forbiddenShellOpt = `${'shell'}: true`;
    const forbiddenNetHttp = `node:${'http'}`;
    const forbiddenNetHttps = `node:${'https'}`;
    const forbiddenNetSocket = `node:${'net'}`;
    const forbiddenFetchCall = `${'fetch'}(`;

    for (const file of discovered.files) {
      const content = fs.readFileSync(file.absolutePath, 'utf8');
      assert.equal(content.includes(forbiddenHomeFn), false, `Forbidden home API in ${file.displayPath}`);
      assert.equal(content.includes(forbiddenShellOpt), false, `Forbidden shell option in ${file.displayPath}`);
      assert.equal(content.includes(forbiddenNetHttp), false, `Forbidden network module in ${file.displayPath}`);
      assert.equal(content.includes(forbiddenNetHttps), false, `Forbidden network module in ${file.displayPath}`);
      assert.equal(content.includes(forbiddenNetSocket), false, `Forbidden network module in ${file.displayPath}`);
      assert.equal(content.includes(forbiddenFetchCall), false, `Forbidden network call in ${file.displayPath}`);
    }
  });
});
