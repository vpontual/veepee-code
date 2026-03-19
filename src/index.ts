#!/usr/bin/env node

import chalk from 'chalk';
import { loadConfig } from './config.js';
import { ModelManager } from './models.js';
import { ToolRegistry } from './tools/registry.js';
import { Agent } from './agent.js';
import { PermissionManager } from './permissions.js';
import { Benchmarker } from './benchmark.js';
import { startApiServer } from './api.js';
import { TUI, theme, icons } from './tui/index.js';
import { validateIntegrations, formatSetupReport } from './setup.js';
import { saveSession, listSessions, findSession, formatSessionList, autoName } from './sessions.js';
import { MoeEngine, type MoeStrategy } from './moe.js';
import { KnowledgeState } from './knowledge.js';
import { createWorktree, listWorktrees, cleanupWorktrees, isGitRepo } from './worktree.js';

// Tool registrations
import { registerCodingTools } from './tools/coding.js';
import { registerWebTools } from './tools/web.js';
import { registerDevOpsTools } from './tools/devops.js';
import { registerHomeTools } from './tools/home.js';
import { registerSocialTools } from './tools/social.js';
import { registerGoogleTools } from './tools/google.js';
import { registerNewsTools } from './tools/news.js';

const VERSION = '0.2.0';


async function main() {
  const config = loadConfig();

  // Check for -p / --print mode (non-interactive, output to stdout)
  const printIdx = process.argv.findIndex(a => a === '-p' || a === '--print');
  const printQuery = printIdx >= 0 ? process.argv[printIdx + 1] : null;

  // Discover models
  const modelManager = new ModelManager(config);
  try {
    await modelManager.discover();
  } catch (err) {
    console.error(chalk.red(`Failed to connect to proxy at ${config.proxyUrl}`));
    console.error(chalk.dim((err as Error).message));
    process.exit(1);
  }

  const allModels = modelManager.getAllModels();
  if (allModels.length === 0) {
    console.error(chalk.red('No models found on the proxy. Is Ollama running?'));
    process.exit(1);
  }

  // Select initial model (may be updated after benchmark)
  let defaultModel = modelManager.selectDefault();
  let defaultProfile = modelManager.getProfile(defaultModel);

  // Register tools
  const registry = new ToolRegistry();
  for (const tool of registerCodingTools()) registry.register(tool);
  for (const tool of registerWebTools(config)) registry.register(tool);
  for (const tool of registerDevOpsTools()) registry.register(tool);
  for (const tool of registerHomeTools(config)) registry.register(tool);
  for (const tool of registerSocialTools(config)) registry.register(tool);
  for (const tool of registerGoogleTools(config)) registry.register(tool);
  for (const tool of registerNewsTools(config)) registry.register(tool);

  // Initialize permissions with TUI-based prompting
  const permissions = new PermissionManager();

  // Create agent
  const agent = new Agent(config, registry, modelManager, permissions);
  agent.getContext().setRegisteredTools(registry.names());
  agent.getContext().setSystemPrompt(defaultModel);

  // Print mode: run query, output to stdout, exit
  if (printQuery) {
    const jsonSchemaArg = process.argv.find(a => a.startsWith('--json-schema='));
    const jsonSchemaFile = jsonSchemaArg?.split('=')[1];

    // Auto-allow all permissions in print mode
    permissions.setPromptHandler(async () => 'y');
    let output = '';
    for await (const event of agent.run(printQuery)) {
      if (event.type === 'text' && event.content) {
        output += event.content;
        if (!jsonSchemaFile) process.stdout.write(event.content);
      } else if (event.type === 'error') {
        process.stderr.write(`Error: ${event.error}\n`);
      }
    }

    // If --json-schema was provided, validate and output as JSON
    if (jsonSchemaFile) {
      try {
        // Try to extract JSON from the response
        const jsonMatch = output.match(/```json\s*([\s\S]*?)```/) || output.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : output;
        const parsed = JSON.parse(jsonStr.trim());
        process.stdout.write(JSON.stringify(parsed, null, 2));
      } catch {
        // If can't parse as JSON, wrap the raw output
        process.stdout.write(JSON.stringify({ result: output.trim() }));
      }
    }

    process.stdout.write('\n');
    process.exit(0);
  }

  // Parse CLI flags
  const cliPort = process.argv.find(a => a.startsWith('--port='))?.split('=')[1];
  const cliHost = process.argv.find(a => a.startsWith('--host='))?.split('=')[1];

  // Start API server
  const apiPort = parseInt(cliPort || process.env.VEEPEE_CODE_API_PORT || '8484', 10);
  const apiHost = cliHost || process.env.VEEPEE_CODE_API_HOST || '127.0.0.1';
  const api = startApiServer({ port: apiPort, host: apiHost, agent, modelManager, registry });

  // Wait a tick for port fallback to resolve, then use actual bound port
  await new Promise(r => setTimeout(r, 50));
  const actualApiPort = api.port;

  // Initialize TUI
  const tui = new TUI();
  tui.start({
    model: defaultModel,
    modelSize: defaultProfile?.parameterSize || '',
    toolCount: registry.count(),
    modelCount: allModels.length,
    version: VERSION,
    apiPort: actualApiPort,
  });

  // Override permission prompting to use TUI
  permissions.setPromptHandler(async (toolName, args, reason) => {
    return tui.promptPermission(toolName, args, reason);
  });

  // Wire Ctrl+C abort
  tui.setAbortHandler(() => agent.abort());

  // First-launch: smart benchmark all models, build roster
  const benchmarker = new Benchmarker(config.proxyUrl);
  const existingRoster = await benchmarker.loadRoster();
  if (!existingRoster) {
    tui.showInfo(`${theme.accent('⚡ First launch')} — testing all your models to find the best for each role.`);
    tui.showInfo(theme.dim('Phase 1: Quick responsiveness check on all models'));
    tui.showInfo(theme.dim('Phase 2: Full benchmark on models fast enough for interactive use'));
    tui.showInfo(theme.dim('Phase 3: Assign best model per role (act, plan, chat, code, search)'));
    tui.showInfo('');

    try {
      const { results, roster } = await benchmarker.smartBenchmark(allModels, (phase, detail) => {
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

        // Apply roster — use act model as default
        if (roster.act) {
          const profile = modelManager.getProfile(roster.act);
          if (profile) {
            defaultModel = roster.act;
            defaultProfile = profile;
            agent.setModel(defaultModel);
            tui.updateModel(defaultModel, defaultProfile.parameterSize);
          }
        }
      }
    } catch (err) {
      tui.showInfo(theme.dim(`Benchmark failed: ${(err as Error).message}. Run /benchmark later.`));
    }
    tui.showInfo('');
  } else {
    // Roster exists — apply it
    if (existingRoster.act) {
      const profile = modelManager.getProfile(existingRoster.act);
      if (profile) {
        defaultModel = existingRoster.act;
        defaultProfile = profile;
        agent.setModel(defaultModel);
        tui.updateModel(defaultModel, defaultProfile.parameterSize);
      }
    }
  }

  // First-run onboarding: show what makes VEEPEE Code different
  const isFirstRun = !existingRoster;
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
      `  ${theme.dim('Run /setup to check integrations | /help for all commands')}`,
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

  // Handle --resume / -c CLI arguments
  let currentSessionId: string | null = null;
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

  // Main loop
  let sessionStart = Date.now();

  while (true) {
    // Update stats
    tui.updateStats(
      agent.getContext().estimateTokens(),
      Math.round((agent.getContext().estimateTokens() / 32000) * 100),
      agent.getContext().messageCount(),
      Date.now() - sessionStart,
    );

    let input: string;
    try {
      input = await tui.getInput();
    } catch {
      // EOF / Ctrl+D
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    // Handle commands
    if (trimmed.startsWith('/')) {
      // Show the command in the chat and clear the input box immediately
      tui.addUserMessage(trimmed);
      const result = await handleCommand(trimmed, tui, agent, modelManager, registry, permissions, config, actualApiPort, currentSessionId);
      if (result === true) break; // quit
      if (typeof result === 'string' && result.startsWith('session:')) {
        currentSessionId = result.slice(8) || null;
      }
      continue;
    }

    // Run agent
    tui.addUserMessage(trimmed);
    const turnStart = Date.now();

    tui.startStream();

    for await (const event of agent.run(trimmed)) {
      switch (event.type) {
        case 'text':
          if (event.content) {
            tui.appendStream(event.content);
          }
          break;

        case 'tool_call':
          // End any in-progress stream before showing tool call
          tui.endStream();
          tui.showToolCall(event.name!, event.args || {});
          break;

        case 'tool_result':
          tui.showToolResult(event.name!, event.success!, event.content || event.error || '');
          tui.startStream(); // resume streaming for next assistant text
          break;

        case 'permission_denied':
          tui.showPermissionDenied(event.name!);
          break;

        case 'model_switch':
          tui.showModelSwitch(event.from!, event.to!);
          tui.updateModel(event.to!);
          break;

        case 'thinking':
          tui.showThinking(event.content || '...');
          break;

        case 'error':
          tui.endStream();
          tui.showError(event.error || 'Unknown error');
          break;

        case 'done':
          tui.endStream();
          tui.showCompletionBadge(modelManager.getCurrentModel(), Date.now() - turnStart, {
            evalCount: event.evalCount,
            promptEvalCount: event.promptEvalCount,
            tokensPerSecond: event.tokensPerSecond,
          });
          break;
      }
    }

    // Update stats after each turn
    tui.updateStats(
      agent.getContext().estimateTokens(),
      Math.round((agent.getContext().estimateTokens() / 32000) * 100),
      agent.getContext().messageCount(),
      Date.now() - sessionStart,
    );
  }

  // Cleanup
  api.close();
  tui.stop();
  process.exit(0);
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
): Promise<boolean | string | void> {
  // Returns: true = quit, 'session:<id>' = set session ID, void = continue
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

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
        `  ${theme.accent('/clear')}            Clear history      ${theme.accent('/compact')}    Free context space`,
        `  ${theme.accent('/status')}           Session info       ${theme.accent('/quit')}       Exit`,
        `  ${theme.accent('/init')}             Create VEEPEE.md    ${theme.accent('/setup')}       Validate tools`,
        `  ${theme.accent('/save [name]')}      Save session        ${theme.accent('/sessions')}    List saved sessions`,
        `  ${theme.accent('/resume <name>')}    Resume a session    ${theme.accent('/rename <name>')} Rename session`,
        `  ${theme.accent('/add-dir <path>')}   Add working dir     ${theme.accent('/worktree')}     Git worktree isolation`,
        `  ${theme.accent('/effort low|med|hi')} Set response depth`,
        '',
        `${theme.textBold('Modes:')}`,
        `  ${theme.accent('/plan')}   Plan mode — thinking ON, heavy model, clarifying questions first`,
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
        `${theme.textBold('Keys:')}`,
        `  ${theme.dim('Enter')} submit  ${theme.dim('Shift+Enter')} newline  ${theme.dim('Tab')} tools  ${theme.dim('Ctrl+P')} commands  ${theme.dim('Ctrl+C')} interrupt`,
        `  ${theme.dim('Ctrl+L')} clear  ${theme.dim('Ctrl+D')} quit  ${theme.dim('Up/Down')} history  ${theme.dim('Scroll/PgUp/PgDn')} scroll`,
      ].join('\n'));
      return false;

    case '/clear':
      agent.clear();
      permissions.resetSession();
      tui.showInfo('Conversation cleared.');
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

    case '/compact': {
      const ctx = agent.getContext();
      if (ctx.messageCount() <= 6) {
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

    case '/model': {
      const modelArg = parts[1];
      if (!modelArg) {
        tui.showInfo(`Current model: ${theme.accent(modelManager.getCurrentModel())}`);
        return false;
      }
      if (modelArg === 'auto') {
        modelManager.setAutoSwitch(true);
        tui.showInfo('Auto model switching enabled.');
        return false;
      }
      const match = modelManager.getAllModels().find(m =>
        m.name === modelArg || m.name.startsWith(modelArg)
      );
      if (!match) {
        tui.showError(`Model not found: ${modelArg}. Use /models to list.`);
        return false;
      }
      agent.setModel(match.name);
      modelManager.setAutoSwitch(false);
      tui.updateModel(match.name, match.parameterSize);
      tui.showInfo(`Switched to ${theme.accent(match.name)} (auto-switch disabled)`);
      return false;
    }

    case '/models':
      tui.showInfo(modelManager.formatModelList());
      return false;

    case '/tools': {
      const tools = registry.list().sort((a, b) => a.name.localeCompare(b.name));
      const lines = tools.map(t =>
        `  ${theme.accent(t.name.padEnd(20))} ${theme.dim(t.description.slice(0, 60))}`
      );
      tui.showInfo(`${theme.textBold(`${tools.length} tools:`)}\n${lines.join('\n')}`);
      return false;
    }

    case '/status':
      tui.showInfo([
        `${theme.textBold('Session:')}`,
        `  Model:    ${theme.accent(modelManager.getCurrentModel())}`,
        `  Messages: ${agent.getContext().messageCount()}`,
        `  Tokens:   ~${agent.getContext().estimateTokens().toLocaleString()}`,
        `  Tools:    ${registry.count()}`,
        `  API:      http://localhost:${apiPort}`,
        `  CWD:      ${process.cwd()}`,
      ].join('\n'));
      return false;

    case '/benchmark': {
      const subCmd = parts[1]?.toLowerCase();

      if (subCmd === 'results' || subCmd === 'show') {
        const b = new Benchmarker(config.proxyUrl);
        const results = await b.loadLatest();
        if (!results) {
          tui.showInfo('No benchmark results. Run /benchmark to generate.');
        } else {
          tui.showInfo(Benchmarker.formatTable(results));
        }
        return false;
      }

      if (subCmd === 'summary') {
        const b = new Benchmarker(config.proxyUrl);
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
        const b = new Benchmarker(config.proxyUrl);
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
        });
        tui.showInfo(Benchmarker.formatTable(results));
        return false;
      }

      const filter = (['heavy', 'standard', 'light'] as const).find(t => t === subCmd) || undefined;
      const candidates = modelManager.getAllModels()
        .filter(m => !m.capabilities.includes('embedding') || m.capabilities.length > 1)
        .filter(m => !filter || m.tier === filter);

      tui.showInfo(`Running benchmarks on ${candidates.length} models... This may take a while.`);

      const b = new Benchmarker(config.proxyUrl);
      const results = await b.benchmarkAll(candidates, {
        filter,
        skipContextProbing: true, // fast by default, use /benchmark context for full probing
        onProgress: (model, test, mi, mt, ti, tt) => {
          tui.showInfo(`[${mi}/${mt}] ${model} — ${test} (${ti}/${tt})`);
        },
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

    case '/plan': {
      if (agent.getMode() === 'plan') {
        tui.showInfo('Already in plan mode.');
        return false;
      }
      const { model } = agent.enterPlanMode();
      tui.updateModel(model);
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
      tui.updateModel(modelManager.getCurrentModel());
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
      tui.updateModel(chatModel);
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
      );
      // Also save the knowledge state file
      await ks.save();
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
        const session = await saveSession(
          newName,
          agent.getContext().getAllMessages(),
          modelManager.getCurrentModel(),
          agent.getMode(),
          process.cwd(),
          undefined,
          agent.getContext().getKnowledgeState().getData(),
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
      );
      tui.showInfo(`${theme.success('Renamed to:')} ${theme.accent(newName)}`);
      return `session:${session.id}`;
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
      // Add to knowledge state and invalidate project tree cache
      agent.getContext().getKnowledgeState().updateMemory('fact', `Additional working directory: ${resolved}`);
      agent.getContext().invalidateProjectTree();
      tui.showInfo(`${theme.success('Added directory:')} ${resolved}`);
      tui.showInfo(theme.dim('The model will be aware of this directory. Use @file paths relative to it.'));
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

    default:
      tui.showInfo(`Unknown command: ${cmd}. Type /help for commands.`);
      return;
  }
}

// Handle signals gracefully
process.on('SIGINT', () => { /* handled in TUI */ });
process.on('SIGTERM', () => process.exit(0));

main().catch((err) => {
  // Make sure we exit alt screen on error
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
