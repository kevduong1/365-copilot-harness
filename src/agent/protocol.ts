import type { ToolCall, ToolResult } from "./types.js";

const xmlToolCallPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const sentinelToolCallPattern =
  /(?:^|\n)TOOL_CALL\s+([\s\S]*?)\s+END_TOOL_CALL(?=\s|$)/gi;
const harnessRequestPattern =
  /(?:^|\n)HARNESS_REQUEST\s+([\s\S]*?)\s+END_HARNESS_REQUEST(?=\s|$)/gi;

export interface ParsedToolCalls {
  calls: ToolCall[];
  errors: string[];
  finalText: string;
  hadToolMarkup: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unescapeMarkdownProtocol(value: string): string {
  return value.replace(/\\([\\`*_{}[\]()#+.!|>-])/g, "$1");
}

export function parseToolCalls(response: string): ParsedToolCalls {
  const normalized = response
    .replaceAll("END\\_HARNESS\\_REQUEST", "END_HARNESS_REQUEST")
    .replaceAll("HARNESS\\_REQUEST", "HARNESS_REQUEST")
    .replaceAll("END\\_TOOL\\_CALL", "END_TOOL_CALL")
    .replaceAll("TOOL\\_CALL", "TOOL_CALL");
  const calls: ToolCall[] = [];
  const errors: string[] = [];
  let hadToolMarkup = false;

  const matches = [
    ...Array.from(normalized.matchAll(xmlToolCallPattern), (match) => ({ match, index: match.index })),
    ...Array.from(normalized.matchAll(sentinelToolCallPattern), (match) => ({ match, index: match.index })),
    ...Array.from(normalized.matchAll(harnessRequestPattern), (match) => ({ match, index: match.index })),
  ].sort((left, right) => left.index - right.index);

  for (const { match } of matches) {
    hadToolMarkup = true;
    const payload = unescapeMarkdownProtocol(match[1] ?? "");
    try {
      const parsed: unknown = JSON.parse(payload);
      const name = isObject(parsed)
        ? typeof parsed.operation === "string"
          ? parsed.operation
          : parsed.name
        : undefined;
      if (!isObject(parsed) || typeof name !== "string" || !isObject(parsed.arguments)) {
        errors.push("Harness requests require a string operation and an object arguments field");
        continue;
      }
      calls.push({ name, arguments: parsed.arguments });
    } catch (error) {
      errors.push(`Invalid tool-call JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (
    (/<tool_call>/i.test(normalized) ||
      /(?:^|\n)TOOL_CALL\s*$/im.test(normalized) ||
      /(?:^|\n)HARNESS_REQUEST\s*$/im.test(normalized)) &&
    !hadToolMarkup
  ) {
    hadToolMarkup = true;
    errors.push("An opening <tool_call> was not followed by </tool_call>");
  }

  return {
    calls,
    errors,
    hadToolMarkup,
    finalText: normalized
      .replace(xmlToolCallPattern, "")
      .replace(sentinelToolCallPattern, "")
      .replace(harnessRequestPattern, "")
      .replace(/```(?:json|xml)?\s*```/gi, "")
      .trim(),
  };
}

function safeResultOutput(output: string): string {
  return output.replaceAll("</tool_result>", "</tool_result_escaped>");
}

export function formatToolResults(results: ToolResult[], protocolErrors: string[] = []): string {
  const payload = {
    results: results.map((result) => ({
      name: result.call.name,
      arguments: result.call.arguments,
      ok: result.ok,
      output: safeResultOutput(result.output),
    })),
    protocol_errors: protocolErrors,
  };
  return `HARNESS_OBSERVATION\n${JSON.stringify(payload, null, 2)}\nEND_HARNESS_OBSERVATION\n\nContinue the coding task using this controller-provided observation. If more evidence or work is needed, print another HARNESS_REQUEST record. Otherwise, answer the user directly without protocol markers.`;
}
