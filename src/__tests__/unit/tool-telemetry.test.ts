import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolTelemetryEvent } from '../../tool-telemetry.js';

/**
 * ENG-2823 — the collected-telemetry seam.
 *
 * Two defects, one test file. First, the outcome this package already records
 * is wrong: an MCP tool refuses by RETURNING `{ isError: true }`, never by
 * throwing (`server.correlation-scope.test.ts` says so in its own header), so
 * `installCorrelationScope` filed every refusal as `outcome: 'ok'` and a
 * broken enrolment looked exactly like a successful one. Second, the line goes
 * to a local rotating file — right on a customer's laptop, invisible inside an
 * ECS container whose disk nothing collects.
 *
 * The sink is the fix for the second: the gateway supplies one that writes to
 * its request logger (stdout → CloudWatch). The file logger keeps its line
 * unchanged, because the stdio surface still cannot write to stdout.
 */

const logMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

vi.mock('../../logger.js', () => ({
  log: logMock,
  serviceVersion: '0.0.0-test',
}));
vi.mock('../../resources/index.js', () => ({ registerResources: vi.fn() }));
vi.mock('../../tools/index.js', () => ({
  registerTools: vi.fn(),
  grantsWriteTools: (scope?: string) => scope === 'read-write',
  resolveCapabilities: () => [],
}));
vi.mock('../../prompts/index.js', () => ({ registerPrompts: vi.fn() }));

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: vi.fn(function () {
    const recorded: Array<{
      name: string;
      config: unknown;
      cb: (...args: unknown[]) => unknown;
    }> = [];
    return {
      __recorded: recorded,
      registerTool(
        name: string,
        config: unknown,
        cb: (...args: unknown[]) => unknown,
      ) {
        recorded.push({ name, config, cb });
      },
    };
  }),
}));

interface RecordingServer {
  __recorded: Array<{
    name: string;
    config: unknown;
    cb: (...args: unknown[]) => unknown;
  }>;
  registerTool: (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) => void;
}

async function wrapTool(
  handler: (...args: unknown[]) => unknown,
  telemetry?: (event: ToolTelemetryEvent) => void,
  toolName = 'enroll_file',
): Promise<(...args: unknown[]) => Promise<unknown>> {
  const { createServer } = await import('../../server.js');
  const server = createServer(
    {} as never,
    telemetry ? { telemetry } : undefined,
  ) as unknown as RecordingServer;
  server.registerTool(toolName, {}, handler);
  return server.__recorded[0].cb as (
    ...args: unknown[]
  ) => Promise<unknown>;
}

