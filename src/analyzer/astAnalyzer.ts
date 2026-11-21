import ts from 'typescript';
import type { Finding, RuleId, Severity, SourceInput } from '../types.js';

export interface AnalyzerOptions {
  readonly includeInfo?: boolean;
}

interface HeaderRecord {
  readonly lowerName: string;
  readonly value: string;
  readonly node: ts.Node;
}

interface SseHandlerRecord {
  readonly scopeNode: ts.Node;
  readonly triggerNode: ts.Node;
  readonly hasCacheControl: boolean;
  readonly unguardedUpstreamNode: ts.Node | undefined;
}

interface GlobalCompressionCandidate {
  readonly file: string;
  readonly sourceFile: ts.SourceFile;
  readonly node: ts.Node;
}

interface ParsedFileAnalysis {
  readonly input: SourceInput;
  readonly sourceFile: ts.SourceFile;
  readonly sseHandlers: readonly SseHandlerRecord[];
  readonly compressionCandidates: readonly GlobalCompressionCandidate[];
  readonly streamDecodeFindings: readonly Finding[];
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lower.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createFinding(
  sourceFile: ts.SourceFile,
  file: string,
  node: ts.Node,
  ruleId: RuleId,
  severity: Severity,
  message: string
): Finding {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    ruleId,
    severity,
    message,
    file,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function unwrapParensAndTypes(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

function getStaticString(expr: ts.Expression | undefined): string | undefined {
  if (!expr) {
    return undefined;
  }
  const unwrapped = unwrapParensAndTypes(expr);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  return undefined;
}

function getPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return getStaticString(name.expression);
  }
  return undefined;
}

function isUndefinedLiteral(expr: ts.Expression): boolean {
  const unwrapped = unwrapParensAndTypes(expr);
  return ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined';
}

function isEventStreamMime(rawValue: string): boolean {
  const normalized = rawValue.trim().toLowerCase();
  return normalized === 'text/event-stream' || normalized.startsWith('text/event-stream;');
}

function isNonEmptyCacheControlValue(rawValue: string): boolean {
  if (rawValue === '__dynamic__') {
    return true;
  }
  return rawValue.trim().length > 0;
}

function isFunctionLikeNode(
  node: ts.Node
): node is
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function isCallToNamedFunction(call: ts.CallExpression, targetName: string): boolean {
  const callee = unwrapParensAndTypes(call.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text === targetName;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === targetName;
  }
  return false;
}

function isNewConstructNamed(expr: ts.Expression, className: string): expr is ts.NewExpression {
  const unwrapped = unwrapParensAndTypes(expr);
  if (!ts.isNewExpression(unwrapped)) {
    return false;
  }
  const callee = unwrapParensAndTypes(unwrapped.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text === className;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === className;
  }
  return false;
}

function isTransparentInnerCallback(fnNode: ts.Node): boolean {
  const parent = fnNode.parent;
  if (!parent) {
    return false;
  }

  // Method or property inside new ReadableStream({ start() {}, pull() {}, cancel() {} })
  if (ts.isMethodDeclaration(fnNode) && ts.isObjectLiteralExpression(parent)) {
    const grand = parent.parent;
    if (grand && ts.isNewExpression(grand) && isNewConstructNamed(grand, 'ReadableStream')) {
      return true;
    }
  }
  if (
    (ts.isArrowFunction(fnNode) || ts.isFunctionExpression(fnNode)) &&
    ts.isPropertyAssignment(parent) &&
    ts.isObjectLiteralExpression(parent.parent)
  ) {
    const objParent = parent.parent.parent;
    if (
      objParent &&
      ts.isNewExpression(objParent) &&
      isNewConstructNamed(objParent, 'ReadableStream')
    ) {
      return true;
    }
  }

  // Callback passed to streamSSE(c, async (stream) => { ... })
  if (
    (ts.isArrowFunction(fnNode) || ts.isFunctionExpression(fnNode)) &&
    ts.isCallExpression(parent) &&
    isCallToNamedFunction(parent, 'streamSSE')
  ) {
    return true;
  }

  // Immediately invoked function expression: (async () => { ... })()
  if (ts.isArrowFunction(fnNode) || ts.isFunctionExpression(fnNode)) {
    let cur: ts.Node = fnNode;
    while (cur.parent && ts.isParenthesizedExpression(cur.parent)) {
      cur = cur.parent;
    }
    if (cur.parent && ts.isCallExpression(cur.parent) && cur.parent.expression === cur) {
      return true;
    }
  }

  return false;
}

function findEnclosingHandlerScope(node: ts.Node, sourceFile: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== sourceFile) {
    if (isFunctionLikeNode(current)) {
      if (isTransparentInnerCallback(current)) {
        current = current.parent;
        continue;
      }
      return current;
    }
    current = current.parent;
  }
  return sourceFile;
}

const ROUTE_REGISTRATION_METHODS = new Set<string>([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'all',
  'options',
  'head',
  'use',
  'route',
  'onRequest',
]);

function isSeparateNestedRouteCallback(fnNode: ts.Node): boolean {
  const parent = fnNode.parent;
  if (!parent || !ts.isCallExpression(parent)) {
    return false;
  }
  const callee = unwrapParensAndTypes(parent.expression);
  if (ts.isPropertyAccessExpression(callee) && ROUTE_REGISTRATION_METHODS.has(callee.name.text)) {
    return true;
  }
  if (ts.isIdentifier(callee) && callee.text === 'createServer') {
    return true;
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createServer') {
    return true;
  }
  return false;
}

function visitHandlerScope(
  scopeRoot: ts.Node,
  visitor: (node: ts.Node) => void
): void {
  function walk(node: ts.Node): void {
    if (node !== scopeRoot) {
      if (ts.isSourceFile(scopeRoot) && isFunctionLikeNode(node)) {
        return;
      }
      if (isFunctionLikeNode(node) && isSeparateNestedRouteCallback(node)) {
        return;
      }
    }
    visitor(node);
    ts.forEachChild(node, walk);
  }
  walk(scopeRoot);
}

function collectConstExpressions(root: ts.Node): Map<string, ts.Expression> {
  const map = new Map<string, ts.Expression>();
  function walk(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      node.parent &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      map.set(node.name.text, unwrapParensAndTypes(node.initializer));
    }
    ts.forEachChild(node, walk);
  }
  walk(root);
  return map;
}

