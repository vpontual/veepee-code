#!/usr/bin/env node

import dns from 'dns';
import os from 'os';
// Prefer IPv4 — prevents failures on IPv4-only tunnels (WireGuard, VPN)
dns.setDefaultResultOrder('ipv4first');

import { resolve } from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { loadConfig, getConfigPath } from './config.js';
import { ModelManager } from './models.js';
import { ToolRegistry } from './tools/registry.js';
import { Agent } from './agent.js';
import { PermissionManager } from './permissions.js';
import { Benchmarker } from './benchmark.js';
import { startApiServer } from './api.js';
import { TUI, theme, icons } from './tui/index.js';
import { validateIntegrations, formatSetupReport } from './setup.js';
import { saveSession, listSessions, findSession, formatSessionList, autoName, loadJsonlSession, autoAppendJsonlTurn, migrateLegacySessions } from './sessions.js';
import { parseBang, runInlineShell, formatShellForLlm } from './inline-bash.js';
import { getProjectSession, setProjectSession, listProjects, formatProjectList } from './projects.js';
import { IgnoreManager } from './ignore.js';
import { FileTracker } from './filetracker.js';
import { Profiler } from './profiler.js';
import { ObservabilityManager } from './observability.js';
import { RalphEngine } from './ralph.js';
import { MoeEngine, type MoeStrategy } from './moe.js';
import { KnowledgeState } from './knowledge.js';
import { createWorktree, listWorktrees, cleanupWorktrees, isGitRepo } from './worktree.js';
import { needsWizard, runWizard, runWizardForStep, getWizardStepIds } from './wizard.js';
import { SandboxManager, formatSize } from './sandbox.js';
import { PreviewManager } from './preview.js';
import { SyncManager } from './sync.js';
import { registerRcRoutes, generateRcToken } from './rc.js';
import { checkForUpdate } from './update.js';
import { resolveApiHost } from './api-host.js';

// Tool registrations
import { registerCodingTools } from './tools/coding.js';
import { registerLspTools } from './tools/lsp.js';
import { LspManager } from './lsp/manager.js';

import { registerWebTools } from './tools/web.js';
import { registerDevOpsTools } from './tools/devops.js';
import { discoverRemoteTools } from './tools/remote.js';
import { connectAndDiscover as connectMcpServers, closeAll as closeMcpClients, type McpClient } from './mcp.js';
import { buildSkillInvokeTool } from './skills.js';
import { createTaskTool } from './tools/task.js';
import { createExitPlanModeTool } from './tools/plan-gate.js';
import { createNotebookEditTool } from './tools/notebook.js';

const VERSION = '0.3.0';


