import * as fs from 'node:fs';
import * as path from 'node:path';
import { PathSecurityError } from '../types.js';

export const MAX_PATH_LENGTH = 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set<string>([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const ALWAYS_IGNORED_DIRS = new Set<string>([
  'node_modules',
  '.git',
  'dist',
  'dist-test',
  'dist-tests',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
]);

const TEST_DIR_NAMES = new Set<string>(['test', 'tests', '__tests__']);

export interface DiscoveredSourceFile {
  readonly absolutePath: string;
  readonly displayPath: string;
}

export interface DiscoverOptions {
  readonly cwd?: string;
  readonly rootDir?: string;
  readonly includeTests?: boolean;
  readonly platform?: NodeJS.Platform;
}

export function hasInvalidPathChars(input: string): boolean {
  if (!input || input.length > MAX_PATH_LENGTH) {
    return true;
  }
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function isUncOrSchemePath(input: string): boolean {
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    return true;
  }
  const colonIdx = input.indexOf(':');
  if (colonIdx > 1) {
    return true;
  }
  if (colonIdx === 1 && input.indexOf(':', 2) !== -1) {
    return true;
  }
  return false;
}

export function hasPosixBackslashTraversal(
  input: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') {
    return false;
  }
  if (!input.includes('\\')) {
    return false;
  }
  if (input.startsWith('\\')) {
    return true;
  }
  const normalizedSlashes = input.replaceAll('\\', '/');
  const segments = normalizedSlashes.split('/');
  return segments.includes('..');
}

function isCaseInsensitivePlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function normalizeForComparison(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const resolved = pathMod.resolve(targetPath);
  return isCaseInsensitivePlatform(platform) ? resolved.toLowerCase() : resolved;
}

export function isWithinRoot(
  canonicalRoot: string,
  candidatePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const normRoot = normalizeForComparison(canonicalRoot, platform);
  const normCandidate = normalizeForComparison(candidatePath, platform);
  const rel = pathMod.relative(normRoot, normCandidate);
  if (rel === '') {
    return true;
  }
  if (rel === '..' || rel.startsWith(`..${pathMod.sep}`) || pathMod.isAbsolute(rel)) {
    return false;
  }
  return true;
}

function canonicalizeExistingPathOrAncestor(targetPath: string): string {
  let current = targetPath;
  const trailingSegments: string[] = [];

  while (true) {
    try {
      fs.lstatSync(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new PathSecurityError(
          `Unable to resolve existing path ancestor: ${targetPath}`,
          'ANCESTOR_NOT_FOUND'
        );
      }
      trailingSegments.push(path.basename(current));
      current = parent;
    }
  }

  let realExisting: string;
  try {
    realExisting = fs.realpathSync.native(current);
  } catch {
    throw new PathSecurityError(
      `Failed to canonicalize path: ${current}`,
      'REALPATH_FAILED'
    );
  }

  if (trailingSegments.length === 0) {
    return realExisting;
  }
  trailingSegments.reverse();
  return path.join(realExisting, ...trailingSegments);
}

export function resolveSafePath(
  inputPath: string,
  rootDir: string,
  options: { readonly platform?: NodeJS.Platform } = {}
): string {
  const platform = options.platform ?? process.platform;

  if (hasInvalidPathChars(inputPath) || hasInvalidPathChars(rootDir)) {
    throw new PathSecurityError(
      'Path contains prohibited characters or exceeds length limit.',
      'INVALID_PATH'
    );
  }
  if (isUncOrSchemePath(inputPath) || isUncOrSchemePath(rootDir)) {
    throw new PathSecurityError(
      'UNC, URL scheme, and alternate data stream paths are blocked.',
      'UNC_BLOCKED'
    );
  }
  if (hasPosixBackslashTraversal(inputPath, platform)) {
    throw new PathSecurityError(
      'Windows-style backslash traversal is rejected on POSIX platforms.',
      'PATH_TRAVERSAL_BLOCKED'
    );
  }

  const resolvedRoot = path.resolve(rootDir);
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(resolvedRoot);
  } catch {
    throw new PathSecurityError(`Root directory does not exist: ${rootDir}`, 'NOT_FOUND');
  }

  const resolvedInput = path.resolve(resolvedRoot, inputPath);
  const parentDir = path.dirname(resolvedInput);
  const canonicalParent = canonicalizeExistingPathOrAncestor(parentDir);
  const canonicalLexicalTarget =
    resolvedInput === parentDir
      ? canonicalParent
      : path.join(canonicalParent, path.basename(resolvedInput));

  if (!isWithinRoot(canonicalRoot, canonicalLexicalTarget, platform)) {
    throw new PathSecurityError(
      `Target path escapes root boundary: ${inputPath}`,
      'PATH_TRAVERSAL_BLOCKED'
    );
  }

  try {
    fs.lstatSync(resolvedInput);
  } catch {
    throw new PathSecurityError(`Target path does not exist: ${inputPath}`, 'NOT_FOUND');
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync.native(resolvedInput);
  } catch {
    throw new PathSecurityError(
      `Broken symbolic link or unreadable path: ${inputPath}`,
      'SYMLINK_ESCAPE_BLOCKED'
    );
  }

  if (!isWithinRoot(canonicalRoot, realTarget, platform)) {
    throw new PathSecurityError(
      `Symbolic link escapes root boundary: ${inputPath}`,
      'SYMLINK_ESCAPE_BLOCKED'
    );
  }

  return realTarget;
}

