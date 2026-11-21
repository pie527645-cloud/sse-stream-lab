import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeSources, type SourceInput } from '../src/index.js';

function makeSource(displayPath: string, content: string): SourceInput {
  return {
    absolutePath: `/virtual/${displayPath}`,
    displayPath,
    content,
  };
}

describe('SSE001: Missing Cache-Control header on SSE handlers', () => {
  it('flags Express, Node HTTP, Web Response, Headers, and Hono SSE handlers missing Cache-Control', () => {
    const sources: SourceInput[] = [
      makeSource(
        'express.ts',
        `
        export function registerRoutes(app: any) {
          app.get('/events-1', (_req: any, res: any) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: hello\\n\\n');
          });

          app.get('/events-2', (_req: any, res: any) => {
            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
            res.write('data: ping\\n\\n');
          });

          app.get('/events-3', (_req: any, res: any) => {
            res.type('text/event-stream');
            res.write('data: typed\\n\\n');
          });
        }
        `
      ),
      makeSource(
        'edge.ts',
        `
        export function handlerA(stream: ReadableStream) {
          return new Response(stream, {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        export function handlerB(stream: ReadableStream) {
          const headers = new Headers();
          headers.set('content-type', 'text/event-stream');
          return new Response(stream, { headers });
        }
        `
      ),
      makeSource(
        'hono.ts',
        `
        export function mountHono(app: any, streamSSE: any) {
          app.get('/hono-header', (c: any) => {
            c.header('Content-Type', 'text/event-stream');
            return c.body('data: ok\\n\\n');
          });

          app.get('/hono-helper', (c: any) => {
            return streamSSE(c, async (stream: any) => {
              await stream.writeSSE({ data: 'tick' });
            });
          });
        }
        `
      ),
    ];

    const findings = analyzeSources(sources);
    const sse001 = findings.filter((f) => f.ruleId === 'SSE001');
    assert.equal(sse001.length, 7);
    assert.ok(sse001.every((f) => f.severity === 'medium'));
  });

  it('stays clean when Cache-Control is set case-insensitively across all framework styles', () => {
    const sources: SourceInput[] = [
      makeSource(
        'clean-handlers.ts',
        `
        const SHARED_SSE_HEADERS = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        };

        export function registerCleanRoutes(app: any, streamSSE: any) {
          app.get('/a', (_req: any, res: any) => {
            res.writeHead(200, SHARED_SSE_HEADERS);
            res.write('data: a\\n\\n');
          });

          app.get('/b', (_req: any, res: any) => {
            res.set('Content-Type', 'text/event-stream');
            res.header('cache-control', 'no-cache, no-transform');
            res.write('data: b\\n\\n');
          });

          app.get('/c', (c: any) => {
            c.header('Cache-Control', 'no-cache');
            return streamSSE(c, async (stream: any) => {
              await stream.writeSSE({ data: 'c' });
            });
          });
        }

        export function cleanWebResponse(body: ReadableStream) {
          const headers = new Headers();
          headers.set('content-type', 'text/event-stream');
          headers.set('CACHE-CONTROL', 'no-cache');
          return new Response(body, { headers });
        }
        `
      ),
    ];

    const findings = analyzeSources(sources);
    assert.equal(findings.length, 0);
  });
});