async function main() {
  const profiler = new Profiler(process.argv.includes('--profile'));
  profiler.mark('main() entered');

  // Project list: vcode --projects
  if (process.argv.includes('--projects')) {
    const projects = await listProjects();
    console.log(formatProjectList(projects));
    process.exit(0);
  }

  // Self-update: vcode --update
  if (process.argv.includes('--update')) {
    const { execSync } = await import('child_process');
    try {
      execSync('curl -fsSL https://raw.githubusercontent.com/vpontual/veepee-code/main/install.sh | bash', { stdio: 'inherit' });
    } catch {
      console.error(chalk.red('Update failed. Run manually: curl -fsSL https://raw.githubusercontent.com/vpontual/veepee-code/main/install.sh | bash'));
    }
    process.exit(0);
  }

  // Run setup wizard on first launch or with --wizard flag
  const forceWizard = process.argv.includes('--wizard');
  if (forceWizard || needsWizard()) {
    await runWizard();
  }

  let config = loadConfig();
  profiler.mark('config loaded');

  // Check for -p / --print mode (non-interactive, output to stdout)
  const printIdx = process.argv.findIndex(a => a === '-p' || a === '--print');
  const printQuery = printIdx >= 0 ? process.argv[printIdx + 1] : null;

  // Discover models — if it fails, offer to run the setup wizard
  let modelManager = new ModelManager(config);
  try {
    await modelManager.discover();
    profiler.mark('models discovered');
  } catch (err) {
    console.error(chalk.red(`Failed to connect to proxy at ${config.proxyUrl}`));
    console.error(chalk.dim((err as Error).message));
    await diagnoseConnection(config.proxyUrl);
    console.error(chalk.hex('#85C7F2')('Running the setup wizard to configure your connection...'));
    console.error('');
    await runWizard();
    config = loadConfig();
    modelManager = new ModelManager(config);
    try {
      await modelManager.discover();
    } catch {
      console.error(chalk.red(`Still cannot connect to proxy at ${config.proxyUrl}`));
      console.error(chalk.dim('Check that Ollama is running and the URL is correct.'));
      process.exit(1);
    }
  }

  const allModels = modelManager.getAllModels();
  if (allModels.length === 0) {
    console.error(chalk.red('No models found on the proxy. Is Ollama running?'));
    await diagnoseConnection(config.proxyUrl);
    console.error(chalk.hex('#85C7F2')('Running the setup wizard to reconfigure...'));
    console.error('');
    await runWizard();
    config = loadConfig();
    modelManager = new ModelManager(config);
    try {
      await modelManager.discover();
    } catch {
      console.error(chalk.red('Still cannot connect. Check your Ollama setup.'));
      process.exit(1);
    }
    const retryModels = modelManager.getAllModels();
    if (retryModels.length === 0) {
      console.error(chalk.red('No models found. Load models with: ollama pull <model>'));
      process.exit(1);
    }
  }

  // Select initial model (may be updated after benchmark)
  let defaultModel = modelManager.selectDefault();
  let defaultProfile = modelManager.getProfile(defaultModel);

  // Register tools — pass IgnoreManager for .veepeignore support and
  // FileTracker for stale-edit detection.
  const ignoreManager = new IgnoreManager(process.cwd());
  const fileTracker = new FileTracker();
  const registry = new ToolRegistry();
  // LSP integration (Phases A-D) — gated on config.lsp. Tools are always
  // registered so users get a helpful "no LSP configured" error instead
  // of "tool not found." See docs/plans/v0.4-lsp.md.
  const lspManager = new LspManager(config.lsp);
  for (const tool of registerCodingTools(ignoreManager, fileTracker, lspManager)) registry.register(tool);
  for (const tool of registerWebTools(config)) registry.register(tool);
  for (const tool of registerDevOpsTools()) registry.register(tool);
  for (const tool of registerLspTools(lspManager)) registry.register(tool);
  profiler.mark('tools registered');

  // Pre-warm any server with warmOnStart=true. Fire-and-forget — we
  // don't want session start to block on LSP init.
  lspManager.warmStart().catch(() => undefined);
  // Clean shutdown on orderly exit (matches MCP cleanup pattern at line ~185).
  // SIGINT goes through the TUI; SIGTERM hits the existing handler below.
  process.on('beforeExit', () => { void lspManager.shutdown(); });

  // Discover remote tools (e.g. from Llama Rider)
  if (config.remote) {
    const localNames = new Set(registry.names());
    const remoteTools = await discoverRemoteTools(config.remote, localNames);
    for (const tool of remoteTools) registry.register(tool);
    if (remoteTools.length > 0) {
      console.error(chalk.dim(`  ${remoteTools.length} remote tools loaded`));
    }
    profiler.mark('remote tools discovered');
  }

  // Connect to configured MCP servers and register their tools. Failures
  // log but don't abort startup — vcode still works without MCP.
  let mcpClients: McpClient[] = [];
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    try {
      const { clients, tools: mcpTools } = await connectMcpServers(config.mcpServers);
      mcpClients = clients;
      const result = registry.registerBatch(mcpTools);
      if (result.registered.length > 0) {
        console.error(chalk.dim(`  ${result.registered.length} MCP tools loaded across ${clients.length} server${clients.length === 1 ? '' : 's'}`));
      }
      if (result.skipped.length > 0) {
        console.error(chalk.dim(`  (${result.skipped.length} MCP tools skipped due to name collision)`));
      }
    } catch (err) {
      console.error(chalk.red('  MCP setup failed:'), err instanceof Error ? err.message : String(err));
    }
  }
  // Clean up child processes on shutdown.
  process.on('beforeExit', () => { void closeMcpClients(mcpClients); });
  profiler.mark('mcp connected');

  // Skills — register the skill_invoke meta-tool ONLY when at least one
  // skill is on disk. Skill bodies stay on disk; only the index is in the
  // tool description. See src/skills.ts for the lazy-load rationale.
  const skillTool = buildSkillInvokeTool();
  if (skillTool) {
    registry.register(skillTool);
    // Count is not exposed by buildSkillInvokeTool — peek via the loader.
    const { loadSkills } = await import('./skills.js');
    const skillCount = loadSkills().length;
    console.error(chalk.dim(`  ${skillCount} skill${skillCount === 1 ? '' : 's'} indexed (lazy-loaded via skill_invoke)`));
  }

  // Initialize permissions with TUI-based prompting
  const permissions = new PermissionManager();

  // Create agent
  const agent = new Agent(config, registry, modelManager, permissions);
  // Register the `task` tool now that subagent manager is available. The
  // tool is intentionally local (not Claude-Code's namespaced "Task" — keep
  // it discoverable via tab-complete and consistent with other vcode tools).
  registry.register(createTaskTool(agent.getSubAgents()));
  // Plan-mode gate. Always registered, but the tool itself enforces that
  // it can only run while agent.getMode() === 'plan'. The model sees it in
  // every mode; tool-pick guidance in the description steers it to plan
  // mode only.
  registry.register(createExitPlanModeTool(agent, permissions));
  // Notebook editing — round-trips cleanly through nbformat instead of
  // letting the model edit raw JSON via edit_file.
  registry.register(createNotebookEditTool());

  // Background-completion notifications. Fires for every subagent
  // transition to a terminal state — foreground completions are already
  // visible inline in the parent's tool result, but Notification hooks
  // may want every event. Background completions get an inline TUI
  // notice so the user doesn't have to manually `/agents output` to find
  // out something finished.
  agent.getSubAgents().setOnTransition((tracked) => {
    const dur = tracked.completedAt && tracked.startedAt
      ? `${tracked.completedAt - tracked.startedAt}ms`
      : '?';
    const statusGlyph =
      tracked.status === 'completed' ? theme.success('✓')
      : tracked.status === 'aborted' ? theme.dim('⊘')
      : theme.error('✗');

    // Inline TUI notification ONLY for background tasks. Foreground tasks
    // already deliver their result via tool_result; printing a duplicate
    // "completed" line would be noise. The `background` flag is set in
    // runTask when run_in_background=true.
    if (tracked.background) {
      tui.showInfo(`${statusGlyph} subagent ${theme.accent(tracked.id)} ${tracked.status} ${theme.dim(`on ${tracked.model}, ${dur}`)} — ${tracked.description}`);
    }

    // Notification hook fires for ALL transitions — foreground and
    // background. Users may want desktop/Telegram alerts on every agent
    // completion regardless of where the result was delivered.
    void (async () => {
      try {
        const { runHooks } = await import('./hooks.js');
        await runHooks('Notification', {
          kind: 'info',
          message: `subagent ${tracked.id} ${tracked.status}: ${tracked.description}`,
        });
      } catch { /* hook subsystem optional; never crash on notify */ }
    })();
  });
  agent.getContext().setRegisteredTools(registry.names());
  agent.getContext().setSystemPrompt(defaultModel);
  if (config.modelStick) agent.setModelStick(true);

  // Capture shell history for context (once on startup, if enabled)
  if (config.shellHistoryContext !== false) {
    agent.getContext().captureShellHistory();
  }

  // Optional observability
  const observability = new ObservabilityManager(config);

  // Initialize sandbox
  const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const sandbox = new SandboxManager(sessionId);
  agent.getContext().setSandboxPath(sandbox.getPathSync());

  // Initialize preview manager
  const preview = new PreviewManager(sandbox);

  // Initialize sync manager (if configured)
  const syncManager = config.sync ? new SyncManager(config.sync.url, config.sync.user, config.sync.pass) : null;

  // Cleanup stale sandbox dirs on startup (>24h old)
  SandboxManager.cleanupStale().catch(() => {});

  // Print mode: run query, output to stdout, exit
  if (printQuery) {
    const jsonSchemaArg = process.argv.find(a => a.startsWith('--json-schema='));
    const jsonSchemaFile = jsonSchemaArg?.split('=')[1];

    profiler.mark('entering print mode');
    profiler.flush();

    // Auto-allow all permissions in print mode
    permissions.setPromptHandler(async () => 'y');
    let output = '';
    for await (const event of agent.run(printQuery)) {
      if (event.type === 'text' && event.content) {
        output += event.content;
        if (!jsonSchemaFile) process.stdout.write(event.content);
      } else if (event.type === 'reset_stream') {
        // Reasoning from orphan </think> was accidentally streamed; drop it.
        if (!jsonSchemaFile && output) {
          // Can't un-write to stdout; insert a clear line to signal reset.
          process.stdout.write('\n');
        }
        output = '';
      } else if (event.type === 'error') {
        // Defense: event.error should be a string but TS can't enforce at
        // runtime. Coerce non-strings so we never write "[object Object]".
        const e: unknown = event.error;
        const errStr = typeof e === 'string' ? e
          : e instanceof Error ? (e.message || e.toString())
          : e && typeof e === 'object' ? (() => { try { return JSON.stringify(e); } catch { return String(e); } })()
          : String(e ?? 'Unknown error');
        process.stderr.write(`Error: ${errStr}\n`);
      }
    }

    // If --json-schema was provided, extract JSON, validate against schema, and output
    if (jsonSchemaFile) {
      try {
        const { readFileSync, existsSync: schemaExists } = await import('fs');
        const { resolve: resolvePath } = await import('path');

        // Extract JSON from the model response
        const jsonMatch = output.match(/```json\s*([\s\S]*?)```/) || output.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : output;
        const parsed = JSON.parse(jsonStr.trim());

        // Load and validate against schema if the file exists
        const schemaPath = resolvePath(jsonSchemaFile);
        if (schemaExists(schemaPath)) {
          const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

          // Lightweight validation: check required fields and types
          const errors: string[] = [];
          if (schema.required && Array.isArray(schema.required)) {
            for (const field of schema.required) {
              if (!(field in parsed)) {
                errors.push(`Missing required field: ${field}`);
              }
            }
          }
          if (schema.properties && typeof schema.properties === 'object') {
            for (const [key, prop] of Object.entries(schema.properties)) {
              if (key in parsed && (prop as { type?: string }).type) {
                const expectedType = (prop as { type: string }).type;
                const actualType = Array.isArray(parsed[key]) ? 'array' : typeof parsed[key];
                if (expectedType !== actualType && !(expectedType === 'integer' && actualType === 'number')) {
                  errors.push(`Field "${key}": expected ${expectedType}, got ${actualType}`);
                }
              }
            }
          }

          if (errors.length > 0) {
            process.stderr.write(`Schema validation warnings:\n${errors.map(e => `  - ${e}`).join('\n')}\n`);
          }
        }

        process.stdout.write(JSON.stringify(parsed, null, 2));
      } catch (err) {
        // If can't parse as JSON, wrap the raw output
        process.stderr.write(`JSON extraction failed: ${(err as Error).message}\n`);
        process.stdout.write(JSON.stringify({ result: output.trim() }));
      }
    }

    process.stdout.write('\n');
    process.exit(0);
  }

  // Parse CLI flags
  const cliPort = process.argv.find(a => a.startsWith('--port='))?.split('=')[1];
  const cliHost = process.argv.find(a => a.startsWith('--host='))?.split('=')[1];

  // Set up RC routes if enabled
  const rcEnabled = !!config.rc?.enabled;
  const apiToken = config.apiToken;
  let rcHandler: ((req: import('http').IncomingMessage, res: import('http').ServerResponse, url: URL) => Promise<boolean>) | undefined;
  let rcInstallPermissions: (() => void) | undefined;
  let rcOnRemoteMessage: ((handler: (message: string, events: AsyncGenerator<import('./agent.js').AgentEvent>) => void) => void) | undefined;
  let rcOnRemoteCommand: ((handler: (message: string) => Promise<void>) => void) | undefined;
  let rcOnSessionChange: ((handler: (sessionId: string, name: string) => void) => void) | undefined;
  let currentSessionId: string | null = null;

  if (rcEnabled) {
    const rc = registerRcRoutes(agent, permissions, preview, parseInt(cliPort || String(config.apiPort), 10), apiToken);
    rcHandler = rc.handleRequest;
    rcInstallPermissions = rc.installPermissionHandler;
    rcOnRemoteMessage = rc.onRemoteMessage;
    rcOnRemoteCommand = rc.onRemoteCommand;
    rcOnSessionChange = rc.onSessionChange;
  }

  // Start API server
  const apiPort = parseInt(cliPort || String(config.apiPort), 10);
  const apiHost = resolveApiHost(cliHost, config.apiHost, rcEnabled);
  const api = startApiServer({
    port: apiPort,
    host: apiHost,
    agent,
    modelManager,
    registry,
    apiToken,
    apiExecute: config.apiExecute,
    rcEnabled,
    rcRequestHandler: rcHandler,
  });

  // Wait a tick for port fallback to resolve, then use actual bound port
  await new Promise(r => setTimeout(r, 50));
  const actualApiPort = api.port;

  // Initialize TUI
  profiler.mark('api server started');
  const tui = new TUI();
  profiler.flush();
  tui.setProgressBar(config.progressBar);
  tui.start({
    model: defaultModel,
    modelSize: defaultProfile?.parameterSize || '',
    toolCount: registry.count(),
    modelCount: allModels.length,
    version: VERSION,
    apiPort: actualApiPort,
    configPath: getConfigPath(),
    proxyUrl: config.proxyUrl,
  });

  // Show initial context stats (system prompt size before any messages)
  tui.updateStats(
    agent.getContext().estimateTokens(),
    Math.round((agent.getContext().estimateTokens() / agent.getContext().getContextLimit()) * 100),
    0,
    0,
  );

  // Poll the API server's live connection count so the status bar can hide
  // the API :port segment when nothing external is actually connected.
  // 2s cadence is plenty — this is a visual hint, not a signal the agent uses.
  const apiPoll = setInterval(() => {
    tui.setApiConnected(api.connectionCount > 0);
  }, 2000);
  tui.setApiConnected(api.connectionCount > 0);
  process.on('beforeExit', () => clearInterval(apiPoll));

  // Check for updates in background (non-blocking)
  setTimeout(() => {
    const update = checkForUpdate();
    if (update?.available) {
      tui.setUpdateAvailable(update.behind);
    }
  }, 0);

  // Probe new models for tool-calling support in background (non-blocking)
  // Only runs for models not yet in the capabilities cache — one cheap test call each
  modelManager.probeNewModels().then(({ updated }) => {
    if (updated.length > 0) {
      tui.showInfo(theme.dim(`  Probed ${updated.length} new model(s) for tool support: ${updated.join(', ')}`));
    }
  }).catch(() => {});

  // Set model list for input completion
  tui.setModelList(allModels);

  // Override permission prompting to use TUI
  permissions.setPromptHandler(async (toolName, args, reason, preview) => {
    return tui.promptPermission(toolName, args, reason, preview);
  });

  // Install RC permission handler (wraps TUI handler, routes to web when RC clients are connected)
  if (rcInstallPermissions) {
    rcInstallPermissions();
  }

  // Wire RC remote messages to TUI — when someone sends from the phone, render it in the terminal too
  if (rcOnRemoteMessage) {
    rcOnRemoteMessage(async (message, events) => {
      tui.addUserMessage(`[RC] ${message}`);
      tui.startStream();
      for await (const event of events) {
        switch (event.type) {
          case 'text':
            if (event.content) tui.appendStream(event.content);
            break;
          case 'tool_call':
            tui.endStream();
            tui.showToolCall(event.name!, event.args || {});
            break;
          case 'tool_result':
            tui.showToolResult(event.name!, event.success!, event.content || event.error || '');
            tui.startStream();
            break;
          case 'hook_output': {
            tui.endStream();
            const layer = event.hookLayer || 'global';
            const ev = event.hookEvent || 'hook';
            const prefix = event.hookBlocked
              ? theme.error(`✗ ${ev} blocked [${layer}]`)
              : theme.dim(`◆ ${ev} [${layer}]`);
            tui.showInfo(`${prefix}\n${event.content || ''}`);
            tui.startStream();
            break;
          }
          case 'thinking':
            tui.showThinking(event.content || '...');
            break;
          case 'reset_stream':
            tui.resetStream();
            break;
          case 'error':
            tui.endStream();
            tui.showError(event.error || 'Unknown error');
            break;
          case 'done':
            tui.endStream();
            tui.showCompletionBadge(modelManager.getCurrentModel(), 0, {
              evalCount: event.evalCount,
              tokensPerSecond: event.tokensPerSecond,
            });
            break;
        }
      }
      await persistTurn();
    });
  }

  // Wire Tab → show tools (without going through the input pipeline)
  tui.onTabTools = () => {
    const tools = registry.list().sort((a, b) => a.name.localeCompare(b.name));
    const lines = tools.map(t =>
      `  ${theme.accent(t.name.padEnd(20))} ${theme.muted(t.description.slice(0, 60))}`
    );
    tui.showInfo(`${theme.textBold(`${tools.length} tools:`)}\n${lines.join('\n')}`);
  };

  // Wire Ctrl+C abort
  tui.setAbortHandler(() => agent.abort());
  tui.setClearHandler(() => {
    agent.clear();
    permissions.resetSession();
    tui.showInfo(theme.warning('Conversation cleared.'));
  });
  // /clear typed mid-run: abort + wipe history in one gesture.
  tui.setClearOnRunHandler(() => {
    agent.abort();
    agent.clear();
    permissions.resetSession();
    tui.showInfo(theme.warning('Stopped and cleared.'));
  });

  // Lock mode: no benchmark, no roster — the locked model is the one and only.
  // Skip the first-launch benchmark that would otherwise fire against every
  // model on the proxy (wasteful; ranking is meaningless with one candidate).
  const benchmarker = config.lockModel ? null : new Benchmarker(config.proxyUrl, config.fleet);
  const existingRoster = benchmarker ? await benchmarker.loadRoster() : null;
  if (config.lockModel) {
    // Locked — skip benchmark silently. Status bar already shows "locked".
  } else if (!existingRoster) {
    tui.showInfo(`${theme.accent('⚡ First launch')} — testing all your models to find the best for each role.`);
    tui.showInfo(theme.dim('Phase 1: Quick responsiveness check on all models'));
    tui.showInfo(theme.dim('Phase 2: Full benchmark on models fast enough for interactive use'));
    tui.showInfo(theme.dim('Phase 3: Assign best model per role (act, plan, chat, code, search)'));
    tui.showInfo('');

    try {
      const { results, roster } = await benchmarker!.smartBenchmark(allModels, (phase, detail) => {
        // Update progress in TUI — overwrite last line if same phase
        const msgs = tui['messages'] as Array<{ role: string; content: string }>;
        const lastIdx = msgs.length - 1;
        const prefix = phase === 'speed-check' ? '🔍' : phase === 'benchmark' ? '📊' : phase === 'done' ? '✓' : '⚡';
        const line = `${prefix} ${detail}`;

        if (lastIdx >= 0 && (msgs[lastIdx].content.startsWith('🔍') || msgs[lastIdx].content.startsWith('📊') || msgs[lastIdx].content.startsWith('[')) && phase !== 'done') {
          msgs[lastIdx].content = line;
        } else {
          tui.showInfo(line);
        }
        tui.render();
      });

      tui.showInfo('');
      if (results.length > 0) {
        tui.showInfo(`${theme.success('✓ Benchmark complete')} — ${results.length} models ranked`);
        tui.showInfo('');
        for (const r of results.slice(0, 8)) {
          tui.showInfo(`  ${theme.accent(r.model.padEnd(30))} ${String(r.overall).padStart(3)}/100  ${r.performance.tokensPerSecond} tok/s`);
        }
        tui.showInfo('');
        tui.showInfo(Benchmarker.formatRoster(roster));

        // Apply roster — use act model as default (only if user hasn't set an explicit preference)
        if (roster.act && !config.model) {
          const profile = modelManager.getProfile(roster.act);
          if (profile) {
            defaultModel = roster.act;
            defaultProfile = profile;
            agent.setModel(defaultModel);
            tui.updateModel(defaultModel, defaultProfile.parameterSize, 'Act');
          }
        }
      }
    } catch (err) {
      tui.showInfo(theme.dim(`Benchmark failed: ${(err as Error).message}. Run /benchmark later.`));
    }
    tui.showInfo('');
  } else {
    // Roster exists — apply it (only if user hasn't set an explicit preference)
    if (existingRoster.act && !config.model) {
      const profile = modelManager.getProfile(existingRoster.act);
      if (profile) {
        defaultModel = existingRoster.act;
        defaultProfile = profile;
        agent.setModel(defaultModel);
        tui.updateModel(defaultModel, defaultProfile.parameterSize, 'Act');
      }
    }
  }

  // First-run onboarding: show what makes VEEPEE Code different
  // Skip the benchmark-themed welcome for locked users — it would advertise
  // features (multi-model roster, auto-switch) that don't apply when locked.
  const isFirstRun = !existingRoster && !config.lockModel;
  if (isFirstRun) {
    tui.showInfo([
      '',
      `${theme.accent('Welcome to VEEPEE Code')} — your local AI coding assistant.`,
      '',
      `  ${theme.dim('What makes this different:')}`,
      `  ${theme.success('●')} ${theme.textBold('Local-first')} — your models, your hardware, your data`,
      `  ${theme.success('●')} ${theme.textBold('Benchmarked')} — auto-ranked model roster per role (act/plan/chat/code/search)`,
      `  ${theme.success('●')} ${theme.textBold('${registry.count()} tools')} — coding, web, devops, home, social, news`,
      `  ${theme.success('●')} ${theme.textBold('Multi-agent')} — MoE mode, sub-agents on lighter models`,
      '',
      `  ${theme.dim('Connect other tools to VEEPEE Code:')}`,
      `  ${theme.accent('Claude Code:')} CLAUDE_CODE_USE_BEDROCK=0 claude --model openai/MODEL --api-base http://localhost:${actualApiPort}/v1`,
      `  ${theme.accent('OpenCode:')}   Set provider URL to http://localhost:${actualApiPort}/v1`,
      '',
      `  ${theme.dim('Quick start:')}`,
      `  ${theme.accent('/plan')}   ${theme.dim('Think through a problem before coding')}`,
      `  ${theme.accent('/setup')}  ${theme.dim('Check which integrations are active')}`,
      `  ${theme.accent('/help')}   ${theme.dim('See all commands')}`,
      `  ${theme.accent('Ctrl+P')} ${theme.dim('Open command palette')}`,
      '',
      `  ${theme.dim('Update anytime:')} ${theme.accent('vcode --update')}`,
      '',
    ].join('\n'));

    // Auto-run setup check on first launch
    tui.showInfo(theme.dim('Checking integrations...'));
    try {
      const setupResults = await validateIntegrations(config);
      const active = setupResults.filter(r => r.status === 'active').length;
      const total = setupResults.length;
      const missing = setupResults.filter(r => r.status === 'missing_config');
      tui.showInfo(`  ${theme.success(`${active}/${total} integrations active`)}${missing.length > 0 ? theme.dim(` | ${missing.length} need config — run /setup for details`) : ''}`);
    } catch {
      tui.showInfo(theme.dim('  Setup check skipped.'));
    }
    tui.showInfo('');
  }

  // Hook trust prompt — shows on every launch (not just first run) when the
  // project has hooks but we haven't decided yet. Quick warning, never blocks.
  {
    const { projectHasHooks, getProjectTrustState } = await import('./hooks.js');
    const trust = getProjectTrustState(process.cwd());
    if (trust === 'unknown' && projectHasHooks(process.cwd())) {
      tui.showInfo([
        '',
        `${theme.warning('⚠ This project defines hooks')} (.veepee/settings.json)`,
        `  Hooks run shell commands at lifecycle events (PreToolUse, PostToolUse, etc.).`,
        `  They will ${theme.error('not run')} until you trust this project.`,
        `  ${theme.accent('/hooks')}        — review what's configured`,
        `  ${theme.accent('/hooks trust')}  — allow them`,
        `  ${theme.accent('/hooks deny')}   — block them (silences this prompt)`,
        '',
      ].join('\n'));
    }
  }
  // Handle --resume / -c CLI arguments
  const continueFlag = process.argv.includes('-c') || process.argv.includes('--continue');
  const resumeArg = process.argv.find(a => a === '--resume' || a.startsWith('--resume='));
  if (resumeArg) {
    const query = resumeArg.includes('=') ? resumeArg.split('=')[1] : process.argv[process.argv.indexOf('--resume') + 1];
    if (query) {
      const session = await findSession(query);
      if (session) {
        // Restore knowledge state if available
        if (session.knowledgeState) {
          const savedKs = await KnowledgeState.load(session.id);
          if (savedKs) {
            agent.getContext().setKnowledgeState(savedKs);
          }
        }

        // Only restore recent messages (sliding window)
        const recentMessages = session.messages.slice(-6);
        for (const msg of recentMessages) {
          if (msg.role === 'user') {
            agent.getContext().addUser(msg.content || '');
            tui.addUserMessage(msg.content || '');
          } else if (msg.role === 'assistant') {
            agent.getContext().addAssistant(msg.content || '');
            tui.showInfo(msg.content || '');
          }
        }
        currentSessionId = session.id;
        if (session.model) {
          const profile = modelManager.getProfile(session.model);
          if (profile) agent.setModel(session.model);
        }
        tui.showInfo(`${theme.success('Resumed session:')} ${theme.accent(session.name)} (${session.messageCount} messages, knowledge state restored)`);
      } else {
        tui.showInfo(`${theme.error('Session not found:')} ${query}`);
      }
    }
  }

  // -c / --continue: resume the most recent session
  if (continueFlag && !currentSessionId) {
    const sessions = await listSessions();
    if (sessions.length > 0) {
      const session = sessions[0]; // newest first
      if (session.knowledgeState) {
        const savedKs = await KnowledgeState.load(session.id);
        if (savedKs) agent.getContext().setKnowledgeState(savedKs);
      }
      const recentMessages = session.messages.slice(-6);
      for (const msg of recentMessages) {
        if (msg.role === 'user') {
          agent.getContext().addUser(msg.content || '');
          tui.addUserMessage(msg.content || '');
        } else if (msg.role === 'assistant') {
          agent.getContext().addAssistant(msg.content || '');
          tui.showInfo(msg.content || '');
        }
      }
      currentSessionId = session.id;
      if (session.model) {
        const profile = modelManager.getProfile(session.model);
        if (profile) {
          agent.setModel(session.model);
          tui.updateModel(session.model);
        }
      }
      tui.showInfo(`${theme.success('Continued:')} ${theme.accent(session.name)} (${session.messageCount} messages)`);
    } else {
      tui.showInfo(theme.dim('No sessions to continue.'));
    }
  }

  // Auto-resume: if no session was explicitly requested, check if there's a saved session for this cwd
  if (!currentSessionId && !continueFlag && !resumeArg) {
    const proj = await getProjectSession(process.cwd());
    if (proj) {
      const session = await findSession(proj.sessionId);
      if (session) {
        if (session.knowledgeState) {
          const savedKs = await KnowledgeState.load(session.id);
          if (savedKs) agent.getContext().setKnowledgeState(savedKs);
        }
        const recentMessages = session.messages.slice(-6);
        for (const msg of recentMessages) {
          if (msg.role === 'user') {
            agent.getContext().addUser(msg.content || '');
            tui.addUserMessage(msg.content || '');
          } else if (msg.role === 'assistant') {
            agent.getContext().addAssistant(msg.content || '');
            tui.showInfo(msg.content || '');
          } else if (msg.role === 'tool') {
            agent.getContext().addToolResult('resumed', msg.content || '');
          }
        }
        currentSessionId = session.id;
        if (session.model) {
          const profile = modelManager.getProfile(session.model);
          if (profile) {
            agent.setModel(session.model);
            tui.updateModel(session.model);
          }
        }
        tui.showInfo(`${theme.success('Auto-resumed:')} ${theme.accent(session.name)} ${theme.dim('(project session)')}`);
      }
    }
  }

  // Main loop
  let sessionStart = Date.now();

  async function persistTurn(): Promise<void> {
    if (!config.useJsonlSessions) return;
    try {
      const result = await autoAppendJsonlTurn({
        currentSessionId,
        cwd: process.cwd(),
        model: modelManager.getCurrentModel(),
        mode: agent.getMode(),
        messages: agent.getContext().getAllMessages(),
        knowledgeState: agent.getContext().getKnowledgeState().getData(),
      });
      if (result && currentSessionId !== result.id) {
        currentSessionId = result.id;
        await setProjectSession(process.cwd(), result.id, result.name);
      }
    } catch {
      // Manual /save remains available if best-effort auto-save fails.
    }
  }

  if (rcOnSessionChange) {
    rcOnSessionChange((sessionId, name) => {
      currentSessionId = sessionId;
      setProjectSession(process.cwd(), sessionId, name).catch(() => {});
    });
  }

  while (true) {
    // Update stats
    tui.updateStats(
      agent.getContext().estimateTokens(),
      Math.round((agent.getContext().estimateTokens() / agent.getContext().getContextLimit()) * 100),
      agent.getContext().messageCount(),
      Date.now() - sessionStart,
    );

    // Drain any follow-up messages queued during the previous turn before
    // soliciting new input. One-at-a-time delivery: pull the oldest pending,
    // run it as a turn, and loop back. The remaining queue is drained on
    // subsequent iterations.
    let input: string;
    const followUps = tui.peekPending().followUp > 0 ? tui.takeFollowUp() : [];
    if (followUps.length > 0) {
      // Process the oldest first; re-queue the rest so they go through the
      // same intake path on the next iteration (preserves order, lets the
      // user see/cancel each before it fires).
      input = followUps[0];
      // Re-queue any remaining follow-ups so the next loop iteration picks
      // them up the same way (preserves "one-at-a-time" semantics).
      for (let i = 1; i < followUps.length; i++) {
        tui.queueFollowUp(followUps[i]);
      }
      tui.showInfo(theme.dim(`◆ Delivering queued follow-up: ${input.slice(0, 80)}${input.length > 80 ? '…' : ''}`));
    } else {
      try {
        input = await tui.getInput();
      } catch {
        // EOF / Ctrl+D
        break;
      }
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    // Agent turn — used for both normal input and for commands like /review
    // that want to run a one-off turn under a different model.
    const runTurn = async (text: string): Promise<void> => {
      tui.addUserMessage(text);
      const turnStart = Date.now();
      const refreshStats = () => tui.updateStats(
        agent.getContext().estimateTokens(),
        Math.round((agent.getContext().estimateTokens() / agent.getContext().getContextLimit()) * 100),
        agent.getContext().messageCount(),
        Date.now() - sessionStart,
      );

      tui.startStream();

      let turnAssistantContent = '';
      const turnToolCalls: Array<{ name: string; success: boolean }> = [];

      for await (const event of agent.run(text, {
        onTurnBoundary: () => tui.takeSteering(),
      })) {
        switch (event.type) {
          case 'text':
            if (event.content) {
              tui.appendStream(event.content);
              turnAssistantContent += event.content;
            }
            break;

          case 'tool_call':
            tui.endStream();
            tui.showToolCall(event.name!, event.args || {});
            break;

          case 'tool_result':
            tui.showToolResult(event.name!, event.success!, event.content || event.error || '');
            turnToolCalls.push({ name: event.name!, success: event.success! });
            refreshStats();
            tui.startStream();
            break;

          case 'permission_denied':
            tui.showPermissionDenied(event.name!);
            break;

          case 'hook_output': {
            // Render hook output as a system message. Blocked hooks (PreToolUse
            // returning non-zero) get a more prominent treatment so users
            // notice the abort. Layer is shown to make trust attribution clear.
            tui.endStream();
            const layer = event.hookLayer || 'global';
            const ev = event.hookEvent || 'hook';
            const prefix = event.hookBlocked
              ? theme.error(`✗ ${ev} blocked [${layer}]`)
              : theme.dim(`◆ ${ev} [${layer}]`);
            tui.showInfo(`${prefix}\n${event.content || ''}`);
            tui.startStream();
            break;
          }

          case 'model_switch':
            tui.showModelSwitch(event.from!, event.to!);
            tui.updateModel(event.to!);
            break;

          case 'thinking':
            tui.showThinking(event.content || '...');
            break;

          case 'reset_stream':
            // Model emitted reasoning as plain content then closed with a bare
            // </think>. Clear what's already been streamed; a 'thinking' event
            // will follow with the reasoning, and 'text' events resume with the
            // real answer.
            tui.resetStream();
            turnAssistantContent = '';
            break;

          case 'error':
            tui.endStream();
            tui.showError(event.error || 'Unknown error');
            break;

          case 'done':
            tui.endStream();
            refreshStats();
            tui.showCompletionBadge(modelManager.getCurrentModel(), Date.now() - turnStart, {
              evalCount: event.evalCount,
              promptEvalCount: event.promptEvalCount,
              tokensPerSecond: event.tokensPerSecond,
            });
            if (observability.isEnabled()) {
              observability.logTurn({
                sessionId: currentSessionId || sessionId,
                model: modelManager.getCurrentModel(),
                mode: agent.getMode(),
                userMessage: text,
                assistantMessage: turnAssistantContent,
                evalCount: event.evalCount || 0,
                promptEvalCount: event.promptEvalCount || 0,
                tokensPerSecond: event.tokensPerSecond || 0,
                latencyMs: Date.now() - turnStart,
                toolCalls: turnToolCalls,
              }).catch(() => {});
            }
            break;
        }
      }

      tui.updateStats(
        agent.getContext().estimateTokens(),
        Math.round((agent.getContext().estimateTokens() / agent.getContext().getContextLimit()) * 100),
        agent.getContext().messageCount(),
        Date.now() - sessionStart,
      );

      await persistTurn();
    };

    if (rcOnRemoteCommand) {
      rcOnRemoteCommand(async (message) => {
        tui.addCommandMessage(`[RC] ${message}`);
        const result = await handleCommand(message, tui, agent, modelManager, registry, permissions, config, actualApiPort, currentSessionId, sandbox, preview, syncManager, lspManager, runTurn);
        if (typeof result === 'string' && result.startsWith('session:')) {
          currentSessionId = result.slice(8) || null;
        }
      });
    }

    // Inline bash. `!!cmd` runs silently (output shown but not sent to LLM);
    // `!cmd` runs and forwards captured output to the LLM as the next user
    // message. `! cmd` (with space) is treated as prose and falls through.
    {
      const bang = parseBang(trimmed);
      if (bang.kind === 'silent') {
        if (bang.cmd) {
          tui.addCommandMessage(trimmed);
          const result = runInlineShell(bang.cmd);
          if (result.output) {
            tui.showInfo(result.ok ? result.output : theme.error(`Exit ${result.exitCode}: ${result.output}`));
          } else {
            tui.showInfo(theme.dim('(no output)'));
          }
        }
        continue;
      }
      if (bang.kind === 'send') {
        if (bang.cmd) {
          tui.addCommandMessage(trimmed);
          const result = runInlineShell(bang.cmd);
          if (result.output) {
            tui.showInfo(result.ok ? result.output : theme.error(`Exit ${result.exitCode}: ${result.output}`));
          } else {
            tui.showInfo(theme.dim('(no output)'));
          }
          await runTurn(formatShellForLlm(bang.cmd, result));
        }
        continue;
      }
    }

    // Handle commands
    if (trimmed.startsWith('/')) {
      // Show the command in the chat (but don't start the turn tracker — commands don't go to the LLM)
      tui.addCommandMessage(trimmed);
      const result = await handleCommand(trimmed, tui, agent, modelManager, registry, permissions, config, actualApiPort, currentSessionId, sandbox, preview, syncManager, lspManager, runTurn);
      if (result === true) break; // quit
      if (typeof result === 'string' && result.startsWith('session:')) {
        currentSessionId = result.slice(8) || null;
      }
      continue;
    }

    // Run agent
    await runTurn(trimmed);

  }

  // Cleanup
  preview.stopServer();
  if (await sandbox.hasFiles()) {
    tui.showInfo(theme.warning('Sandbox has files. Cleaning up...'));
    const files = await sandbox.list();
    for (const f of files) {
      tui.showInfo(theme.dim(`  Removed: ${f.name} (${formatSize(f.size)})`));
    }
  }
  await sandbox.clean();
  api.close();
  tui.stop();
  process.exit(0);
}

