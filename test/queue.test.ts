import assert from "node:assert/strict";
import test from "node:test";
import { Mutex } from "../src/queue.js";

test("Mutex runs work in FIFO order and survives rejection", async () => {
  const mutex = new Mutex();
  const events: string[] = [];

  const first = mutex.run(async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push("first:end");
    throw new Error("expected");
  });
  const second = mutex.run(async () => {
    events.push("second:start");
    events.push("second:end");
    return 42;
  });

  await assert.rejects(first, /expected/);
  assert.equal(await second, 42);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});
