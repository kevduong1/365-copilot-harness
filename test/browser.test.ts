import assert from "node:assert/strict";
import test from "node:test";
import { isCopilotChatUrl } from "../src/browser.js";

test("Copilot readiness rejects Microsoft login pages even when they contain textboxes", () => {
  assert.equal(
    isCopilotChatUrl(
      "https://login.microsoftonline.com/common/oauth2/authorize",
      "https://m365.cloud.microsoft/chat",
    ),
    false,
  );
});

test("Copilot readiness accepts the configured chat route and child routes", () => {
  assert.equal(
    isCopilotChatUrl("https://m365.cloud.microsoft/chat", "https://m365.cloud.microsoft/chat"),
    true,
  );
  assert.equal(
    isCopilotChatUrl(
      "https://m365.cloud.microsoft/chat/?auth=2",
      "https://m365.cloud.microsoft/chat",
    ),
    true,
  );
  assert.equal(
    isCopilotChatUrl("https://m365.cloud.microsoft/", "https://m365.cloud.microsoft/chat"),
    false,
  );
});