function collectHeaderMutations(root: ts.Node): Map<string, HeaderRecord[]> {
  const map = new Map<string, HeaderRecord[]>();
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = unwrapParensAndTypes(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'set' || callee.name.text === 'append') &&
        ts.isIdentifier(callee.expression) &&
        node.arguments.length >= 2
      ) {
        const keyStr = getStaticString(node.arguments[0]);
        const valArg = node.arguments[1]!;
        if (keyStr !== undefined && !isUndefinedLiteral(valArg)) {
          const valStr = getStaticString(valArg) ?? '__dynamic__';
          const list = map.get(callee.expression.text) ?? [];
          list.push({
            lowerName: keyStr.trim().toLowerCase(),
            value: valStr,
            node,
          });
          map.set(callee.expression.text, list);
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(root);
  return map;
}

function extractHeadersFromExpr(
  expr: ts.Expression | undefined,
  reportNode: ts.Node,
  constMap: ReadonlyMap<string, ts.Expression>,
  mutationsMap: ReadonlyMap<string, readonly HeaderRecord[]>,
  visited = new Set<string>()
): HeaderRecord[] {
  if (!expr) {
    return [];
  }
  const unwrapped = unwrapParensAndTypes(expr);
  const records: HeaderRecord[] = [];

  if (ts.isObjectLiteralExpression(unwrapped)) {
    for (const prop of unwrapped.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const key = getPropertyNameText(prop.name);
        if (key !== undefined && !isUndefinedLiteral(prop.initializer)) {
          const val = getStaticString(prop.initializer) ?? '__dynamic__';
          records.push({
            lowerName: key.trim().toLowerCase(),
            value: val,
            node: reportNode,
          });
        }
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        records.push({
          lowerName: prop.name.text.trim().toLowerCase(),
          value: '__dynamic__',
          node: reportNode,
        });
      } else if (ts.isSpreadAssignment(prop)) {
        records.push(
          ...extractHeadersFromExpr(prop.expression, reportNode, constMap, mutationsMap, visited)
        );
      }
    }
    return records;
  }

  if (ts.isArrayLiteralExpression(unwrapped)) {
    for (const el of unwrapped.elements) {
      if (ts.isArrayLiteralExpression(el) && el.elements.length >= 2) {
        const key = getStaticString(el.elements[0]);
        const valExpr = el.elements[1]!;
        if (key !== undefined && !isUndefinedLiteral(valExpr)) {
          const val = getStaticString(valExpr) ?? '__dynamic__';
          records.push({
            lowerName: key.trim().toLowerCase(),
            value: val,
            node: reportNode,
          });
        }
      }
    }
    return records;
  }

  if (isNewConstructNamed(unwrapped, 'Headers')) {
    if (unwrapped.arguments && unwrapped.arguments.length >= 1) {
      records.push(
        ...extractHeadersFromExpr(
          unwrapped.arguments[0],
          reportNode,
          constMap,
          mutationsMap,
          visited
        )
      );
    }
    return records;
  }

  if (ts.isIdentifier(unwrapped)) {
    const name = unwrapped.text;
    if (visited.has(name)) {
      return records;
    }
    visited.add(name);
    const init = constMap.get(name);
    if (init) {
      records.push(
        ...extractHeadersFromExpr(init, reportNode, constMap, mutationsMap, visited)
      );
    }
    const muts = mutationsMap.get(name);
    if (muts) {
      for (const m of muts) {
        records.push({
          lowerName: m.lowerName,
          value: m.value,
          node: reportNode,
        });
      }
    }
    return records;
  }

  return records;
}

function extractHeadersFromResponseInit(
  initExpr: ts.Expression | undefined,
  reportNode: ts.Node,
  constMap: ReadonlyMap<string, ts.Expression>,
  mutationsMap: ReadonlyMap<string, readonly HeaderRecord[]>,
  visited = new Set<string>()
): HeaderRecord[] {
  if (!initExpr) {
    return [];
  }
  const unwrapped = unwrapParensAndTypes(initExpr);
  if (ts.isIdentifier(unwrapped)) {
    if (visited.has(unwrapped.text)) {
      return [];
    }
    visited.add(unwrapped.text);
    const resolved = constMap.get(unwrapped.text);
    return extractHeadersFromResponseInit(
      resolved,
      reportNode,
      constMap,
      mutationsMap,
      visited
    );
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    return [];
  }

  const out: HeaderRecord[] = [];
  for (const prop of unwrapped.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const propName = getPropertyNameText(prop.name);
      if (propName === 'headers') {
        out.push(
          ...extractHeadersFromExpr(prop.initializer, reportNode, constMap, mutationsMap)
        );
      }
    } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'headers') {
      out.push(
        ...extractHeadersFromExpr(prop.name, reportNode, constMap, mutationsMap)
      );
    } else if (ts.isSpreadAssignment(prop)) {
      out.push(
        ...extractHeadersFromResponseInit(
          prop.expression,
          reportNode,
          constMap,
          mutationsMap,
          visited
        )
      );
    }
  }
  return out;
}