describe('tool telemetry (ENG-2823)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('outcome classification', () => {
    it('a refusal is REFUSED, not ok — a returned isError never threw', async () => {
      const events: ToolTelemetryEvent[] = [];
      const wrapped = await wrapTool(
        () =>
          Promise.resolve({
            content: [{ type: 'text', text: 'not enrolled' }],
            isError: true,
          }),
        (e) => events.push(e),
      );

      await wrapped({ fileMsId: 'file-1' });

      expect(events).toHaveLength(1);
      expect(events[0].outcome).toBe('refused');
      expect(events[0].tool).toBe('enroll_file');
    });

    it('the FILE line carries the same corrected outcome', async () => {
      const wrapped = await wrapTool(() =>
        Promise.resolve({ content: [], isError: true }),
      );

      await wrapped({});

      expect(logMock.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tool_call', outcome: 'refused' }),
        'tool_call',
      );
    });

    it('a clean result is ok', async () => {
      const events: ToolTelemetryEvent[] = [];
      const wrapped = await wrapTool(
        () => Promise.resolve({ content: [{ type: 'text', text: 'hi' }] }),
        (e) => events.push(e),
      );

      await wrapped({});

      expect(events[0].outcome).toBe('ok');
    });

    it('a throw is FAILED and names the error TYPE only', async () => {
      const events: ToolTelemetryEvent[] = [];
      class UpstreamError extends Error {
        status = 502;
      }
      const boom = new UpstreamError('Budget FY26.xlsx blew up at /sites/Finance');
      const wrapped = await wrapTool(
        () => Promise.reject(boom),
        (e) => events.push(e),
      );

      await expect(wrapped({})).rejects.toThrow('blew up');

      expect(events[0].outcome).toBe('failed');
      expect(events[0].errorName).toBe('UpstreamError');
      expect(events[0].status).toBe(502);
      expect(JSON.stringify(events[0])).not.toContain('Budget FY26.xlsx');
      expect(JSON.stringify(events[0])).not.toContain('/sites/Finance');
    });

    /**
     * A handler that rejects with something that is not an `Error`.
     *
     * `describeError` (`tool-telemetry.ts:101-111`) has three arms and only the
     * `instanceof Error` one was driven. This is the arm an operator meets when
     * an upstream SDK rejects with a bare string or a plain object: the line has
     * to say SOMETHING about what came back, and it must still say nothing
     * about the value, which is uncontrolled text.
     */
    it.each([
      ['a bare string', 'ECONNRESET on /sites/Finance/Budget.xlsx', 'string'],
      ['a plain object', { detail: '/sites/Finance/Budget.xlsx' }, 'object'],
      ['a number', 502, 'number'],
    ])('a non-Error rejection is FAILED and names its %s type only', async (
      _label,
      thrown,
      expectedName,
    ) => {
      const events: ToolTelemetryEvent[] = [];
      const wrapped = await wrapTool(
        () => Promise.reject(thrown),
        (e) => events.push(e),
      );

      await expect(wrapped({})).rejects.toBeDefined();

      expect(events[0].outcome).toBe('failed');
      expect(events[0].errorName).toBe(expectedName);
      expect(JSON.stringify(events[0])).not.toContain('Budget.xlsx');
    });

    /**
     * `null` and `undefined` are the one non-Error case that must record NO
     * name rather than the string "object": `typeof null` is `'object'`, which
     * would put a word in the log that describes nothing.
     */
    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('records no errorName at all when the handler rejects with %s', async (
      _label,
      thrown,
    ) => {
      const events: ToolTelemetryEvent[] = [];
      const wrapped = await wrapTool(
        () => Promise.reject(thrown),
        (e) => events.push(e),
      );

      await expect(wrapped({})).rejects.toBeFalsy();

      expect(events[0].outcome).toBe('failed');
      expect(events[0].errorName).toBeUndefined();
      expect(events[0].status).toBeUndefined();
    });

    /**
     * The status field is typed `number`. A backend that starts serving it as
     * text must not put that text into the collected line — the whole reason
     * the event carries a fixed, typed key set.
     */
    it('drops a non-numeric status rather than emitting it', async () => {
      const events: ToolTelemetryEvent[] = [];
      class TextStatusError extends Error {
        status = '502 /sites/Finance';
      }
      const wrapped = await wrapTool(
        () => Promise.reject(new TextStatusError('upstream')),
        (e) => events.push(e),
      );

      await expect(wrapped({})).rejects.toThrow('upstream');

      expect(events[0].errorName).toBe('TextStatusError');
      expect(events[0].status).toBeUndefined();
      expect(JSON.stringify(events[0])).not.toContain('/sites/Finance');
    });

    it('records how long the call took', async () => {
      const events: ToolTelemetryEvent[] = [];
      const wrapped = await wrapTool(
        () => Promise.resolve({ content: [] }),
        (e) => events.push(e),
      );

      await wrapped({});

      expect(typeof events[0].durationMs).toBe('number');
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('what may never reach the sink', () => {
    it('emits no tool arguments — KI-1350 is not being recreated', async () => {
      const events: ToolTelemetryEvent[] = [];
      const wrapped = await wrapTool(
        () => Promise.resolve({ content: [] }),
        (e) => events.push(e),
      );

      await wrapped({
        fileMsId: 'file-1',
        query: 'Q3 payroll',
        token: 'rh_pat_supersecret',
        path: '/sites/Finance/Shared Documents/Budget.xlsx',
      });

      const line = JSON.stringify(events[0]);
      expect(line).not.toContain('rh_pat_supersecret');
      expect(line).not.toContain('Q3 payroll');
      expect(line).not.toContain('Shared Documents');
      expect(Object.keys(events[0]).sort()).toEqual(
        ['durationMs', 'event', 'outcome', 'tool'].sort(),
      );
    });

    it('emits no tool RESULT content either', async () => {
      const events: ToolTelemetryEvent[] = [];
      const wrapped = await wrapTool(
        () =>
          Promise.resolve({
            content: [{ type: 'text', text: 'Cell B4 = 1,240,000' }],
          }),
        (e) => events.push(e),
      );

      await wrapped({});

      expect(JSON.stringify(events[0])).not.toContain('1,240,000');
    });
  });

  describe('the sink can never break a tool call', () => {
    it('a throwing sink does not fail the call', async () => {
      const wrapped = await wrapTool(
        () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
        () => {
          throw new Error('log transport down');
        },
      );

      await expect(wrapped({})).resolves.toEqual({
        content: [{ type: 'text', text: 'ok' }],
      });
    });

    it('a throwing sink does not swallow the handler error', async () => {
      const wrapped = await wrapTool(
        () => Promise.reject(new Error('handler exploded')),
        () => {
          throw new Error('log transport down');
        },
      );

      await expect(wrapped({})).rejects.toThrow('handler exploded');
    });

    it('no sink is the stdio default and still logs to the file', async () => {
      const wrapped = await wrapTool(() =>
        Promise.resolve({ content: [] }),
      );

      await expect(wrapped({})).resolves.toEqual({ content: [] });
      expect(logMock.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tool_call', outcome: 'ok' }),
        'tool_call',
      );
    });
  });
});
