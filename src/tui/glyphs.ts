export const glyphs = {
  prompt: "❯",
  boxTl: "╭",
  boxTr: "╮",
  boxBl: "╰",
  boxBr: "╯",
  boxH: "─",
  boxV: "│",
  rail: "┃",
  railCollapsed: "❙",
  bullet: "◆",
  group: "◈",
  list: "•",
  quote: "│",
  rule: "───",
  sep: "│",
  tokenDown: "⇣",
  check: "✓",
  cross: "✗",
  waiting: "◆",
} as const;

export const PROMPT_ARROW = `${glyphs.prompt} `;
export const PROMPT_ARROW_WIDTH = 2;
