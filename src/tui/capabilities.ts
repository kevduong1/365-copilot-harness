export type TerminalColorMode = "none" | "truecolor";

export interface TerminalCapabilities {
  colorMode: TerminalColorMode;
  unicode: boolean;
  reducedMotion: boolean;
  /** Leave base cells on the terminal's configured background. */
  defaultBackground?: boolean;
}

export function terminalCapabilities(env: NodeJS.ProcessEnv = process.env): TerminalCapabilities {
  const term = (env.TERM ?? "").toLowerCase();
  const dumb = term === "dumb";
  const noColor = Object.prototype.hasOwnProperty.call(env, "NO_COLOR");
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? "";
  const explicitlyNonUnicode = /^(?:c|posix)(?:\.|$)/i.test(locale) && !/utf-?8/i.test(locale);
  const reducedMotion = dumb || /^(?:1|true|yes)$/i.test(env.REDUCE_MOTION ?? "");
  const defaultBackground = /^(?:1|true|yes)$/i.test(env.TUI_TRANSPARENT ?? "");
  return {
    colorMode: dumb || noColor ? "none" : "truecolor",
    unicode: !dumb && !explicitlyNonUnicode,
    reducedMotion,
    defaultBackground,
  };
}
