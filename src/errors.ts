export class NotLoggedInError extends Error {
  override name = "NotLoggedInError";

  constructor(message = "Microsoft login is required; run: pnpm cli login") {
    super(message);
  }
}

export class ResponseTimeoutError extends Error {
  override name = "ResponseTimeoutError";

  constructor(
    message: string,
    readonly partialResponse: string,
  ) {
    super(message);
  }
}

export class PromptTooLargeError extends Error {
  override name = "PromptTooLargeError";

  constructor(
    readonly promptLength: number,
    readonly maximumLength?: number,
  ) {
    super(
      maximumLength === undefined
        ? `Copilot did not accept the entire prompt (${promptLength} characters)`
        : `Prompt is ${promptLength} characters, but the Copilot input limit is ${maximumLength}`,
    );
  }
}