// ─── Connection Diagnostics ───────────────────────────────────────────────────

async function diagnoseConnection(proxyUrl: string): Promise<void> {
  const url = new URL(proxyUrl);
  const host = url.hostname;
  const tagsUrl = `${proxyUrl}/api/tags`;

  console.error(chalk.hex('#85C7F2')('\nRunning connection diagnostics...\n'));

  // Test 1: Network reachability (ping)
  try {
    execSync(`ping -c 1 -W 2 ${host}`, { stdio: 'pipe', timeout: 5000 });
    console.error(chalk.green(`  ✓ Host ${host} is reachable (ping)`));
  } catch {
    console.error(chalk.red(`  ✗ Host ${host} is not reachable (ping failed)`));
    console.error(chalk.dim('    Check your network connection, VPN, or WireGuard tunnel'));
    return;
  }

  // Test 2: Port reachability (curl)
  try {
    execSync(`curl -s --connect-timeout 3 ${tagsUrl} > /dev/null`, { stdio: 'pipe', timeout: 5000 });
    console.error(chalk.green(`  ✓ Ollama API responds (curl)`));
  } catch {
    console.error(chalk.red(`  ✗ Ollama API not responding at ${tagsUrl}`));
    console.error(chalk.dim(`    Host is reachable but port ${url.port || 80} is not — is Ollama running?`));
    return;
  }

  // Test 3: Node.js fetch (the actual method vcode uses)
  try {
    const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(5000) });
    const data = await res.json() as { models?: unknown[] };
    const count = data.models?.length || 0;
    console.error(chalk.green(`  ✓ Node.js fetch works (${count} models)`));
  } catch (err: any) {
    console.error(chalk.red(`  ✗ Node.js fetch failed: ${err.message}`));

    // Test 4: IPv4 vs IPv6
    const { setDefaultResultOrder } = await import('dns');
    const origOrder = dns.getDefaultResultOrder();
    try {
      setDefaultResultOrder('ipv4first');
      const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(5000) });
      const data = await res.json() as { models?: unknown[] };
      const count = data.models?.length || 0;
      console.error(chalk.yellow(`  ⚠ Works with IPv4 forced (${count} models) — IPv6 issue detected`));
      console.error(chalk.dim('    This has been auto-fixed for this session.'));
      // Already set ipv4first at top of file, so this is informational
    } catch {
      console.error(chalk.red('  ✗ Still fails with IPv4 forced'));
      console.error(chalk.dim('    Node.js networking issue — try: node -e "fetch(\'' + tagsUrl + '\').then(r=>r.text()).then(console.log).catch(console.error)"'));
    } finally {
      setDefaultResultOrder(origOrder);
    }
  }

  console.error('');
}

// ─── Shell Escape ─────────────────────────────────────────────────────────────

/** Project a JsonlSession's active path into the TreeView item shape. Pure
 *  data transform — knows nothing about React/Ink, just renders previews
 *  and attaches label metadata. Lives here (not in sessions/jsonl.ts) so
 *  the storage module stays free of TUI types. */
function buildTreeViewItems(j: import('./sessions/jsonl.js').JsonlSession): import('./tui/types.js').TreeViewItem[] {
  const path = j.getActivePath();
  const labels = j.getLabelsOnPath();
  const leafId = j.getLeafId();
  const out: import('./tui/types.js').TreeViewItem[] = [];
  path.forEach((e, idx) => {
    const labelEntries = labels.get(e.id) ?? [];
    const labelNames = labelEntries.map(l => l.name);
    const isLeaf = e.id === leafId;
    let preview = '';
    let role: string | undefined;
    if (e.type === 'message') {
      const me = e as { role: string; content: string };
      role = me.role;
      preview = (me.content || '').replace(/\n/g, ' ').slice(0, 80);
    } else if (e.type === 'meta') {
      preview = (e as { name: string }).name;
    } else if (e.type === 'compaction') {
      preview = (e as { summary: string }).summary.slice(0, 80);
    } else if (e.type === 'label') {
      preview = (e as { name: string }).name;
    } else if (e.type === 'model_change') {
      const c = e as { from: string; to: string };
      preview = `${c.from} → ${c.to}`;
    } else if (e.type === 'mode_change') {
      const c = e as { from: string; to: string };
      preview = `${c.from} → ${c.to}`;
    } else if (e.type === 'custom') {
      preview = `(${(e as { namespace: string }).namespace})`;
    }
    out.push({
      id: e.id,
      pathIndex: idx,
      type: e.type as import('./tui/types.js').TreeViewItem['type'],
      preview,
      role,
      isLeaf,
      labels: labelNames,
    });
  });
  return out;
}