function collectNodeHeaderRecords(
  node: ts.Node,
  constMap: ReadonlyMap<string, ts.Expression>,
  mutationsMap: ReadonlyMap<string, readonly HeaderRecord[]>
): { readonly headers: readonly HeaderRecord[]; readonly isStreamSseHelper: boolean } {
  if (ts.isNewExpression(node) && isNewConstructNamed(node, 'Response')) {
    const initArg = node.arguments?.[1];
    return {
      headers: extractHeadersFromResponseInit(initArg, node, constMap, mutationsMap),
      isStreamSseHelper: false,
    };
  }

  if (!ts.isCallExpression(node)) {
    return { headers: [], isStreamSseHelper: false };
  }

  if (isCallToNamedFunction(node, 'streamSSE')) {
    return { headers: [], isStreamSseHelper: true };
  }

  const callee = unwrapParensAndTypes(node.expression);

  // Standalone H3 / Nitro helpers: setHeader(event, name, value), setResponseHeader(event, name, value)
  if (ts.isIdentifier(callee)) {
    const fnName = callee.text;
    if (
      (fnName === 'setHeader' ||
        fnName === 'setResponseHeader' ||
        fnName === 'appendHeader' ||
        fnName === 'appendResponseHeader') &&
      node.arguments.length >= 3
    ) {
      const key = getStaticString(node.arguments[1]);
      const valArg = node.arguments[2]!;
      if (key !== undefined && !isUndefinedLiteral(valArg)) {
        return {
          headers: [
            {
              lowerName: key.trim().toLowerCase(),
              value: getStaticString(valArg) ?? '__dynamic__',
              node,
            },
          ],
          isStreamSseHelper: false,
        };
      }
    }
    if ((fnName === 'setHeaders' || fnName === 'setResponseHeaders') && node.arguments.length >= 2) {
      return {
        headers: extractHeadersFromExpr(node.arguments[1], node, constMap, mutationsMap),
        isStreamSseHelper: false,
      };
    }
    return { headers: [], isStreamSseHelper: false };
  }

  if (!ts.isPropertyAccessExpression(callee)) {
    return { headers: [], isStreamSseHelper: false };
  }

  const method = callee.name.text;

  // res.writeHead(200, headers) or res.writeHead(200, 'OK', headers)
  if (method === 'writeHead') {
    const out: HeaderRecord[] = [];
    if (node.arguments.length >= 2) {
      out.push(...extractHeadersFromExpr(node.arguments[1], node, constMap, mutationsMap));
    }
    if (node.arguments.length >= 3) {
      out.push(...extractHeadersFromExpr(node.arguments[2], node, constMap, mutationsMap));
    }
    return { headers: out, isStreamSseHelper: false };
  }

  // res.type('text/event-stream') / reply.type('text/event-stream') / res.contentType(...)
  if ((method === 'type' || method === 'contentType') && node.arguments.length >= 1) {
    const mimeVal = getStaticString(node.arguments[0]);
    if (mimeVal !== undefined) {
      return {
        headers: [
          {
            lowerName: 'content-type',
            value: mimeVal,
            node,
          },
        ],
        isStreamSseHelper: false,
      };
    }
  }

  // res.setHeader(k, v), res.set(k, v | obj), res.header(k, v | obj), headers.set(k, v), c.header(k, v)
  if (
    method === 'setHeader' ||
    method === 'set' ||
    method === 'header' ||
    method === 'append' ||
    method === 'headers' ||
    method === 'setHeaders'
  ) {
    if (
      (method === 'set' ||
        method === 'header' ||
        method === 'headers' ||
        method === 'setHeaders') &&
      node.arguments.length === 1
    ) {
      return {
        headers: extractHeadersFromExpr(node.arguments[0], node, constMap, mutationsMap),
        isStreamSseHelper: false,
      };
    }

    if (node.arguments.length >= 2) {
      const key = getStaticString(node.arguments[0]);
      const valArg = node.arguments[1]!;
      if (key !== undefined && !isUndefinedLiteral(valArg)) {
        return {
          headers: [
            {
              lowerName: key.trim().toLowerCase(),
              value: getStaticString(valArg) ?? '__dynamic__',
              node,
            },
          ],
          isStreamSseHelper: false,
        };
      }
    }
  }

  return { headers: [], isStreamSseHelper: false };
}

function collectCompressionImports(sourceFile: ts.SourceFile): {
  readonly importedNames: ReadonlySet<string>;
  readonly shadowedNonCompression: ReadonlySet<string>;
} {
  const importedNames = new Set<string>();
  const shadowedNonCompression = new Set<string>();

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const modName = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) {
        continue;
      }
      const isCompressionPkg = modName === 'compression' || modName === '@fastify/compress';
      if (clause.name) {
        if (isCompressionPkg) {
          importedNames.add(clause.name.text);
        } else {
          shadowedNonCompression.add(clause.name.text);
        }
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          if (isCompressionPkg) {
            importedNames.add(clause.namedBindings.name.text);
          } else {
            shadowedNonCompression.add(clause.namedBindings.name.text);
          }
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (isCompressionPkg) {
              importedNames.add(el.name.text);
            } else {
              shadowedNonCompression.add(el.name.text);
            }
          }
        }
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isCallExpression(decl.initializer)
        ) {
          const callee = unwrapParensAndTypes(decl.initializer.expression);
          if (
            ts.isIdentifier(callee) &&
            callee.text === 'require' &&
            decl.initializer.arguments.length >= 1
          ) {
            const reqMod = getStaticString(decl.initializer.arguments[0]);
            if (reqMod === 'compression') {
              importedNames.add(decl.name.text);
            } else if (reqMod !== undefined) {
              shadowedNonCompression.add(decl.name.text);
            }
          }
        }
      }
    }
  }

  return { importedNames, shadowedNonCompression };
}

function isGlobalMountPath(pathValue: string): boolean {
  const trimmed = pathValue.trim();
  return trimmed === '' || trimmed === '/' || trimmed === '*' || trimmed === '/*';
}

