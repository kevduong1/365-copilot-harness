import { blendHex, stringWidth } from "./format.js";
import { theme } from "./theme.js";
import type { Style } from "./buffer.js";

/**
 * An original navigation mark for the harness. The open bearing, waypoint,
 * and route stem keep it distinct from solid outdoor-navigation wordmarks.
 */
export const WAYPOINT_FULL_UNICODE = `       △
      ╱ ╲
     ╱ ◇ ╲
    ╱  │  ╲
   ╱───┼───╲
       ╵`;

export const WAYPOINT_FULL_ASCII = `       ^
      / \\
     / o \\
    /  |  \\
   /---+---\\
       |`;

export const WAYPOINT_COMPACT_UNICODE = `  ╱△╲
 ╱ ◇ ╲
   ╵`;

export const WAYPOINT_COMPACT_ASCII = ` /\\
<o>
 |`;

export const WAYPOINT_SYMBOL_UNICODE = "△";
export const WAYPOINT_SYMBOL_ASCII = "^";

export type WaypointVariant = "full" | "compact" | "symbol";

export interface WaypointMark {
  art: string;
  variant: WaypointVariant;
}

export interface WaypointSpace {
  width: number;
  height: number;
  unicode?: boolean;
}

/** Choose a mark using the actual drawable area, not the terminal height alone. */
export function pickWaypointMark(space: WaypointSpace): WaypointMark | undefined {
  const unicode = space.unicode !== false;
  if (space.width >= 64 && space.height >= 18) {
    return { art: unicode ? WAYPOINT_FULL_UNICODE : WAYPOINT_FULL_ASCII, variant: "full" };
  }
  if (space.width >= 40 && space.height >= 10) {
    return { art: unicode ? WAYPOINT_COMPACT_UNICODE : WAYPOINT_COMPACT_ASCII, variant: "compact" };
  }
  if (space.width >= 16 && space.height >= 5) {
    return { art: unicode ? WAYPOINT_SYMBOL_UNICODE : WAYPOINT_SYMBOL_ASCII, variant: "symbol" };
  }
  return undefined;
}

export function waypointLines(mark: WaypointMark | string): string[] {
  const art = typeof mark === "string" ? mark : mark.art;
  return art.split("\n").filter((line) => line.length > 0);
}

export function waypointSize(mark: WaypointMark | string): { width: number; height: number } {
  const lines = waypointLines(mark);
  return {
    width: lines.reduce((maximum, line) => Math.max(maximum, stringWidth(line)), 0),
    height: lines.length,
  };
}

export interface StyledMarkCell {
  ch: string;
  style: Style;
}

/** A quiet navigation pulse; callers can disable it for reduced-motion terminals. */
export function styleWaypointMark(mark: WaypointMark, seconds: number, animate = true): StyledMarkCell[][] {
  const lines = waypointLines(mark);
  const phase = animate ? (Math.sin(seconds * 1.7) + 1) / 2 : 0.55;
  const accent = blendHex(theme.accentRunning, theme.accentUser, 0.34 + phase * 0.28);
  return lines.map((line) =>
    [...line].map((ch) => ({
      ch,
      style: { fg: ch === "◇" || ch === "o" ? theme.command : accent },
    })),
  );
}
