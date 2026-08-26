import assert from "node:assert/strict";
import test from "node:test";
import { extractMarkdown } from "../src/extract.js";

test("extractMarkdown preserves fenced code and its language", () => {
  const markdown = extractMarkdown(
    '<p>Example:</p><pre><code class="language-python">def fib(n):\n    return n\n</code></pre>',
  );

  assert.equal(markdown, "Example:\n\n```python\ndef fib(n):\n    return n\n```");
});

test("extractMarkdown uses a longer fence when code contains backticks", () => {
  const markdown = extractMarkdown("<pre><code>const fence = ```;</code></pre>");
  assert.match(markdown, /^````\nconst fence = ```;\n````$/);
});

test("extractMarkdown emits GFM tables and removes citation chips", () => {
  const markdown = extractMarkdown(
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><sup>1</sup><button aria-label="Citation 1">[1]</button>',
  );

  assert.match(markdown, /\| A \| B \|/);
  assert.doesNotMatch(markdown, /\[1\]/);
});

test("extractMarkdown reconstructs Copilot code previews without toolbar or line numbers", () => {
  const markdown = extractMarkdown(`
    <p>Use this:</p>
    <div role="group" aria-label="Code Preview">
      <button aria-label="Go to line (Ctrl+G)">Go to line</button>
      <button aria-label="Copy code">Copy code</button>
      <div id="language-badge" aria-label="Python">Python</div>
      <div role="textbox" aria-label="Code editor" aria-readonly="true">
        <div class="line-number">1</div>
        <div data-line-index="0">import zipfile</div>
        <div class="line-number">2</div>
        <div data-line-index="1"></div>
        <div class="line-number">3</div>
        <div data-line-index="2">with zipfile.ZipFile(&quot;archive.zip&quot;) as archive:</div>
        <div class="line-number">4</div>
        <div data-line-index="3">    archive.extractall(&quot;output&quot;)</div>
      </div>
    </div>
  `);

  assert.equal(
    markdown,
    [
      "Use this:",
      "",
      "```python",
      "import zipfile",
      "",
      'with zipfile.ZipFile("archive.zip") as archive:',
      '    archive.extractall("output")',
      "```",
    ].join("\n"),
  );
  assert.doesNotMatch(markdown, /Copy code|Go to line|\n1\n|\n2\n/);
});

test("extractMarkdown suppresses an incomplete streaming code preview", () => {
  const markdown = extractMarkdown(
    '<p>Before</p><div role="group" aria-label="Code Preview"><button>Copy code</button></div>',
  );
  assert.equal(markdown, "Before");
});
