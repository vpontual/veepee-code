import chalk from 'chalk';
import { Marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

const marked = new Marked(TerminalRenderer as never);

/** Render markdown to terminal-formatted string */
export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text) as string;
  } catch {
    return text;
  }
}

/** Show a tool call being executed */
export function renderToolCall(name: string, args: Record<string, unknown>): void {
  const argsStr = Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string'
        ? (v.length > 80 ? v.slice(0, 77) + '...' : v)
        : JSON.stringify(v);
      return `${chalk.dim(k)}=${val}`;
    })
    .join(' ');

  console.log(chalk.cyan(`  ◆ ${name}`) + (argsStr ? ` ${argsStr}` : ''));
}

/** Show a tool result */
export function renderToolResult(name: string, success: boolean, output: string, error?: string): void {
  if (success) {
    // Show truncated output
    const lines = output.split('\n');
    if (lines.length > 5) {
      const preview = lines.slice(0, 4).join('\n');
      console.log(chalk.dim(`  ${preview}\n  ... (${lines.length - 4} more lines)`));
    } else if (output.length > 0) {
      console.log(chalk.dim(`  ${output}`));
    }
  } else {
    console.log(chalk.red(`  ✗ ${error || 'Unknown error'}`));
  }
}

/** Show model switch notification */
export function renderModelSwitch(from: string, to: string): void {
  console.log(chalk.yellow(`\n  ⟳ Model switch: ${from} → ${to}\n`));
}

/** Show startup banner */
export function renderBanner(
  version: string,
  proxyUrl: string,
  serverCount: number,
  modelCount: number,
  activeModel: string,
  toolCount: number,
  cwd: string,
): void {
  console.log('');
  console.log(chalk.bold('  ⚡ VEEPEE Code') + chalk.dim(` v${version}`));
  console.log(chalk.dim(`  Proxy: ${proxyUrl} (${serverCount} servers, ${modelCount} models)`));
  console.log(chalk.dim(`  Model: `) + chalk.cyan(activeModel));
  console.log(chalk.dim(`  Tools: ${toolCount} available`));
  console.log(chalk.dim(`  CWD:   ${cwd}`));
  console.log('');
  console.log(chalk.dim('  Type /help for commands, /quit to exit'));
  console.log('');
}

/** Show help text */
export function renderHelp(): void {
  console.log(`
${chalk.bold('Commands:')}
  ${chalk.cyan('/model <name>')}    Switch to a specific model
  ${chalk.cyan('/model auto')}      Re-enable auto model switching
  ${chalk.cyan('/models')}          List all available models with rankings
  ${chalk.cyan('/tools')}           List all available tools
  ${chalk.cyan('/clear')}           Clear conversation history
  ${chalk.cyan('/compact')}         Compact conversation to free context
  ${chalk.cyan('/status')}          Show current session status
  ${chalk.cyan('/help')}            Show this help
  ${chalk.cyan('/quit')}            Exit VEEPEE Code
`);
}

/** Render a spinner-style status */
export function statusLine(text: string): { stop: () => void } {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(frames[i++ % frames.length])} ${chalk.dim(text)}`);
  }, 80);
  return {
    stop: () => {
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(text.length + 4) + '\r');
    },
  };
}
