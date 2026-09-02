import type { Rect, ScreenBuffer, Style } from "./buffer.js";
import { glyphs, type GlyphSet } from "./glyphs.js";
import { stringWidth, truncate } from "./format.js";

export function drawBox(
  buf: ScreenBuffer,
  rect: Rect,
  style: Style,
  options: {
    title?: string;
    footer?: string;
    titleStyle?: Style;
    footerStyle?: Style;
    glyphs?: GlyphSet;
  } = {},
): Rect {
  if (rect.w < 2 || rect.h < 2) return rect;
  const set = options.glyphs ?? glyphs;
  const h = set.boxH;
  const v = set.boxV;
  buf.text(rect.x, rect.y, set.boxTl, style);
  buf.text(rect.x + rect.w - 1, rect.y, set.boxTr, style);
  buf.text(rect.x, rect.y + rect.h - 1, set.boxBl, style);
  buf.text(rect.x + rect.w - 1, rect.y + rect.h - 1, set.boxBr, style);
  const top = h.repeat(Math.max(0, rect.w - 2));
  const bottom = h.repeat(Math.max(0, rect.w - 2));
  buf.text(rect.x + 1, rect.y, top, style);
  buf.text(rect.x + 1, rect.y + rect.h - 1, bottom, style);
  for (let y = 1; y < rect.h - 1; y += 1) {
    buf.text(rect.x, rect.y + y, v, style);
    buf.text(rect.x + rect.w - 1, rect.y + y, v, style);
  }
  if (options.title !== undefined && options.title.length > 0 && rect.w > 8) {
    const label = ` ${truncate(options.title, rect.w - 8)} `;
    const x = rect.x + rect.w - 1 - stringWidth(label) - 2;
    if (x > rect.x + 1) buf.text(x, rect.y, label, options.titleStyle ?? style);
  }
  if (options.footer !== undefined && options.footer.length > 0 && rect.w > 6) {
    const label = ` ${truncate(options.footer, rect.w - 6)} `;
    const x = rect.x + rect.w - 1 - stringWidth(label) - 1;
    if (x > rect.x) buf.text(x, rect.y + rect.h - 1, label, options.footerStyle ?? style);
  }
  return { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 };
}

export function hline(
  buf: ScreenBuffer,
  x: number,
  y: number,
  width: number,
  style: Style,
  set: GlyphSet = glyphs,
): void {
  buf.text(x, y, set.boxH.repeat(Math.max(0, width)), style);
}

export function joinHints(parts: string[], width: number): string {
  const sep = "  ";
  let out = "";
  for (const part of parts) {
    const next = out.length === 0 ? part : `${out}${sep}${part}`;
    if (stringWidth(next) > width) break;
    out = next;
  }
  return out;
}
