import { charWidth, hexToRgb } from "./format.js";
import { terminalCapabilities, type TerminalColorMode } from "./capabilities.js";

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Cell {
  ch: string;
  style: Style;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function styleKey(style: Style): string {
  return `${style.fg ?? ""}|${style.bg ?? ""}|${style.bold === true ? 1 : 0}|${style.dim === true ? 1 : 0}|${style.italic === true ? 1 : 0}|${style.underline === true ? 1 : 0}`;
}

function sameStyle(a: Style, b: Style): boolean {
  return styleKey(a) === styleKey(b);
}

function emptyCell(bg: string, defaultBackground: boolean): Cell {
  return { ch: " ", style: defaultBackground ? {} : { bg } };
}

export class ScreenBuffer {
  readonly cols: number;
  readonly rows: number;
  readonly bg: string;
  readonly colorMode: TerminalColorMode;
  readonly defaultBackground: boolean;
  private readonly cells: Cell[];

  constructor(
    cols: number,
    rows: number,
    bg: string,
    colorMode: TerminalColorMode = terminalCapabilities().colorMode,
    defaultBackground = terminalCapabilities().defaultBackground === true,
  ) {
    this.cols = Math.max(0, cols);
    this.rows = Math.max(0, rows);
    this.bg = bg;
    this.colorMode = colorMode;
    this.defaultBackground = defaultBackground;
    this.cells = Array.from({ length: this.cols * this.rows }, () => emptyCell(bg, defaultBackground));
  }

  at(x: number, y: number): Cell | undefined {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return undefined;
    return this.cells[y * this.cols + x];
  }

  put(x: number, y: number, ch: string, style: Style = {}): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const cell = this.cells[y * this.cols + x];
    if (cell === undefined) return;
    cell.ch = safeCellChar(ch);
    cell.style = {
      ...style,
      ...(style.bg === undefined && !this.defaultBackground ? { bg: this.bg } : {}),
    };
  }

  fill(rect: Rect, style: Style = {}): void {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(this.cols, rect.x + rect.w);
    const y1 = Math.min(this.rows, rect.y + rect.h);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        this.put(x, y, " ", style);
      }
    }
  }

  /** Write text honoring character display width (wide glyphs occupy two cells). */
  text(x: number, y: number, value: string, style: Style = {}, maxWidth?: number): number {
    let col = x;
    const limit = maxWidth === undefined ? this.cols - x : Math.min(maxWidth, this.cols - x);
    const end = x + Math.max(0, limit);
    for (const ch of value) {
      const width = Math.max(charWidth(ch), ch === "" ? 0 : 1);
      if (width === 0) continue;
      if (col + width > end) break;
      this.put(col, y, ch, style);
      if (width === 2 && col + 1 < end) this.put(col + 1, y, " ", style);
      col += width;
    }
    return col - x;
  }

  dump(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y += 1) {
      let line = "";
      for (let x = 0; x < this.cols; x += 1) {
        const cell = this.at(x, y);
        const ch = cell?.ch ?? " ";
        line += ch === "" ? " " : ch;
      }
      lines.push(line.replace(/\s+$/u, ""));
    }
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    return lines.join("\n");
  }

  diffAnsi(previous: ScreenBuffer | undefined): string {
    if (previous === undefined || previous.cols !== this.cols || previous.rows !== this.rows) {
      return this.fullAnsi();
    }
    let out = "";
    let lastX = -2;
    let lastY = -2;
    let lastStyle = "";
    for (let y = 0; y < this.rows; y += 1) {
      for (let x = 0; x < this.cols; x += 1) {
        const next = this.at(x, y)!;
        const prev = previous.at(x, y)!;
        if (next.ch === prev.ch && sameStyle(next.style, prev.style)) continue;
        if (x !== lastX + 1 || y !== lastY) out += `\x1b[${y + 1};${x + 1}H`;
        const key = styleKey(next.style);
        if (key !== lastStyle) {
          out += sgr(next.style, this.bg, this.colorMode, this.defaultBackground);
          lastStyle = key;
        }
        out += next.ch === "" ? " " : next.ch;
        lastX = x;
        lastY = y;
      }
    }
    return out;
  }

  fullAnsi(): string {
    let out = "\x1b[H\x1b[J";
    let lastStyle = "";
    for (let y = 0; y < this.rows; y += 1) {
      if (y > 0) out += "\r\n";
      for (let x = 0; x < this.cols; x += 1) {
        const cell = this.at(x, y)!;
        if (cell.ch === "") continue;
        const key = styleKey(cell.style);
        if (key !== lastStyle) {
          out += sgr(cell.style, this.bg, this.colorMode, this.defaultBackground);
          lastStyle = key;
        }
        out += cell.ch;
      }
    }
    return out;
  }
}

/** Never let rendered conversation or tool text become terminal instructions. */
function safeCellChar(ch: string): string {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(ch) ? "�" : ch;
}

export function sgr(
  style: Style,
  fallbackBg: string,
  colorMode: TerminalColorMode = terminalCapabilities().colorMode,
  defaultBackground = terminalCapabilities().defaultBackground === true,
): string {
  const parts = ["0"];
  if (style.bold === true) parts.push("1");
  if (style.dim === true) parts.push("2");
  if (style.italic === true) parts.push("3");
  if (style.underline === true) parts.push("4");
  if (colorMode === "truecolor") {
    const fg = rgbSeq(style.fg);
    if (fg !== undefined) parts.push(`38;2;${fg}`);
    const bg = rgbSeq(style.bg ?? (defaultBackground ? undefined : fallbackBg));
    if (bg !== undefined) parts.push(`48;2;${bg}`);
  }
  return `\x1b[${parts.join(";")}m`;
}

function rgbSeq(hex: string | undefined): string | undefined {
  if (hex === undefined) return undefined;
  const [r, g, b] = hexToRgb(hex);
  return `${r};${g};${b}`;
}

export function inset(rect: Rect, dx: number, dy = dx): Rect {
  return {
    x: rect.x + dx,
    y: rect.y + dy,
    w: Math.max(0, rect.w - dx * 2),
    h: Math.max(0, rect.h - dy * 2),
  };
}

export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}
