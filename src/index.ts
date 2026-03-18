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

// Tool registrations
import { registerCodingTools } from './tools/coding.js';
import { registerWebTools } from './tools/web.js';
import { registerDevOpsTools } from './tools/devops.js';
import { registerHomeTools } from './tools/home.js';
import { registerSocialTools } from './tools/social.js';
import { registerGoogleTools } from './tools/google.js';
import { registerNewsTools } from './tools/news.js';

const VERSION = '0.1.0';

const INIT_PROMPT = `Analyze this codebase and create a VEEPEE.md file in the project root. This file will be automatically loaded into your system prompt on every session, so it must be high-quality and useful.

The file should contain (~150 lines):

1. **Project overview** — What this project does, in 2-3 sentences.

2. **Tech stack** — Language, framework, key libraries/dependencies.

3. **Build/lint/test commands** — The exact commands to build, lint, typecheck, and test this project. Especially include how to run a SINGLE test file or test case (this is critical for agent workflows).

4. **Code style guidelines** — Import ordering, formatting rules, naming conventions (camelCase vs snake_case, etc.), type usage, error handling patterns. Infer these from the existing code — don't guess.

5. **Architecture notes** — Key directories, where to find what, important patterns (e.g., "all API routes are in src/routes/", "we use repository pattern for DB access").

6. **Common gotchas** — Things an agent might get wrong (e.g., "always run migrations before tests", "this project uses pnpm not npm", "env vars must be in both .env and docker-compose.yml").

To create this file:
- Use glob and list_files to understand the project structure
- Read package.json, Cargo.toml, requirements.txt, pyproject.toml, or equivalent for dependencies and scripts
- Read a few representative source files to understand code style
- Check for existing config files: .eslintrc, .prettierrc, tsconfig.json, ruff.toml, .editorconfig, etc.
- Check for existing instruction files: .cursor/rules/, .cursorrules, .github/copilot-instructions.md, CLAUDE.md, AGENTS.md, OpenCode.md, GEMINI.md — incorporate relevant content
- Check README.md for project description and setup instructions

Write the VEEPEE.md file using write_file. Be specific and actionable — vague guidelines are useless. Every line should help an agent write better code in this specific project.`;