function isNonRootScopedMountArg(arg: ts.Expression): boolean {
  const strVal = getStaticString(arg);
  if (strVal !== undefined) {
    return !isGlobalMountPath(strVal);
  }
  const unwrapped = unwrapParensAndTypes(arg);
  if (ts.isArrayLiteralExpression(unwrapped) && unwrapped.elements.length > 0) {
    for (const el of unwrapped.elements) {
      const s = getStaticString(el);
      if (s === undefined || isGlobalMountPath(s)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function hasCompressionFilterOption(
  optionsArg: ts.Expression | undefined,
  constMap: ReadonlyMap<string, ts.Expression>,
  visited = new Set<string>()
): boolean {
  if (!optionsArg) {
    return false;
  }
  const unwrapped = unwrapParensAndTypes(optionsArg);
  if (ts.isIdentifier(unwrapped)) {
    if (visited.has(unwrapped.text)) {
      return false;
    }
    visited.add(unwrapped.text);
    return hasCompressionFilterOption(constMap.get(unwrapped.text), constMap, visited);
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    return false;
  }

  for (const prop of unwrapped.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = getPropertyNameText(prop.name);
      if (name === 'filter' && !isUndefinedLiteral(prop.initializer)) {
        return true;
      }
    } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'filter') {
      return true;
    } else if (ts.isMethodDeclaration(prop)) {
      const name = getPropertyNameText(prop.name);
      if (name === 'filter') {
        return true;
      }
    } else if (ts.isSpreadAssignment(prop)) {
      if (hasCompressionFilterOption(prop.expression, constMap, visited)) {
        return true;
      }
    }
  }
  return false;
}

function collectGlobalCompressionCandidates(
  sourceFile: ts.SourceFile,
  file: string,
  constMap: ReadonlyMap<string, ts.Expression>
): GlobalCompressionCandidate[] {
  const { importedNames, shadowedNonCompression } = collectCompressionImports(sourceFile);
  const candidates: GlobalCompressionCandidate[] = [];

  function isCompressionFactoryCall(expr: ts.Expression): expr is ts.CallExpression {
    const unwrapped = unwrapParensAndTypes(expr);
    if (!ts.isCallExpression(unwrapped)) {
      return false;
    }
    const callee = unwrapParensAndTypes(unwrapped.expression);
    if (ts.isIdentifier(callee)) {
      if (importedNames.has(callee.text)) {
        return true;
      }
      if (callee.text === 'compression' && !shadowedNonCompression.has('compression')) {
        return true;
      }
    }
    return false;
  }

  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = unwrapParensAndTypes(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'use') {
        const args = node.arguments;
        if (args.length >= 1) {
          let startIdx = 0;
          if (args.length >= 2 && !isCompressionFactoryCall(args[0]!)) {
            if (isNonRootScopedMountArg(args[0]!)) {
              ts.forEachChild(node, walk);
              return;
            }
            const firstStr = getStaticString(args[0]);
            if (firstStr !== undefined && isGlobalMountPath(firstStr)) {
              startIdx = 1;
            }
          }

          for (let i = startIdx; i < args.length; i += 1) {
            const arg = args[i]!;
            if (isCompressionFactoryCall(arg)) {
              if (!hasCompressionFilterOption(arg.arguments[0], constMap)) {
                candidates.push({
                  file,
                  sourceFile,
                  node,
                });
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
  return candidates;
}

function collectUndiciRequestImports(sourceFile: ts.SourceFile): {
  readonly undiciRequestIdents: ReadonlySet<string>;
  readonly undiciNamespaceIdents: ReadonlySet<string>;
  readonly nonUndiciRequestIdents: ReadonlySet<string>;
} {
  const undiciRequestIdents = new Set<string>();
  const undiciNamespaceIdents = new Set<string>();
  const nonUndiciRequestIdents = new Set<string>();

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const modName = stmt.moduleSpecifier.text;
      const isUndici = modName === 'undici';
      const clause = stmt.importClause;
      if (!clause) {
        continue;
      }
      if (clause.name) {
        if (isUndici) {
          undiciNamespaceIdents.add(clause.name.text);
        } else if (clause.name.text === 'request') {
          nonUndiciRequestIdents.add('request');
        }
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings) && isUndici) {
          undiciNamespaceIdents.add(clause.namedBindings.name.text);
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const imported = el.propertyName ? el.propertyName.text : el.name.text;
            if (isUndici && imported === 'request') {
              undiciRequestIdents.add(el.name.text);
            } else if (!isUndici && el.name.text === 'request') {
              nonUndiciRequestIdents.add('request');
            }
          }
        }
      }
    }
  }

  return { undiciRequestIdents, undiciNamespaceIdents, nonUndiciRequestIdents };
}

function isUpstreamStreamingOrHttpCall(
  call: ts.CallExpression,
  undiciInfo: {
    readonly undiciRequestIdents: ReadonlySet<string>;
    readonly undiciNamespaceIdents: ReadonlySet<string>;
    readonly nonUndiciRequestIdents: ReadonlySet<string>;
  }
): boolean {
  const callee = unwrapParensAndTypes(call.expression);

  // 1. Global or Undici fetch
  if (ts.isIdentifier(callee) && callee.text === 'fetch') {
    return call.arguments.length >= 1;
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch') {
    const recv = unwrapParensAndTypes(callee.expression);
    if (
      ts.isIdentifier(recv) &&
      (recv.text === 'globalThis' ||
        recv.text === 'global' ||
        recv.text === 'window' ||
        recv.text === 'self' ||
        recv.text === 'undici' ||
        undiciInfo.undiciNamespaceIdents.has(recv.text))
    ) {
      return call.arguments.length >= 1;
    }
  }

  // 2. Undici request(...)
  if (ts.isIdentifier(callee)) {
    if (undiciInfo.undiciRequestIdents.has(callee.text)) {
      return call.arguments.length >= 1;
    }
    if (callee.text === 'request' && !undiciInfo.nonUndiciRequestIdents.has('request')) {
      return call.arguments.length >= 1;
    }
  }
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'request') {
    const recv = unwrapParensAndTypes(callee.expression);
    if (
      ts.isIdentifier(recv) &&
      (recv.text === 'undici' || undiciInfo.undiciNamespaceIdents.has(recv.text))
    ) {
      return call.arguments.length >= 1;
    }
  }

  // 3. Vercel AI SDK streamText({ ... }) (exclude Hono 2-arg streamText(c, async (stream) => ...))
  if (
    (ts.isIdentifier(callee) && callee.text === 'streamText') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'streamText')
  ) {
    if (
      call.arguments.length >= 2 &&
      isFunctionLikeNode(unwrapParensAndTypes(call.arguments[1]!))
    ) {
      return false;
    }
    return call.arguments.length >= 1;
  }

  // 4. AI SDK .stream(...) with >= 1 argument (OpenAI / Anthropic / LangChain)
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'stream') {
    return call.arguments.length >= 1;
  }

  return false;
}

function getRootIdentifierText(expr: ts.Expression): string | undefined {
  let cur = unwrapParensAndTypes(expr);
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = unwrapParensAndTypes(cur.expression);
  }
  if (ts.isIdentifier(cur)) {
    return cur.text;
  }
  return undefined;
}

const CLIENT_CONTEXT_NAMES = new Set<string>([
  'req',
  'res',
  'request',
  'response',
  'reply',
  'c',
  'ctx',
  'context',
  'event',
]);

