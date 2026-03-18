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

// Tool registrations
import { registerCodingTools } from './tools/coding.js';
import { registerWebTools } from './tools/web.js';
import { registerDevOpsTools } from './tools/devops.js';
import { registerHomeTools } from './tools/home.js';
import { registerSocialTools } from './tools/social.js';
import { registerGoogleTools } from './tools/google.js';
import { registerNewsTools } from './tools/news.js';

const VERSION = '0.1.0';

const INIT_PROMPT = `Analyze this codebase and create a LLAMA.md file in the project root. This file will be automatically loaded into your system prompt on every session, so it must be high-quality and useful.

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

Write the LLAMA.md file using write_file. Be specific and actionable — vague guidelines are useless. Every line should help an agent write better code in this specific project.`;

async function main() {
  const config = loadConfig();

  // Discover models (before TUI starts, so we can show loading)
  console.log(chalk.dim('  Connecting to proxy...'));
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

  // Select default model
  const defaultModel = modelManager.selectDefault();
  const defaultProfile = modelManager.getProfile(defaultModel);

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
  const apiPort = parseInt(process.env.LLAMA_CODE_API_PORT || '8484', 10);
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
      const shouldQuit = await handleCommand(trimmed, tui, agent, modelManager, registry, permissions, config, apiPort);
      if (shouldQuit) break;
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
): Promise<boolean> {
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
        `  ${theme.accent('/init')}             Create LLAMA.md    ${theme.accent('/setup')}       Validate tools`,
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

    case '/act': {
      if (agent.getMode() === 'act') {
        tui.showInfo('Already in act mode.');
        return false;
      }
      agent.exitPlanMode();
      tui.updateModel(modelManager.getCurrentModel());
      tui.showInfo([
        `${theme.accent('Act mode activated')}`,
        `  ${theme.dim('Thinking:')} OFF — fast execution`,
        `  ${theme.dim('Auto-switch:')} ON — model adapts to task complexity`,
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
      const llamaMdPath = `${process.cwd()}/LLAMA.md`;
      const exists = await import('fs').then(fs => fs.existsSync(llamaMdPath));

      tui.showInfo(`Analyzing project to ${exists ? 'improve' : 'create'} LLAMA.md...`);
      tui.addUserMessage(INIT_PROMPT + (exists ? '\n\nThere is already a LLAMA.md in this directory. Read it and improve it — keep what\'s good, add what\'s missing, fix what\'s wrong.' : ''));

      // Run through the agent to let the model analyze and create LLAMA.md
      tui.startStream();
      const turnStart = Date.now();

      for await (const event of agent.run(INIT_PROMPT + (exists ? '\n\nThere is already a LLAMA.md in this directory. Read it and improve it.' : ''))) {
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

            // Auto-add LLAMA.md to .gitignore if it's a git repo and not already ignored
            try {
              const { execSync } = await import('child_process');
              const isGit = await import('fs').then(fs => fs.existsSync(`${process.cwd()}/.git`));
              if (isGit) {
                const gitignorePath = `${process.cwd()}/.gitignore`;
                const fs = await import('fs');
                if (fs.existsSync(gitignorePath)) {
                  const content = fs.readFileSync(gitignorePath, 'utf-8');
                  if (!content.includes('LLAMA.md')) {
                    fs.appendFileSync(gitignorePath, '\n# Llama Code project instructions\nLLAMA.md\n');
                    tui.showInfo(`${theme.success('Added LLAMA.md to .gitignore')}`);
                  }
                } else {
                  fs.writeFileSync(gitignorePath, '# Llama Code project instructions\nLLAMA.md\n');
                  tui.showInfo(`${theme.success('Created .gitignore with LLAMA.md')}`);
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

    default:
      tui.showInfo(`Unknown command: ${cmd}. Type /help for commands.`);
      return false;
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
