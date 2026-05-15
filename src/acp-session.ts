import { randomUUID } from 'crypto';
import { loadConfigLayered } from './config.js';
import { ModelManager } from './models.js';
import { ToolRegistry } from './tools/registry.js';
import { Agent } from './agent.js';
import { PermissionManager } from './permissions.js';
import { registerCodingTools } from './tools/coding.js';
import { registerWebTools } from './tools/web.js';
import { registerDevOpsTools } from './tools/devops.js';
import { connectAndDiscover, closeAll, type McpClient } from './mcp.js';
import { buildSkillInvokeTool } from './skills.js';
import { loadSession, listSessions, saveSession, autoName, type Session } from './sessions.js';
import type { McpServerConfig } from './config.js';

// ACP mcpServer entry — flat shape as sent by Zed (ACP spec)
export type AcpMcpServer =
  | { name: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> }
  | { type: 'sse' | 'http'; name: string; url: string; headers?: Array<{ name: string; value: string }> };

export interface ActivePrompt {
  requestId: string | number;
  generation: number;
  cancelled: boolean;
}

export class AcpSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly agent: Agent;
  readonly registry: ToolRegistry;
  readonly permissions: PermissionManager;
  private mcpClients: McpClient[];
  activePrompt: ActivePrompt | null = null;
  private generation = 0;

  nextGeneration(): number { return ++this.generation; }

  private constructor(
    sessionId: string,
    cwd: string,
    agent: Agent,
    registry: ToolRegistry,
    permissions: PermissionManager,
    mcpClients: McpClient[],
  ) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.agent = agent;
    this.registry = registry;
    this.permissions = permissions;
    this.mcpClients = mcpClients;
  }

  static async create(cwd: string, acpMcpServers: AcpMcpServer[] = [], sessionId?: string): Promise<AcpSession> {
    const id = sessionId ?? randomUUID();
    const config = loadConfigLayered(cwd);
    const modelManager = new ModelManager(config);
    await modelManager.discover();

    const registry = new ToolRegistry();
    const permissions = new PermissionManager();

    for (const tool of registerCodingTools()) registry.register(tool);
    for (const tool of registerWebTools(config)) registry.register(tool);
    for (const tool of registerDevOpsTools()) registry.register(tool);

    const skillTool = buildSkillInvokeTool(cwd);
    if (skillTool) registry.register(skillTool);

    // Convert flat ACP mcpServers → vcode McpServerConfig
    const vcodeServers: Record<string, McpServerConfig> = {};
    for (const s of acpMcpServers) {
      if ('command' in s) {
        const env: Record<string, string> = {};
        for (const { name, value } of s.env ?? []) env[name] = value;
        vcodeServers[s.name] = { command: s.command, args: s.args, env, cwd };
      } else {
        const headers: Record<string, string> = {};
        for (const { name, value } of s.headers ?? []) headers[name] = value;
        vcodeServers[s.name] = { url: s.url, transport: s.type, headers };
      }
    }

    let mcpClients: McpClient[] = [];
    if (Object.keys(vcodeServers).length > 0) {
      const { clients, tools } = await connectAndDiscover(vcodeServers);
      mcpClients = clients;
      registry.registerBatch(tools);
    }

    const agent = new Agent(config, registry, modelManager, permissions);
    agent.getContext().setRegisteredTools(registry.names());

    return new AcpSession(id, cwd, agent, registry, permissions, mcpClients);
  }

  async autoSave(): Promise<void> {
    const raw = this.agent.getContext().getMessages();
    if (raw.length === 0) return;
    const messages = raw.map(m => {
      if (m.role !== 'assistant') return m;
      let content = m.content;
      // Strip complete <think>...</think> blocks
      content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
      // Strip orphan leading thinking text that ends at </think> (Qwen3 vLLM pattern)
      const idx = content.indexOf('</think>');
      if (idx !== -1) content = content.slice(idx + 8).replace(/^\s+/, '');
      return { ...m, content };
    });
    const name = autoName(messages);
    await saveSession(
      name,
      messages,
      this.agent.getModelManager().getCurrentModel(),
      this.agent.getMode(),
      this.cwd,
      this.sessionId,
    );
  }

  async close(): Promise<void> {
    this.agent.abort();
    await closeAll(this.mcpClients);
  }

  /** Restore a saved vcode session, keeping storedId as the active session ID. */
  static async load(
    storedId: string,
    overrideCwd?: string,
    acpMcpServers: AcpMcpServer[] = [],
  ): Promise<{ session: AcpSession; storedSession: Session } | null> {
    const storedSession = await loadSession(storedId);
    if (!storedSession) return null;
    const cwd = overrideCwd ?? storedSession.cwd;
    // Pass storedId so session.sessionId === storedId — Zed keeps using the same ID
    const session = await AcpSession.create(cwd, acpMcpServers, storedId);
    session.agent.getContext().replaceMessages(storedSession.messages);
    return { session, storedSession };
  }
}

export class AcpSessionStore {
  private sessions = new Map<string, AcpSession>();

  async create(cwd: string, mcpServers: AcpMcpServer[] = []): Promise<AcpSession> {
    const session = await AcpSession.create(cwd, mcpServers);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async list(): Promise<Session[]> {
    return listSessions();
  }

  async load(
    storedId: string,
    cwd?: string,
    mcpServers: AcpMcpServer[] = [],
  ): Promise<{ session: AcpSession; storedSession: Session } | null> {
    const result = await AcpSession.load(storedId, cwd, mcpServers);
    if (!result) return null;
    this.sessions.set(result.session.sessionId, result.session);
    return result;
  }

  get(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    await session.close();
    this.sessions.delete(sessionId);
    return true;
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) await session.close();
    this.sessions.clear();
  }
}
