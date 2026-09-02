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

/** FIFO counting semaphore for bounded parallelism. */
export class Semaphore {
  private available: number;
  private readonly waiters: Release[] = [];

  constructor(count: number) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Semaphore count must be a positive integer; received ${count}`);
    }
    this.available = count;
  }

  async acquire(): Promise<Release> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next !== undefined) next();
      else this.available += 1;
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
