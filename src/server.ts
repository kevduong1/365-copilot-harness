#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { pathToFileURL } from "node:url";
import { CopilotClient } from "./client.js";
import { config } from "./config.js";
import { Mutex } from "./queue.js";

const MODEL = "copilot-browser";

interface ContentPart {
  type: string;
  text?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
}

interface CompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
}

export interface BrowserChatClient {
  send(prompt: string): AsyncIterable<string>;
  sendAndWait(prompt: string): Promise<string>;
  newChat(): Promise<void>;
}

function textContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function sameMessage(left: ChatMessage, right: ChatMessage): boolean {
  return left.role === right.role && textContent(left.content) === textContent(right.content);
}

function extendsHistory(previous: ChatMessage[] | undefined, current: ChatMessage[]): boolean {
  return (
    previous !== undefined &&
    current.length >= previous.length &&
    previous.every((message, index) => {
      const candidate = current[index];
      return candidate !== undefined && sameMessage(message, candidate);
    })
  );
}

function completionId(): string {
  return `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
}

function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function parseRequest(value: unknown): CompletionRequest {
  if (typeof value !== "object" || value === null) throw new Error("Request body must be a JSON object");
  const candidate = value as Partial<CompletionRequest>;
  if (!Array.isArray(candidate.messages) || candidate.messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  for (const message of candidate.messages) {
    if (
      typeof message !== "object" ||
      message === null ||
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      !(typeof message.content === "string" || Array.isArray(message.content))
    ) {
      throw new Error("Each message needs a supported role and string or text-part content");
    }
  }
  return candidate as CompletionRequest;
}

function errorBody(error: unknown): { error: { message: string; type: string } } {
  return {
    error: {
      message: error instanceof Error ? error.message : String(error),
      type: error instanceof Error ? error.name : "browser_error",
    },
  };
}

export function createApp(client: BrowserChatClient): Hono {
  const app = new Hono();
  const requests = new Mutex();
  let previousMessages: ChatMessage[] | undefined;
  let previousSystem: string | undefined;

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: [{ id: MODEL, object: "model", created: 0, owned_by: "microsoft" }],
    }),
  );

  app.post("/v1/chat/completions", async (c) => {
    let body: CompletionRequest;
    try {
      body = parseRequest(await c.req.json());
    } catch (error) {
      return c.json(errorBody(error), 400);
    }

    const lastUser = body.messages.findLast((message) => message.role === "user");
    if (lastUser === undefined) return c.json(errorBody(new Error("A user message is required")), 400);

    const requestedModel = body.model ?? MODEL;
    const id = completionId();
    const created = Math.floor(Date.now() / 1_000);
    const forceNew = /^true$/i.test(c.req.header("X-New-Chat") ?? "");

    const execute = async <T>(respond: (prompt: string) => Promise<T>): Promise<T> => {
      return requests.run(async () => {
        const system = body.messages.find((message) => message.role === "system");
        const systemText = system === undefined ? undefined : textContent(system.content);
        const reset = forceNew || !extendsHistory(previousMessages, body.messages);
        if (reset) await client.newChat();

        const userText = textContent(lastUser.content);
        const includeSystem = systemText !== undefined && (reset || systemText !== previousSystem);
        const prompt = includeSystem ? `${systemText}\n\n${userText}` : userText;
        const result = await respond(prompt);
        previousMessages = body.messages.map((message) => ({ ...message }));
        previousSystem = systemText;
        return result;
      });
    };

    if (body.stream === true) {
      return streamSSE(c, async (stream) => {
        try {
          await execute(async (prompt) => {
            let completion = "";
            for await (const delta of client.send(prompt)) {
              completion += delta;
              await stream.writeSSE({
                data: JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: requestedModel,
                  choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                }),
              });
            }
            await stream.writeSSE({
              data: JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: tokens(prompt),
                  completion_tokens: tokens(completion),
                  total_tokens: tokens(prompt) + tokens(completion),
                },
              }),
            });
          });
        } catch (error) {
          await stream.writeSSE({ data: JSON.stringify(errorBody(error)) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      });
    }

    try {
      const result = await execute(async (prompt) => ({
        prompt,
        completion: await client.sendAndWait(prompt),
      }));
      const promptTokens = tokens(result.prompt);
      const completionTokens = tokens(result.completion);
      return c.json({
        id,
        object: "chat.completion",
        created,
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.completion },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    } catch (error) {
      return c.json(errorBody(error), 502);
    }
  });

  return app;
}

export async function main(): Promise<void> {
  const client = await CopilotClient.launch();
  const app = createApp(client);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.serverPort });
  console.log(`OpenAI-compatible Copilot shim listening on http://127.0.0.1:${config.serverPort}/v1`);

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    server.close(() => void client.close());
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
