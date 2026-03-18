import { theme } from './theme.js';

// Block-pixel font — "VEEPEE CODE" inspired by OpenCode's style
const LOGO_LINES = [
  '██╗   ██╗███████╗███████╗██████╗ ███████╗███████╗',
  '██║   ██║██╔════╝██╔════╝██╔══██╗██╔════╝██╔════╝',
  '██║   ██║█████╗  █████╗  ██████╔╝█████╗  █████╗  ',
  '╚██╗ ██╔╝██╔══╝  ██╔══╝  ██╔═══╝ ██╔══╝  ██╔══╝  ',
  ' ╚████╔╝ ███████╗███████╗██║     ███████╗███████╗',
  '  ╚═══╝  ╚══════╝╚══════╝╚═╝     ╚══════╝╚══════╝',
  '',
  '          ██████╗ ██████╗ ██████╗ ███████╗',
  '         ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '         ██║     ██║   ██║██║  ██║█████╗  ',
  '         ██║     ██║   ██║██║  ██║██╔══╝  ',
  '         ╚██████╗╚██████╔╝██████╔╝███████╗',
  '          ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];

// Compact logo for narrow terminals
const LOGO_COMPACT = [
  '┃ veepee code ┃',
];

export function getLogo(maxWidth: number): string[] {
  const logoWidth = Math.max(...LOGO_LINES.map(l => l.length));
  if (maxWidth < logoWidth + 4) {
    return LOGO_COMPACT;
  }

  // Apply gradient coloring — top part (VEEPEE) warm, bottom part (CODE) cool
  return LOGO_LINES.map((line, i) => {
    if (i <= 5) {
      return theme.brand(line);
    } else if (i === 6) {
      return '';
    } else {
      return theme.text(line);
    }
  });
}

export function getLogoWidth(): number {
  return Math.max(...LOGO_LINES.map(l => l.length));
}

export function getLogoHeight(): number {
  return LOGO_LINES.length;
}
