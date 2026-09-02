import { syntax, theme, type Theme } from "./theme.js";
import type { Style } from "./buffer.js";
import { wrapText } from "./format.js";
import { glyphs, type GlyphSet } from "./glyphs.js";

export interface RichSpan {
  text: string;
  style: Style;
}

export interface RichLine {
  spans: RichSpan[];
}

export function renderMarkdown(
  source: string,
  width: number,
  options: { raw?: boolean; glyphs?: GlyphSet } = {},
): RichLine[] {
  const set = options.glyphs ?? glyphs;
  if (options.raw === true) {
    return wrapText(source, width).map((text) => ({ spans: [{ text, style: { fg: theme.mdText } }] }));
  }
  const lines: RichLine[] = [];
  const blocks = source.replaceAll("\r\n", "\n").split("\n");
  let inFence = false;
  let fenceLang = "";
  const code: string[] = [];

  const flushCode = (): void => {
    for (const line of code) {
      const highlighted = highlightLine(line, fenceLang);
      const padded = padTo(highlighted, width);
      lines.push({
        spans: padded.map((span) => ({
          ...span,
          style: { ...span.style, bg: theme.mdCodeBg },
        })),
      });
    }
    code.length = 0;
    fenceLang = "";
  };

  for (const line of blocks) {
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (inFence) {
        flushCode();
        inFence = false;
      } else {
        inFence = true;
        fenceLang = (fence[2] ?? "").trim().split(/\s+/)[0] ?? "";
      }
      continue;
    }
    if (inFence) {
      code.push(line);
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      lines.push({ spans: [{ text: set.rule, style: { fg: theme.mdMuted } }] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length, 6);
      const color = theme.heading[level - 1] ?? theme.textPrimary;
      const italic = level === 4;
      lines.push(
        ...wrapInline(heading[2] ?? "", width, { fg: color, bold: true, ...(italic ? { italic: true } : {}) }),
      );
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      const inner = wrapInline(quote[1] ?? "", Math.max(1, width - 2), { fg: theme.mdText });
      for (const wrapped of inner) {
        lines.push({
          spans: [{ text: `${set.quote} `, style: { fg: theme.mdMuted } }, ...wrapped.spans],
        });
      }
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      const inner = wrapInline(ul[1] ?? "", Math.max(1, width - 2), { fg: theme.mdText });
      inner.forEach((wrapped, index) => {
        const bullet = index === 0 ? `${set.list} ` : "  ";
        lines.push({
          spans: [{ text: bullet, style: { fg: theme.mdMuted } }, ...wrapped.spans],
        });
      });
      continue;
    }
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ol) {
      const marker = `${ol[1]}. `;
      const inner = wrapInline(ol[2] ?? "", Math.max(1, width - marker.length), { fg: theme.mdText });
      inner.forEach((wrapped, index) => {
        const prefix = index === 0 ? marker : " ".repeat(marker.length);
        lines.push({
          spans: [{ text: prefix, style: { fg: theme.mdMuted } }, ...wrapped.spans],
        });
      });
      continue;
    }
    if (line.trim() === "") {
      lines.push({ spans: [{ text: "", style: {} }] });
      continue;
    }
    lines.push(...wrapInline(line, width, { fg: theme.mdText }));
  }
  if (inFence) flushCode();
  return lines;
}

function padTo(spans: RichSpan[], width: number): RichSpan[] {
  let used = 0;
  for (const span of spans) used += span.text.length;
  if (used >= width) return spans;
  return [...spans, { text: " ".repeat(width - used), style: { bg: theme.mdCodeBg } }];
}

function wrapInline(text: string, width: number, base: Style): RichLine[] {
  const spans = parseInline(text, base);
  const lines: RichLine[] = [{ spans: [] }];
  let used = 0;
  const push = (span: RichSpan): void => {
    const pieces = wrapText(span.text, width);
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index]!;
      if (index > 0 || used + piece.length > width) {
        lines.push({ spans: [] });
        used = 0;
      }
      if (piece.length === 0 && index < pieces.length - 1) continue;
      lines.at(-1)!.spans.push({ text: piece, style: span.style });
      used += piece.length;
    }
  };
  for (const span of spans) push(span);
  return lines;
}

function parseInline(text: string, base: Style): RichSpan[] {
  const spans: RichSpan[] = [];
  const pattern =
    /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ text: text.slice(last, index), style: { ...base } });
    const token = match[0]!;
    if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ text: token.slice(2, -2), style: { ...base, bold: true } });
    } else if (token.startsWith("`")) {
      spans.push({ text: token.slice(1, -1), style: { fg: theme.mdCode, bold: true } });
    } else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]"));
      spans.push({ text: label, style: { fg: theme.linkFg, underline: true } });
    } else {
      spans.push({ text: token.slice(1, -1), style: { ...base, italic: true } });
    }
    last = index + token.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), style: { ...base } });
  return spans.length > 0 ? spans : [{ text, style: { ...base } }];
}

const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "class",
  "import",
  "export",
  "from",
  "async",
  "await",
  "new",
  "try",
  "catch",
  "throw",
  "interface",
  "type",
  "enum",
  "true",
  "false",
  "null",
  "undefined",
  "def",
  "fn",
  "pub",
  "struct",
  "impl",
  "use",
  "match",
  "case",
  "break",
  "continue",
  "yield",
]);

function highlightLine(line: string, _lang: string): RichSpan[] {
  const spans: RichSpan[] = [];
  const re =
    /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w]*\b|[(){}\[\],.;:]|=>|===|!==|&&|\|\||[+\-*/%=<>!]+)/g;
  let last = 0;
  for (const match of line.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ text: line.slice(last, index), style: { fg: syntax.variable } });
    const token = match[0]!;
    let fg: string = syntax.variable;
    if (token.startsWith("//") || token.startsWith("#") || token.startsWith("/*")) fg = syntax.comment;
    else if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) fg = syntax.string;
    else if (/^\d/.test(token)) fg = syntax.number;
    else if (KEYWORDS.has(token)) fg = syntax.keyword;
    else if (/^[(){}\[\],.;:]+$/.test(token)) fg = syntax.punctuation;
    else if (/^[+\-*/%=<>!&|]+$/.test(token) || token === "=>") fg = syntax.operator;
    spans.push({ text: token, style: { fg } });
    last = index + token.length;
  }
  if (last < line.length) spans.push({ text: line.slice(last), style: { fg: syntax.variable } });
  return spans.length > 0 ? spans : [{ text: line, style: { fg: syntax.variable } }];
}

export function themeHeadingColor(level: number, current: Theme = theme): string {
  return current.heading[Math.min(5, Math.max(0, level - 1))] ?? current.textPrimary;
}
