import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';

describe('telemetry bootstrap stdout safety', () => {
  it('does not write to stdout when loaded via --import', async () => {
    const instrumentation = path
      .relative(
        process.cwd(),
        path.join(process.cwd(), 'dist/telemetry/instrumentation.js')
      )
      .split(path.sep)
      .join('/');

    const child = spawn(
      process.execPath,
      [
        '--import',
        `./${instrumentation}`,
        '-e',
        "process.stdout.write('MCP_MARKER\\n'); process.exit(0);",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
          OTEL_METRIC_EXPORT_INTERVAL: '60000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });

    const code = await new Promise<number | null>((resolve) => {
      child.on('close', (c) => resolve(c));
    });

    expect(code, `stderr=${stderr}`).toBe(0);
    // Only MCP marker may appear on stdout — no OTel console dump
    expect(stdout.trim(), `stderr=${stderr}`).toBe('MCP_MARKER');
    expect(stdout).not.toMatch(/OpenTelemetry|otlp|BatchSpanProcessor/i);
    expect(stderr).toMatch(/\[telemetry\]/);
  }, 15_000);
});