function collectHandlerParameterRoots(scopeNode: ts.Node): {
  readonly paramRoots: ReadonlySet<string>;
  readonly destructuredSignalVars: ReadonlySet<string>;
} {
  const paramRoots = new Set<string>(CLIENT_CONTEXT_NAMES);
  const destructuredSignalVars = new Set<string>();

  if (isFunctionLikeNode(scopeNode)) {
    for (const param of scopeNode.parameters) {
      if (ts.isIdentifier(param.name)) {
        paramRoots.add(param.name.text);
      } else if (ts.isObjectBindingPattern(param.name)) {
        for (const el of param.name.elements) {
          const propName = el.propertyName
            ? getPropertyNameText(el.propertyName)
            : ts.isIdentifier(el.name)
              ? el.name.text
              : undefined;
          if (propName === 'signal' && ts.isIdentifier(el.name)) {
            destructuredSignalVars.add(el.name.text);
          }
          if (
            (propName === 'req' ||
              propName === 'res' ||
              propName === 'request' ||
              propName === 'response') &&
            ts.isIdentifier(el.name)
          ) {
            paramRoots.add(el.name.text);
          }
        }
      }
    }
  }

  // Also detect `const { signal } = req;` inside the handler
  visitHandlerScope(scopeNode, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const initRoot = getRootIdentifierText(node.initializer);
      if (initRoot !== undefined && paramRoots.has(initRoot)) {
        for (const el of node.name.elements) {
          const propName = el.propertyName
            ? getPropertyNameText(el.propertyName)
            : ts.isIdentifier(el.name)
              ? el.name.text
              : undefined;
          if (propName === 'signal' && ts.isIdentifier(el.name)) {
            destructuredSignalVars.add(el.name.text);
          }
        }
      }
    }
  });

  return { paramRoots, destructuredSignalVars };
}

function readableStreamSourceHasCancel(
  sourceArg: ts.Expression | undefined,
  constMap: ReadonlyMap<string, ts.Expression>,
  visited = new Set<string>()
): boolean {
  if (!sourceArg) {
    return false;
  }
  const unwrapped = unwrapParensAndTypes(sourceArg);
  if (ts.isIdentifier(unwrapped)) {
    if (visited.has(unwrapped.text)) {
      return false;
    }
    visited.add(unwrapped.text);
    return readableStreamSourceHasCancel(constMap.get(unwrapped.text), constMap, visited);
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    return false;
  }
  for (const prop of unwrapped.properties) {
    if (ts.isMethodDeclaration(prop) && getPropertyNameText(prop.name) === 'cancel') {
      return true;
    }
    if (
      ts.isPropertyAssignment(prop) &&
      getPropertyNameText(prop.name) === 'cancel' &&
      !isUndefinedLiteral(prop.initializer)
    ) {
      return true;
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'cancel') {
      return true;
    }
  }
  return false;
}

function handlerWiresClientDisconnect(
  scopeNode: ts.Node,
  constMap: ReadonlyMap<string, ts.Expression>,
  undiciInfo: {
    readonly undiciRequestIdents: ReadonlySet<string>;
    readonly undiciNamespaceIdents: ReadonlySet<string>;
    readonly nonUndiciRequestIdents: ReadonlySet<string>;
  }
): boolean {
  const { paramRoots, destructuredSignalVars } = collectHandlerParameterRoots(scopeNode);
  const upstreamResultVars = new Set<string>();

  visitHandlerScope(scopeNode, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init = unwrapParensAndTypes(node.initializer);
      if (ts.isAwaitExpression(init)) {
        init = unwrapParensAndTypes(init.expression);
      }
      if (ts.isCallExpression(init) && isUpstreamStreamingOrHttpCall(init, undiciInfo)) {
        upstreamResultVars.add(node.name.text);
      }
    }
  });

  let wired = false;

  visitHandlerScope(scopeNode, (node) => {
    if (wired) {
      return;
    }

    // 1. ReadableStream({ cancel() { ... } })
    if (ts.isNewExpression(node) && isNewConstructNamed(node, 'ReadableStream')) {
      if (readableStreamSourceHasCancel(node.arguments?.[0], constMap)) {
        wired = true;
        return;
      }
    }

    // 2. Client AbortSignal property access: req.signal, request.signal, c.req.raw.signal, etc.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'signal') {
      const rootName = getRootIdentifierText(node.expression);
      if (
        rootName !== undefined &&
        paramRoots.has(rootName) &&
        !upstreamResultVars.has(rootName)
      ) {
        wired = true;
        return;
      }
    }

    // 3. Destructured client signal referenced in an expression position
    if (ts.isIdentifier(node) && destructuredSignalVars.has(node.text)) {
      const parent = node.parent;
      const isBindingSite =
        parent !== undefined &&
        ts.isBindingElement(parent) &&
        parent.name === node;
      if (!isBindingSite) {
        wired = true;
        return;
      }
    }

    // 4. Listener hooks: req.on('close'|'aborted'), res.on('close'), req.once(...), stream.onAbort(...)
    if (ts.isCallExpression(node)) {
      const callee = unwrapParensAndTypes(node.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (method === 'onAbort' && node.arguments.length >= 1) {
          wired = true;
          return;
        }
        if (
          (method === 'on' ||
            method === 'once' ||
            method === 'addListener' ||
            method === 'addEventListener') &&
          node.arguments.length >= 2
        ) {
          const eventName = getStaticString(node.arguments[0])?.trim().toLowerCase();
          if (eventName === 'close' || eventName === 'aborted' || eventName === 'abort') {
            const rootName = getRootIdentifierText(callee.expression);
            if (rootName !== undefined && !upstreamResultVars.has(rootName)) {
              if (paramRoots.has(rootName) || eventName === 'aborted') {
                wired = true;
                return;
              }
            }
          }
        }
      }
    }
  });

  return wired;
}

