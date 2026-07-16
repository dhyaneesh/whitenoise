# Testing WhiteNoise

WhiteNoise ships a Vitest suite (unit, hermetic integration, and gated end-to-end) plus a manual MCP Inspector workflow for interactive smoke testing. For product/architecture overview see [README.md](README.md).

## Automated tests

Requires **Node.js 20+** (use **22** if you also run MCP Inspector).

```bash
npm install
npm run build   # integration/e2e globalSetup also builds automatically
npm test        # unit + integration (hermetic)
npm run test:unit
npm run test:watch
npm run test:coverage
```

### End-to-end (real downstream servers)

Boots `dist/index.js` over stdio via the MCP SDK client and starts the real downstream servers configured in `src/downstream/servers.ts` (`filesystem`, `memory`, `playwright`). First run may need npm registry access for `npx -y` package fetches.

```bash
# Sets RUN_E2E=1 cross-platform via cross-env
npm run test:e2e
```

| Project       | Location                 | Imports from | Notes                                        |
| ------------- | ------------------------ | ------------ | -------------------------------------------- |
| `unit`        | `test/unit/`             | `src/`       | Fast; no build required                      |
| `integration` | `test/integration/`      | `dist/`      | Fake downstream pool; builds via globalSetup |
| `e2e`         | `test/e2e/`              | live process | Gated by `RUN_E2E=1`; real downstreams       |

CI runs unit/integration on every PR and a separate e2e job (see `.github/workflows/ci.yml`).

---

## Manual testing with MCP Inspector

Use Node.js **22** (Inspector needs `22.7.5+`; the proxy itself needs 20+).

### 1. Install and build

```bash
git clone https://github.com/dhyaneesh/whitenoise.git
cd whitenoise

node --version
npm install
npm run build
```

The build runs `tsc` and should produce `dist/index.js`.

Clean dependency check:

```bash
rm -rf node_modules dist
npm install
npm run build
```

On CI, prefer:

```bash
npm ci
npm run build
```

### 2. Launch with MCP Inspector

From the repository root:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Inspector opens at `http://localhost:6274`. It launches WhiteNoise as a stdio MCP server — you do **not** need `npm start` separately.

**Keep MCP Inspector bound to localhost.** Its proxy can launch local processes and should not be exposed to an untrusted network.

Successful startup should include messages resembling:

```text
[proxy] booting
[downstream] connected: filesystem
[downstream] connected: memory
[downstream] connected: playwright
[proxy] downstream servers connected
[proxy] MCP proxy server ready
```

Current downstream servers (see `src/downstream/servers.ts`):

- `filesystem`
- `memory`
- `playwright`

This differs from older README examples that listed `everything` / `github-mcp-server`. Because they start via `npx -y`, the first run may need npm registry access unless packages are cached.

### 3. Verify the four MCP tools

In Inspector → **Tools**, you should see exactly:

```text
search_tools
list_modules
read_module
execute_code
```

#### `list_modules`

```json
{ "path": "" }
```

Expected: modules like `mcp/servers/filesystem/readFile`, `mcp/servers/filesystem/readFile.schema`, plus memory/playwright entries.

#### `search_tools`

```json
{ "query": "read file", "limit": 10 }
```

Expected: one or more filesystem tools with a `specifier` for `read_module`.

#### `read_module`

```json
{ "specifier": "mcp/servers/filesystem/readFile" }
```

Expected: generated TypeScript with the function signature, types, schema import, and fully-qualified tool name (`filesystem__read_file`). Downstream names like `read_file` become camelCase wrappers like `readFile`.

### 4. Smoke-test `execute_code`

```json
{
  "code": "console.log('smoke-test-ok');",
  "timeoutMs": 5000
}
```

Expected:

```json
{
  "durationMs": 123,
  "stdout": "smoke-test-ok\n",
  "stderr": ""
}
```

### 5. Downstream filesystem call

Confirm the import via `search_tools` / `read_module`, then:

```typescript
import { readFile } from 'mcp/servers/filesystem/readFile';

const result = await readFile({
  path: '/absolute/path/to/whitenoise/package.json'
});

console.log(JSON.stringify(result, null, 2));
```

On Windows, prefer:

```text
C:/Users/your-name/projects/whitenoise/package.json
```

The filesystem server is rooted at the repo path in `servers.ts`, so the file must live under that directory.

A successful response proves:

```text
Inspector → WhiteNoise → execute_code → wrapper → filesystem MCP → response
```

### 6. Negative tests

**Invalid TypeScript** — server stays up; error returned as tool content:

```json
{ "code": "const broken = ;", "timeoutMs": 5000 }
```

**Runtime exception:**

```json
{ "code": "throw new Error('expected test error');", "timeoutMs": 5000 }
```

**Invalid module** — MCP error, not process exit:

```json
{ "specifier": "mcp/servers/filesystem/notARealTool" }
```

**Search with no strong matches** — valid JSON response (catalog may fall back to a browse-style list when nothing scores above zero):

```json
{ "query": "definitely-not-a-real-tool-xyz", "limit": 10 }
```

### Minimum acceptance checklist

```text
[ ] npm install succeeds
[ ] npm run build succeeds without TypeScript errors
[ ] Inspector connects through stdio
[ ] All four WhiteNoise meta-tools appear
[ ] list_modules returns generated wrappers
[ ] search_tools finds filesystem tools
[ ] read_module returns valid wrapper source
[ ] execute_code captures stdout
[ ] execute_code can read package.json through filesystem MCP
[ ] Invalid code returns an error without killing the server
[ ] Ctrl+C shuts down WhiteNoise and its downstream processes
```