async function runShellCommand(cmd: string, tui: TUI): Promise<void> {
  try {
    const output = execSync(cmd, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = output.trim();
    tui.showInfo(result || theme.dim('(no output)'));
  } catch (err: any) {
    const stderr = err.stderr?.trim() || '';
    const stdout = err.stdout?.trim() || '';
    const output = stderr || stdout || err.message;
    tui.showInfo(theme.error(`Exit ${err.status ?? 1}: ${output}`));
  }
}

async function runShellMode(tui: TUI): Promise<void> {
  tui.showInfo([
    theme.textBold('Shell mode') + theme.dim(' — type commands, they run in your terminal'),
    theme.dim('Type "exit" or press Ctrl+C to return to VEEPEE Code'),
  ].join('\n'));

  while (true) {
    const input = await tui.getInput('$ ');
    const trimmed = input.trim();
    if (!trimmed) continue;
    if (trimmed === 'exit' || trimmed === 'quit') {
      tui.showInfo(theme.dim('Back to VEEPEE Code'));
      return;
    }
    tui.addCommandMessage(`$ ${trimmed}`);
    await runShellCommand(trimmed, tui);
  }
}

async function handleCommand(
  input: string,
  tui: TUI,
  agent: Agent,
  modelManager: ModelManager,
  registry: ToolRegistry,
  permissions: PermissionManager,
  config: ReturnType<typeof loadConfig>,
  apiPort: number,
  currentSessionId: string | null,
  sandbox: SandboxManager,
  preview: PreviewManager,
  syncManager: SyncManager | null,
  lspManager: LspManager,
  runTurn: (text: string) => Promise<void>,
): Promise<boolean | string | void> {
  // Returns: true = quit, 'session:<id>' = set session ID, void = continue
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // User-defined slash commands (markdown files in ~/.veepee-code/commands/
  // or .veepee/commands/) take precedence over the hardcoded ones below
  // when there's a name conflict — lets users override defaults locally.
  if (cmd.length > 1) {
    const userCmdName = cmd.slice(1); // strip leading '/'
    const { findUserCommand, expandCommand } = await import('./user-commands.js');
    const userCmd = findUserCommand(userCmdName);
    if (userCmd) {
      const argString = input.slice(parts[0].length).trim();
      const expanded = expandCommand(userCmd, argString);
      tui.showInfo(theme.dim(`◆ /${userCmd.name} [${userCmd.source}]`));
      await runTurn(expanded);
      return false;
    }
  }

  switch (cmd) {
    case '/quit':
    case '/exit':
    case '/q':
      return true;

    case '/help':
      tui.showInfo([
        '',
        `${theme.textBold('Commands:')}`,
        `  ${theme.accent('/model <name>')}     Switch model       ${theme.accent('/models')}     List all models`,
        `  ${theme.accent('/model auto')}       Auto-switch on     ${theme.accent('/tools')}      List all tools`,
        `  ${theme.accent('/review <prompt>')}  Run one turn through reviewModel (different-family second opinion)`,
        `  ${theme.accent('/clear')}            Clear history      ${theme.accent('/compact')}    Free context space`,
        `  ${theme.accent('/stop')}             ${theme.dim('Type while agent runs to interrupt (same as Ctrl+C). /clear also stops + wipes.')}`,
        `  ${theme.accent('/status')}           Session info       ${theme.accent('/quit')}       Exit`,
        `  ${theme.accent('/init')}             Create VEEPEE.md    ${theme.accent('/setup')}       Validate tools`,
        `  ${theme.accent('/save [name]')}      Save session        ${theme.accent('/sessions')}    List saved sessions`,
        `  ${theme.accent('/resume <name>')}    Resume a session    ${theme.accent('/rename <name>')} Rename session`,
        `  ${theme.accent('/fork [name]')}      Fork current session ${theme.accent('/projects')}    List tracked projects`,
        `  ${theme.accent('/add-dir <path>')}   Add working dir     ${theme.accent('/worktree')}     Git worktree isolation`,
        `  ${theme.accent('/ralph <task>')}      Work→Review loop    ${theme.dim('/ralph --max <n> <task>')}`,
        `  ${theme.accent('/effort low|med|hi')} Set response depth  ${theme.accent('/settings')}    View/toggle settings`,
        '',
        `${theme.textBold('Output styles:')}`,
        `  ${theme.accent('/output-style')}      List available styles (default / explanatory / learning + custom)`,
        `  ${theme.accent('/output-style <name>')} Activate a style — overlays the system prompt`,
        `  ${theme.dim('  Drop ~/.veepee-code/output-styles/<name>.md or .veepee/output-styles/<name>.md to add custom.')}`,
        '',
        `${theme.textBold('Statusline customization:')}`,
        `  ${theme.dim('  Drop ~/.veepee-code/statusline.sh (executable). Receives state JSON on stdin, output replaces the right-aligned status.')}`,
        `  ${theme.dim('  State: { model, mode, tokens, tokenPercent, cwd, apiPort, apiConnected, version }. Cached 30s.')}`,
        '',
        `${theme.textBold('@file mentions:')}`,
        `  ${theme.dim('  Type @<partial> in input + Tab to complete file paths.')}`,
        `  ${theme.dim('  Submit with @path/to/file.ts to attach file content.')}`,
        `  ${theme.dim('  Image extensions (png/jpg/etc.) auto-attach as base64 to vision-capable models.')}`,
        '',
        `${theme.textBold('User commands (drop markdown files to add slash commands):')}`,
        `  ${theme.dim('  Global:  ~/.veepee-code/commands/<name>.md')}`,
        `  ${theme.dim('  Project: .veepee/commands/<name>.md  (overrides global by name)')}`,
        `  ${theme.dim('  Frontmatter: description, argument-hint. Body is the prompt template.')}`,
        `  ${theme.dim('  Substitutions: $1, $2, ... $9 for positional args; $ARGUMENTS / $@ for the full string.')}`,
        '',
        `${theme.textBold('Skills (lazy-loaded knowledge, fetched on demand by the model):')}`,
        `  ${theme.accent('/skills')}            List indexed skills`,
        `  ${theme.dim('  Drop markdown in ~/.veepee-code/skills/ (global) or .veepee/skills/ (project).')}`,
        `  ${theme.dim('  Frontmatter: name, description, tags?, allowed-tools?, model?. Body is the skill content.')}`,
        `  ${theme.dim('  Skills are NOT in the system prompt — only the index. Model calls skill_invoke to fetch.')}`,
        '',
        `${theme.textBold('MCP servers (Model Context Protocol):')}`,
        `  ${theme.accent('/mcp')}               List configured servers and tool counts`,
        `  ${theme.dim('  Configure in settings.json mcpServers: { name: { command, args } } or { url }.')}`,
        `  ${theme.dim('  Tools registered as mcp__<server>__<tool>; per-server allow list supported.')}`,
        '',
        `${theme.textBold('Health and configuration:')}`,
        `  ${theme.accent('/doctor')}           Audit env (proxy, fleet, LSP, hooks, MCP, CLI tools)`,
        `  ${theme.accent('/doctor fix')}       Apply available auto-fixes`,
        `  ${theme.accent('/extras')}           List language bundles (LSP + formatter hook + prompt hints)`,
        `  ${theme.accent('/extras add typescript')}     Install one`,
        '',
        `${theme.textBold('Language Server Protocol (LSP):')}`,
        `  ${theme.accent('/lsp')}              List configured LSP servers and live status`,
        `  ${theme.dim('  Tools: lsp_diagnostics, lsp_references, lsp_definition, lsp_restart.')}`,
        `  ${theme.dim('  Configure under "lsp" in settings.json. See docs/plans/v0.4-lsp.md.')}`,
        '',
        `${theme.textBold('Hooks (run shell commands at lifecycle events):')}`,
        `  ${theme.accent('/hooks')}            Show configured hooks   ${theme.accent('/hooks trust')}  Trust this project`,
        `  ${theme.accent('/hooks deny')}        Block project hooks`,
        `  ${theme.dim('  Configure in ~/.veepee-code/settings.json (global) or .veepee/settings.json (project, requires trust).')}`,
        `  ${theme.dim('  Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification.')}`,
        '',
        `${theme.textBold('Modes:')}`,
        `  ${theme.accent('/plan')}   Plan mode — thinking ON, mutating tools BLOCKED until exit_plan_mode approved`,
        `  ${theme.accent('/act')}    Act mode  — thinking OFF, all tools, auto-switch (default)`,
        `  ${theme.accent('/chat')}   Chat mode — fast model, web search only, no file access`,
        `  ${theme.accent('/moe')}    Mixture of Experts — 3 models discuss your question`,
        `  ${theme.dim('  /moe debate | /moe vote | /moe fastest | /moe (auto-detects)')}`,
        `  ${theme.dim('  Plan auto-activates on "plan", "think through", "design", etc.')}`,
        '',
        `${theme.textBold('Benchmark:')}`,
        `  ${theme.accent('/benchmark')}        Benchmark all      ${theme.accent('/benchmark heavy')}  Heavy only`,
        `  ${theme.accent('/benchmark results')} Show results      ${theme.accent('/benchmark context')} Probe context sizes`,
        '',
        `${theme.textBold('Shell:')}`,
        `  ${theme.accent('!<command>')}        Run shell command   ${theme.accent('/shell')}         Interactive shell mode`,
        '',
        `${theme.textBold('Sandbox & Preview:')}`,
        `  ${theme.accent('/sandbox')}          List files        ${theme.accent('/sandbox keep <f>')} Move file out`,
        `  ${theme.accent('/preview <file>')}   Preview/run       ${theme.accent('/preview stop')}     Stop server`,
        `  ${theme.accent('/run <file>')}       Run script        ${theme.accent('/sandbox clean')}    Clean sandbox`,
        '',
        `${theme.textBold('Sync & Remote:')}`,
        `  ${theme.accent('/sync push [all]')} Push sessions     ${theme.accent('/sync pull')}    Pull sessions`,
        `  ${theme.accent('/sync auto')}       Toggle auto-sync  ${theme.accent('/sync status')}  Show config`,
        `  ${theme.accent('/rc')}              Remote Connect    ${theme.accent('/rc qr')}        Show URL`,
        '',
        `${theme.textBold('Keys:')}`,
        `  ${theme.dim('Enter')} submit  ${theme.dim('Shift+Enter')} newline  ${theme.dim('Tab')} tools  ${theme.dim('Ctrl+P')} commands  ${theme.dim('Ctrl+C')} interrupt`,
        `  ${theme.dim('Ctrl+L')} clear  ${theme.dim('Ctrl+D')} quit  ${theme.dim('Up/Down')} prompt history  ${theme.dim('Ctrl+Y')} copy last response`,
        '',
        `${theme.textBold('Scroll the chat:')}`,
        `  ${theme.dim('Trackpad / mouse wheel')}     Scroll by 3 lines per tick`,
        `  ${theme.dim('Shift+Up / Shift+Down')}      Scroll by 3 lines (also Ctrl+Up/Down)`,
        `  ${theme.dim('PgUp / PgDn')}                Scroll by 10 lines`,
        `  ${theme.dim('Ctrl+Home / Ctrl+End')}       Jump to top / bottom`,
        `  ${theme.dim('Click+drag')}                 Native text selection (terminal handles it)`,
      ].join('\n'));
      return false;

    case '/clear':
      agent.clear();
      permissions.resetSession();
      tui.showInfo('Conversation cleared.');
      return false;

    case '/stop':
      // Mid-run /stop is intercepted by the TUI before reaching here. This
      // path runs only when the user typed /stop between turns — explain
      // the gesture so they discover it.
      tui.showInfo([
        theme.dim('Nothing to stop — no agent is running.'),
        '',
        'Mid-run interrupts:',
        `  ${theme.accent('Ctrl+C')}    Abort the current turn`,
        `  ${theme.accent('/stop⏎')}    Type while agent is running — same as Ctrl+C`,
        `  ${theme.accent('/clear⏎')}   Stop and wipe conversation history in one gesture`,
      ].join('\n'));
      return false;

    case '/effort': {
      const level = parts[1]?.toLowerCase();
      if (!level || !['low', 'medium', 'high'].includes(level)) {
        const current = agent.getEffort();
        tui.showInfo([
          `${theme.textBold('Effort:')} ${theme.accent(current)}`,
          `  ${theme.dim('low')}    — fast, short responses (256 tok, temp 0.3)`,
          `  ${theme.dim('medium')} — balanced (1024 tok, temp 0.5) [default]`,
          `  ${theme.dim('high')}   — thorough, detailed (4096 tok, temp 0.7)`,
          '',
          `  Usage: /effort low|medium|high`,
        ].join('\n'));
        return false;
      }
      agent.setEffort(level as 'low' | 'medium' | 'high');
      tui.showInfo(`${theme.success('Effort set to:')} ${theme.accent(level)}`);
      return false;
    }

    case '/copy': {
      tui.copyLastResponse();
      return false;
    }

    case '/retry': {
      // Find the most recent user message in the agent's context and re-run
      // it. Useful when a transient error (proxy busy, model not loaded,
      // network blip) interrupted the previous turn and the model never
      // produced a useful answer. We don't pop the failed turn from history
      // — keeping it lets the model see what happened, which sometimes helps
      // it adapt; if the user wants a clean slate, /clear before /retry.
      const allMessages = agent.getContext().getAllMessages();
      let lastUser: string | null = null;
      for (let i = allMessages.length - 1; i >= 0; i--) {
        if (allMessages[i].role === 'user' && allMessages[i].content) {
          lastUser = allMessages[i].content as string;
          break;
        }
      }
      if (!lastUser) {
        tui.showInfo(theme.dim('No previous user message to retry.'));
        return false;
      }
      tui.showInfo(`${theme.dim('↻ Retrying:')} ${theme.muted(lastUser.length > 80 ? lastUser.slice(0, 77) + '…' : lastUser)}`);
      await runTurn(lastUser);
      return false;
    }

    case '/compact': {
      const ctx = agent.getContext();
      if (ctx.messageCount() <= 4) {
        tui.showInfo('No compaction needed — conversation is short.');
        return false;
      }

      // Ask the model to verify/update the knowledge state before compacting
      tui.showInfo(theme.dim('Summarizing conversation into knowledge state...'));
      const ks = ctx.getKnowledgeState();
      const currentState = ks.serialize();
      const allMsgs = ctx.getAllMessages();

      try {
        const { Ollama: OllamaClient } = await import('ollama');
        const ollamaCompact = new OllamaClient({ host: config.proxyUrl });
        const summaryResp = await ollamaCompact.chat({
          model: modelManager.getCurrentModel(),
          messages: [
            { role: 'user', content: `Here is the current knowledge state of our conversation:\n\n${currentState}\n\nAnd here are the full messages (${allMsgs.length} total). Review them and output an UPDATED knowledge state in the same format. Add any missing decisions, facts, files, or context. Only output the knowledge state, nothing else.\n\nMessages:\n${allMsgs.slice(0, -6).map(m => `[${m.role}] ${(m.content || '').slice(0, 200)}`).join('\n')}` },
          ],
          keep_alive: '30m',
          options: { num_predict: 512 },
        } as never) as unknown as { message: { content: string } };

        // Parse the model's updated state
        if (summaryResp.message.content) {
          const updated = summaryResp.message.content;
          // Try to extract key-value pairs from the response
          for (const line of updated.split('\n')) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const key = line.slice(0, colonIdx).trim();
            const val = line.slice(colonIdx + 1).trim();
            if (key === 'FACTS' || key === 'DECISIONS' || key === 'OPEN_QUESTIONS') {
              const items = val.replace(/^\[/, '').replace(/\]$/, '').split(',').map(s => s.trim()).filter(Boolean);
              for (const item of items) {
                ks.updateMemory(key.toLowerCase().replace('_', ''), item);
              }
            }
          }
        }
      } catch {
        // Non-critical — compact without AI summary
      }

      if (ctx.compact()) {
        await ks.save();
        tui.showInfo(`${theme.success('Compacted:')} ${ctx.messageCount()} messages kept, knowledge state updated.`);
      } else {
        tui.showInfo('No compaction needed.');
      }
      return false;
    }

    case '/model':
    case '/models': {
      const modelArg = parts[1];
      // Lock mode: refuse all model changes (direct, auto, selector) with clear reason
      if (config.lockModel) {
        tui.showInfo(
          `${theme.accent('🔒 Locked to')} ${config.lockModel}\n` +
          theme.dim('  Remove lockModel from ~/.veepee-code/settings.json, ') +
          theme.dim('or run ') + theme.accent('vcode --wizard-step model') + theme.dim(' to change.'),
        );
        return false;
      }
      if (modelArg === 'auto') {
        modelManager.setAutoSwitch(true);
        tui.showInfo('Auto model switching enabled.');
        return false;
      }
      // Direct model name provided — switch immediately
      if (modelArg) {
        const match = modelManager.getAllModels().find(m =>
          m.name === modelArg || m.name.startsWith(modelArg)
        );
        if (!match) {
          tui.showError(`Model not found: ${modelArg}`);
          return false;
        }
        agent.setModel(match.name);
        modelManager.setAutoSwitch(false);
        tui.updateModel(match.name, match.parameterSize);
        tui.showInfo(`Switched to ${theme.accent(match.name)} (auto-switch disabled)`);
        return false;
      }
      // No argument — show interactive selector
      const allModels = modelManager.getAllModels();
      const result = await tui.showModelSelector(
        allModels.map(m => ({ name: m.name, parameterSize: m.parameterSize, score: m.score, tier: m.tier, capabilities: m.capabilities })),
        modelManager.getCurrentModel(),
      );
      if (result) {
        agent.setModel(result.name);
        const profile = modelManager.getProfile(result.name);
        if (result.action === 'default') {
          modelManager.setAutoSwitch(false);
          tui.updateModel(result.name, profile?.parameterSize);
          // Persist to config file
          const { getConfigPath, loadConfig, saveConfigFile } = await import('./config.js');
          const currentConfig = loadConfig();
          saveConfigFile({ ...currentConfig, model: result.name, autoSwitch: false });
          tui.showInfo(`${theme.accent(result.name)} set as default model`);
        } else {
          modelManager.setAutoSwitch(false);
          tui.updateModel(result.name, profile?.parameterSize);
          tui.showInfo(`Using ${theme.accent(result.name)} for this session`);
        }
      }
      return false;
    }

    case '/review': {
      // Route one turn through config.reviewModel for a cross-family second
      // opinion (e.g. DGX Qwen generates, AGX Gemma reviews). Restores the
      // previous model after the turn completes, even on error.
      if (!config.reviewModel) {
        tui.showInfo([
          `${theme.warning('reviewModel not set.')}`,
          `  Add ${theme.accent('"reviewModel": "gemma4:26b-a4b"')} to ${theme.dim('~/.veepee-code/settings.json')}`,
          `  Any model name the proxy advertises will work — pick one from a different family than your primary for best second-opinion value.`,
        ].join('\n'));
        return false;
      }
      const text = input.slice('/review'.length).trim();
      if (!text) {
        tui.showInfo([
          `${theme.textBold('Usage:')} ${theme.accent('/review <your prompt>')}`,
          `  Routes the next turn through ${theme.accent(config.reviewModel)} instead of the primary model.`,
          `  Example: ${theme.dim('/review Critique this diff: <paste>')}`,
        ].join('\n'));
        return false;
      }
      const previousModel = modelManager.getCurrentModel();
      tui.showInfo(`${theme.dim('↪ Reviewing with')} ${theme.accent(config.reviewModel)}`);
      agent.setModel(config.reviewModel);
      tui.updateModel(config.reviewModel);
      try {
        await runTurn(text);
      } finally {
        agent.setModel(previousModel);
        tui.updateModel(previousModel);
      }
      return false;
    }

    case '/probe': {
      tui.showInfo(theme.dim('Probing all models for tool-calling support...'));
      try {
        const { updated } = await modelManager.probeNewModels();
        if (updated.length === 0) {
          tui.showInfo('All models already probed. Delete ~/.veepee-code/capabilities.json to re-probe.');
        } else {
          tui.showInfo(`Probed ${updated.length} model(s): ${updated.join(', ')}`);
          tui.showInfo(theme.dim('Results cached in ~/.veepee-code/capabilities.json'));
        }
      } catch (err) {
        tui.showError(`Probe failed: ${(err as Error).message}`);
      }
      return false;
    }

    case '/tools': {
      // Group by source so users can see which tools came from where —
      // makes provenance auditable when a tool misbehaves and tells users
      // what their setup is actually exposing.
      const groups = registry.bySource();
      const total = registry.count();
      const lines: string[] = [`${theme.textBold(`${total} tools:`)}`];
      for (const group of groups) {
        const sourceLabel = group.sourceName
          ? `${group.source}:${group.sourceName}`
          : group.source;
        lines.push('');
        lines.push(`${theme.accent(sourceLabel)} ${theme.dim(`(${group.tools.length})`)}`);
        const sortedTools = [...group.tools].sort((a, b) => a.name.localeCompare(b.name));
        for (const t of sortedTools) {
          const desc = t.description.replace(/^\[(remote|mcp|skill)[^\]]*\]\s*/, ''); // strip prefix; group label conveys source
          lines.push(`  ${theme.accent(t.name.padEnd(20))} ${theme.muted(desc.slice(0, 70))}`);
        }
      }
      tui.showInfo(lines.join('\n'));
      return false;
    }

    case '/settings': {
      const settingName = parts[1]?.toLowerCase();
      if (settingName === 'progress-bar') {
        const newVal = !tui.getProgressBar();
        tui.setProgressBar(newVal);
        const { getConfigPath, loadConfig, saveConfigFile } = await import('./config.js');
        const currentConfig = loadConfig();
        saveConfigFile({ ...currentConfig, progressBar: newVal });
        tui.showInfo(`Progress bar ${newVal ? theme.success('enabled') : theme.muted('disabled')}`);
      } else if (settingName === 'model_stick' || settingName === 'model-stick' || settingName === 'stick') {
        const newVal = !agent.getModelStick();
        agent.setModelStick(newVal);
        const { loadConfig: reloadConfig, saveConfigFile } = await import('./config.js');
        const currentConfig = reloadConfig();
        saveConfigFile({ ...currentConfig, modelStick: newVal });
        const currentModel = modelManager.getCurrentModel();
        tui.showInfo(newVal
          ? `Model stick ${theme.success('ON')} — locked to ${theme.accent(currentModel)}. Mode switches won't change the model.`
          : `Model stick ${theme.muted('OFF')} — mode switches will select the best model per mode.`);
      } else {
        tui.showInfo([
          '',
          `${theme.textBold('Settings:')}`,
          `  ${theme.accent('progress-bar')}   ${tui.getProgressBar() ? theme.success('ON') : theme.muted('OFF')}   Bouncing progress bar animation`,
          `  ${theme.accent('model_stick')}    ${agent.getModelStick() ? theme.success('ON') : theme.muted('OFF')}   Lock model across mode switches`,
          '',
          `${theme.dim('Toggle with: /settings <name>')}`,
        ].join('\n'));
      }
      return false;
    }

    case '/status': {
      const summarizerLabel = config.summarizerModel
        ? theme.accent(config.summarizerModel)
        : theme.dim(`(falls back to ${modelManager.getCurrentModel()})`);
      tui.showInfo([
        `${theme.textBold('Session:')}`,
        `  Model:       ${theme.accent(modelManager.getCurrentModel())}`,
        `  Summarizer:  ${summarizerLabel}`,
        `  Messages:    ${agent.getContext().messageCount()}`,
        `  Tokens:      ~${agent.getContext().estimateTokens().toLocaleString()}`,
        `  Tools:       ${registry.count()}`,
        `  API:         http://localhost:${apiPort}`,
        `  CWD:         ${process.cwd()}`,
      ].join('\n'));
      return false;
    }

    case '/benchmark': {
      const subCmd = parts[1]?.toLowerCase();

      if (subCmd === 'results' || subCmd === 'show') {
        const b = new Benchmarker(config.proxyUrl, config.fleet);
        const results = await b.loadLatest();
        if (!results) {
          tui.showInfo('No benchmark results. Run /benchmark to generate.');
        } else {
          tui.showInfo(Benchmarker.formatTable(results));
        }
        return false;
      }

      if (subCmd === 'summary') {
        const b = new Benchmarker(config.proxyUrl, config.fleet);
        const results = await b.loadLatest();
        if (!results) {
          tui.showInfo('No benchmark results. Run /benchmark to generate.');
        } else {
          tui.showInfo(Benchmarker.formatSummary(results));
        }
        return false;
      }

      if (subCmd === 'context') {
        tui.showInfo('Running context probing on all benchmarked models... This will take a while.');
        const b = new Benchmarker(config.proxyUrl, config.fleet);
        const existing = await b.loadLatest();
        if (!existing) {
          tui.showInfo('No benchmark results. Run /benchmark first.');
          return false;
        }
        const candidates = modelManager.getAllModels()
          .filter(m => existing.some(r => r.model === m.name));
        const results = await b.benchmarkAll(candidates, {
          skipContextProbing: false,
          onProgress: (model, test, mi, mt, ti, tt) => {
            tui.showInfo(`[${mi}/${mt}] ${model} — ${test} (${ti}/${tt})`);
          },
          onStatusUpdate: (msg) => tui.showInfo(msg),
        });
        tui.showInfo(Benchmarker.formatTable(results));
        return false;
      }

      const filter = (['heavy', 'standard', 'light'] as const).find(t => t === subCmd) || undefined;
      const candidates = modelManager.getAllModels()
        .filter(m => !m.capabilities.includes('embedding') || m.capabilities.length > 1)
        .filter(m => !filter || m.tier === filter);

      tui.showInfo(`Running benchmarks on ${candidates.length} models... This may take a while.`);

      const b = new Benchmarker(config.proxyUrl, config.fleet);
      const results = await b.benchmarkAll(candidates, {
        filter,
        skipContextProbing: true, // fast by default, use /benchmark context for full probing
        onProgress: (model, test, mi, mt, ti, tt) => {
          tui.showInfo(`[${mi}/${mt}] ${model} — ${test} (${ti}/${tt})`);
        },
        onStatusUpdate: (msg) => tui.showInfo(msg),
      });

      tui.showInfo(Benchmarker.formatTable(results));
      tui.showInfo(Benchmarker.formatSummary(results));
      return false;
    }

    case '/permissions':
    case '/perms': {
      const perms = permissions.listPermissions();
      tui.showInfo([
        `${theme.textBold('Permissions:')}`,
        `  ${theme.success('Safe (auto-allowed):')} ${perms.safeTools.join(', ')}`,
        `  ${theme.accent('Always allowed:')} ${perms.alwaysAllowed.length > 0 ? perms.alwaysAllowed.join(', ') : '(none)'}`,
        `  ${theme.warning('Session allowed:')} ${perms.sessionAllowed.length > 0 ? perms.sessionAllowed.join(', ') : '(none)'}`,
      ].join('\n'));
      return false;
    }

    case '/revoke': {
      const toolName = parts[1];
      if (!toolName) {
        tui.showInfo('Usage: /revoke <tool_name>');
        return false;
      }
      if (permissions.revoke(toolName)) {
        tui.showInfo(`Revoked always-allow for ${toolName}`);
      } else {
        tui.showInfo(`${toolName} was not in the always-allowed list`);
      }
      return false;
    }

    case '/output-style':
    case '/style': {
      const sub = parts[1];
      const { loadOutputStyles } = await import('./output-styles.js');
      const styles = loadOutputStyles();
      if (!sub || sub === 'list') {
        const lines: string[] = [`${theme.textBold('Output styles')}`];
        const active = agent.getContext().getOutputStyleName() ?? 'default';
        for (const s of styles) {
          const marker = s.name === active ? theme.success('●') : theme.dim(' ');
          const tag = s.source === 'builtin' ? theme.dim('[built-in]') : theme.dim(`[${s.source}]`);
          lines.push(`  ${marker} ${theme.accent(s.name.padEnd(16))} ${tag} ${theme.muted(s.description)}`);
        }
        lines.push('');
        lines.push(theme.dim('  /output-style <name>   activate'));
        lines.push(theme.dim('  Drop ~/.veepee-code/output-styles/<name>.md (frontmatter: description) to add custom.'));
        tui.showInfo(lines.join('\n'));
        return false;
      }
      const ok = agent.getContext().setOutputStyle(sub);
      if (!ok) {
        tui.showInfo(`${theme.error('Unknown output style:')} ${sub}\nAvailable: ${styles.map((s) => s.name).join(', ')}`);
        return false;
      }
      tui.showInfo(`${theme.success('Output style:')} ${theme.accent(sub)}`);
      return false;
    }

    case '/agents': {
      const sub = parts[1];
      const mgr = agent.getSubAgents();
      const agents = mgr.listAgents();

      if (sub === 'output') {
        const id = parts[2];
        if (!id) { tui.showInfo('Usage: /agents output <id>'); return false; }
        tui.showInfo(theme.dim(`Awaiting ${id}...`));
        const result = await mgr.waitFor(id);
        if (!result) { tui.showInfo(theme.warning(`No subagent ${id}.`)); return false; }
        const meta = `[${id} on ${result.model}, ${result.elapsed}ms, ${result.toolCalls.length} tool calls]`;
        if (result.success) {
          tui.showInfo(`${theme.success(meta)}\n\n${result.content}`);
        } else {
          tui.showInfo(`${theme.error(meta)}\n${result.error || '(no error message)'}`);
        }
        return false;
      }

      if (sub === 'stop') {
        const id = parts[2];
        if (!id) { tui.showInfo('Usage: /agents stop <id>'); return false; }
        const ok = mgr.abort(id);
        tui.showInfo(ok ? `${theme.warning(`Abort signaled for ${id}`)} (stops at next turn boundary)` : theme.error(`No running subagent ${id}.`));
        return false;
      }

      // Default: list
      const stats = mgr.stats();
      const allowed = mgr.getAllowedModels();
      const lines: string[] = [
        `${theme.textBold('Subagents')} ${theme.dim(`(${stats.running}/${stats.max} running, ${stats.total} tracked total)`)}`,
      ];
      if (allowed) {
        lines.push(theme.dim(`  Allowed models: ${allowed.join(', ')}`));
      }
      if (agents.length === 0) {
        lines.push(theme.dim('  (none — model can spawn via the `task` tool)'));
      } else {
        for (const a of agents.slice(0, 20)) {
          const status =
            a.status === 'running' ? theme.warning('● running')
            : a.status === 'completed' ? theme.success('✓ done')
            : a.status === 'aborted' ? theme.dim('⊘ aborted')
            : theme.error('✗ failed');
          const dur = a.completedAt
            ? `${a.completedAt - a.startedAt}ms`
            : `${Date.now() - a.startedAt}ms+`;
          lines.push(`  ${theme.accent(a.id.padEnd(8))} ${status.padEnd(20)} ${theme.dim(a.model.padEnd(30))} ${theme.dim(dur.padStart(8))}  ${a.description}`);
        }
        if (agents.length > 20) lines.push(theme.dim(`  ... and ${agents.length - 20} more`));
      }
      lines.push('');
      lines.push(theme.dim('  /agents output <id>  — fetch result (blocks until done)'));
      lines.push(theme.dim('  /agents stop <id>    — request abort'));
      tui.showInfo(lines.join('\n'));
      return false;
    }

    case '/skills': {
      const { loadSkills } = await import('./skills.js');
      const skills = loadSkills();
      const lines: string[] = [`${theme.textBold('Skills')} ${theme.dim('(lazy-loaded — model calls skill_invoke to fetch)')}`];
      if (skills.length === 0) {
        lines.push(theme.dim('  (none) — drop markdown files in ~/.veepee-code/skills/ or .veepee/skills/'));
      } else {
        for (const s of skills) {
          const tags = s.tags && s.tags.length > 0 ? theme.dim(` [${s.tags.join(', ')}]`) : '';
          lines.push(`  ${theme.accent(s.name.padEnd(24))} ${theme.muted(s.description)}${tags} ${theme.dim('— ' + s.source)}`);
        }
      }
      tui.showInfo(lines.join('\n'));
      return false;
    }

    case '/mcp': {
      const servers = config.mcpServers || {};
      const names = Object.keys(servers);
      const lines: string[] = [`${theme.textBold('MCP servers')}`];
      if (names.length === 0) {
        lines.push(theme.dim('  (none configured)'));
        lines.push(theme.dim('  Add to settings.json under `mcpServers`. Stdio: { command, args }; SSE: { url }.'));
      } else {
        for (const name of names) {
          const cfg = servers[name];
          const transport = 'command' in cfg ? `stdio (${cfg.command})` : `sse (${cfg.url})`;
          const allow = cfg.allow && cfg.allow.length > 0 ? ` allow=${cfg.allow.length}` : '';
          const disabled = cfg.disabled ? theme.dim(' [disabled]') : '';
          lines.push(`  ${theme.accent(name)} ${theme.dim(transport + allow)}${disabled}`);
        }
        const groups = registry.bySource().filter((g) => g.source === 'mcp');
        const totalTools = groups.reduce((n, g) => n + g.tools.length, 0);
        lines.push('');
        lines.push(theme.dim(`  ${totalTools} MCP tool${totalTools === 1 ? '' : 's'} registered across ${groups.length} server${groups.length === 1 ? '' : 's'}.`));
      }
      tui.showInfo(lines.join('\n'));
      return false;
    }

    case '/extras': {
      const sub = parts[1]?.toLowerCase();
      const { listExtras, addExtra, removeExtra } = await import('./extras/index.js');

      if (!sub || sub === 'list') {
        const items = listExtras();
        const lines: string[] = [`${theme.textBold('Extras')} ${theme.dim('(LazyVim-style language bundles — LSP + formatters + prompt hints)')}`];
        for (const { extra, active, matchesCwd } of items) {
          const status = active ? theme.success('on ') : theme.dim('off');
          const here = matchesCwd ? theme.accent(' [matches cwd]') : '';
          lines.push(`  ${status} ${theme.accent(extra.name.padEnd(12))} ${theme.dim(extra.description)}${here}`);
        }
        lines.push('');
        lines.push(theme.dim(`Add:    /extras add <name>    Remove: /extras remove <name>`));
        tui.showInfo(lines.join('\n'));
        return false;
      }

      if (sub === 'add') {
        const name = parts[2];
        if (!name) { tui.showInfo(theme.warning('Usage: /extras add <name>')); return false; }
        const out = addExtra(name);
        const lines: string[] = [];
        if (!out.ok) {
          lines.push(`${theme.warning('✗')} ${out.message}`);
        } else {
          lines.push(`${theme.success('✓')} ${out.message}`);
          if (out.installed.length) lines.push(theme.dim(`  Installed LSP: ${out.installed.join(', ')}`));
          if (out.alreadyPresent.length) lines.push(theme.dim(`  Already present: ${out.alreadyPresent.join(', ')}`));
          if (out.hooksAdded > 0) lines.push(theme.dim(`  Registered ${out.hooksAdded} PostToolUse hook${out.hooksAdded === 1 ? '' : 's'}`));
          lines.push(theme.dim(`  Restart vcode to activate the new hooks and prompt section.`));
        }
        tui.showInfo(lines.join('\n'));
        return false;
      }

      if (sub === 'remove') {
        const name = parts[2];
        if (!name) { tui.showInfo(theme.warning('Usage: /extras remove <name>')); return false; }
        const out = removeExtra(name);
        tui.showInfo(out.ok
          ? `${theme.success('✓')} ${out.message} (removed ${out.hooksRemoved} hook${out.hooksRemoved === 1 ? '' : 's'})`
          : `${theme.warning('✗')} ${out.message}`);
        return false;
      }

      tui.showInfo([
        `${theme.textBold('Usage:')}`,
        `  ${theme.accent('/extras')}                    List built-in extras (active + match-cwd marker)`,
        `  ${theme.accent('/extras add <name>')}         Install LSP + register hooks for the bundle`,
        `  ${theme.accent('/extras remove <name>')}      Unregister hooks (LSP servers stay)`,
      ].join('\n'));
      return false;
    }

    case '/doctor': {
      const { defaultChecks, runChecks, renderDoctor } = await import('./doctor/index.js');
      const sub = parts[1];
      const checks = await defaultChecks(config);

      if (!sub) {
        tui.showInfo(theme.dim('Running checks...'));
        const summary = await runChecks(checks);
        tui.showInfo(renderDoctor(summary));
        return false;
      }

      if (sub === 'fix') {
        const idFilter = parts[2];
        tui.showInfo(theme.dim('Running checks before applying fixes...'));
        const summary = await runChecks(checks);
        const candidates = summary.results.filter((r) =>
          (r.result.severity === 'error' || r.result.severity === 'warn') &&
          typeof r.check.fix === 'function' &&
          (!idFilter || r.check.id === idFilter),
        );
        if (candidates.length === 0) {
          tui.showInfo(idFilter
            ? `${theme.dim(`No fixable issue with id "${idFilter}".`)}`
            : `${theme.success('Nothing to fix — no fixable issues found.')}`);
          return false;
        }
        const fixLines: string[] = [`${theme.textBold('Applying fixes:')}`];
        for (const { check } of candidates) {
          fixLines.push(theme.dim(`  → ${check.id} (${check.fixLabel ?? check.description})`));
          try {
            const out = await check.fix!();
            fixLines.push(`    ${out.ok ? theme.success('✓') : theme.warning('✗')} ${out.message}`);
          } catch (err) {
            fixLines.push(`    ${theme.warning('✗')} fix threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        tui.showInfo(fixLines.join('\n'));
        return false;
      }

      tui.showInfo([
        `${theme.textBold('Usage:')}`,
        `  ${theme.accent('/doctor')}              Run all health checks`,
        `  ${theme.accent('/doctor fix')}          Apply every available auto-fix`,
        `  ${theme.accent('/doctor fix <id>')}     Apply just one fix (id from the report)`,
      ].join('\n'));
      return false;
    }

    case '/lsp': {
      const sub = parts[1]?.toLowerCase();

      if (sub === 'install') {
        const { KNOWN_RECIPES, recipeByLabel, detectRecipes, runInstall, writeServerToSettings, whichBin } = await import('./lsp/install.js');
        let labels = parts.slice(2);
        if (labels.length === 0) {
          // Auto-detect from cwd
          const detected = detectRecipes(process.cwd());
          if (detected.length === 0) {
            tui.showInfo([
              `${theme.warning('No project markers detected in')} ${process.cwd()}`,
              '',
              `Available recipes:`,
              ...KNOWN_RECIPES.map((r) => `  ${theme.accent(r.label.padEnd(12))} ${theme.dim(r.language)}`),
              '',
              `Usage: ${theme.accent('/lsp install <label> [<label>...]')}`,
            ].join('\n'));
            return false;
          }
          labels = detected.map((r) => r.label);
          tui.showInfo(`${theme.dim('Auto-detected')} ${labels.join(', ')} ${theme.dim('from project markers in')} ${process.cwd()}`);
        }
        const lines: string[] = [];
        for (const label of labels) {
          const recipe = recipeByLabel(label);
          if (!recipe) {
            lines.push(`${theme.warning('✗')} Unknown recipe '${label}'. Known: ${KNOWN_RECIPES.map((r) => r.label).join(', ')}`);
            continue;
          }
          const existing = whichBin(recipe.binaryProbe);
          if (existing) {
            lines.push(`${theme.success('✓')} ${recipe.language} already installed at ${existing}`);
          } else {
            lines.push(`${theme.dim('→')} Installing ${recipe.language}: ${recipe.install.command} ${recipe.install.args.join(' ')}`);
            const out = runInstall(recipe);
            lines.push(`  ${out.ok ? theme.success('✓') : theme.warning('✗')} ${out.message}`);
            if (!out.ok) continue;
          }
          const w = writeServerToSettings(recipe.label, recipe.serverConfig);
          if (w.changed) {
            lines.push(`  ${theme.success('✓')} Added lsp.${recipe.label} to ${w.path}`);
          } else {
            lines.push(`  ${theme.dim('•')} Settings unchanged: ${w.reason}`);
          }
        }
        lines.push('');
        lines.push(theme.dim('Restart vcode to pick up new LSP servers.'));
        tui.showInfo(lines.join('\n'));
        return false;
      }

      if (sub === 'help' || sub === '?') {
        tui.showInfo([
          `${theme.textBold('LSP commands:')}`,
          `  ${theme.accent('/lsp')}                       Show configured servers and live status`,
          `  ${theme.accent('/lsp install')}               Auto-detect project type and install recipes`,
          `  ${theme.accent('/lsp install <label>...')}    Install specific recipes (typescript, python, go, rust, lua)`,
        ].join('\n'));
        return false;
      }

      const cfg = config.lsp;
      const lines: string[] = [`${theme.textBold('LSP servers')}`];
      if (!cfg || Object.keys(cfg).length === 0) {
        lines.push(theme.dim('  (none configured)'));
        lines.push(theme.dim('  Run /lsp install to set one up. See docs/plans/v0.4-lsp.md.'));
      } else {
        const running = new Set(lspManager.runningLabels());
        for (const [label, c] of Object.entries(cfg)) {
          const status = c.enabled === false
            ? theme.dim('disabled')
            : running.has(label)
              ? theme.success('running')
              : theme.dim('idle');
          const reason = lspManager.failureReason(label);
          const reasonStr = reason ? theme.warning(`  failed: ${reason}`) : '';
          const filetypes = c.filetypes.map((s) => `.${s}`).join(' ');
          lines.push(`  ${theme.accent(label.padEnd(12))} ${status.padEnd(16)} ${theme.dim(c.command)} ${theme.dim(filetypes)}${reasonStr}`);
        }
        lines.push('');
        lines.push(theme.dim(`  Tools: lsp_diagnostics, lsp_restart. Use /tools for the full registry.`));
      }
      tui.showInfo(lines.join('\n'));
      return false;
    }

    case '/hooks': {
      const sub = parts[1];
      const hooksMod = await import('./hooks.js');
      const cwd = process.cwd();

      if (sub === 'trust') {
        hooksMod.setProjectTrust(cwd, 'trust');
        tui.showInfo([
          `${theme.success('✓ Project trusted')} — hooks from .veepee/settings.json and .veepee/settings.local.json will run.`,
          theme.dim(`  Revert with: /hooks deny`),
        ].join('\n'));
        return false;
      }
      if (sub === 'deny') {
        hooksMod.setProjectTrust(cwd, 'deny');
        tui.showInfo(`${theme.warning('Project denied')} — project/local hooks will not run.`);
        return false;
      }

      // Default: show
      const trust = hooksMod.getProjectTrustState(cwd);
      const lines: string[] = [`${theme.textBold('Hooks status')}`];
      lines.push(`  Trust state for ${cwd}: ${
        trust === 'trusted' ? theme.success('trusted') :
        trust === 'denied' ? theme.error('denied') :
        theme.warning('unknown')
      }`);
      lines.push('');
      for (const eventName of hooksMod.HOOK_EVENTS) {
        const collected = hooksMod.collectHooks(eventName, cwd);
        if (collected.length === 0) continue;
        lines.push(`  ${theme.accent(eventName)} (${collected.length})`);
        for (const { hook, layer } of collected) {
          const willFire = layer === 'global' || trust === 'trusted';
          const marker = willFire ? theme.dim('✓') : theme.error('✗');
          const matcher = hook.matcher ? theme.dim(` /${hook.matcher}/`) : '';
          const desc = hook.description ? theme.dim(` — ${hook.description}`) : '';
          lines.push(`    ${marker} [${layer}]${matcher} ${theme.dim('$')} ${hook.command}${desc}`);
        }
      }
      if (lines.length === 2) lines.push(theme.dim('  No hooks configured.'));
      lines.push('');
      lines.push(theme.dim('  Configure in ~/.veepee-code/settings.json (global), .veepee/settings.json (project), or .veepee/settings.local.json (local).'));
      lines.push(theme.dim('  Subcommands: /hooks trust | /hooks deny | /hooks (this listing)'));
      tui.showInfo(lines.join('\n'));
      return false;
    }

    case '/plan': {
      if (agent.getMode() === 'plan') {
        tui.showInfo('Already in plan mode.');
        return false;
      }
      const { model } = agent.enterPlanMode();
      tui.updateModel(model, undefined, 'Plan');
      tui.showInfo([
        `${theme.accent('Plan mode activated')}`,
        `  ${theme.dim('Model:')} ${model} (heaviest with thinking)`,
        `  ${theme.dim('Thinking:')} ON — model will reason through decisions`,
        `  ${theme.dim('Behavior:')} Asks clarifying questions before acting`,
        `  ${theme.dim('Exit:')} /act to switch back to execution mode`,
      ].join('\n'));
      return false;
    }

    case '/act':
    case '/code': {
      if (agent.getMode() === 'act') {
        tui.showInfo('Already in act/code mode.');
        return false;
      }
      agent.exitPlanMode();
      tui.updateModel(modelManager.getCurrentModel(), undefined, 'Act');
      tui.showInfo([
        `${theme.accent('Act mode activated')} (all tools, coding-ready)`,
        `  ${theme.dim('Model:')} ${modelManager.getCurrentModel()}`,
        `  ${theme.dim('Thinking:')} OFF — fast execution`,
        `  ${theme.dim('Tools:')} All ${registry.count()} tools available`,
      ].join('\n'));
      return false;
    }

    case '/chat': {
      if (agent.getMode() === 'chat') {
        tui.showInfo('Already in chat mode.');
        return false;
      }
      const { model: chatModel } = agent.enterChatMode();
      tui.updateModel(chatModel, undefined, 'Chat');
      // Show only actually registered chat tools
      const chatToolNames = ['web_search', 'web_fetch', 'http_request', 'weather', 'news']
        .filter(t => registry.has(t));
      tui.showInfo([
        `${theme.accent('Chat mode activated')}`,
        `  ${theme.dim('Model:')} ${chatModel} (fast, conversational)`,
        `  ${theme.dim('Tools:')} ${chatToolNames.length > 0 ? chatToolNames.join(', ') : '(none — configure SearXNG for web search)'}`,
        `  ${theme.dim('Exit:')} /act to switch back to coding mode`,
      ].join('\n'));
      return false;
    }

    case '/moe': {
      const strategyArg = parts[1]?.toLowerCase() as MoeStrategy | undefined;
      const validStrategies = ['auto', 'synthesize', 'debate', 'vote', 'fastest'];
      const strategy: MoeStrategy = validStrategies.includes(strategyArg || '') ? strategyArg as MoeStrategy : 'auto';

      // Initialize MoE engine with roster
      const roster = agent.getRoster();
      const moe = new MoeEngine(config, roster);
      const moeModels = moe.getModels();

      tui.showInfo([
        `${theme.accent('⚡ MoE mode')} — ${strategy === 'auto' ? 'auto-detecting strategy' : strategy}`,
        `  ${moeModels.map(m => `${theme.dim(m.role)}: ${theme.accent(m.name)}`).join('\n  ')}`,
        '',
        theme.dim('Type your question. All models will respond in parallel.'),
      ].join('\n'));

      // Get user input
      let moeInput: string;
      try {
        moeInput = await tui.getInput();
      } catch {
        return false;
      }
      if (!moeInput.trim() || moeInput.startsWith('/')) return false;

      tui.addUserMessage(moeInput);
      const moeStart = Date.now();

      // Run MoE
      const moeResult = await moe.run(
        moeInput,
        agent.getContext().getSystemPrompt(),
        agent.getContext().getMessages(),
        strategy,
        (model, role, status, content) => {
          if (status === 'started') {
            tui.showInfo(theme.dim(`${role} (${model}): starting...`));
          } else if (status === 'done' && content) {
            const preview = content.split('\n')[0].slice(0, 80);
            tui.showInfo(`${theme.accent(role)} (${model}): ${theme.dim('done')}`);
          }
        },
      );

      // Display results based on strategy
      tui.showInfo('');
      tui.showInfo(`${theme.accent('⚡ MoE Results')} — strategy: ${moeResult.strategy} — ${((Date.now() - moeStart) / 1000).toFixed(1)}s`);
      tui.showInfo('');

      if (moeResult.strategy === 'vote') {
        // Show all responses for user to pick
        for (const r of moeResult.responses) {
          tui.showInfo(`${theme.accent(`── ${r.role}`)} (${r.model}, ${(r.elapsed / 1000).toFixed(1)}s) ──`);
          tui.showInfo(r.content);
          tui.showInfo('');
        }
        tui.showInfo(theme.dim('Pick the best response above. Use /act to return to normal mode.'));
      } else {
        // Show individual responses collapsed, then synthesis
        for (const r of moeResult.responses) {
          const firstLine = r.content.split('\n')[0].slice(0, 80);
          tui.showInfo(theme.dim(`  ${r.role} (${(r.elapsed / 1000).toFixed(1)}s): ${firstLine}...`));
        }
        tui.showInfo('');

        if (moeResult.synthesis) {
          tui.showInfo(`${theme.accent('── Synthesized Answer ──')}`);
          tui.showInfo(moeResult.synthesis);
        }
      }

      tui.showInfo('');
      return false;
    }

    case '/setup': {
      if (parts[1] === 'wizard' || parts[1] === '--wizard') {
        // Full wizard or per-integration: /setup wizard [integration]
        const stepId = parts[2];
        tui.stop();
        if (stepId) {
          await runWizardForStep(stepId);
        } else {
          await runWizard();
        }
        tui.start({
          model: modelManager.getCurrentModel(),
          modelSize: modelManager.getProfile(modelManager.getCurrentModel())?.parameterSize || '',
          toolCount: registry.count(),
          modelCount: modelManager.getAllModels().length,
          version: VERSION,
          apiPort,
        });
        tui.showInfo(theme.success('Configuration updated. Restart vcode to apply changes.'));
        return false;
      }
      tui.showInfo('Validating integrations...');
      const results = await validateIntegrations(config);
      tui.showInfo(formatSetupReport(results));
      return false;
    }

    case '/worktree': {
      const subCmd = parts[1]?.toLowerCase();
      if (!isGitRepo()) {
        tui.showError('Not a git repository — worktrees require git.');
        return false;
      }

      if (subCmd === 'list' || !subCmd) {
        const wts = listWorktrees();
        if (wts.length === 0) {
          tui.showInfo(theme.dim('No active worktrees. Use /worktree create [name] to create one.'));
        } else {
          tui.showInfo(theme.textBold(`  ${wts.length} worktree(s):`));
          for (const wt of wts) {
            tui.showInfo(`  ${theme.accent(wt.branch)} → ${theme.dim(wt.path)}`);
          }
        }
      } else if (subCmd === 'create') {
        const taskName = parts.slice(2).join(' ') || undefined;
        try {
          const wt = createWorktree(taskName);
          tui.showInfo([
            `${theme.success('Worktree created:')}`,
            `  ${theme.dim('Branch:')} ${theme.accent(wt.branch)}`,
            `  ${theme.dim('Path:')} ${wt.path}`,
            `  ${theme.dim('Base:')} ${wt.baseBranch}`,
            '',
            theme.dim('  Agent tasks in this worktree won\'t affect your working tree.'),
            theme.dim(`  cd ${wt.path} to work there, or /worktree cleanup when done.`),
          ].join('\n'));
        } catch (err) {
          tui.showError(`Failed: ${(err as Error).message}`);
        }
      } else if (subCmd === 'cleanup') {
        const count = cleanupWorktrees();
        tui.showInfo(count > 0
          ? `${theme.success(`Cleaned up ${count} worktree(s).`)}`
          : theme.dim('No worktrees to clean up.'));
      } else {
        tui.showInfo('Usage: /worktree [list|create [name]|cleanup]');
      }
      return false;
    }

    case '/init': {
      const fs = await import('fs');
      const path = await import('path');
      const { glob: globFn } = await import('glob');
      const llamaMdPath = path.resolve(process.cwd(), 'VEEPEE.md');
      const exists = fs.existsSync(llamaMdPath);

      tui.showInfo(`Analyzing project to ${exists ? 'improve' : 'create'} VEEPEE.md...`);
      const turnStart = Date.now();

      // ── Phase 1: Gather data programmatically (no model needed) ──
      const cwd = process.cwd();
      const gathered: string[] = [];

      // File tree
      tui.showInfo(theme.dim('  Scanning file tree...'));
      try {
        const files = await globFn('**/*', {
          cwd, ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', '.next/**', '__pycache__/**', 'venv/**', '.venv/**'],
          maxDepth: 3, mark: true,
        });
        gathered.push(`## File Tree (${files.length} entries)\n${files.slice(0, 150).join('\n')}`);
      } catch { /* skip */ }

      // Package manifests
      const manifests = ['package.json', 'Cargo.toml', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle'];
      for (const m of manifests) {
        const mPath = path.resolve(cwd, m);
        if (fs.existsSync(mPath)) {
          tui.showInfo(theme.dim(`  Reading ${m}...`));
          try {
            const content = fs.readFileSync(mPath, 'utf-8');
            gathered.push(`## ${m}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``);
          } catch { /* skip */ }
        }
      }

      // Config files
      const configs = ['tsconfig.json', '.eslintrc.json', '.eslintrc.js', '.prettierrc', 'ruff.toml', '.editorconfig', 'Makefile', 'Dockerfile', 'docker-compose.yml'];
      for (const c of configs) {
        const cPath = path.resolve(cwd, c);
        if (fs.existsSync(cPath)) {
          tui.showInfo(theme.dim(`  Reading ${c}...`));
          try {
            const content = fs.readFileSync(cPath, 'utf-8');
            gathered.push(`## ${c}\n\`\`\`\n${content.slice(0, 1500)}\n\`\`\``);
          } catch { /* skip */ }
        }
      }

      // README
      const readmePath = path.resolve(cwd, 'README.md');
      if (fs.existsSync(readmePath)) {
        tui.showInfo(theme.dim('  Reading README.md...'));
        try {
          gathered.push(`## README.md\n${fs.readFileSync(readmePath, 'utf-8').slice(0, 2000)}`);
        } catch { /* skip */ }
      }

      // Existing instruction files
      const instructionFiles = ['CLAUDE.md', 'AGENTS.md', 'OpenCode.md', 'GEMINI.md', '.cursorrules'];
      for (const f of instructionFiles) {
        const fPath = path.resolve(cwd, f);
        if (fs.existsSync(fPath)) {
          tui.showInfo(theme.dim(`  Reading ${f}...`));
          try {
            gathered.push(`## ${f} (existing instructions)\n${fs.readFileSync(fPath, 'utf-8').slice(0, 2000)}`);
          } catch { /* skip */ }
        }
      }

      // Sample source files (first 3 .ts/.js/.py/.rs/.go files)
      try {
        const sourceFiles = await globFn('src/**/*.{ts,js,py,rs,go}', { cwd, maxDepth: 3 });
        for (const sf of sourceFiles.slice(0, 3)) {
          tui.showInfo(theme.dim(`  Reading ${sf}...`));
          try {
            const content = fs.readFileSync(path.resolve(cwd, sf), 'utf-8');
            gathered.push(`## Sample source: ${sf}\n\`\`\`\n${content.slice(0, 1500)}\n\`\`\``);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }

      // Existing VEEPEE.md
      if (exists) {
        try {
          gathered.push(`## Existing VEEPEE.md (improve this)\n${fs.readFileSync(llamaMdPath, 'utf-8')}`);
        } catch { /* skip */ }
      }

      tui.showInfo(theme.dim(`  Gathered ${gathered.length} sections. Asking model to synthesize...`));

      // ── Phase 2: Ask model to produce VEEPEE.md content (no tools needed) ──
      const { Ollama } = await import('ollama');
      const ollama = new Ollama({ host: config.proxyUrl });

      const synthesisPrompt = `Based on the project data below, write the content of a VEEPEE.md file (~150 lines). This file is loaded into an AI coding assistant's system prompt, so it must be specific and actionable.

Sections to include:
1. Project overview (2-3 sentences — what it does)
2. Tech stack (language, framework, key libraries)
3. Build/lint/test commands (exact commands, especially how to run a SINGLE test)
4. Code style (naming conventions, imports, formatting — infer from the sample code)
5. Architecture (key directories, patterns, where to find what)
6. Common gotchas (things an agent might get wrong)

Rules:
- Be specific to THIS project. Generic advice is useless.
- Include exact file paths and command names.
- Output ONLY the markdown content. No preamble, no explanation, no code fences around the whole thing.

${gathered.join('\n\n')}`;

      let veepeeContent = '';
      try {
        const stream = await ollama.chat({
          model: modelManager.getCurrentModel(),
          messages: [
            { role: 'system', content: 'You are a technical writer. Output only the requested markdown content. No preamble.' },
            { role: 'user', content: synthesisPrompt },
          ],
          stream: true,
          think: false,
          keep_alive: '30m',
          options: { num_predict: 2048 },
        } as never);

        tui.startStream();
        for await (const chunk of stream) {
          if (chunk.message.content) {
            veepeeContent += chunk.message.content;
            tui.appendStream(chunk.message.content);
          }
        }
        tui.endStream();
      } catch (err) {
        tui.showError(`Model failed: ${(err as Error).message}`);
        return false;
      }

      // ── Phase 3: Write the file ourselves (no tool dependency) ──
      if (veepeeContent.trim().length > 50) {
        // Strip any code fences the model may have wrapped around the content
        let cleaned = veepeeContent.trim();
        if (cleaned.startsWith('```markdown')) cleaned = cleaned.slice(11);
        else if (cleaned.startsWith('```md')) cleaned = cleaned.slice(5);
        else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
        cleaned = cleaned.trim();

        fs.writeFileSync(llamaMdPath, cleaned, 'utf-8');
        tui.showInfo(`${theme.success(`VEEPEE.md ${exists ? 'updated' : 'created'}`)} (${cleaned.split('\n').length} lines)`);
      } else {
        tui.showError('Model produced insufficient content. Try again or create VEEPEE.md manually.');
        return false;
      }

      const elapsed = Date.now() - turnStart;
      tui.showCompletionBadge(modelManager.getCurrentModel(), elapsed);

      // Auto-add VEEPEE.md to .gitignore
      try {
        const isGit = fs.existsSync(`${process.cwd()}/.git`);
        if (isGit) {
          const gitignorePath = `${process.cwd()}/.gitignore`;
          if (fs.existsSync(gitignorePath)) {
            const content = fs.readFileSync(gitignorePath, 'utf-8');
            if (!content.includes('VEEPEE.md')) {
              fs.appendFileSync(gitignorePath, '\n# VEEPEE Code project instructions\nVEEPEE.md\n');
              tui.showInfo(`${theme.success('Added VEEPEE.md to .gitignore')}`);
            }
          } else {
            fs.writeFileSync(gitignorePath, '# VEEPEE Code project instructions\nVEEPEE.md\n');
            tui.showInfo(`${theme.success('Created .gitignore with VEEPEE.md')}`);
          }
        }
      } catch { /* non-critical */ }
      return false;
    }

    // ─── Session Commands ─────────────────────────────────────────────
    case '/save': {
      const name = parts.slice(1).join(' ') || autoName(agent.getContext().getAllMessages());
      if (agent.getContext().messageCount() === 0) {
        tui.showInfo('Nothing to save — start a conversation first.');
        return;
      }
      const ks = agent.getContext().getKnowledgeState();
      const session = await saveSession(
        name,
        agent.getContext().getAllMessages(),
        modelManager.getCurrentModel(),
        agent.getMode(),
        process.cwd(),
        currentSessionId || undefined,
        ks.getData(),
        { jsonl: config.useJsonlSessions },
      );
      // Also save the knowledge state file
      await ks.save();
      // Track in project registry so this session auto-resumes next time
      await setProjectSession(process.cwd(), session.id, session.name);
      tui.showInfo(`${theme.success('Saved:')} ${theme.accent(session.name)} ${theme.dim(`(ID: ${session.id})`)}`);
      return `session:${session.id}`;
    }

    case '/sessions': {
      const sessions = await listSessions();
      tui.showInfo(formatSessionList(sessions));
      return;
    }

    case '/rename': {
      const newName = parts.slice(1).join(' ');
      if (!newName) {
        tui.showInfo('Usage: /rename <new name>');
        return;
      }
      if (!currentSessionId) {
        // Auto-save first, then rename
        const autoSaveName = autoName(agent.getContext().getAllMessages());
        void autoSaveName;
        const session = await saveSession(
          newName,
          agent.getContext().getAllMessages(),
          modelManager.getCurrentModel(),
          agent.getMode(),
          process.cwd(),
          undefined,
          agent.getContext().getKnowledgeState().getData(),
          { jsonl: config.useJsonlSessions },
        );
        tui.showInfo(`${theme.success('Saved and named:')} ${theme.accent(newName)}`);
        return `session:${session.id}`;
      }
      // Re-save with new name
      const session = await saveSession(
        newName,
        agent.getContext().getAllMessages(),
        modelManager.getCurrentModel(),
        agent.getMode(),
        process.cwd(),
        currentSessionId,
        agent.getContext().getKnowledgeState().getData(),
        { jsonl: config.useJsonlSessions },
      );
      tui.showInfo(`${theme.success('Renamed to:')} ${theme.accent(newName)}`);
      return `session:${session.id}`;
    }

    case '/fork': {
      if (agent.getContext().messageCount() === 0) {
        tui.showInfo('Nothing to fork — start a conversation first.');
        return;
      }
      const forkName = parts.slice(1).join(' ') || `${autoName(agent.getContext().getAllMessages())} (fork)`;
      const ks = agent.getContext().getKnowledgeState();
      // Save a new session (no existingId → new ID generated) with a copy of all messages
      const forkedSession = await saveSession(
        forkName,
        agent.getContext().getAllMessages(),
        modelManager.getCurrentModel(),
        agent.getMode(),
        process.cwd(),
        undefined,
        ks.getData(),
        { jsonl: config.useJsonlSessions },
      );
      await setProjectSession(process.cwd(), forkedSession.id, forkedSession.name);
      tui.showInfo([
        `${theme.success('Forked:')} ${theme.accent(forkedSession.name)} ${theme.dim(`(ID: ${forkedSession.id})`)}`,
        theme.dim('  You are now working in the fork. The original session is preserved.'),
        theme.dim('  Use /sessions to see both sessions.'),
      ].join('\n'));
      return `session:${forkedSession.id}`;
    }

    case '/tree': {
      // Interactive picker over the active path. Arrow nav, Enter rewinds,
      // Esc cancels, Ctrl+O cycles filter, Shift+L bookmarks. Stays open
      // after a label so the user can keep navigating.
      if (!currentSessionId) {
        tui.showInfo(theme.dim('No active session. /save to start tracking branches with /tree.'));
        return;
      }
      let j = await loadJsonlSession(currentSessionId);
      if (!j) {
        tui.showInfo([
          theme.dim('This session is in the legacy JSON format. /tree requires JSONL.'),
          theme.dim('Enable `useJsonlSessions: true` in settings.json, then /save to migrate.'),
        ].join('\n'));
        return;
      }

      while (true) {
        const items = buildTreeViewItems(j);
        const result = await tui.showTreeView(items);
        if (!result) return;

        if (result.action === 'rewind') {
          try {
            j.setLeaf(result.entryId);
            const newMessages = j.getMessages();
            agent.getContext().replaceMessages(newMessages);
            const idx = items.findIndex(i => i.id === result.entryId);
            tui.showInfo([
              theme.success(`✓ Rewound to entry ${idx} (${items[idx]?.type ?? '?'})`),
              theme.dim(`  Active path now has ${newMessages.length} messages. New turns branch off this point.`),
              theme.dim('  The abandoned branch is preserved in the session file.'),
            ].join('\n'));
          } catch (err) {
            tui.showInfo(theme.error(`Rewind failed: ${err instanceof Error ? err.message : String(err)}`));
          }
          return;
        }
        if (result.action === 'label') {
          try {
            j.label(result.entryId, result.name);
            tui.showInfo(theme.dim(`  ★ Labeled "${result.name}"`));
          } catch (err) {
            tui.showInfo(theme.error(`Label failed: ${err instanceof Error ? err.message : String(err)}`));
          }
          // Reopen with refreshed items so the user sees the new ★
          j = (await loadJsonlSession(currentSessionId))!;
          continue;
        }
      }
    }

    case '/label': {
      const labelName = parts.slice(1).join(' ');
      if (!labelName) {
        tui.showInfo('Usage: /label <name>');
        return;
      }
      if (!currentSessionId) {
        tui.showInfo(theme.dim('No active session — save it first with /save.'));
        return;
      }
      const j = await loadJsonlSession(currentSessionId);
      if (!j) {
        tui.showInfo(theme.dim('Labels require the JSONL session format. Enable `useJsonlSessions` in settings.json.'));
        return;
      }
      const entry = j.label(j.getLeafId(), labelName);
      tui.showInfo(`${theme.success('★ Bookmarked:')} ${theme.accent(labelName)} ${theme.dim(`(entry ${entry.targetId.slice(0, 8)})`)}`);
      return;
    }

    case '/clone': {
      if (!currentSessionId) {
        tui.showInfo(theme.dim('No active session — save it first with /save.'));
        return;
      }
      const j = await loadJsonlSession(currentSessionId);
      if (!j) {
        tui.showInfo(theme.dim('/clone requires the JSONL session format. Enable `useJsonlSessions` in settings.json.'));
        return;
      }
      const cloneName = parts.slice(1).join(' ') || `${j.getMeta().name} (clone)`;
      const { join: pathJoin } = await import('path');
      const { existsSync: exists } = await import('fs');
      // Generate a new id + filename. Mirrors saveSession's slug logic.
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const newSlug = cloneName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      const sessDir = (await import('./sessions.js')).getSessionDir();
      let newPath = pathJoin(sessDir, `${newId}-${newSlug}.jsonl`);
      // Highly unlikely collision
      let attempt = 0;
      while (exists(newPath) && attempt++ < 5) {
        newPath = pathJoin(sessDir, `${newId}-${newSlug}-${attempt}.jsonl`);
      }
      const cloned = j.clone(newPath);
      cloned.updateMeta({ name: cloneName });
      await setProjectSession(process.cwd(), newId, cloneName);
      tui.showInfo([
        `${theme.success('Cloned:')} ${theme.accent(cloneName)} ${theme.dim(`(ID: ${newId})`)}`,
        theme.dim('  You are now in the clone. The original session is preserved.'),
      ].join('\n'));
      return `session:${newId}`;
    }

    case '/migrate-sessions': {
      const out = await migrateLegacySessions();
      const lines = ['', theme.textBold('  Session migration'), ''];
      if (out.migrated.length > 0) {
        lines.push(`  ${theme.success(`Migrated ${out.migrated.length} session(s) to JSONL:`)}`);
        for (const f of out.migrated) {
          lines.push(`    ${theme.dim(f)} ${icons.arrow} ${theme.accent(f.replace(/\.json$/, '.jsonl'))}`);
        }
        lines.push(theme.dim(`    Original .json files renamed to .json.legacy (kept for rollback).`));
      }
      if (out.skipped.length > 0) {
        lines.push(`  ${theme.dim(`Skipped ${out.skipped.length} (already migrated or unsupported)`)}`);
      }
      if (out.errors.length > 0) {
        lines.push(`  ${theme.error(`Errors on ${out.errors.length} file(s):`)}`);
        for (const e of out.errors) {
          lines.push(`    ${theme.error(e.file)}: ${e.error}`);
        }
      }
      if (out.migrated.length === 0 && out.errors.length === 0) {
        lines.push(`  ${theme.dim('Nothing to migrate. All sessions are already in JSONL format (or none exist).')}`);
      }
      lines.push('');
      tui.showInfo(lines.join('\n'));
      return;
    }

    case '/projects': {
      const projects = await listProjects();
      tui.showInfo(formatProjectList(projects));
      return;
    }

    case '/ralph': {
      const ralphTask = parts.slice(1).join(' ').trim();
      if (!ralphTask) {
        tui.showInfo([
          `${theme.textBold('Ralph Loop')} — iterative Work→Review until SHIP`,
          '',
          `  Usage: /ralph <task description>`,
          `  Options: /ralph --max <n> <task>  (default: 5 iterations)`,
          '',
          `  Worker model:   ${theme.accent(agent.getRoster()?.act ?? modelManager.getCurrentModel())}`,
          `  Reviewer model: ${theme.accent(agent.getRoster()?.plan ?? modelManager.getCurrentModel())}`,
          '',
          theme.dim('  State saved to .veepee/ralph/ — survives context compaction.'),
        ].join('\n'));
        return;
      }

      // Parse optional --max <n> flag
      let task = ralphTask;
      let maxIter = 5;
      const maxIdx = parts.indexOf('--max');
      if (maxIdx >= 0) {
        const parsed = parseInt(parts[maxIdx + 1] || '5', 10);
        if (!isNaN(parsed)) maxIter = Math.max(1, Math.min(20, parsed));
        // Remove --max and its value from the task string
        task = parts.slice(1)
          .filter((_, i) => i !== maxIdx - 1 && i !== maxIdx)
          .join(' ')
          .trim();
      }

      const ralph = new RalphEngine(config, agent.getRoster(), modelManager.getCurrentModel());

      tui.showInfo([
        `${theme.accent('Ralph Loop')} — ${maxIter} max iterations`,
        `  Worker:   ${theme.dim(agent.getRoster()?.act ?? modelManager.getCurrentModel())}`,
        `  Reviewer: ${theme.dim(agent.getRoster()?.plan ?? modelManager.getCurrentModel())}`,
        `  Task: ${task}`,
        '',
      ].join('\n'));

      for await (const event of ralph.run(task, maxIter)) {
        switch (event.type) {
          case 'worker_start':
            tui.showInfo(theme.dim(`\n[Iteration ${event.iteration}] Worker (${event.model}) producing...`));
            tui.startStream();
            break;
          case 'worker_chunk':
            tui.appendStream(event.content);
            break;
          case 'worker_done':
            tui.endStream();
            break;
          case 'reviewer_start':
            tui.showInfo(theme.dim(`[Iteration ${event.iteration}] Reviewer (${event.model}) evaluating...`));
            tui.startStream();
            break;
          case 'reviewer_chunk':
            tui.appendStream(event.content);
            break;
          case 'reviewer_done':
            tui.endStream();
            break;
          case 'decision': {
            const col = event.decision === 'SHIP'
              ? theme.success
              : event.decision === 'ABANDON'
                ? theme.error
                : theme.warning;
            tui.showInfo(`Decision: ${col(event.decision)}`);
            break;
          }
          case 'done': {
            const statusLabel: Record<string, string> = {
              shipped: theme.success('SHIPPED'),
              abandoned: theme.error('ABANDONED'),
              max_iterations_reached: theme.warning('MAX ITERATIONS'),
              running: theme.muted('INCOMPLETE'),
            };
            tui.showInfo([
              '',
              `${theme.textBold('Ralph complete')} — ${statusLabel[event.state.status] ?? event.state.status}`,
              `  Iterations: ${event.state.iteration}/${event.state.maxIterations}`,
              theme.dim(`  State saved to .veepee/ralph/${event.state.id}.json`),
            ].join('\n'));
            break;
          }
        }
      }
      return;
    }

    case '/add-dir': {
      const dirPath = parts.slice(1).join(' ');
      if (!dirPath) {
        tui.showInfo('Usage: /add-dir <path>');
        return;
      }
      const { existsSync: dirExists } = await import('fs');
      const { resolve: resolvePath } = await import('path');
      const resolved = resolvePath(dirPath);
      if (!dirExists(resolved)) {
        tui.showError(`Directory not found: ${resolved}`);
        return;
      }
      // Register as search path for @file resolution and tool operations
      agent.getContext().addSearchDir(resolved);
      agent.getContext().getKnowledgeState().updateMemory('fact', `Additional working directory: ${resolved}`);
      agent.getContext().invalidateProjectTree();
      tui.showInfo(`${theme.success('Added directory:')} ${resolved}`);
      tui.showInfo(theme.dim('  @file mentions and tools will now search this directory too.'));
      return;
    }

    case '/resume': {
      const query = parts.slice(1).join(' ');
      if (!query) {
        // Show session list for selection
        const sessions = await listSessions();
        if (sessions.length === 0) {
          tui.showInfo('No saved sessions.');
          return;
        }
        tui.showInfo(formatSessionList(sessions));
        tui.showInfo(theme.dim('Use /resume <name> to continue a session.'));
        return;
      }

      const session = await findSession(query);
      if (!session) {
        tui.showInfo(`${theme.error('Session not found:')} ${query}`);
        return;
      }

      // Clear current conversation and restore
      agent.clear();

      // Restore knowledge state if available (instead of replaying full history)
      if (session.knowledgeState) {
        const ks = new KnowledgeState(session.id);
        // Rebuild from saved data by loading it
        const savedKs = await KnowledgeState.load(session.id);
        if (savedKs) {
          agent.getContext().setKnowledgeState(savedKs);
        }
      }

      // Only restore recent messages (the sliding window worth)
      const recentMessages = session.messages.slice(-6);
      for (const msg of recentMessages) {
        if (msg.role === 'user') {
          agent.getContext().addUser(msg.content || '');
          tui.addUserMessage(msg.content || '');
        } else if (msg.role === 'assistant') {
          agent.getContext().addAssistant(msg.content || '', msg.tool_calls);
          tui.showInfo(msg.content || '');
        } else if (msg.role === 'tool') {
          agent.getContext().addToolResult('resumed', msg.content || '');
        }
      }

      // Restore model if available
      if (session.model) {
        const profile = modelManager.getProfile(session.model);
        if (profile) {
          agent.setModel(session.model);
          tui.updateModel(session.model);
        }
      }

      tui.showInfo(`${theme.success('Resumed:')} ${theme.accent(session.name)} (${session.messageCount} messages, knowledge state restored)`);
      return `session:${session.id}`;
    }

    // ─── Shell Commands ───────────────────────────────────────────────
    case '/shell':
    case '/sh':
      await runShellMode(tui);
      return;

    // ─── Sandbox Commands ──────────────────────────────────────────────
    case '/sandbox': {
      const subCmd = parts[1]?.toLowerCase();

      if (subCmd === 'keep') {
        const file = parts[2];
        const dest = parts[3];
        if (!file) {
          tui.showInfo('Usage: /sandbox keep <file> [destination]');
          return;
        }
        try {
          const destPath = await sandbox.keep(file, dest);
          tui.showInfo(`${theme.success('Kept:')} ${file} ${icons.arrow} ${destPath}`);
        } catch (err) {
          tui.showError((err as Error).message);
        }
        return;
      }

      if (subCmd === 'clean') {
        await sandbox.clean();
        tui.showInfo(theme.success('Sandbox cleaned.'));
        return;
      }

      if (subCmd === 'preview') {
        const file = parts[2];
        if (!file) {
          tui.showInfo('Usage: /sandbox preview <file>');
          return;
        }
        const filePath = sandbox.resolvePath(`sandbox:${file}`);
        try {
          const result = await preview.run(filePath);
          if (result.type === 'url') {
            tui.showInfo(`${theme.success('Preview:')} ${theme.accent(result.content)}`);
          } else {
            tui.showInfo(result.content);
          }
        } catch (err) {
          tui.showError((err as Error).message);
        }
        return;
      }

      // Default: list sandbox contents
      const files = await sandbox.list();
      if (files.length === 0) {
        tui.showInfo(theme.dim('Sandbox is empty.'));
      } else {
        const lines = files.map(f =>
          `  ${theme.accent(f.name.padEnd(30))} ${theme.dim(formatSize(f.size))}`
        );
        tui.showInfo(`${theme.textBold('Sandbox files:')}\n${lines.join('\n')}`);
        tui.showInfo(theme.dim(`  Path: ${sandbox.getPathSync()}`));
      }
      return;
    }

    // ─── Preview / Run Commands ─────────────────────────────────────────
    case '/preview':
    case '/run': {
      const fileArg = parts[1];
      if (!fileArg) {
        tui.showInfo('Usage: /preview <file> | /preview stop | /run <file>');
        return;
      }

      if (fileArg === 'stop') {
        preview.stopServer();
        tui.showInfo(theme.success('Preview server stopped.'));
        return;
      }

      const filePath = sandbox.resolvePath(fileArg);
      try {
        const result = await preview.run(filePath);
        if (result.type === 'url') {
          tui.showInfo(`${theme.success('Serving:')} ${theme.accent(result.content)}`);
        } else {
          tui.showInfo(result.content);
        }
      } catch (err) {
        tui.showError((err as Error).message);
      }
      return;
    }

    // ─── Sync Commands ──────────────────────────────────────────────────
    case '/sync': {
      if (!syncManager) {
        tui.showInfo([
          theme.error('Sync not configured.'),
          theme.dim('  Run /setup wizard sync, or add to ~/.veepee-code/settings.json:'),
          theme.dim('  "sync": { "url": "https://cloud.example.com/dav/...", "user": "...", "pass": "...", "auto": false }'),
        ].join('\n'));
        return;
      }

      const subCmd = parts[1]?.toLowerCase();

      if (subCmd === 'push') {
        const pushAll = parts[2] === 'all';
        tui.showInfo(theme.dim(pushAll ? 'Pushing all sessions...' : 'Pushing current session...'));
        try {
          if (pushAll) {
            await syncManager.push();
          } else if (currentSessionId) {
            await syncManager.push(currentSessionId);
          } else {
            tui.showInfo(theme.warning('No active session. Use /sync push all or /save first.'));
            return;
          }
          tui.showInfo(theme.success('Push complete.'));
        } catch (err) {
          tui.showError(`Sync push failed: ${(err as Error).message}`);
        }
        return;
      }

      if (subCmd === 'pull') {
        tui.showInfo(theme.dim('Pulling sessions...'));
        try {
          const pulled = await syncManager.pull();
          tui.showInfo(`${theme.success('Pull complete.')} ${pulled} session(s) updated.`);
        } catch (err) {
          tui.showError(`Sync pull failed: ${(err as Error).message}`);
        }
        return;
      }

      if (subCmd === 'auto') {
        const currentAuto = config.sync?.auto ?? false;
        syncManager.setAutoSync(!currentAuto);
        tui.showInfo(`Auto-sync ${!currentAuto ? theme.success('enabled') : theme.dim('disabled')}`);
        return;
      }

      if (subCmd === 'status') {
        const s = config.sync!;
        tui.showInfo([
          `${theme.textBold('Sync:')}`,
          `  URL:  ${theme.accent(s.url)}`,
          `  User: ${s.user}`,
          `  Auto: ${s.auto ? theme.success('on') : theme.dim('off')}`,
        ].join('\n'));
        return;
      }

      // Default: show help
      tui.showInfo([
        `${theme.textBold('Sync commands:')}`,
        `  ${theme.accent('/sync push')}       Push current session to WebDAV`,
        `  ${theme.accent('/sync push all')}   Push all sessions`,
        `  ${theme.accent('/sync pull')}       Pull sessions from WebDAV`,
        `  ${theme.accent('/sync auto')}       Toggle auto-sync`,
        `  ${theme.accent('/sync status')}     Show sync config`,
      ].join('\n'));
      return;
    }

    // ─── Remote Connect Commands ────────────────────────────────────────
    case '/rc': {
      const subCmd = parts[1]?.toLowerCase();

      if (!config.rc?.enabled) {
        tui.showInfo([
          `${theme.textBold('Remote Connect Setup')}`,
          '',
          `  RC lets you control VEEPEE Code from your phone or another device.`,
          `  It needs an API token (used as a password for access).`,
          '',
          `  ${theme.accent('Setting up...')}`,
        ].join('\n'));

        // Generate a token if none exists, or use the existing one
        const { generateRcToken } = await import('./rc.js');
        const { loadConfig: reloadConfig, saveConfigFile } = await import('./config.js');
        const currentConfig = reloadConfig();
        const token = currentConfig.apiToken || generateRcToken();

        // Enable RC and save token
        saveConfigFile({ ...currentConfig, rc: { enabled: true }, apiToken: token });
        config.rc = { enabled: true };
        config.apiToken = token;

        const url = `http://${getLocalIp()}:${apiPort}/rc?token=${token}`;
        tui.showInfo([
          `${theme.success('Remote Connect enabled!')}`,
          '',
          `  ${theme.textBold('URL:')}   ${theme.accent(url)}`,
          `  ${theme.textBold('Token:')} ${theme.dim(token)}`,
          '',
          `  Open the URL on your phone. The token is included in the link.`,
          `  ${theme.dim('Restart veepee-code for RC to take effect.')}`,
        ].join('\n'));
        return;
      }

      // Show RC status with QR code and URL
      const rcUrl = config.apiToken
        ? `http://${getLocalIp()}:${apiPort}/rc?token=${config.apiToken}`
        : `http://${getLocalIp()}:${apiPort}/rc`;

      try {
        const qrcode = await import('qrcode-terminal');
        const qrMod = qrcode.default || qrcode;
        qrMod.setErrorLevel?.('L');
        const code = await new Promise<string>((resolve) => {
          qrMod.generate(rcUrl, { small: true }, (qr: string) => resolve(qr));
        });
        tui.showInfo([
          `${theme.textBold('Remote Connect:')} ${theme.success('active')}`,
          '',
          code,
          '',
          `  ${theme.accent(rcUrl)}`,
        ].join('\n'));
      } catch {
        tui.showInfo([
          `${theme.textBold('Remote Connect:')} ${theme.success('active')}`,
          `  ${theme.accent(rcUrl)}`,
        ].join('\n'));
      }
      return;
    }

    default:
      tui.showInfo(`Unknown command: ${cmd}. Type /help for commands.`);
      return;
  }
}

/** Get local IP for RC URL display */
function getLocalIp(): string {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        const isIPv4 = net.family === 'IPv4' || String(net.family) === '4';
        if (isIPv4 && !net.internal) {
          return net.address;
        }
      }
    }
  } catch { /* fallback */ }
  return '127.0.0.1';
}

// Handle signals gracefully
process.on('SIGINT', () => { /* handled in TUI */ });
process.on('SIGTERM', () => process.exit(0));

// Crash handlers — log and exit cleanly so the terminal isn't left in alt-screen
process.on('uncaughtException', (err) => {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  console.error(chalk.red('Uncaught exception:'), err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  console.error(chalk.red('Unhandled rejection:'), reason);
  process.exit(1);
});


main().catch((err) => {
  // Make sure we exit alt screen on error
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
