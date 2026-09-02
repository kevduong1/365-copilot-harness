import { execFileSync } from "node:child_process";
import { stdout, stdin } from "node:process";
import { theme } from "./theme.js";
import type { ScreenBuffer } from "./buffer.js";
import { terminalCapabilities, type TerminalCapabilities } from "./capabilities.js";

const ENTER =
  "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[>4;1m";
const LEAVE =
  "\x1b[>4;0m\x1b[?2004l\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l\x1b]111\x1b\\\x1b]112\x1b\\";

export class Terminal {
  private previous: ScreenBuffer | undefined;
  private restored = false;
  readonly capabilities: TerminalCapabilities;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.capabilities = terminalCapabilities(env);
  }

  start(): void {
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdout.write(ENTER);
    if (this.capabilities.colorMode !== "none") {
      const background = this.capabilities.defaultBackground === true ? "" : `\x1b]11;${theme.bgBase}\x1b\\`;
      stdout.write(`${background}\x1b]12;${theme.accentUser}\x1b\\`);
    }
  }

  size(): { cols: number; rows: number } {
    return { cols: stdout.columns || 80, rows: stdout.rows || 24 };
  }

  paint(buffer: ScreenBuffer, cursor: { x: number; y: number; visible: boolean }): void {
    let out = buffer.diffAnsi(this.previous);
    this.previous = buffer;
    if (cursor.visible) {
      out += `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`;
    } else {
      out += "\x1b[?25l";
    }
    stdout.write(out);
  }

  invalidate(): void {
    this.previous = undefined;
  }

  copy(text: string): void {
    const payload = Buffer.from(text, "utf8").toString("base64");
    stdout.write(`\x1b]52;c;${payload}\x1b\\`);
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    try {
      stdin.setRawMode?.(false);
    } catch {
      // ignore
    }
    stdout.write(`\x1b[0m${LEAVE}`);
  }
}

export function gitBranch(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 400,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