function analyzeSseHandlersInFile(
  sourceFile: ts.SourceFile,
  constMap: ReadonlyMap<string, ts.Expression>,
  mutationsMap: ReadonlyMap<string, readonly HeaderRecord[]>
): SseHandlerRecord[] {
  const undiciInfo = collectUndiciRequestImports(sourceFile);
  const scopeTriggerMap = new Map<ts.Node, ts.Node>();
  const scopeOrder: ts.Node[] = [];

  function findSseTriggers(node: ts.Node): void {
    const { headers, isStreamSseHelper } = collectNodeHeaderRecords(node, constMap, mutationsMap);
    let isSse = isStreamSseHelper;
    if (!isSse) {
      for (const h of headers) {
        if (h.lowerName === 'content-type' && isEventStreamMime(h.value)) {
          isSse = true;
          break;
        }
      }
    }

    if (isSse) {
      const scope = findEnclosingHandlerScope(node, sourceFile);
      if (!scopeTriggerMap.has(scope)) {
        scopeTriggerMap.set(scope, node);
        scopeOrder.push(scope);
      }
    }

    ts.forEachChild(node, findSseTriggers);
  }

  findSseTriggers(sourceFile);

  const records: SseHandlerRecord[] = [];

  for (const scopeNode of scopeOrder) {
    const triggerNode = scopeTriggerMap.get(scopeNode)!;
    let hasCacheControl = false;
    let firstUpstreamCall: ts.Node | undefined;

    visitHandlerScope(scopeNode, (node) => {
      const { headers } = collectNodeHeaderRecords(node, constMap, mutationsMap);
      for (const h of headers) {
        if (h.lowerName === 'cache-control' && isNonEmptyCacheControlValue(h.value)) {
          hasCacheControl = true;
        }
      }

      if (firstUpstreamCall === undefined && ts.isCallExpression(node)) {
        if (isUpstreamStreamingOrHttpCall(node, undiciInfo)) {
          firstUpstreamCall = node;
        }
      }
    });

    let unguardedUpstreamNode: ts.Node | undefined;
    if (
      firstUpstreamCall !== undefined &&
      !handlerWiresClientDisconnect(scopeNode, constMap, undiciInfo)
    ) {
      unguardedUpstreamNode = firstUpstreamCall;
    }

    records.push({
      scopeNode,
      triggerNode,
      hasCacheControl,
      unguardedUpstreamNode,
    });
  }

  return records;
}

function normalizeExprKey(expr: ts.Expression, sourceFile: ts.SourceFile): string {
  const unwrapped = unwrapParensAndTypes(expr);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return `${normalizeExprKey(unwrapped.expression, sourceFile)}.${unwrapped.name.text}`;
  }
  return unwrapped.getText(sourceFile).trim();
}

function exprContainsTextDecoderStream(expr: ts.Node): boolean {
  let found = false;
  function walk(n: ts.Node): void {
    if (found) {
      return;
    }
    if (ts.isNewExpression(n) && isNewConstructNamed(n, 'TextDecoderStream')) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  }
  walk(expr);
  return found;
}

function isSetEncodingUtf8Call(node: ts.Node): ts.Expression | undefined {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }
  const callee = unwrapParensAndTypes(node.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'setEncoding') {
    return undefined;
  }
  if (node.arguments.length < 1) {
    return undefined;
  }
  const enc = getStaticString(node.arguments[0])?.trim().toLowerCase();
  if (enc === 'utf8' || enc === 'utf-8') {
    return callee.expression;
  }
  return undefined;
}

function hasStreamTrueOption(
  optionsArg: ts.Expression | undefined,
  constMap: ReadonlyMap<string, ts.Expression>,
  trueBoolVars: ReadonlySet<string>,
  visited = new Set<string>()
): boolean {
  if (!optionsArg) {
    return false;
  }
  const unwrapped = unwrapParensAndTypes(optionsArg);
  if (ts.isIdentifier(unwrapped)) {
    if (visited.has(unwrapped.text)) {
      return false;
    }
    visited.add(unwrapped.text);
    return hasStreamTrueOption(constMap.get(unwrapped.text), constMap, trueBoolVars, visited);
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    return false;
  }

  for (const prop of unwrapped.properties) {
    if (ts.isPropertyAssignment(prop) && getPropertyNameText(prop.name) === 'stream') {
      const val = unwrapParensAndTypes(prop.initializer);
      if (val.kind === ts.SyntaxKind.TrueKeyword) {
        return true;
      }
      if (ts.isIdentifier(val) && trueBoolVars.has(val.text)) {
        return true;
      }
    } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'stream') {
      if (trueBoolVars.has(prop.name.text)) {
        return true;
      }
    } else if (ts.isSpreadAssignment(prop)) {
      if (hasStreamTrueOption(prop.expression, constMap, trueBoolVars, visited)) {
        return true;
      }
    }
  }
  return false;
}

function isTextDecoderReceiver(
  expr: ts.Expression,
  textDecoderVars: ReadonlySet<string>
): boolean {
  const unwrapped = unwrapParensAndTypes(expr);
  if (isNewConstructNamed(unwrapped, 'TextDecoder')) {
    return true;
  }
  if (ts.isIdentifier(unwrapped)) {
    if (textDecoderVars.has(unwrapped.text)) {
      return true;
    }
    return unwrapped.text.toLowerCase().endsWith('decoder');
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text.toLowerCase().endsWith('decoder');
  }
  return false;
}

function isBinaryOnlyToStringArg(arg: ts.Expression | undefined): boolean {
  if (!arg) {
    return false;
  }
  const enc = getStaticString(arg)?.trim().toLowerCase();
  return enc === 'hex' || enc === 'base64' || enc === 'base64url';
}

