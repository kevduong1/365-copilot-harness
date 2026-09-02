export type KeyName =
  | "char"
  | "enter"
  | "tab"
  | "backspace"
  | "delete"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "space"
  | "f2"
  | "f3"
  | "paste";

export interface KeyEvent {
  type: "key";
  name: KeyName;
  char: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface MouseEvent {
  type: "mouse";
  kind: "down" | "up" | "move" | "drag" | "scroll";
  button: "none" | "left" | "middle" | "right" | "wheelup" | "wheeldown";
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type InputEvent = KeyEvent | MouseEvent;

export function key(
  name: KeyName,
  options: Partial<Omit<KeyEvent, "type" | "name">> & { char?: string } = {},
): KeyEvent {
  return {
    type: "key",
    name,
    char: options.char ?? "",
    ctrl: options.ctrl === true,
    alt: options.alt === true,
    shift: options.shift === true,
    meta: options.meta === true,
  };
}

const CTRL_NAMES: Record<number, KeyEvent> = {
  0x01: key("char", { char: "a", ctrl: true }),
  0x02: key("char", { char: "b", ctrl: true }),
  0x03: key("char", { char: "c", ctrl: true }),
  0x04: key("char", { char: "d", ctrl: true }),
  0x05: key("char", { char: "e", ctrl: true }),
  0x06: key("char", { char: "f", ctrl: true }),
  0x07: key("char", { char: "g", ctrl: true }),
  0x08: key("backspace", { ctrl: true }),
  0x09: key("tab"),
  0x0b: key("char", { char: "k", ctrl: true }),
  0x0c: key("char", { char: "l", ctrl: true }),
  0x0e: key("char", { char: "n", ctrl: true }),
  0x0f: key("char", { char: "o", ctrl: true }),
  0x10: key("char", { char: "p", ctrl: true }),
  0x11: key("char", { char: "q", ctrl: true }),
  0x12: key("char", { char: "r", ctrl: true }),
  0x13: key("char", { char: "s", ctrl: true }),
  0x14: key("char", { char: "t", ctrl: true }),
  0x15: key("char", { char: "u", ctrl: true }),
  0x16: key("char", { char: "v", ctrl: true }),
  0x17: key("char", { char: "w", ctrl: true }),
  0x18: key("char", { char: "x", ctrl: true }),
  0x19: key("char", { char: "y", ctrl: true }),
  0x1a: key("char", { char: "z", ctrl: true }),
  0x1f: key("char", { char: "/", ctrl: true }),
};

const ARROWS: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "tab",
};

export class InputParser {
  private pending = "";
  private paste: string | undefined;

  push(chunk: string): InputEvent[] {
    this.pending += chunk;
    const events: InputEvent[] = [];
    while (this.pending.length > 0) {
      const next = this.consume();
      if (next === "need-more") break;
      if (next !== undefined) events.push(next);
    }
    return events;
  }

  flush(): InputEvent[] {
    if (this.pending === "\x1b") {
      this.pending = "";
      return [key("escape")];
    }
    return [];
  }

  private consume(): InputEvent | undefined | "need-more" {
    const buf = this.pending;
    if (this.paste !== undefined) {
      const end = buf.indexOf("\x1b[201~");
      if (end === -1) {
        this.paste += buf;
        this.pending = "";
        return "need-more";
      }
      const text = this.paste + buf.slice(0, end);
      this.paste = undefined;
      this.pending = buf.slice(end + 6);
      return key("paste", { char: text });
    }

    if (buf.startsWith("\x1b[200~")) {
      this.pending = buf.slice(6);
      this.paste = "";
      return undefined;
    }

    const mouse = this.parseMouse();
    if (mouse !== undefined) return mouse;

    if (buf.startsWith("\x1b")) {
      if (buf.length === 1) return "need-more";
      const csi = this.parseCsi();
      if (csi !== undefined) return csi;
      if (buf.startsWith("\x1bO") && buf.length >= 3) {
        this.pending = buf.slice(3);
        const ch = buf[2]!;
        if (ch === "P") return key("char", { char: "p", ctrl: true });
        if (ch === "Q") return key("f2");
        if (ch === "R") return key("f3");
        const name = ARROWS[ch];
        if (name !== undefined) return key(name);
        return key("char", { char: ch, alt: true });
      }
      if (buf[1] === "\x1b") {
        this.pending = buf.slice(2);
        return key("escape");
      }
      this.pending = buf.slice(2);
      const ch = buf[1]!;
      if (ch === "\r") return key("enter", { alt: true });
      if (ch === " ") return key("space", { alt: true, char: " " });
      return key("char", { char: ch, alt: true });
    }

    const code = buf.charCodeAt(0);
    this.pending = buf.slice(1);
    if (code === 0x0d) return key("enter");
    if (code === 0x0a) return key("enter", { shift: true });
    if (code === 0x7f || code === 0x08) return key("backspace");
    if (code === 0x09) return key("tab");
    if (code === 0x1b) return key("escape");
    if (code < 32) {
      const mapped = CTRL_NAMES[code];
      if (mapped !== undefined) return { ...mapped };
      return undefined;
    }
    const ch = buf[0]!;
    if (ch === " ") return key("space", { char: " " });
    return key("char", { char: ch, shift: ch.length === 1 && ch >= "A" && ch <= "Z" });
  }

