export interface GlyphSet {
  prompt: string;
  boxTl: string;
  boxTr: string;
  boxBl: string;
  boxBr: string;
  boxH: string;
  boxV: string;
  rail: string;
  railCollapsed: string;
  bullet: string;
  group: string;
  list: string;
  quote: string;
  rule: string;
  sep: string;
  tokenDown: string;
  check: string;
  cross: string;
  waiting: string;
}

export const unicodeGlyphs: GlyphSet = {
  prompt: "›",
  boxTl: "╭",
  boxTr: "╮",
  boxBl: "╰",
  boxBr: "╯",
  boxH: "─",
  boxV: "│",
  rail: "│",
  railCollapsed: "┆",
  bullet: "·",
  group: "△",
  list: "•",
  quote: "│",
  rule: "───",
  sep: "│",
  tokenDown: "↓",
  check: "✓",
  cross: "✕",
  waiting: "△",
};

export const asciiGlyphs: GlyphSet = {
  prompt: ">",
  boxTl: "+",
  boxTr: "+",
  boxBl: "+",
  boxBr: "+",
  boxH: "-",
  boxV: "|",
  rail: "|",
  railCollapsed: ":",
  bullet: "-",
  group: "^",
  list: "-",
  quote: ">",
  rule: "---",
  sep: "|",
  tokenDown: "v",
  check: "OK",
  cross: "X",
  waiting: "^",
};

export const glyphs = unicodeGlyphs;

export function glyphsFor(unicode: boolean): GlyphSet {
  return unicode ? unicodeGlyphs : asciiGlyphs;
}

export function promptArrow(set: GlyphSet = glyphs): string {
  return `${set.prompt} `;
}

export const PROMPT_ARROW_WIDTH = 2;
export const UNICODE_SPINNER_FRAMES = ["◜", "◝", "◞", "◟"] as const;
export const ASCII_SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;
