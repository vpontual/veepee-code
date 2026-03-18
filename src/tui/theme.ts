import chalk from 'chalk';

// VEEPEE Code color palette — warm tones inspired by llama wool
export const theme = {
  // Primary
  brand: chalk.hex('#E8A87C'),          // warm terracotta
  brandBold: chalk.hex('#E8A87C').bold,
  accent: chalk.hex('#85C7F2'),          // sky blue
  accentBold: chalk.hex('#85C7F2').bold,

  // Text
  text: chalk.white,
  textBold: chalk.white.bold,
  dim: chalk.gray,
  dimmer: chalk.hex('#555555'),
  muted: chalk.hex('#888888'),

  // Status
  success: chalk.hex('#7EC8A0'),         // sage green
  error: chalk.hex('#E57373'),           // soft red
  warning: chalk.hex('#FFD93D'),         // warm yellow
  info: chalk.hex('#85C7F2'),            // sky blue

  // UI Elements
  border: chalk.hex('#555555'),
  borderFocused: chalk.hex('#85C7F2'),
  bg: chalk.bgHex('#1A1A2E'),
  inputBg: chalk.bgHex('#252540'),
  highlight: chalk.bgHex('#2A2A4A'),

  // Roles
  user: chalk.hex('#85C7F2'),
  assistant: chalk.white,
  tool: chalk.hex('#E8A87C'),
  system: chalk.hex('#888888'),

  // Scores
  scoreHigh: chalk.hex('#7EC8A0'),
  scoreMed: chalk.hex('#FFD93D'),
  scoreLow: chalk.hex('#E57373'),
};

// Box drawing characters
export const box = {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│',
  ltee: '├', rtee: '┤',
  cross: '┼',
  thickH: '━', thickV: '┃',
  roundTl: '╭', roundTr: '╮', roundBl: '╰', roundBr: '╯',
};

// Icons
export const icons = {
  llama: '⚡',
  check: '✓',
  cross: '✗',
  dot: '●',
  circle: '○',
  arrow: '→',
  tool: '◆',
  toolDone: '◇',
  thinking: '◐',
  prompt: '▎',
  block: '█',
  lock: '🔒',
  unlock: '🔓',
  warn: '⚠',
  info: 'ℹ',
  up: '▲',
  down: '▼',
};