export function isSupportedSourceFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const ext = path.extname(lower);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return false;
  }
  const stem = lower.slice(0, lower.length - ext.length);
  if (stem.endsWith('.d')) {
    return false;
  }
  return true;
}

export function isTestFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const ext = path.extname(lower);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return false;
  }
  const stem = lower.slice(0, lower.length - ext.length);
  return stem.endsWith('.test') || stem.endsWith('.spec');
}

export function toPosixDisplayPath(baseDir: string, absoluteFile: string): string {
  const rel = path.relative(baseDir, absoluteFile);
  if (!rel || rel === '') {
    return path.basename(absoluteFile).replaceAll('\\', '/');
  }
  return rel.replaceAll('\\', '/');
}

export function discoverProjectFiles(
  targetInput: string,
  options: DiscoverOptions = {}
): { readonly scanRoot: string; readonly files: readonly DiscoveredSourceFile[] } {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const includeTests = options.includeTests ?? false;

  if (hasInvalidPathChars(targetInput)) {
    throw new PathSecurityError(`Invalid target path: ${targetInput}`, 'INVALID_PATH');
  }
  if (isUncOrSchemePath(targetInput)) {
    throw new PathSecurityError(
      'UNC, URL scheme, and alternate data stream paths are blocked.',
      'UNC_BLOCKED'
    );
  }
  if (hasPosixBackslashTraversal(targetInput, platform)) {
    throw new PathSecurityError(
      'Windows-style backslash traversal is rejected on POSIX platforms.',
      'PATH_TRAVERSAL_BLOCKED'
    );
  }

  if (options.rootDir !== undefined) {
    resolveSafePath(targetInput, options.rootDir, { platform });
  }

  const resolvedRoot = path.resolve(cwd);
  let canonicalCwd: string;
  try {
    canonicalCwd = fs.realpathSync.native(resolvedRoot);
  } catch {
    throw new PathSecurityError(`Working directory is unreadable: ${cwd}`, 'NOT_FOUND');
  }

  const resolvedInput = path.resolve(resolvedRoot, targetInput);
  let inputLstat: fs.Stats;
  try {
    inputLstat = fs.lstatSync(resolvedInput);
  } catch {
    throw new PathSecurityError(`Target path does not exist: ${targetInput}`, 'NOT_FOUND');
  }

  const parentDir = path.dirname(resolvedInput);
  let canonicalParent: string;
  try {
    canonicalParent = fs.realpathSync.native(parentDir);
  } catch {
    throw new PathSecurityError(
      `Failed to canonicalize target parent directory: ${targetInput}`,
      'REALPATH_FAILED'
    );
  }

  const canonicalLexicalInput =
    resolvedInput === parentDir
      ? canonicalParent
      : path.join(canonicalParent, path.basename(resolvedInput));

  let realTarget: string;
  try {
    realTarget = fs.realpathSync.native(resolvedInput);
  } catch {
    throw new PathSecurityError(
      `Broken symbolic link or unreadable target: ${targetInput}`,
      'SYMLINK_ESCAPE_BLOCKED'
    );
  }

  if (inputLstat.isSymbolicLink()) {
    const escapedCwd =
      isWithinRoot(canonicalCwd, canonicalLexicalInput, platform) &&
      !isWithinRoot(canonicalCwd, realTarget, platform);
    const escapedParent = !isWithinRoot(canonicalParent, realTarget, platform);
    if (escapedCwd || escapedParent) {
      throw new PathSecurityError(
        `Symbolic link escapes boundary: ${targetInput}`,
        'SYMLINK_ESCAPE_BLOCKED'
      );
    }
  }

  let targetStat: fs.Stats;
  try {
    targetStat = fs.statSync(realTarget);
  } catch {
    throw new PathSecurityError(`Target path is unreadable: ${targetInput}`, 'STAT_FAILED');
  }

  if (targetStat.isFile()) {
    const fileName = path.basename(realTarget);
    const scanRoot = path.dirname(realTarget);
    if (!isSupportedSourceFile(fileName) || targetStat.size > MAX_FILE_BYTES) {
      return { scanRoot, files: [] };
    }
    return {
      scanRoot,
      files: [
        {
          absolutePath: realTarget,
          displayPath: fileName,
        },
      ],
    };
  }

  if (!targetStat.isDirectory()) {
    throw new PathSecurityError(
      `Target path must be a regular file or directory: ${targetInput}`,
      'INVALID_TARGET'
    );
  }

  const canonicalScanRoot = realTarget;
  const visitedDirs = new Set<string>([normalizeForComparison(canonicalScanRoot, platform)]);
  const files: DiscoveredSourceFile[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (ALWAYS_IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      if (
        !includeTests &&
        TEST_DIR_NAMES.has(entry.name) &&
        (entry.isDirectory() || entry.isSymbolicLink())
      ) {
        continue;
      }

      const fullEntryPath = path.join(currentDir, entry.name);

      if (entry.isSymbolicLink()) {
        let resolvedLink: string;
        try {
          resolvedLink = fs.realpathSync.native(fullEntryPath);
        } catch {
          throw new PathSecurityError(
            `Broken symbolic link inside target directory: ${entry.name}`,
            'SYMLINK_ESCAPE_BLOCKED'
          );
        }

        if (!isWithinRoot(canonicalScanRoot, resolvedLink, platform)) {
          throw new PathSecurityError(
            `Symbolic link escapes scan root boundary: ${entry.name}`,
            'SYMLINK_ESCAPE_BLOCKED'
          );
        }

        let linkStat: fs.Stats;
        try {
          linkStat = fs.statSync(resolvedLink);
        } catch {
          continue;
        }

        if (linkStat.isDirectory()) {
          if (!includeTests && TEST_DIR_NAMES.has(entry.name)) {
            continue;
          }
          const normKey = normalizeForComparison(resolvedLink, platform);
          if (visitedDirs.has(normKey)) {
            continue;
          }
          visitedDirs.add(normKey);
          walk(resolvedLink);
        } else if (linkStat.isFile()) {
          if (!isSupportedSourceFile(entry.name)) {
            continue;
          }
          if (!includeTests && isTestFileName(entry.name)) {
            continue;
          }
          if (linkStat.size <= MAX_FILE_BYTES) {
            files.push({
              absolutePath: resolvedLink,
              displayPath: toPosixDisplayPath(canonicalScanRoot, fullEntryPath),
            });
          }
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!includeTests && TEST_DIR_NAMES.has(entry.name)) {
          continue;
        }
        const normKey = normalizeForComparison(fullEntryPath, platform);
        if (visitedDirs.has(normKey)) {
          continue;
        }
        visitedDirs.add(normKey);
        walk(fullEntryPath);
        continue;
      }

      if (entry.isFile()) {
        if (!isSupportedSourceFile(entry.name)) {
          continue;
        }
        if (!includeTests && isTestFileName(entry.name)) {
          continue;
        }
        let fileStat: fs.Stats;
        try {
          fileStat = fs.statSync(fullEntryPath);
        } catch {
          continue;
        }
        if (fileStat.size <= MAX_FILE_BYTES) {
          files.push({
            absolutePath: fullEntryPath,
            displayPath: toPosixDisplayPath(canonicalScanRoot, fullEntryPath),
          });
        }
      }
    }
  }

  walk(canonicalScanRoot);
  files.sort((a, b) => (a.displayPath < b.displayPath ? -1 : a.displayPath > b.displayPath ? 1 : 0));

  return {
    scanRoot: canonicalScanRoot,
    files,
  };
}
