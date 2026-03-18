import { theme } from './theme.js';

// Block-pixel font inspired by OpenCode's style
const LOGO_LINES = [
  '██╗     ██╗      █████╗ ███╗   ███╗ █████╗ ',
  '██║     ██║     ██╔══██╗████╗ ████║██╔══██╗',
  '██║     ██║     ███████║██╔████╔██║███████║',
  '██║     ██║     ██╔══██║██║╚██╔╝██║██╔══██║',
  '███████╗███████╗██║  ██║██║ ╚═╝ ██║██║  ██║',
  '╚══════╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝',
  '',
  ' ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██║     ██║   ██║██║  ██║█████╗  ',
  '██║     ██║   ██║██║  ██║██╔══╝  ',
  '╚██████╗╚██████╔╝██████╔╝███████╗',
  ' ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

// Compact logo for narrow terminals
const LOGO_COMPACT = [
  '┃ llama code ┃',
];

export function getLogo(maxWidth: number): string[] {
  // Check if terminal is wide enough for the full logo
  const logoWidth = Math.max(...LOGO_LINES.map(l => l.length));
  if (maxWidth < logoWidth + 4) {
    return LOGO_COMPACT;
  }

  // Apply gradient coloring — top part (LLAMA) warm, bottom part (CODE) cool
  return LOGO_LINES.map((line, i) => {
    if (i <= 5) {
      // LLAMA — warm terracotta gradient
      return theme.brand(line);
    } else if (i === 6) {
      return '';
    } else {
      // CODE — brighter accent
      return theme.text(line);
    }
  });
}

/** Get the logo width for centering calculations */
export function getLogoWidth(): number {
  return Math.max(...LOGO_LINES.map(l => l.length));
}

export function getLogoHeight(): number {
  return LOGO_LINES.length;
}
