export type Release = () => void;

/** FIFO single-flight mutex. A rejected task never poisons the queue. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<Release> {
    let release!: Release;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.catch(() => undefined).then(() => turn);
    await previous.catch(() => undefined);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
