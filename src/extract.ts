import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

function languageHint(element: HTMLElement): string {
  const code = element.matches("code") ? element : element.querySelector("code");
  const candidates = [
    code?.getAttribute("data-language"),
    element.getAttribute("data-language"),
    code?.className,
    element.className,
  ];

  for (const candidate of candidates) {
    const match = candidate?.match(/(?:language-|lang-)([\w#+.-]+)/i);
    if (match?.[1]) return match[1];
    if (candidate && /^[\w#+.-]+$/.test(candidate)) return candidate;
  }
  return "";
}

function fenceFor(code: string): string {
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function normalizeLanguageLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  const aliases: Record<string, string> = {
    "c#": "csharp",
    "c++": "cpp",
    "plain text": "text",
    powershell: "powershell",
    shell: "bash",
    typescript: "typescript",
  };
  return aliases[normalized] ?? normalized.replace(/[^\w#+.-]/g, "");
}

function copilotCodePreview(element: HTMLElement): string {
  const editor = element.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Code editor"]',
  );
  if (editor == null) return "";

  const lines = Array.from(editor.querySelectorAll<HTMLElement>("[data-line-index]"))
    .sort(
      (left, right) =>
        Number(left.getAttribute("data-line-index") ?? 0) -
        Number(right.getAttribute("data-line-index") ?? 0),
    )
    .map((line) => line.textContent ?? "");
  if (lines.length === 0) return "";

  const code = lines.join("\n");
  const languageLabel =
    element.querySelector<HTMLElement>('#language-badge[aria-label]')?.getAttribute("aria-label") ??
    "";
  const language = normalizeLanguageLabel(languageLabel);
  const fence = fenceFor(code);
  return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
}

/**
 * Turndown collapses whitespace in ordinary divs before custom rules run.
 * Copilot renders source lines as divs, so temporarily marking each line as
 * preformatted preserves indentation for the code-preview rule below.
 */
function protectCopilotCodeLineWhitespace(html: string): string {
  return html.replace(
    /<div(\s[^>]*\bdata-line-index=(?:"[^"]*"|'[^']*')[^>]*)>([\s\S]*?)<\/div>/gi,
    "<pre$1>$2</pre>",
  );
}

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  headingStyle: "atx",
});
turndown.use(gfm);

turndown.addRule("copilotCodePreview", {
  filter: (node) =>
    node.nodeType === 1 &&
    (node as HTMLElement).getAttribute("role") === "group" &&
    (node as HTMLElement).getAttribute("aria-label") === "Code Preview",
  replacement: (_content, node) => copilotCodePreview(node as HTMLElement),
});

turndown.addRule("copilotFencedCode", {
  filter: "pre",
  replacement: (_content, node) => {
    const element = node as HTMLElement;
    const code = (element.textContent ?? "").replace(/\n$/, "");
    const fence = fenceFor(code);
    return `\n\n${fence}${languageHint(element)}\n${code}\n${fence}\n\n`;
  },
});

turndown.addRule("copilotCitations", {
  filter: (node) => {
    if (node.nodeType !== 1) return false;
    const element = node as HTMLElement;
    const marker = [
      element.getAttribute("data-testid"),
      element.getAttribute("aria-label"),
      element.getAttribute("class"),
    ]
      .filter(Boolean)
      .join(" ");
    return (
      /citation|reference|source-chip/i.test(marker) ||
      (element.tagName === "SUP" && /^\s*\[?\d+\]?\s*$/.test(element.textContent ?? ""))
    );
  },
  replacement: () => "",
});

export function extractMarkdown(html: string): string {
  return turndown
    .turndown(protectCopilotCodeLineWhitespace(html))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
