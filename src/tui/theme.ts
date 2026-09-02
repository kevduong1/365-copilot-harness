/**
 * Oscura Midnight chrome palette, byte-exact from Grok Build
 * (`xai-grok-pager-render` ThemeKind::OscuraMidnight, Apache-2.0).
 */

export const palette = {
  base: "#030304",
  surface: "#040507",
  elevated: "#0F1216",
  panel: "#040406",
  text: "#E4E4E4",
  textDim: "#BEBEBE",
  muted: "#81868F",
  subtle: "#5E646C",
  gold: "#EBD96E",
  red: "#DC5A64",
  teal: "#50B48C",
  amber: "#F1BD00",
  purple: "#9B7ECE",
  purpleDim: "#6E5A9A",
  purpleBright: "#C4A7E7",
  cyan: "#7DCFDF",
  highlightLow: "#12101C",
  highlightMed: "#242034",
  highlightHigh: "#343048",
  diffDeleteBg: "#2D0F19",
  diffInsertBg: "#0A231E",
  captionFocused: "#737374",
  captionUnfocused: "#4E4E4E",
} as const;

export const syntax = {
  comment: "#51597d",
  keyword: "#bb9af7",
  function: "#7aa2f7",
  variable: "#c8c8c8",
  string: "#9ece6a",
  number: "#ff9e64",
  type: "#0db9d7",
  operator: "#89ddff",
  punctuation: "#9abdf5",
} as const;

export interface Theme {
  bgBase: string;
  bgLight: string;
  bgDark: string;
  bgHighlight: string;
  bgVisual: string;
  textPrimary: string;
  textSecondary: string;
  gray: string;
  grayDim: string;
  grayBright: string;
  accentUser: string;
  accentAssistant: string;
  accentThinking: string;
  accentTool: string;
  accentSuccess: string;
  accentError: string;
  accentRunning: string;
  command: string;
  warning: string;
  path: string;
  promptBorder: string;
  promptBorderActive: string;
  mdMuted: string;
  mdText: string;
  mdCode: string;
  mdCodeBg: string;
  linkFg: string;
  heading: readonly [string, string, string, string, string, string];
  captionFocused: string;
  captionUnfocused: string;
}

export const theme: Theme = {
  bgBase: palette.base,
  bgLight: palette.elevated,
  bgDark: palette.surface,
  bgHighlight: palette.elevated,
  bgVisual: palette.highlightMed,
  textPrimary: palette.text,
  textSecondary: palette.textDim,
  gray: palette.muted,
  grayDim: palette.subtle,
  grayBright: palette.textDim,
  accentUser: palette.purpleBright,
  accentAssistant: palette.purple,
  accentThinking: palette.muted,
  accentTool: palette.subtle,
  accentSuccess: palette.teal,
  accentError: palette.red,
  accentRunning: palette.purpleDim,
  command: palette.gold,
  warning: palette.gold,
  path: palette.amber,
  promptBorder: palette.highlightMed,
  promptBorderActive: palette.highlightHigh,
  mdMuted: palette.muted,
  mdText: palette.text,
  mdCode: palette.cyan,
  mdCodeBg: palette.surface,
  linkFg: palette.cyan,
  heading: [
    palette.text,
    palette.purpleBright,
    palette.purple,
    palette.teal,
    palette.gold,
    palette.cyan,
  ],
  captionFocused: palette.captionFocused,
  captionUnfocused: palette.captionUnfocused,
};

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
export const SPINNER_MS = 133;
export const SHIMMER_FPS = 12;
export const OUTER_HPAD = 2;
export const OUTER_VPAD = 1;
export const MAX_SLASH_VISIBLE = 6;
export const ESC_DOUBLE_MS = 800;
export const QUIT_CONFIRM_MS = 1000;
export const TOOL_DISPLAY_LIMIT = 4_000;
