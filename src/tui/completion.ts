import { filterCommands } from "./commands.js";
import { fuzzyFilter } from "./fuzzy.js";
import { atQuery, slashToken } from "./prompt.js";
import { MAX_SLASH_VISIBLE } from "./theme.js";
import type { TuiState } from "./types.js";

export type CompletionKind = "slash" | "file";

export interface CompletionItem {
  id: string;
  label: string;
  description: string;
  value: string;
}

export interface CompletionModel {
  kind: CompletionKind;
  /** Identifies the exact token being completed; changes reset selection. */
  signature: string;
  query: string;
  tokenStart: number;
  tokenEnd: number;
  items: CompletionItem[];
  selected: number;
  windowStart: number;
  dismissed: boolean;
}

interface CompletionCandidate {
  kind: CompletionKind;
  signature: string;
  query: string;
  tokenStart: number;
  tokenEnd: number;
  items: CompletionItem[];
}

function candidate(state: TuiState): CompletionCandidate | undefined {
  const slash = slashToken(state.prompt);
  if (slash !== undefined && !state.prompt.includes(" ")) {
    return {
      kind: "slash",
      signature: `slash:${slash}`,
      query: slash,
      tokenStart: 0,
      tokenEnd: slash.length,
      items: filterCommands(slash).map((command) => ({
        id: command.name,
        label: `/${command.name}`,
        description: command.description,
        value: command.name,
      })),
    };
  }

  const query = atQuery(state.prompt, state.cursor);
  if (query === undefined) return undefined;
  const tokenStart = state.cursor - query.length;
  return {
    kind: "file",
    signature: `file:${tokenStart}:${query}`,
    query,
    tokenStart,
    tokenEnd: state.cursor,
    items: fuzzyFilter(query, state.files).map((hit) => ({
      id: hit.text,
      label: hit.text,
      description: "",
      value: hit.text,
    })),
  };
}

function clampedIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index));
}

function visibleWindow(selected: number, previousStart: number, length: number): number {
  const maximum = Math.max(0, length - MAX_SLASH_VISIBLE);
  let start = Math.max(0, Math.min(maximum, previousStart));
  if (selected < start) start = selected;
  else if (selected >= start + MAX_SLASH_VISIBLE) start = selected - MAX_SLASH_VISIBLE + 1;
  return Math.max(0, Math.min(maximum, start));
}

/** Rebuild completion items after prompt, cursor, or file-list changes. */
export function syncCompletion(state: TuiState): TuiState {
  const next = candidate(state);
  if (next === undefined || next.items.length === 0) {
    return state.completion === undefined ? state : { ...state, completion: undefined };
  }
  const previous = state.completion;
  const sameQuery = previous?.signature === next.signature;
  const selected = clampedIndex(sameQuery ? previous.selected : 0, next.items.length);
  const windowStart = visibleWindow(
    selected,
    sameQuery ? previous.windowStart : 0,
    next.items.length,
  );
  return {
    ...state,
    completion: {
      ...next,
      selected,
      windowStart,
      dismissed: sameQuery ? previous.dismissed : false,
    },
  };
}

export function activeCompletion(state: TuiState): CompletionModel | undefined {
  const completion = state.completion;
  return completion === undefined || completion.dismissed || completion.items.length === 0
    ? undefined
    : completion;
}

export function moveCompletion(state: TuiState, delta: number): TuiState {
  const synced = syncCompletion(state);
  const completion = activeCompletion(synced);
  if (completion === undefined) return synced;
  const selected = clampedIndex(completion.selected + delta, completion.items.length);
  return {
    ...synced,
    completion: {
      ...completion,
      selected,
      windowStart: visibleWindow(selected, completion.windowStart, completion.items.length),
    },
  };
}

export function selectCompletion(state: TuiState, index: number): TuiState {
  const synced = syncCompletion(state);
  const completion = activeCompletion(synced);
  if (completion === undefined) return synced;
  const selected = clampedIndex(index, completion.items.length);
  return {
    ...synced,
    completion: {
      ...completion,
      selected,
      windowStart: visibleWindow(selected, completion.windowStart, completion.items.length),
    },
  };
}

export function dismissCompletion(state: TuiState): TuiState {
  const completion = activeCompletion(state);
  if (completion === undefined) return state;
  return { ...state, completion: { ...completion, dismissed: true } };
}

/** Insert the selected completion and close the menu. */
export function acceptCompletion(state: TuiState): TuiState {
  const completion = activeCompletion(state);
  if (completion === undefined) return state;
  const item = completion.items[completion.selected];
  if (item === undefined) return state;
  const replacement = completion.kind === "slash" ? `/${item.value} ` : `${item.value} `;
  const prompt =
    state.prompt.slice(0, completion.tokenStart) +
    replacement +
    state.prompt.slice(completion.tokenEnd);
  return {
    ...state,
    prompt,
    cursor: completion.tokenStart + replacement.length,
    completion: undefined,
    historyIndex: -1,
  };
}
