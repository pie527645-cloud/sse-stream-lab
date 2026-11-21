import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { checkProject } from '../src/index.js';

describe('Golden-clean multi-file SSE services (0 findings)', () => {
  it('verifies a complete Express + Undici SSE relay service with filtered compression, Cache-Control, X-Accel-Buffering: no, streaming UTF-8 decode, and disconnect cleanup has 0 findings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-golden-express-'));
    try {
      const files: Record<string, string> = {
        'src/middleware/compression.ts': `
          import compression from 'compression';

          export function registerCompression(app: any): void {
            app.use(
              compression({
                filter(req: any, res: any) {
                  const contentType = String(res.getHeader('Content-Type') ?? '');
                  if (contentType.includes('text/event-stream')) {
                    return false;
                  }
                  return compression.filter(req, res);
                },
              })
            );
          }
        `,
        'src/routes/chatStream.ts': `
          import { request } from 'undici';

          export function mountChatStream(router: any): void {
            router.get('/v1/chat/events', async (req: any, res: any) => {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
                Connection: 'keep-alive',
              });

              const abortController = new AbortController();
              req.on('close', () => {
                abortController.abort();
              });

              const upstream = await request('https://llm.internal.example/v1/stream', {
                method: 'POST',
                signal: abortController.signal,
              });

              const reader = upstream.body.getReader();
              const decoder = new TextDecoder('utf-8');
              while (true) {
                const { value, done } = await reader.read();
                if (done) {
                  break;
                }
                const text = decoder.decode(value, { stream: true });
                res.write(text);
              }
              const trailing = decoder.decode();
              if (trailing.length > 0) {
                res.write(trailing);
              }
              res.end();
            });
          }
        `,
      };

      for (const [rel, body] of Object.entries(files)) {
        const full = path.join(tmpDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf8');
      }

      const report = checkProject({ target: tmpDir });
      assert.equal(report.scannedFiles, 2);
      assert.equal(report.summary.total, 0);
      assert.deepEqual(report.findings, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifies a Web Fetch + ReadableStream + Hono SSE service has 0 findings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-golden-edge-'));
    try {
      const files: Record<string, string> = {
        'src/edgeHandler.ts': `
          export async function GET(request: Request): Promise<Response> {
            const ac = new AbortController();
            request.signal.addEventListener('abort', () => ac.abort());

            const stream = new ReadableStream({
              async start(controller) {
                const upstream = await fetch('https://events.internal.example/feed', {
                  signal: ac.signal,
                });
                if (!upstream.body) {
                  controller.close();
                  return;
                }
                const textStream = upstream.body.pipeThrough(new TextDecoderStream());
                for await (const chunk of textStream) {
                  controller.enqueue(new TextEncoder().encode(chunk));
                }
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
                'X-Accel-Buffering': 'no',
              },
            });
          }
        `,
        'src/honoRoutes.ts': `
          export function registerHonoSse(app: any, streamSSE: any): void {
            app.get('/realtime', (c: any) => {
              c.header('Cache-Control', 'no-cache');
              c.header('X-Accel-Buffering', 'no');
              return streamSSE(c, async (stream: any) => {
                const res = await fetch('https://events.internal.example/ping', {
                  signal: c.req.raw.signal,
                });
                await stream.writeSSE({ data: String(res.status) });
              });
            });
          }
        `,
      };

      for (const [rel, body] of Object.entries(files)) {
        const full = path.join(tmpDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf8');
      }

      const report = checkProject({ target: tmpDir });
      assert.equal(report.scannedFiles, 2);
      assert.equal(report.summary.total, 0);
      assert.deepEqual(report.findings, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