function analyzeStreamDecodeFindingsInFile(
  sourceFile: ts.SourceFile,
  file: string,
  constMap: ReadonlyMap<string, ts.Expression>
): Finding[] {
  const textDecoderVars = new Set<string>();
  const decodedStreamVars = new Set<string>();
  const decodedReaderVars = new Set<string>();
  const utf8StreamKeys = new Set<string>();
  const trueBoolVars = new Set<string>();

  function collectMetadata(node: ts.Node): void {
    const encodedTarget = isSetEncodingUtf8Call(node);
    if (encodedTarget) {
      utf8StreamKeys.add(normalizeExprKey(encodedTarget, sourceFile));
      if (
        node.parent &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)
      ) {
        utf8StreamKeys.add(node.parent.name.text);
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const varName = node.name.text;
      const init = unwrapParensAndTypes(node.initializer);

      if (init.kind === ts.SyntaxKind.TrueKeyword) {
        trueBoolVars.add(varName);
      }
      if (isNewConstructNamed(init, 'TextDecoder')) {
        textDecoderVars.add(varName);
      }
      if (exprContainsTextDecoderStream(init)) {
        if (
          ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(unwrapParensAndTypes(init.expression)) &&
          (unwrapParensAndTypes(init.expression) as ts.PropertyAccessExpression).name.text ===
            'getReader'
        ) {
          decodedReaderVars.add(varName);
        } else {
          decodedStreamVars.add(varName);
        }
      }
      if (ts.isCallExpression(init)) {
        const callee = unwrapParensAndTypes(init.expression);
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'getReader') {
          const recvKey = normalizeExprKey(callee.expression, sourceFile);
          if (decodedStreamVars.has(recvKey) || utf8StreamKeys.has(recvKey)) {
            decodedReaderVars.add(varName);
          }
        }
      }
    }

    ts.forEachChild(node, collectMetadata);
  }

  collectMetadata(sourceFile);

  const findings: Finding[] = [];
  const reportedNodes = new Set<ts.Node>();

  function checkLoopBodyForUnsafeDecode(
    bodyRoot: ts.Node,
    chunkNames: ReadonlySet<string>,
    readResultNames: ReadonlySet<string>
  ): void {
    function walkBody(node: ts.Node): void {
      if (node !== bodyRoot && isFunctionLikeNode(node)) {
        // Do not cross into standalone nested function declarations
        if (ts.isFunctionDeclaration(node)) {
          return;
        }
      }

      if (ts.isCallExpression(node) && !reportedNodes.has(node)) {
        const callee = unwrapParensAndTypes(node.expression);
        if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text;

          // Case 1: decoder.decode(chunk) / new TextDecoder().decode(chunk) without { stream: true }
          // Note: 0-arg decoder.decode() is a final flush and MUST stay clean.
          if (method === 'decode' && node.arguments.length >= 1) {
            if (isTextDecoderReceiver(callee.expression, textDecoderVars)) {
              if (!hasStreamTrueOption(node.arguments[1], constMap, trueBoolVars)) {
                reportedNodes.add(node);
                findings.push(
                  createFinding(
                    sourceFile,
                    file,
                    node,
                    'SSE003',
                    'medium',
                    'TextDecoder.decode called on a stream chunk without { stream: true }; multi-byte UTF-8 characters split across TCP chunks will corrupt.'
                  )
                );
              }
            }
          }

          // Case 2: chunk.toString(...) on raw stream chunk variable
          if (method === 'toString' && !isBinaryOnlyToStringArg(node.arguments[0])) {
            const recv = unwrapParensAndTypes(callee.expression);
            let isChunkReceiver = false;

            if (ts.isIdentifier(recv) && chunkNames.has(recv.text)) {
              isChunkReceiver = true;
            } else if (
              ts.isPropertyAccessExpression(recv) &&
              recv.name.text === 'value' &&
              ts.isIdentifier(unwrapParensAndTypes(recv.expression)) &&
              readResultNames.has((unwrapParensAndTypes(recv.expression) as ts.Identifier).text)
            ) {
              isChunkReceiver = true;
            } else if (
              ts.isCallExpression(recv) &&
              ts.isPropertyAccessExpression(unwrapParensAndTypes(recv.expression))
            ) {
              const innerProp = unwrapParensAndTypes(recv.expression) as ts.PropertyAccessExpression;
              const innerObj = unwrapParensAndTypes(innerProp.expression);
              if (
                ts.isIdentifier(innerObj) &&
                innerObj.text === 'Buffer' &&
                innerProp.name.text === 'from' &&
                recv.arguments.length >= 1
              ) {
                const firstArg = unwrapParensAndTypes(recv.arguments[0]!);
                if (ts.isIdentifier(firstArg) && chunkNames.has(firstArg.text)) {
                  isChunkReceiver = true;
                }
              }
            }

            if (isChunkReceiver) {
              reportedNodes.add(node);
              findings.push(
                createFinding(
                  sourceFile,
                  file,
                  node,
                  'SSE003',
                  'medium',
                  'Calling toString() directly on a raw byte stream chunk splits multi-byte UTF-8 code points across packet boundaries; use TextDecoder with { stream: true }, TextDecoderStream, or stream.setEncoding("utf8").'
                )
              );
            }
          }
        }
      }

      ts.forEachChild(node, walkBody);
    }

    walkBody(bodyRoot);
  }

  function isStreamExpressionAlreadyUtf8(streamExpr: ts.Expression): boolean {
    if (exprContainsTextDecoderStream(streamExpr)) {
      return true;
    }
    if (isSetEncodingUtf8Call(streamExpr) !== undefined) {
      return true;
    }
    const key = normalizeExprKey(streamExpr, sourceFile);
    if (utf8StreamKeys.has(key) || decodedStreamVars.has(key) || decodedReaderVars.has(key)) {
      return true;
    }
    const unwrapped = unwrapParensAndTypes(streamExpr);
    if (ts.isCallExpression(unwrapped)) {
      const callee = unwrapParensAndTypes(unwrapped.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (isStreamExpressionAlreadyUtf8(callee.expression)) {
          return true;
        }
      }
    }
    return false;
  }

  function walkLoops(node: ts.Node): void {
    // Form 1: for await (const chunk of stream) { ... }
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
      if (!isStreamExpressionAlreadyUtf8(node.expression)) {
        const chunkNames = new Set<string>();
        if (ts.isVariableDeclarationList(node.initializer)) {
          for (const decl of node.initializer.declarations) {
            if (ts.isIdentifier(decl.name)) {
              chunkNames.add(decl.name.text);
            }
          }
        } else if (ts.isIdentifier(node.initializer)) {
          chunkNames.add(node.initializer.text);
        }
        checkLoopBodyForUnsafeDecode(node.statement, chunkNames, new Set());
      }
    }

    // Form 2: stream.on('data', (chunk) => { ... })
    if (ts.isCallExpression(node)) {
      const callee = unwrapParensAndTypes(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'on' || callee.name.text === 'addListener') &&
        node.arguments.length >= 2 &&
        getStaticString(node.arguments[0]) === 'data'
      ) {
        const cb = unwrapParensAndTypes(node.arguments[1]!);
        if (
          (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
          !isStreamExpressionAlreadyUtf8(callee.expression)
        ) {
          const chunkNames = new Set<string>();
          const firstParam = cb.parameters[0];
          if (firstParam && ts.isIdentifier(firstParam.name)) {
            chunkNames.add(firstParam.name.text);
          }
          checkLoopBodyForUnsafeDecode(cb.body, chunkNames, new Set());
        }
      }
    }

    // Form 3: while (...) / do ... while (...) / for (...) containing reader.read()
    if (ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)) {
      const readerExprs: ts.Expression[] = [];
      const chunkNames = new Set<string>();
      const readResultNames = new Set<string>();

      function scanReaderCalls(sub: ts.Node): void {
        if (sub !== node && isFunctionLikeNode(sub)) {
          return;
        }
        if (ts.isCallExpression(sub) && sub.arguments.length === 0) {
          const callee = unwrapParensAndTypes(sub.expression);
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'read') {
            readerExprs.push(callee.expression);

            // Walk past await/parens to find binding target: const { value } = await reader.read()
            let up: ts.Node = sub;
            while (
              up.parent &&
              (ts.isAwaitExpression(up.parent) || ts.isParenthesizedExpression(up.parent))
            ) {
              up = up.parent;
            }
            const holder = up.parent;
            if (holder && ts.isVariableDeclaration(holder) && holder.initializer === up) {
              if (ts.isIdentifier(holder.name)) {
                readResultNames.add(holder.name.text);
              } else if (ts.isObjectBindingPattern(holder.name)) {
                for (const el of holder.name.elements) {
                  const prop = el.propertyName
                    ? getPropertyNameText(el.propertyName)
                    : ts.isIdentifier(el.name)
                      ? el.name.text
                      : undefined;
                  if (prop === 'value' && ts.isIdentifier(el.name)) {
                    chunkNames.add(el.name.text);
                  }
                }
              }
            } else if (
              holder &&
              ts.isBinaryExpression(holder) &&
              holder.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              holder.right === up
            ) {
              const lhs = unwrapParensAndTypes(holder.left);
              if (ts.isIdentifier(lhs)) {
                readResultNames.add(lhs.text);
              } else if (ts.isObjectLiteralExpression(lhs)) {
                for (const prop of lhs.properties) {
                  if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'value') {
                    chunkNames.add('value');
                  } else if (
                    ts.isPropertyAssignment(prop) &&
                    getPropertyNameText(prop.name) === 'value' &&
                    ts.isIdentifier(unwrapParensAndTypes(prop.initializer))
                  ) {
                    chunkNames.add((unwrapParensAndTypes(prop.initializer) as ts.Identifier).text);
                  }
                }
              }
            }
          }
        }
        ts.forEachChild(sub, scanReaderCalls);
      }

      scanReaderCalls(node);

      if (readerExprs.length > 0) {
        // Also track `const chunk = res.value;` aliases inside loop
        function scanResultValueAliases(sub: ts.Node): void {
          if (sub !== node && isFunctionLikeNode(sub)) {
            return;
          }
          if (ts.isVariableDeclaration(sub) && ts.isIdentifier(sub.name) && sub.initializer) {
            const init = unwrapParensAndTypes(sub.initializer);
            if (
              ts.isPropertyAccessExpression(init) &&
              init.name.text === 'value' &&
              ts.isIdentifier(unwrapParensAndTypes(init.expression)) &&
              readResultNames.has((unwrapParensAndTypes(init.expression) as ts.Identifier).text)
            ) {
              chunkNames.add(sub.name.text);
            }
          }
          ts.forEachChild(sub, scanResultValueAliases);
        }

        scanResultValueAliases(node.statement);

        const allAlreadyDecoded = readerExprs.every((r) => isStreamExpressionAlreadyUtf8(r));
        if (!allAlreadyDecoded) {
          checkLoopBodyForUnsafeDecode(node.statement, chunkNames, readResultNames);
        }
      }
    }

    ts.forEachChild(node, walkLoops);
  }

  walkLoops(sourceFile);
  return findings;
}

