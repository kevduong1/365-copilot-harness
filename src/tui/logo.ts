import { blendHex, shineOpacity, stringWidth } from "./format.js";
import { theme } from "./theme.js";
import type { Style } from "./buffer.js";

/** Braille spark from Grok Build (Apache-2.0, xai-org/grok-build). */
export const LOGO_FULL = `⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄
⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀
⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀
⠀⠀⣿⡇⠀⠀⠀⠔⠁⠀⠀⣿⡇⠀
⠀⠀⢹⣷⠀⠀⠀⠀⠀⢀⣴⡿⠀⠀
⠀⢀⠞⠁⠠⢶⣶⣶⣶⠿⠋⠀⠀⠀
⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀`;

export const LOGO_SMALL = `⠀⠀⠀⣀⣤⣤⣀⠀⠀⡠
⠀⢀⡾⠋⠁⠀⢁⢴⡎⠀
⠀⢸⡇⠀⠀⠐⠁⢀⣿⠀
⠀⢈⠗⢀⣀⣀⣠⡾⠃⠀
⠐⠁⠀⠈⠉⠉⠉⠀⠀⠀`;

const SMALL_MIN = 22;
const FULL_MIN = 26;

export function pickLogo(height: number): string | undefined {
  if (height < SMALL_MIN) return undefined;
  if (height < FULL_MIN) return LOGO_SMALL;
  return LOGO_FULL;
}

export function logoLines(logo: string): string[] {
  return logo.split("\n").filter((line) => line.length > 0);
}

export function logoSize(logo: string): { width: number; height: number } {
  const lines = logoLines(logo);
  return {
    width: lines.reduce((max, line) => Math.max(max, stringWidth(line)), 0),
    height: lines.length,
  };
}

export interface StyledChar {
  ch: string;
  style: Style;
}

export function shineLogo(logo: string, secs: number): StyledChar[][] {
  const lines = logoLines(logo);
  const rows = Math.max(lines.length, 1);
  const cols = Math.max(
    lines.reduce((max, line) => Math.max(max, [...line].length), 0),
    1,
  );
  return lines.map((line, row) => {
    const chars = [...line];
    return chars.map((ch, col) => {
      const diag = (col + (rows - 1 - row)) / (cols + rows);
      const color = blendHex(theme.gray, theme.textPrimary, shineOpacity(diag, secs));
      return { ch, style: { fg: color } };
    });
  });
}

export function logoVisualWidth(height: number): number {
  const logo = pickLogo(height);
  return logo === undefined ? 24 : logoSize(logo).width;
}
