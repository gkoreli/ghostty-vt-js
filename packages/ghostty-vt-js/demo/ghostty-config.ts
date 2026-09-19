import type { ITheme } from '../src/browser-terminal/interfaces.js';

export interface ResolvedGhosttyConfig {
  fontFamily?: string;
  fontSize?: number;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  theme: ITheme;
}

const PALETTE_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const satisfies readonly (keyof ITheme)[];

/** Map resolved `ghostty +show-config` output into browser-terminal options. */
export function mapGhosttyShowConfig(text: string): ResolvedGhosttyConfig {
  const config: ResolvedGhosttyConfig = { theme: {} };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    switch (key) {
      case 'font-family':
        config.fontFamily ??= value;
        break;
      case 'font-size': {
        const size = Number(value);
        if (Number.isFinite(size) && size > 0) config.fontSize = size;
        break;
      }
      case 'cursor-style':
        if (value === 'block' || value === 'underline' || value === 'bar') {
          config.cursorStyle = value;
        }
        break;
      case 'cursor-style-blink':
        if (value === 'true' || value === 'false') config.cursorBlink = value === 'true';
        break;
      case 'background':
        config.theme.background = value;
        break;
      case 'foreground':
        config.theme.foreground = value;
        break;
      case 'cursor-color':
        config.theme.cursor = value;
        break;
      case 'cursor-text':
        config.theme.cursorAccent = value;
        break;
      case 'selection-background':
        config.theme.selectionBackground = value;
        break;
      case 'selection-foreground':
        config.theme.selectionForeground = value;
        break;
      case 'palette': {
        const paletteSeparator = value.indexOf('=');
        if (paletteSeparator < 0) break;
        const index = Number(value.slice(0, paletteSeparator));
        const color = value.slice(paletteSeparator + 1).trim();
        const themeKey = PALETTE_KEYS[index];
        if (themeKey && color) config.theme[themeKey] = color;
        break;
      }
    }
  }

  return config;
}
