/** Canonical Waypoint swatches from the approved visual reference. */
export const palette = {
  jetBlack: "#0D0D0F",
  carbon: "#1A1C1F",
  slate: "#2A2D31",
  graphite: "#3C4046",
  steel: "#5A6068",
  garminBlue: "#007CC3",
  skyBlue: "#4DA6D9",
  iceBlue: "#8FB3C8",
} as const;

/**
 * The eight reference swatches do not include accessible neutral body text or
 * semantic states. Keep those deliberate exceptions named and centralized.
 */
export const derivedColors = {
  text: "#F3F4F6",
  textDim: "#D2D6DA",
  mutedText: "#969CA4",
  success: "#66C28A",
  error: "#FF747A",
  warning: "#F2C14E",
  violet: "#B9A7E8",
  string: "#91C990",
  number: "#FFB17A",
} as const;

/** Structural and interaction roles map directly to the canonical swatches. */
export const colorRoles = {
  base: palette.jetBlack,
  surface: palette.carbon,
  elevated: palette.slate,
  panel: palette.carbon,
  border: palette.graphite,
  borderStrong: palette.steel,
  muted: palette.iceBlue,
  selection: palette.slate,
  primary: palette.garminBlue,
  bright: palette.skyBlue,
  soft: palette.iceBlue,
  codeBackground: palette.carbon,
} as const;

export const syntax = {
  comment: derivedColors.mutedText,
  keyword: derivedColors.violet,
  function: palette.skyBlue,
  variable: derivedColors.textDim,
  string: derivedColors.string,
  number: derivedColors.number,
  type: palette.iceBlue,
  operator: palette.iceBlue,
  punctuation: derivedColors.mutedText,
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
  bgBase: colorRoles.base,
  bgLight: colorRoles.elevated,
  bgDark: colorRoles.surface,
  bgHighlight: colorRoles.panel,
  bgVisual: colorRoles.selection,
  textPrimary: derivedColors.text,
  textSecondary: derivedColors.textDim,
  gray: colorRoles.muted,
  grayDim: derivedColors.mutedText,
  grayBright: derivedColors.textDim,
  accentUser: colorRoles.bright,
  // Garmin Blue is reserved for non-text emphasis; Sky Blue clears AA on Jet.
  accentAssistant: colorRoles.bright,
  accentThinking: colorRoles.soft,
  accentTool: derivedColors.mutedText,
  accentSuccess: derivedColors.success,
  accentError: derivedColors.error,
  accentRunning: colorRoles.bright,
  command: derivedColors.warning,
  warning: derivedColors.warning,
  path: colorRoles.bright,
  promptBorder: colorRoles.border,
  promptBorderActive: colorRoles.primary,
  mdMuted: derivedColors.mutedText,
  mdText: derivedColors.text,
  mdCode: colorRoles.bright,
  mdCodeBg: colorRoles.codeBackground,
  linkFg: colorRoles.bright,
  heading: [
    derivedColors.text,
    colorRoles.bright,
    colorRoles.soft,
    derivedColors.success,
    derivedColors.warning,
    derivedColors.violet,
  ],
  captionFocused: derivedColors.textDim,
  captionUnfocused: derivedColors.mutedText,
};

export const SPINNER_MS = 160;
export const OUTER_HPAD = 2;
export const OUTER_VPAD = 1;
export const MAX_SLASH_VISIBLE = 6;
export const ESC_DOUBLE_MS = 800;
export const QUIT_CONFIRM_MS = 1000;
export const TOOL_DISPLAY_LIMIT = 4_000;
