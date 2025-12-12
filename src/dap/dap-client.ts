/**
 * DAP Client for Godot
 *
 * Connects to Godot's Debug Adapter Protocol server (default port 6006)
 * to query debugger state (breakpoints, call stack, variables).
 */

import * as net from 'net';
import {
  DAPRequest,
  DAPResponse,
  DAPEvent,
  Thread,
  StackFrame,
  Scope,
  Variable,
  Breakpoint,
  Capabilities,
  StoppedEventBody,
} from './dap-types.js';

// Debug mode
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';

function logDebug(message: string): void {
  if (DEBUG_MODE) {
    console.debug(`[DAP] ${message}`);
  }
}

/**
 * DAP Client that connects to Godot's debug adapter
 */
export class DAPClient {
  private socket: net.Socket | null = null;
  private connected: boolean = false;
  private paused: boolean = false;
  private currentThreadId: number = 1;
  private sequenceNumber: number = 1;
  private pendingRequests: Map<number, {
    resolve: (response: DAPResponse) => void;
    reject: (error: Error) => void;
    command: string;
  }> = new Map();
  private buffer: string = '';
  private capabilities: Capabilities | null = null;
  private breakpoints: Map<string, Breakpoint[]> = new Map(); // Keyed by source path

  /**
   * Connect to the DAP server
   */
  async connect(host: string = '127.0.0.1', port: number = 6006): Promise<void> {
    return new Promise((resolve, reject) => {
      logDebug(`Connecting to DAP server at ${host}:${port}`);

      this.socket = new net.Socket();

      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error(`Connection timeout to DAP server at ${host}:${port}`));
      }, 5000);

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        logDebug('Connected to DAP server');
        this.connected = true;
        resolve();
      });

      this.socket.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        logDebug('DAP connection closed');
        this.connected = false;
        this.paused = false;
        this.socket = null;
      });

      this.socket.on('error', (err: Error) => {
        clearTimeout(timeout);
        logDebug(`DAP connection error: ${err.message}`);
        this.connected = false;
        reject(err);
      });

      this.socket.connect(port, host);
    });
  }

  /**
   * Disconnect from the DAP server
   */
  disconnect(): void {
    if (this.socket) {
      logDebug('Disconnecting from DAP server');
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      this.paused = false;
    }
  }

  /**
   * Check if connected to DAP server
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Check if the debugger is paused (at a breakpoint)
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Get the current thread ID (the one that is stopped)
   */
  getCurrentThreadId(): number {
    return this.currentThreadId;
  }

  /**
   * Initialize the DAP session
   */
  async initialize(): Promise<Capabilities> {
    const response = await this.sendRequest('initialize', {
      clientID: 'godot-mcp',
      clientName: 'Godot MCP Server',
      adapterID: 'godot',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
    });

    if (response.success && response.body) {
      this.capabilities = response.body as Capabilities;
      logDebug(`DAP capabilities: ${JSON.stringify(this.capabilities)}`);
    }

    // Send configurationDone to complete initialization
    await this.sendRequest('configurationDone', {});

    return this.capabilities || {};
  }

  /**
   * Get all threads
   */
  async getThreads(): Promise<Thread[]> {
    const response = await this.sendRequest('threads', {});
    if (response.success && response.body) {
      const body = response.body as { threads: Thread[] };
      return body.threads || [];
    }
    return [];
  }

  /**
   * Get stack trace for a thread
   */
  async stackTrace(threadId: number = 1, startFrame: number = 0, levels: number = 20): Promise<StackFrame[]> {
    const response = await this.sendRequest('stackTrace', {
      threadId,
      startFrame,
      levels,
    });

    if (response.success && response.body) {
      const body = response.body as { stackFrames: StackFrame[] };
      return body.stackFrames || [];
    }
    return [];
  }

  /**
   * Get scopes for a stack frame
   */
  async scopes(frameId: number): Promise<Scope[]> {
    const response = await this.sendRequest('scopes', { frameId });

    if (response.success && response.body) {
      const body = response.body as { scopes: Scope[] };
      return body.scopes || [];
    }
    return [];
  }

  /**
   * Get variables for a variables reference (from scope or nested variable)
   */
  async variables(variablesReference: number, start?: number, count?: number): Promise<Variable[]> {
    const args: Record<string, unknown> = { variablesReference };
    if (start !== undefined) args.start = start;
    if (count !== undefined) args.count = count;

    const response = await this.sendRequest('variables', args);

    if (response.success && response.body) {
      const body = response.body as { variables: Variable[] };
      return body.variables || [];
    }
    return [];
  }

  /**
   * Get all breakpoints that have been set
   * Note: DAP doesn't have a direct "get all breakpoints" request.
   * We track breakpoints locally from setBreakpoints responses.
   */
  getBreakpoints(): Array<{ script: string; line: number; enabled: boolean }> {
    const result: Array<{ script: string; line: number; enabled: boolean }> = [];

    for (const [sourcePath, breakpoints] of this.breakpoints.entries()) {
      for (const bp of breakpoints) {
        result.push({
          script: sourcePath.startsWith('res://') ? sourcePath : `res://${sourcePath}`,
          line: bp.line || 0,
          enabled: bp.verified,
        });
      }
    }

    return result;
  }

  /**
   * Evaluate an expression in the context of a stack frame
   * This is the primary way to get variable values in Godot's DAP implementation
   */
  async evaluate(expression: string, frameId: number = 0): Promise<{ result: string; variablesReference: number } | null> {
    const response = await this.sendRequest('evaluate', {
      expression,
      frameId,
      context: 'hover', // or 'watch', 'repl'
    });

    if (response.success && response.body) {
      const body = response.body as { result: string; variablesReference: number };
      return {
        result: body.result || '',
        variablesReference: body.variablesReference || 0,
      };
    }
    return null;
  }

  /**
   * Evaluate multiple expressions and return their values
   */
  async evaluateMultiple(expressions: string[], frameId: number = 0): Promise<Array<{ name: string; value: string; variablesReference: number }>> {
    const results: Array<{ name: string; value: string; variablesReference: number }> = [];

    for (const expr of expressions) {
      try {
        const result = await this.evaluate(expr, frameId);
        if (result) {
          results.push({
            name: expr,
            value: result.result,
            variablesReference: result.variablesReference,
          });
        }
      } catch (err) {
        // Variable might not exist in this scope, skip it
        logDebug(`Failed to evaluate '${expr}': ${err}`);
      }
    }

    return results;
  }

  /**
   * Set breakpoints for a source file
   */
  async setBreakpoints(sourcePath: string, lines: number[]): Promise<Breakpoint[]> {
    const response = await this.sendRequest('setBreakpoints', {
      source: { path: sourcePath },
      breakpoints: lines.map(line => ({ line })),
    });

    if (response.success && response.body) {
      const body = response.body as { breakpoints: Breakpoint[] };
      const breakpoints = body.breakpoints || [];
      // Store breakpoints for later retrieval
      this.breakpoints.set(sourcePath, breakpoints);
      return breakpoints;
    }
    return [];
  }

  /**
   * Continue execution
   */
  async continue(threadId: number = 1): Promise<void> {
    await this.sendRequest('continue', { threadId });
  }

  /**
   * Step over (next line)
   */
  async next(threadId: number = 1): Promise<void> {
    await this.sendRequest('next', { threadId });
  }

  /**
   * Step into
   */
  async stepIn(threadId: number = 1): Promise<void> {
    await this.sendRequest('stepIn', { threadId });
  }

  /**
   * Step out
   */
  async stepOut(threadId: number = 1): Promise<void> {
    await this.sendRequest('stepOut', { threadId });
  }

  /**
   * Pause execution
   */
  async pause(threadId: number = 1): Promise<void> {
    await this.sendRequest('pause', { threadId });
  }

  /**
   * Send a DAP request and wait for response
   */
  private sendRequest(command: string, args: Record<string, unknown>): Promise<DAPResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected to DAP server'));
        return;
      }

      const seq = this.sequenceNumber++;
      const request: DAPRequest = {
        seq,
        type: 'request',
        command,
        arguments: args,
      };

      this.pendingRequests.set(seq, { resolve, reject, command });

      const message = JSON.stringify(request);
      const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

      logDebug(`Sending DAP request: ${command} (seq=${seq})`);
      this.socket.write(header + message);

      // Timeout for request
      setTimeout(() => {
        if (this.pendingRequests.has(seq)) {
          this.pendingRequests.delete(seq);
          reject(new Error(`DAP request timeout: ${command}`));
        }
      }, 10000);
    });
  }

  /**
   * Handle incoming data from DAP server
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Parse Content-Length header and extract messages
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.substring(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        // Invalid header, try to recover
        this.buffer = this.buffer.substring(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) {
        // Message not complete yet
        break;
      }

      const messageStr = this.buffer.substring(messageStart, messageEnd);
      this.buffer = this.buffer.substring(messageEnd);

      try {
        const message = JSON.parse(messageStr);
        this.handleMessage(message);
      } catch (err) {
        logDebug(`Failed to parse DAP message: ${err}`);
      }
    }
  }

  /**
   * Handle a parsed DAP message
   */
  private handleMessage(message: DAPResponse | DAPEvent): void {
    if (message.type === 'response') {
      const response = message as DAPResponse;
      logDebug(`Received DAP response: ${response.command} (seq=${response.request_seq}, success=${response.success})`);

      const pending = this.pendingRequests.get(response.request_seq);
      if (pending) {
        this.pendingRequests.delete(response.request_seq);
        if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(response.message || `DAP request failed: ${response.command}`));
        }
      }
    } else if (message.type === 'event') {
      const event = message as DAPEvent;
      this.handleEvent(event);
    }
  }

  /**
   * Handle DAP events
   */
  private handleEvent(event: DAPEvent): void {
    logDebug(`Received DAP event: ${event.event}`);

    switch (event.event) {
      case 'stopped':
        this.paused = true;
        if (event.body) {
          const body = event.body as unknown as StoppedEventBody;
          if (body.threadId) {
            this.currentThreadId = body.threadId;
          }
          logDebug(`Stopped at thread ${this.currentThreadId}, reason: ${body.reason || 'unknown'}`);
        }
        break;

      case 'continued':
        this.paused = false;
        logDebug('Execution continued');
        break;

      case 'terminated':
        this.paused = false;
        logDebug('Debug session terminated');
        break;

      case 'output':
        if (event.body) {
          const body = event.body as { output: string; category?: string };
          logDebug(`[${body.category || 'output'}] ${body.output}`);
        }
        break;

      case 'breakpoint':
        // Breakpoint was added/changed/removed
        logDebug('Breakpoint event received');
        break;

      default:
        logDebug(`Unhandled event: ${event.event}`);
    }
  }
}

/**
 * Check if a port is reachable (for pre-connection verification)
 */
export function checkPort(host: string, port: number, timeout: number = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}
