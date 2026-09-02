import { colorRoles, derivedColors } from "./theme.js";

export function hexToRgb(hex: string): [number, number, number] {
  const short = hex.trim().replace(/^#/, "");
  const full = short.length === 3 ? short.replace(/./g, (ch) => ch + ch) : short;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`invalid hex colour: ${hex}`);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Per-channel linear interpolation. `t` clamps to [0, 1]. */
export function blendHex(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const k = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  return rgbToHex([
    Math.round(a[0]! + (b[0]! - a[0]!) * k),
    Math.round(a[1]! + (b[1]! - a[1]!) * k),
    Math.round(a[2]! + (b[2]! - a[2]!) * k),
  ]);
}

export function formatDuration(ms: number): string {
  const secs = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  const whole = Math.floor(secs);
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m${whole % 60}s`;
  return `${Math.floor(whole / 3600)}h${Math.floor((whole % 3600) / 60)}m`;
}

function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Turn-status token format — lowercase k/m. */
export function formatTurnTokens(n: number): string {
  const value = count(n);
  if (value < 1_000) return `${value}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(2)}k`;
  if (value < 100_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.floor(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/** Context-chip token format — uppercase K/M. */
export function formatContextTokens(n: number): string {
  const value = count(n);
  if (value < 1_000) return `${value}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value < 1_000_000) return `${Math.floor(value / 1_000)}K`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.floor(value / 1_000_000)}M`;
}

/** Always exactly 5 columns. */
export function formatPercent5(pct: number): string {
  const p = Number.isFinite(pct) && pct > 0 ? pct : 0;
  if (p >= 100) return "MAX %";
  let body = p < 10 ? p.toFixed(2) : p.toFixed(1);
  if (body.length > 4) body = p.toFixed(1);
  if (body.length > 4) return "MAX %";
  return `${body}%`;
}

const CONTEXT_STOPS: readonly (readonly [number, string])[] = [
  [0, colorRoles.soft],
  [50, colorRoles.bright],
  [65, colorRoles.bright],
  [75, derivedColors.warning],
  [85, derivedColors.warning],
  [95, derivedColors.error],
];

export function contextGradientHex(percent: number): string {
  const p = Number.isFinite(percent) ? percent : 0;
  const first = CONTEXT_STOPS[0]!;
  const last = CONTEXT_STOPS.at(-1)!;
  if (p <= first[0]) return first[1];
  if (p >= last[0]) return last[1];
  for (let index = 1; index < CONTEXT_STOPS.length; index += 1) {
    const [hi, hiHex] = CONTEXT_STOPS[index]!;
    if (p > hi) continue;
    const [lo, loHex] = CONTEXT_STOPS[index - 1]!;
    const span = hi - lo;
    return blendHex(loHex, hiHex, span === 0 ? 1 : (p - lo) / span);
  }
  return last[1];
}

export function formatCwd(cwd: string, home: string): string {
  const trim = (path: string) => (path.length > 1 ? path.replace(/[/\\]+$/, "") : path);
  const current = trim(cwd);
  const homeDir = trim(home);
  if (current === homeDir) return "~";
  const prefix = homeDir.endsWith("/") || homeDir.endsWith("\\") ? homeDir : `${homeDir}/`;
  const winPrefix = `${homeDir}\\`;
  if (current.startsWith(prefix)) return `~/${current.slice(prefix.length).replaceAll("\\", "/")}`;
  if (current.startsWith(winPrefix)) return `~/${current.slice(winPrefix.length).replaceAll("\\", "/")}`;
  return cwd;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  if (width === 1) return "…";
  let used = 0;
  let out = "";
  for (const char of text) {
    const next = charWidth(char);
    if (used + next > width - 1) break;
    out += char;
    used += next;
  }
  return `${out}…`;
}

export function padEndWidth(text: string, width: number): string {
  const extra = width - stringWidth(text);
  return extra > 0 ? `${text}${" ".repeat(extra)}` : text;
}

export function charWidth(char: string): number {
  const code = char.codePointAt(0);
  if (code === undefined || code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  if (code >= 0xfe00 && code <= 0xfe0f) return 0;
  if (code >= 0x200b && code <= 0x200f) return 0;
  if (code >= 0xfeff && code <= 0xfeff) return 0;
  if (isWide(code)) return 2;
  return 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1fa70 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const char of paragraph) {
      const next = Math.max(charWidth(char), 1);
      if (currentWidth + next > width && current.length > 0) {
        lines.push(current);
        current = char;
        currentWidth = next;
      } else {
        current += char;
        currentWidth += next;
      }
    }
    lines.push(current);
  }
  return lines;
}
