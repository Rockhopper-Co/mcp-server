import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
};

export class McpStdioClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = '';
  private stderrBuffer = '';
  private pending = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  async start(env: Record<string, string>): Promise<void> {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(currentDir, '../../../..');
    const tsxBin = resolve(
      projectRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
    );

    this.process = spawn(tsxBin, ['src/cli.ts'], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });

    this.process.stdout.on('data', (chunk: Buffer) => {
      this.handleChunk(chunk.toString('utf8'));
    });

    this.process.stderr.on('data', (chunk: Buffer) => {
      // Keep stderr drained and preserve logs for failures.
      this.stderrBuffer += chunk.toString('utf8');
    });

    this.process.on('exit', (code) => {
      const error = new Error(
        `MCP server exited early (code=${String(code)}): ${this.stderrBuffer}`,
      );
      for (const pendingRequest of this.pending.values()) {
        clearTimeout(pendingRequest.timer);
        pendingRequest.reject(error);
      }
      this.pending.clear();
    });

    await this.initialize();
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.process = null;
  }

  async initialize(): Promise<JsonRpcResponse> {
    const response = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-server-test-client', version: '1.0.0' },
    });

    this.notify('notifications/initialized', {});
    return response;
  }

  async listTools(): Promise<JsonRpcResponse> {
    return this.request('tools/list', {});
  }

  async listResources(): Promise<JsonRpcResponse> {
    return this.request('resources/list', {});
  }

  async listPrompts(): Promise<JsonRpcResponse> {
    return this.request('prompts/list', {});
  }

  async callTool(name: string, argumentsPayload: Record<string, unknown>): Promise<JsonRpcResponse> {
    return this.request('tools/call', {
      name,
      arguments: argumentsPayload,
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0' as const,
      id,
      method,
      params,
    };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 10_000);

      this.pending.set(id, { resolve, reject, timer });
      this.send(payload);
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error('MCP client process not started');
    }
    const message = `${JSON.stringify(payload)}\n`;
    this.process.stdin.write(message);
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const newLineIndex = this.buffer.indexOf('\n');
      if (newLineIndex === -1) return;

      const line = this.buffer.slice(0, newLineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newLineIndex + 1);
      if (!line.trim()) {
        continue;
      }

      const message = JSON.parse(line) as JsonRpcResponse;
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const pendingRequest = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pendingRequest.timer);
        pendingRequest.resolve(message);
      }
    }
  }
}
