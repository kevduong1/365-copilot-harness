export interface ChatAdapter {
  ensureReady(): Promise<void>;
  newChat(): Promise<void>;
  send(prompt: string): AsyncIterable<string>;
  sendAndWait(prompt: string): Promise<string>;
  /** Optional authoritative text used when rendered streaming content was rewritten. */
  lastResponse?(): string;
}