describe('SSE002: Two-pass project-wide global compression check', () => {
  it('flags global app.use(compression()), app.use("/", compression()), and router.use(compression()) across files when an SSE handler exists', () => {
    const crossFileProject: SourceInput[] = [
      makeSource(
        'src/app.ts',
        `
        import express from 'express';
        import compression from 'compression';

        export const app = express();
        app.use(compression());
        app.use('/', compression({ level: 6 }));
        `
      ),
      makeSource(
        'src/router.ts',
        `
        import { Router } from 'express';
        import compression from 'compression';

        export const router = Router();
        router.use(compression());
        `
      ),
      makeSource(
        'src/routes/events.ts',
        `
        export function eventsRoute(_req: any, res: any) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          res.write('data: ready\\n\\n');
        }
        `
      ),
    ];

    const findings = analyzeSources(crossFileProject);
    assert.equal(findings.length, 3);
    assert.ok(findings.every((f) => f.ruleId === 'SSE002' && f.severity === 'medium'));
    assert.deepEqual(
      findings.map((f) => f.file),
      ['src/app.ts', 'src/app.ts', 'src/router.ts']
    );
  });

  it('stays clean when compression supplies a filter, is scoped to a non-root route, or project has zero SSE handlers', () => {
    const filteredAndScopedWithSse: SourceInput[] = [
      makeSource(
        'src/app.ts',
        `
        import compression from 'compression';

        const customOptions = {
          filter(req: any, res: any) {
            if (res.getHeader('Content-Type') === 'text/event-stream') {
              return false;
            }
            return compression.filter(req, res);
          },
        };

        export function configureMiddleware(app: any) {
          app.use(compression({ filter: (req: any, res: any) => req.headers['accept'] !== 'text/event-stream' }));
          app.use(compression(customOptions));
          app.use('/api/json', compression());
          app.use(['/v1/rest', '/v2/rest'], compression());
        }
        `
      ),
      makeSource(
        'src/sse.ts',
        `
        export function sseEndpoint(_req: any, res: any) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
        }
        `
      ),
    ];

    assert.equal(analyzeSources(filteredAndScopedWithSse).length, 0);

    const restOnlyProjectWithoutSse: SourceInput[] = [
      makeSource(
        'src/restApp.ts',
        `
        import compression from 'compression';

        export function buildRestApp(app: any) {
          app.use(compression());
          app.get('/api/health', (_req: any, res: any) => {
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":true}');
          });
        }
        `
      ),
    ];

    assert.equal(analyzeSources(restOnlyProjectWithoutSse).length, 0);
  });
});

describe('SSE003: Multi-byte UTF-8 stream chunk decoding in read loops', () => {
  it('flags decoder.decode(chunk) without { stream: true } and chunk.toString() across reader.read(), for-await, and data listeners', () => {
    const buggyConsumer = makeSource(
      'consumer.ts',
      `
      export async function readWithReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
        const decoder = new TextDecoder();
        let out = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          out += decoder.decode(value);
        }
        return out;
      }

      export async function readForAwait(stream: AsyncIterable<Uint8Array>) {
        let out = '';
        for await (const chunk of stream) {
          out += new TextDecoder().decode(chunk, { stream: false });
        }
        return out;
      }

      export function readNodeDataEvent(stream: any) {
        let out = '';
        stream.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
        });
        return out;
      }

      export async function readReaderToString(reader: any) {
        let out = '';
        while (true) {
          const res = await reader.read();
          if (res.done) break;
          out += res.value.toString();
        }
        return out;
      }
      `
    );

    const findings = analyzeSources([buggyConsumer]);
    assert.equal(findings.length, 4);
    assert.ok(findings.every((f) => f.ruleId === 'SSE003' && f.severity === 'medium'));
  });

  it('stays clean for { stream: true } + 0-arg flush, stream.setEncoding("utf8"|"utf-8"), and TextDecoderStream', () => {
    const cleanConsumers = makeSource(
      'clean-consumers.ts',
      `
      export async function safeReaderDecode(reader: ReadableStreamDefaultReader<Uint8Array>) {
        const decoder = new TextDecoder('utf-8');
        let text = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            text += decoder.decode();
            break;
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
      }

      export function safeSetEncodingData(stream: any) {
        stream.setEncoding('utf8');
        let acc = '';
        stream.on('data', (chunk: string) => {
          acc += chunk.toString();
        });
        return acc;
      }

      export async function safeSetEncodingForAwait(stream: any) {
        stream.setEncoding('utf-8');
        let acc = '';
        for await (const chunk of stream) {
          acc += chunk.toString();
        }
        return acc;
      }

      export async function safeTextDecoderStream(body: ReadableStream<Uint8Array>) {
        const textStream = body.pipeThrough(new TextDecoderStream());
        let acc = '';
        for await (const chunk of textStream) {
          acc += chunk.toString();
        }
        return acc;
      }

      export async function safeTextDecoderStreamReader(body: ReadableStream<Uint8Array>) {
        const reader = body.pipeThrough(new TextDecoderStream()).getReader();
        let acc = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += value.toString();
        }
        return acc;
      }
      `
    );

    const findings = analyzeSources([cleanConsumers]);
    assert.equal(findings.length, 0);
  });
});

