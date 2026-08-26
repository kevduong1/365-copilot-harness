export interface ChatAdapter {
  ensureReady(): Promise<void>;
  newChat(): Promise<void>;
  send(prompt: string): AsyncIterable<string>;
  sendAndWait(prompt: string): Promise<string>;
}