async function main() {
  const config = loadConfig();

  // Discover models (before TUI starts, so we can show loading)
  // Discover models (quick — just fetches /api/tags)
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
  agent.getContext().setSystemPrompt(defaultModel);

  // Start API server
  const apiPort = parseInt(process.env.VEEPEE_CODE_API_PORT || '8484', 10);
  const api = startApiServer({ port: apiPort, agent, modelManager, registry });

  // Initialize TUI
  const tui = new TUI();
  tui.start({
    model: defaultModel,
    modelSize: defaultProfile?.parameterSize || '',
    toolCount: registry.count(),
    modelCount: allModels.length,
    version: VERSION,
    apiPort,
  });

  // Override permission prompting to use TUI
  permissions.setPromptHandler(async (toolName, args, reason) => {
    return tui.promptPermission(toolName, args, reason);
  });

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

  // Handle --resume CLI argument
  let currentSessionId: string | null = null;
  const resumeArg = process.argv.find(a => a === '--resume' || a.startsWith('--resume='));
  if (resumeArg) {
    const query = resumeArg.includes('=') ? resumeArg.split('=')[1] : process.argv[process.argv.indexOf('--resume') + 1];
    if (query) {
      const session = await findSession(query);
      if (session) {
        // Restore conversation
        for (const msg of session.messages) {
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
        tui.showInfo(`${theme.success('Resumed session:')} ${theme.accent(session.name)} (${session.messageCount} messages)`);
      } else {
        tui.showInfo(`${theme.error('Session not found:')} ${query}`);
      }
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
      const result = await handleCommand(trimmed, tui, agent, modelManager, registry, permissions, config, apiPort, currentSessionId);
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
          tui.showCompletionBadge(modelManager.getCurrentModel(), Date.now() - turnStart);
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
        `  ${theme.accent('/resume <name>')}    Resume a session`,
        '',
        `${theme.textBold('Modes:')}`,
        `  ${theme.accent('/plan')}   Plan mode — thinking ON, heavy model, clarifying questions first`,
        `  ${theme.accent('/act')}    Act mode  — thinking OFF, all tools, auto-switch (default)`,
        `  ${theme.accent('/chat')}   Chat mode — fast model, web search only, no file access`,
        `  ${theme.dim('  Plan auto-activates on "plan", "think through", "design", etc.')}`,
        '',
        `${theme.textBold('Benchmark:')}`,
        `  ${theme.accent('/benchmark')}        Benchmark all      ${theme.accent('/benchmark heavy')}  Heavy only`,
        `  ${theme.accent('/benchmark results')} Show results      ${theme.accent('/benchmark summary')}`,
        '',
        `${theme.textBold('Keys:')}`,
        `  ${theme.dim('Enter')} submit  ${theme.dim('Tab')} tools  ${theme.dim('Ctrl+P')} commands  ${theme.dim('Ctrl+L')} clear  ${theme.dim('Ctrl+D')} quit  ${theme.dim('Up/Down')} history`,
      ].join('\n'));
      return false;

    case '/clear':
      agent.clear();
      permissions.resetSession();
      tui.showInfo('Conversation cleared.');
      return false;

    case '/compact':
      if (agent.getContext().compact()) {
        tui.showInfo('Conversation compacted.');
      } else {
        tui.showInfo('No compaction needed.');
      }
      return false;

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

      const filter = (['heavy', 'standard', 'light'] as const).find(t => t === subCmd) || undefined;
      const candidates = modelManager.getAllModels()
        .filter(m => !m.capabilities.includes('embedding') || m.capabilities.length > 1)
        .filter(m => !filter || m.tier === filter);

      tui.showInfo(`Running benchmarks on ${candidates.length} models... This may take a while.`);

      const b = new Benchmarker(config.proxyUrl);
      const results = await b.benchmarkAll(candidates, {
        filter,
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
        `  ${theme.dim('Tools:')} All 25 tools available`,
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
      tui.showInfo([
        `${theme.accent('Chat mode activated')}`,
        `  ${theme.dim('Model:')} ${chatModel} (fast, conversational)`,
        `  ${theme.dim('Tools:')} web_search, web_fetch, weather, news (no file access)`,
        `  ${theme.dim('Exit:')} /act to switch back to coding mode`,
      ].join('\n'));
      return false;
    }

    case '/setup': {
      tui.showInfo('Validating integrations...');
      const results = await validateIntegrations(config);
      tui.showInfo(formatSetupReport(results));
      return false;
    }

    case '/init': {
      const llamaMdPath = `${process.cwd()}/VEEPEE.md`;
      const exists = await import('fs').then(fs => fs.existsSync(llamaMdPath));

      tui.showInfo(`Analyzing project to ${exists ? 'improve' : 'create'} VEEPEE.md...`);
      tui.addUserMessage(INIT_PROMPT + (exists ? '\n\nThere is already a VEEPEE.md in this directory. Read it and improve it — keep what\'s good, add what\'s missing, fix what\'s wrong.' : ''));

      // Run through the agent to let the model analyze and create VEEPEE.md
      tui.startStream();
      const turnStart = Date.now();

      for await (const event of agent.run(INIT_PROMPT + (exists ? '\n\nThere is already a VEEPEE.md in this directory. Read it and improve it.' : ''))) {
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
          case 'done':
            tui.endStream();
            tui.showCompletionBadge(modelManager.getCurrentModel(), Date.now() - turnStart);

            // Auto-add VEEPEE.md to .gitignore if it's a git repo and not already ignored
            try {
              const { execSync } = await import('child_process');
              const isGit = await import('fs').then(fs => fs.existsSync(`${process.cwd()}/.git`));
              if (isGit) {
                const gitignorePath = `${process.cwd()}/.gitignore`;
                const fs = await import('fs');
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
            break;
          case 'error':
            tui.endStream();
            tui.showError(event.error || 'Failed to analyze project');
            break;
          default:
            break;
        }
      }
      return false;
    }

    // ─── Session Commands ─────────────────────────────────────────────
    case '/save': {
      const name = parts.slice(1).join(' ') || autoName(agent.getContext().getMessages());
      if (agent.getContext().messageCount() === 0) {
        tui.showInfo('Nothing to save — start a conversation first.');
        return;
      }
      const session = await saveSession(
        name,
        agent.getContext().getMessages(),
        modelManager.getCurrentModel(),
        agent.getMode(),
        process.cwd(),
        currentSessionId || undefined,
      );
      tui.showInfo(`${theme.success('Saved:')} ${theme.accent(session.name)} ${theme.dim(`(ID: ${session.id})`)}`);
      return `session:${session.id}`;
    }

    case '/sessions': {
      const sessions = await listSessions();
      tui.showInfo(formatSessionList(sessions));
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
      for (const msg of session.messages) {
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

      tui.showInfo(`${theme.success('Resumed:')} ${theme.accent(session.name)} (${session.messageCount} messages)`);
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