function analyzeSingleFile(input: SourceInput): ParsedFileAnalysis {
  const sourceFile = ts.createSourceFile(
    input.displayPath,
    input.content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(input.displayPath)
  );

  const constMap = collectConstExpressions(sourceFile);
  const mutationsMap = collectHeaderMutations(sourceFile);

  const sseHandlers = analyzeSseHandlersInFile(sourceFile, constMap, mutationsMap);
  const compressionCandidates = collectGlobalCompressionCandidates(
    sourceFile,
    input.displayPath,
    constMap
  );
  const streamDecodeFindings = analyzeStreamDecodeFindingsInFile(
    sourceFile,
    input.displayPath,
    constMap
  );

  return {
    input,
    sourceFile,
    sseHandlers,
    compressionCandidates,
    streamDecodeFindings,
  };
}

export function analyzeSources(
  sources: readonly SourceInput[],
  _options: AnalyzerOptions = {}
): Finding[] {
  // Pass 1: Parse and collect per-file SSE handlers, global compression candidates, and stream decode findings.
  const perFile: ParsedFileAnalysis[] = sources.map((src) => analyzeSingleFile(src));

  let projectHasSseHandler = false;
  for (const analysis of perFile) {
    if (analysis.sseHandlers.length > 0) {
      projectHasSseHandler = true;
      break;
    }
  }

  // Pass 2: Emit SSE001, project-wide SSE002, SSE003, and SSE004 findings deterministically.
  const findings: Finding[] = [];

  for (const analysis of perFile) {
    const { input, sourceFile, sseHandlers, compressionCandidates, streamDecodeFindings } = analysis;

    for (const handler of sseHandlers) {
      if (!handler.hasCacheControl) {
        findings.push(
          createFinding(
            sourceFile,
            input.displayPath,
            handler.triggerNode,
            'SSE001',
            'medium',
            'SSE handler sets Content-Type to text/event-stream without setting a Cache-Control header in the same handler.'
          )
        );
      }

      if (handler.unguardedUpstreamNode !== undefined) {
        findings.push(
          createFinding(
            sourceFile,
            input.displayPath,
            handler.unguardedUpstreamNode,
            'SSE004',
            'medium',
            'SSE handler starts an upstream request or AI stream without wiring client disconnect cleanup (req/res close listener, request AbortSignal, or ReadableStream cancel).'
          )
        );
      }
    }

    if (projectHasSseHandler) {
      for (const candidate of compressionCandidates) {
        findings.push(
          createFinding(
            candidate.sourceFile,
            candidate.file,
            candidate.node,
            'SSE002',
            'medium',
            'Global compression middleware is registered without a filter option in a project that serves text/event-stream endpoints, buffering SSE frames.'
          )
        );
      }
    }

    findings.push(...streamDecodeFindings);
  }

  findings.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    if (a.column !== b.column) {
      return a.column - b.column;
    }
    return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
  });

  return findings;
}
