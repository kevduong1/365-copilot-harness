import { stdin, stdout } from "node:process";
import { applyToast, dispatch } from "./dispatch.js";
import { listProjectFiles } from "./files.js";
import { TuiHarness, defaultHome } from "./harness.js";
import { InputParser, type InputEvent } from "./keys.js";
import { renderFrame } from "./render.js";
import { gitBranch, Terminal } from "./terminal.js";
import { SPINNER_MS } from "./theme.js";
import { createState, type Effect, type TuiOptions, type TuiState } from "./types.js";

export async function runTui(options: TuiOptions): Promise<void> {
  const terminal = new Terminal();
  let state = createState({
    ...options,
    home: options.home ?? defaultHome(),
    branch: options.branch ?? gitBranch(options.cwd),
  });
  const parser = new InputParser();
  let running = true;
  let closed = false;
  let paintQueued = false;
  let hits = renderFrame(state, 80, 24).hits;
  let inputChain = Promise.resolve();
  let draining = false;

  const setState = (update: (current: TuiState) => TuiState): void => {
    state = update(state);
    schedulePaint();
  };
  const getState = (): TuiState => state;

  const harness = new TuiHarness(setState, getState, options.cwd, options.allowedRoots, options.readOnly);

  const paint = (): void => {
    if (!running) return;
    state = { ...state, now: Date.now() };
    const { cols, rows } = terminal.size();
    const frame = renderFrame(state, cols, rows);
    hits = frame.hits;
    terminal.paint(frame.buffer, frame.cursor);
  };

  const schedulePaint = (): void => {
    if (paintQueued || !running) return;
    paintQueued = true;
    setImmediate(() => {
      paintQueued = false;
      paint();
    });
  };

  const applyEffects = async (effects: Effect[]): Promise<void> => {
    for (const effect of effects) {
      if (effect.type === "quit") {
        running = false;
        return;
      }
      if (effect.type === "toast") setState((current) => applyToast(current, effect.message));
      if (effect.type === "copy") {
        terminal.copy(effect.text);
        setState((current) => applyToast(current, "Copied!"));
      }
      if (effect.type === "approve") harness.resolveApproval(effect.id, effect.allow);
      if (effect.type === "cancel") harness.cancel();
      if (effect.type === "listTools") {
        await harness.refreshTools();
        setState((current) => {
          if (current.tools.length === 0) return applyToast(current, "No tools loaded yet.");
          const id = current.nextEntryId;
          return applyToast(
            {
              ...current,
              nextEntryId: id + 1,
              entries: [
                ...current.entries,
                {
                  id,
                  createdAt: Date.now(),
                  kind: "system",
                  message: current.tools.join(", "),
                  collapsed: false,
                  raw: false,
                },
              ],
            },
            "Tools listed.",
          );
        });
      }
      if (effect.type === "refreshAgents") harness.refreshAgents();
      if (effect.type === "login") {
        if (getState().ready) setState((current) => applyToast(current, "Already signed in."));
        else await harness.launch(true);
      }
      if (effect.type === "newChat") {
        await harness.newChat(getState().sessionKind);
        setState((current) => ({ ...current, usage: harness.client?.getTokenUsage() ?? current.usage }));
      }
      if (effect.type === "compact") await harness.compact(getState().sessionKind);
      if (effect.type === "send") void drainQueue(effect.text);
    }
  };

  const drainQueue = async (first: string): Promise<void> => {
    if (draining) {
      setState((current) =>
        current.queued.includes(first) || current.turn !== "idle"
          ? current
          : { ...current, queued: [...current.queued, first] },
      );
      return;
    }
    draining = true;
    let next: string | undefined = first;
    try {
      while (next !== undefined && running) {
        const kind = getState().sessionKind;
        await harness.send(next, kind);
        const queued = getState().queued;
        next = queued[0];
        if (next !== undefined) setState((current) => ({ ...current, queued: current.queued.slice(1) }));
      }
    } finally {
      draining = false;
    }
  };

  const handleEvents = async (events: InputEvent[]): Promise<void> => {
    for (const event of events) {
      if (!running) return;
      let effects: Effect[] = [];
      setState((current) => {
        const result = dispatch({ ...current, now: Date.now() }, event, hits);
        effects = result.effects;
        return result.state;
      });
      await applyEffects(effects);
    }
  };

  const onInput = (raw: string): void => {
    const events = parser.push(raw);
    inputChain = inputChain.then(() => handleEvents(events));
  };

  const onResize = (): void => {
    terminal.invalidate();
    schedulePaint();
  };

  const stop = async (): Promise<void> => {
    running = false;
    if (closed) return;
    closed = true;
    clearInterval(tick);
    stdin.off("data", onInput);
    stdout.off("resize", onResize);
    terminal.restore();
    await harness.close();
  };

  terminal.start();
  stdin.on("data", onInput);
  stdout.on("resize", onResize);
  const tick = setInterval(() => {
    if (
      getState().turn !== "idle" ||
      getState().screen === "welcome" ||
      (getState().toast !== undefined && Date.now() < (getState().toast?.until ?? 0))
    ) {
      schedulePaint();
    }
  }, SPINNER_MS);

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("exit", () => terminal.restore());

  void listProjectFiles(options.cwd).then((files) => setState((current) => ({ ...current, files })));
  void harness.launch(false);
  paint();

  await new Promise<void>((resolve) => {
    const wait = setInterval(() => {
      if (!running) {
        clearInterval(wait);
        resolve();
      }
    }, 50);
  });
  await stop();
}