describe('SSE004: Upstream streaming/request calls without client disconnect cleanup', () => {
  it('flags upstream fetch, Undici request, streamText, and SDK .stream calls in SSE handlers lacking disconnect wiring', () => {
    const leakyHandlers = makeSource(
      'leaky-sse.ts',
      `
      import { request } from 'undici';

      export function registerExpressLeaks(app: any, openai: any, streamText: any) {
        app.get('/leak-fetch', async (_req: any, res: any) => {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          const ac = new AbortController();
          // Timer abort alone does NOT handle client disconnect
          const timer = setTimeout(() => ac.abort(), 30000);
          const upstream = await fetch('https://api.example.com/v1/stream', { signal: ac.signal });
          clearTimeout(timer);
          res.end(String(upstream.status));
        });

        app.get('/leak-undici', async (_req: any, res: any) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          await request('https://api.example.com/events');
          res.end();
        });

        app.get('/leak-sdk', async (_req: any, res: any) => {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          const completion = openai.chat.completions.stream({ model: 'gpt-4o-mini', messages: [] });
          res.end(String(Boolean(completion)));
        });
      }

      export function leakyEdgeReadableStream(streamText: any) {
        const stream = new ReadableStream({
          async start(controller) {
            const result = streamText({ model: 'demo', prompt: 'hello' });
            controller.enqueue(result);
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });
      }
      `
    );

    const findings = analyzeSources([leakyHandlers]);
    assert.equal(findings.length, 4);
    assert.ok(findings.every((f) => f.ruleId === 'SSE004' && f.severity === 'medium'));
  });

  it('stays clean for req.on("close"|"aborted"), res.on("close"), req.signal, c.req.raw.signal, event.node.req.on("close"), and ReadableStream cancel()', () => {
    const cleanDisconnectHandlers = makeSource(
      'clean-disconnect.ts',
      `
      import { request } from 'undici';

      export function registerCleanExpress(app: any, anthropic: any) {
        app.get('/close-listener', async (req: any, res: any) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          const ac = new AbortController();
          req.on('close', () => ac.abort());
          await request('https://api.example.com/sse', { signal: ac.signal });
          res.end();
        });

        app.get('/res-once-close', async (_req: any, res: any) => {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          const sdkStream = anthropic.messages.stream({ model: 'claude', messages: [] });
          res.once('close', () => sdkStream.abort());
        });
      }

      export async function edgeFetchSignal(req: Request) {
        const upstream = await fetch('https://api.example.com/sse', {
          signal: req.signal,
        });
        return new Response(upstream.body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });
      }

      export function honoRawSignal(app: any, streamSSE: any) {
        app.get('/hono-sse', (c: any) => {
          c.header('Cache-Control', 'no-cache');
          return streamSSE(c, async (stream: any) => {
            const upstream = await fetch('https://api.example.com/sse', {
              signal: c.req.raw.signal,
            });
            await stream.writeSSE({ data: String(upstream.status) });
          });
        });
      }

      export function nitroEventHandler(event: any, setResponseHeader: any) {
        setResponseHeader(event, 'Content-Type', 'text/event-stream');
        setResponseHeader(event, 'Cache-Control', 'no-cache');
        const ac = new AbortController();
        event.node.req.on('close', () => ac.abort());
        return fetch('https://api.example.com/sse', { signal: ac.signal });
      }

      export function readableStreamWithCancel(streamText: any) {
        const ac = new AbortController();
        const stream = new ReadableStream({
          async start(controller) {
            const result = streamText({ model: 'demo', abortSignal: ac.signal });
            controller.enqueue(result);
            controller.close();
          },
          cancel() {
            ac.abort();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });
      }
      `
    );

    const findings = analyzeSources([cleanDisconnectHandlers]);
    assert.equal(findings.length, 0);
  });
});
