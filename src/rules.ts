import type {
  FailOnThreshold,
  Finding,
  RuleId,
  RuleMetadata,
  Severity,
  SeveritySummary,
} from './types.js';

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export const RULES: readonly RuleMetadata[] = [
  {
    id: 'SSE001',
    name: 'MissingSseCacheControlHeader',
    defaultSeverity: 'medium',
    shortDescription: 'SSE handler sets text/event-stream without a Cache-Control header.',
    fullDescription:
      'An HTTP handler establishes a Server-Sent Events stream (Content-Type: text/event-stream or streamSSE) without setting a Cache-Control header in the same handler, allowing CDN or proxy response caching and buffering.',
    helpText:
      'Set Cache-Control: no-cache (and optionally X-Accel-Buffering: no for Nginx proxies) alongside Content-Type: text/event-stream in the handler.',
  },
  {
    id: 'SSE002',
    name: 'UnfilteredGlobalCompressionWithSse',
    defaultSeverity: 'medium',
    shortDescription: 'Global compression middleware registered without a filter in a project serving SSE.',
    fullDescription:
      'compression middleware is mounted globally without a custom filter option in a project that also serves text/event-stream endpoints, causing gzip/deflate chunk buffering that delays incremental SSE delivery.',
    helpText:
      'Supply a filter callback to compression options that skips text/event-stream responses, or mount compression only on non-SSE routes.',
  },
  {
    id: 'SSE003',
    name: 'UnsafeMultiByteStreamChunkDecode',
    defaultSeverity: 'medium',
    shortDescription: 'Stream read loop decodes byte chunks without { stream: true } or UTF-8 stream encoding.',
    fullDescription:
      'Inside a stream read loop, calling TextDecoder.decode on a chunk without { stream: true } or calling chunk.toString splits multi-byte UTF-8 characters (such as CJK text or emoji) across TCP packet boundaries into U+FFFD replacement characters.',
    helpText:
      'Pass { stream: true } to decoder.decode(chunk, { stream: true }) with a final 0-argument decoder.decode() flush, pipe through new TextDecoderStream(), or call stream.setEncoding("utf8").',
  },
  {
    id: 'SSE004',
    name: 'MissingUpstreamAbortOnClientDisconnect',
    defaultSeverity: 'medium',
    shortDescription: 'SSE handler starts an upstream stream or HTTP request without client disconnect cleanup.',
    fullDescription:
      'An event-stream handler starts an upstream HTTP request or AI SDK stream without wiring client disconnect cleanup via req/res close listeners, request AbortSignal forwarding, or ReadableStream cancel hook, leaking upstream compute and connections after clients disconnect.',
    helpText:
      'Forward req.signal / request.signal / c.req.raw.signal, abort an AbortController inside req.on("close", ...), or implement cancel() on ReadableStream.',
  },
];

export const RULE_MAP: ReadonlyMap<RuleId, RuleMetadata> = new Map(
  RULES.map((rule) => [rule.id, rule])
);

export function summarizeFindings(findings: readonly Finding[]): SeveritySummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  let info = 0;

  for (const finding of findings) {
    switch (finding.severity) {
      case 'high':
        high += 1;
        break;
      case 'medium':
        medium += 1;
        break;
      case 'low':
        low += 1;
        break;
      case 'info':
        info += 1;
        break;
    }
  }

  return {
    total: findings.length,
    high,
    medium,
    low,
    info,
  };
}

export function exceedsFailOnThreshold(
  findings: readonly Finding[],
  failOn: FailOnThreshold
): boolean {
  if (failOn === 'none') {
    return false;
  }
  const thresholdRank = SEVERITY_RANK[failOn];
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] >= thresholdRank) {
      return true;
    }
  }
  return false;
}