  private parseMouse(): InputEvent | "need-more" | undefined {
    const buf = this.pending;
    if (!buf.startsWith("\x1b[<")) return undefined;
    const end = buf.search(/[Mm]/);
    if (end === -1) return "need-more";
    const body = buf.slice(3, end);
    const suffix = buf[end]!;
    this.pending = buf.slice(end + 1);
    const [btnRaw, xRaw, yRaw] = body.split(";");
    const btn = Number(btnRaw);
    const x = Number(xRaw) - 1;
    const y = Number(yRaw) - 1;
    if (!Number.isFinite(btn) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    const shift = (btn & 4) !== 0;
    const alt = (btn & 8) !== 0;
    const ctrl = (btn & 16) !== 0;
    const low = btn & 3;
    const wheel = (btn & 64) !== 0;
    let kind: MouseEvent["kind"] = suffix === "m" ? "up" : "down";
    if ((btn & 32) !== 0) kind = low === 3 ? "move" : "drag";
    let button: MouseEvent["button"] =
      low === 0 ? "left" : low === 1 ? "middle" : low === 2 ? "right" : "none";
    if (wheel) {
      kind = "scroll";
      button = (btn & 1) === 1 ? "wheeldown" : "wheelup";
    }
    return { type: "mouse", kind, button, x, y, ctrl, alt, shift };
  }

  private parseCsi(): InputEvent | "need-more" | undefined {
    const buf = this.pending;
    if (!buf.startsWith("\x1b[")) return undefined;
    const match = /^(?:\x1b\[)([0-9;?]*)([A-Za-z~u])/.exec(buf);
    if (match === null) {
      if (buf.length > 32) {
        this.pending = buf.slice(1);
        return key("escape");
      }
      return "need-more";
    }
    this.pending = buf.slice(match[0].length);
    const params = match[1] ?? "";
    const final = match[2]!;
    if (final === "Z") return key("tab", { shift: true });
    if (final === "u") return this.kittyKey(params);
    if (final === "~") return this.tildeKey(params);
    const arrow = ARROWS[final];
    if (arrow !== undefined) {
      const mods = modifier(params);
      return key(arrow, { ...mods, shift: mods.shift || (arrow === "tab" && final === "Z") });
    }
    return undefined;
  }

  private tildeKey(params: string): KeyEvent | undefined {
    const parts = params.split(";").map(Number);
    const code = parts[0] ?? 0;
    const mods = modifier(parts.length > 1 ? `1;${parts[1]}` : "");
    if (code === 3) return key("delete", mods);
    if (code === 5) return key("pageup", mods);
    if (code === 6) return key("pagedown", mods);
    if (code === 13) return key("enter", mods);
    if (code === 27) {
      const ascii = parts[2];
      if (ascii === 13) return key("enter", mods);
      if (ascii === 9) return key("tab", mods);
    }
    return undefined;
  }

  private kittyKey(params: string): KeyEvent | undefined {
    const parts = params.split(";").map(Number);
    const code = parts[0] ?? 0;
    const mods = modifier(parts.length > 1 ? `1;${parts[1]}` : "");
    if (code === 13) return key("enter", mods);
    if (code === 9) return key("tab", mods);
    if (code === 27) return key("escape", mods);
    if (code === 32) return key("space", { ...mods, char: " " });
    if (code === 127) return key("backspace", mods);
    if (code >= 33 && code < 127) {
      const ch = String.fromCharCode(code);
      return key("char", { ...mods, char: ch });
    }
    return undefined;
  }
}

function modifier(params: string): { ctrl: boolean; alt: boolean; shift: boolean } {
  const parts = params.split(";");
  const mask = Number(parts[1] ?? parts[0] ?? 1) || 1;
  const bits = mask - 1;
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}

export function isVsCodeFamily(): boolean {
  const program = process.env.TERM_PROGRAM ?? "";
  return (
    program === "vscode" ||
    program === "cursor" ||
    process.env.VSCODE_INJECTION !== undefined ||
    process.env.CURSOR_TRACE_ID !== undefined ||
    process.env.TERM_PROGRAM_VERSION !== undefined && process.env.VSCODE_GIT_ASKPASS_NODE !== undefined
  );
}
