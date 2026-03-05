import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'node:child_process';

export class FigmaClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private serverPid: number | null = null;
  private connected = false;
  private connectingPromise: Promise<void> | null = null;
  private bridgeCheckPromise: Promise<boolean> | null = null;

  isConnected(): boolean {
    return this.connected;
  }

  async isBridgeReady(): Promise<boolean> {
    if (this.bridgeCheckPromise) return this.bridgeCheckPromise;
    this.bridgeCheckPromise = this._checkBridgeStatus();
    try {
      return await this.bridgeCheckPromise;
    } finally {
      this.bridgeCheckPromise = null;
    }
  }

  private async _checkBridgeStatus(): Promise<boolean> {
    if (!this.connected || !this.client) return false;

    // Fast-fail if the subprocess is dead
    if (!this.isProcessAlive()) {
      this.disconnect();
      return false;
    }

    try {
      const result = await this.client.callTool(
        { name: 'figma_get_status', arguments: {} },
        undefined,
        { signal: AbortSignal.timeout(3000) },
      );
      if (result.isError) return false;
      const textContent = (result.content as Array<{ type: string; text: string }>)
        ?.find((c) => c.type === 'text');
      if (!textContent) return false;
      const status = JSON.parse(textContent.text);
      return status?.transport?.websocket?.available === true;
    } catch {
      return false;
    }
  }

  private isProcessAlive(): boolean {
    if (!this.serverPid) return false;
    try {
      process.kill(this.serverPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async connect(): Promise<void> {
    // Guard against concurrent connect() calls
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = this._doConnect();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async _doConnect(): Promise<void> {
    // Clean up any previous connection before creating a new one
    this.disconnect();

    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', 'figma-console-mcp@1.11.2'],
    });

    // Capture the child PID after the transport spawns the process,
    // so we can force-kill the process tree on disconnect.
    // The SDK's close() only aborts the AbortController which doesn't
    // reliably kill `npm exec` child trees.
    const origStart = this.transport.start.bind(this.transport);
    this.transport.start = async () => {
      await origStart();
      // Access the private _process field to grab the PID
      const proc = (this.transport as unknown as { _process?: { pid?: number } })?._process;
      if (proc?.pid) {
        this.serverPid = proc.pid;
      }
    };

    this.client = new Client({
      name: 'journey-mapper',
      version: '1.0.0',
    });

    await this.client.connect(this.transport);
    this.connected = true;

    // Detect connection closure (e.g. Figma desktop quit)
    this.client.onclose = () => {
      this.connected = false;
      this.client = null;
      this.transport = null;
      this.serverPid = null;
      console.warn('Figma MCP client connection closed');
    };
  }

  disconnect(): void {
    this.connected = false;

    // Kill the process tree. The SDK's transport.close() only aborts
    // the AbortController, which doesn't propagate to npm's child.
    if (this.serverPid) {
      this._killTree(this.serverPid);
      this.serverPid = null;
    }

    if (this.transport) {
      try { this.transport.close?.(); } catch { /* ignore */ }
      this.transport = null;
    }
    this.client = null;
  }

  private _killTree(pid: number): void {
    try {
      // pkill -P kills all children of the given PID, then we kill the parent
      execSync(`pkill -P ${pid} 2>/dev/null; kill ${pid} 2>/dev/null`, { stdio: 'ignore' });
    } catch {
      // Already dead
    }
  }

  async execute(code: string, timeout = 15000): Promise<unknown> {
    if (!this.client || !this.connected) {
      throw new Error('Figma MCP client not connected');
    }

    const result = await this.client.callTool({
      name: 'figma_execute',
      arguments: { code, timeout },
    });

    // Check for tool-level error
    if (result.isError) {
      const contentArr = result.content as Array<{ type: string; text: string }> | undefined;
      const errText = contentArr
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join(' ') || 'Figma command failed';
      throw new Error(errText);
    }

    // Parse the response - figma_execute returns content array
    if (result.content && Array.isArray(result.content)) {
      const textContent = result.content.find(
        (c: { type: string }) => c.type === 'text'
      ) as { type: string; text: string } | undefined;
      if (textContent) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return textContent.text;
        }
      }
    }

    return result;
  }
}
