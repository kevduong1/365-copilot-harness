import { wrapText } from "./format.js";

export interface PromptSnapshot {
  text: string;
  cursor: number;
}

export function insertText(snapshot: PromptSnapshot, value: string): PromptSnapshot {
  const text = snapshot.text.slice(0, snapshot.cursor) + value + snapshot.text.slice(snapshot.cursor);
  return { text, cursor: snapshot.cursor + value.length };
}

export function deleteBackward(snapshot: PromptSnapshot): PromptSnapshot {
  if (snapshot.cursor === 0) return snapshot;
  return {
    text: snapshot.text.slice(0, snapshot.cursor - 1) + snapshot.text.slice(snapshot.cursor),
    cursor: snapshot.cursor - 1,
  };
}

export function deleteForward(snapshot: PromptSnapshot): PromptSnapshot {
  if (snapshot.cursor >= snapshot.text.length) return snapshot;
  return {
    text: snapshot.text.slice(0, snapshot.cursor) + snapshot.text.slice(snapshot.cursor + 1),
    cursor: snapshot.cursor,
  };
}

export function killLine(snapshot: PromptSnapshot): PromptSnapshot {
  return { text: snapshot.text.slice(0, snapshot.cursor), cursor: snapshot.cursor };
}

export function move(snapshot: PromptSnapshot, delta: number): PromptSnapshot {
  return {
    text: snapshot.text,
    cursor: Math.max(0, Math.min(snapshot.text.length, snapshot.cursor + delta)),
  };
}

export function wrappedCursor(text: string, cursor: number, width: number): { row: number; col: number } {
  const before = text.slice(0, cursor);
  const lines = wrapText(before, Math.max(1, width));
  const last = lines.at(-1) ?? "";
  return { row: Math.max(0, lines.length - 1), col: last.length };
}

export function promptLines(text: string, width: number): string[] {
  const lines = wrapText(text.length === 0 ? "" : text, Math.max(1, width));
  return lines.length === 0 ? [""] : lines;
}

export function slashToken(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  if (text.includes("\n")) return undefined;
  const token = text.split(/\s+/)[0] ?? "";
  return token;
}

/**
 * The local command behind a `!` passthrough line, or undefined when the prompt
 * is not one. A bare `!` is ordinary text.
 */
export function bangCommand(text: string): string | undefined {
  if (!text.startsWith("!")) return undefined;
  const command = text.slice(1).trim();
  return command.length === 0 ? undefined : command;
}

export function atQuery(text: string, cursor: number): string | undefined {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)@([^\s]*)$/.exec(before);
  return match?.[1];
}
