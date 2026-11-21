# @pie527645-cloud/sse-stream-lab

Static TypeScript/JavaScript AST auditor for **Server-Sent Events (`text/event-stream`)** endpoints and stream consumers. Detects missing `Cache-Control` headers, unfiltered global `compression()` buffering across project files, multi-byte UTF-8 boundary corruption in stream read loops, and leaked upstream HTTP/LLM streams on client disconnect.

## Features

- **Pure Static AST Analysis (v1)**: Parses `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs` files with the TypeScript Compiler API. Zero runtime network calls, zero regular-expression backtracking, and zero third-party runtime dependencies beyond `typescript`.
- **Two-Pass Cross-File Detection**: Correlates global Express/router `compression()` middleware in app setup files with `text/event-stream` route handlers in separate route modules.
- **Framework-Agnostic SSE Support**: Understands Node HTTP (`res.writeHead`, `res.setHeader`), Express/Fastify (`res.set`, `res.header`, `res.type`), Web Fetch (`new Response`, `Headers`), Hono (`c.header`, `streamSSE`), and H3/Nitro (`setResponseHeader`, `event.node.req`).
- **CI-Ready Outputs**: Supports `text`, `json`, and **SARIF v2.1.0** (`--format sarif`) for GitHub Code Scanning.

## Installation

```bash
npm install -D @pie527645-cloud/sse-stream-lab
```

Or run directly via `npx`:

```bash
npx @pie527645-cloud/sse-stream-lab check .
```

## CLI Usage

```bash
sse-stream-lab check [target] [--format text|json|sarif] [--fail-on high|medium|low|info|none] [--include-tests]
```

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | `.` | File or directory to audit |
| `--format <text\|json\|sarif>` | `text` | Output format (`text`, `json`, or SARIF v2.1.0 `sarif`) |
| `--fail-on <high\|medium\|low\|info\|none>` | `medium` | Minimum finding severity that triggers exit code `1` |
| `--include-tests` | `false` | Include `test/`, `tests/`, `__tests__/`, `*.test.*`, and `*.spec.*` files |
| `-h, --help` | — | Print usage information and exit |
| `-v, --version` | — | Print package version and exit |

### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Clean scan, or all findings strictly below `--fail-on` threshold (or `--fail-on none`) |
| `1` | One or more findings at or above `--fail-on` threshold |
| `2` | Invalid CLI arguments, missing target path, or `SYMLINK_ESCAPE_BLOCKED` |

## Rules (`v1`)

| Rule ID | Severity | Summary | What Stays Clean |
| --- | --- | --- | --- |
| `SSE001` | `medium` | Handler sets `Content-Type: text/event-stream` (or calls Hono `streamSSE`) without setting a `Cache-Control` header in the same handler. | Setting `Cache-Control: no-cache` (case-insensitive; optionally alongside `X-Accel-Buffering: no`). |
| `SSE002` | `medium` | Two-pass project-wide rule: `app.use(compression())`, `app.use('/', compression(...))`, or `router.use(compression(...))` registered globally without a `filter` option in a project that contains at least one `event-stream` handler. | Passing `{ filter: ... }` to `compression(...)`, scoping `compression()` to a non-root path (`app.use('/api/json', compression())`), or projects with zero SSE handlers. |
| `SSE003` | `medium` | Inside a stream read loop (`reader.read()`, `for await (const chunk of stream)`, or `stream.on('data', ...)`), calling `decoder.decode(chunk)` without `{ stream: true }` or calling `chunk.toString(...)` on raw byte chunks (corrupting split multi-byte UTF-8 CJK/emoji sequences). | `decoder.decode(chunk, { stream: true })` (plus final 0-arg `decoder.decode()` flush), `stream.setEncoding('utf8')` / `'utf-8'`, or `pipeThrough(new TextDecoderStream())`. |
| `SSE004` | `medium` | An `event-stream` handler starts an upstream `fetch`, Undici `request`, or AI SDK `.stream(...)` / `streamText(...)` call without wiring client disconnect cleanup. | Forwarding `req.signal` / `request.signal` / `c.req.raw.signal`, listening to `req.on('close'\|'aborted')` / `res.on('close')` / `event.node.req.on('close')`, or implementing `ReadableStream({ cancel() { ... } })`. |

## Programmatic API

```ts
import { checkProject, formatSarif } from '@pie527645-cloud/sse-stream-lab';

const report = checkProject({
  target: './src',
  failOn: 'medium',
  includeTests: false,
});

if (report.summary.total > 0) {
  console.log(formatSarif(report));
}
```

## Prior Art

- **`rexxars/eventsource-parser`**: Standards-compliant runtime SSE framing parser for JavaScript streams; solves runtime event parsing once decoded text arrives, whereas `sse-stream-lab` statically audits server headers, middleware buffering, UTF-8 chunk decoding (`SSE003`), and upstream abort plumbing before deployment.
- **`expressjs/compression`**: Express gzip/deflate middleware whose default `compressible` filter buffers responses unless `Cache-Control: no-transform` or a custom `filter` skips `text/event-stream`; `SSE002` statically detects unfiltered global `compression()` registrations across multi-file projects that serve SSE.
- **`semgrep/semgrep-rules`** and **`eslint-community/eslint-plugin-n`**: General-purpose static analysis ecosystems for Node.js security and API best practices, but neither ships cross-file SSE middleware buffering rules, multi-byte `TextDecoder` stream-loop state checks, or SSE-specific upstream disconnect leak rules (`SSE001`–`SSE004`).
- **Scope Note**: Version 1 of `@pie527645-cloud/sse-stream-lab` performs deterministic static AST auditing only; live network/TCP chaos probing is intentionally deferred beyond v1.

## License

MIT
