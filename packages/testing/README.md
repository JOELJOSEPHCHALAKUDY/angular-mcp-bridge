# @angular-mcp-bridge/testing

Run a conversation through a real in-memory MCP server/client with any AI SDK 7 model. Use deterministic mock models for runner/schema tests, then explicit provider models for tool-selection evaluations. This package does not render Angular, choose a provider, load credentials or import a test runner at runtime.

This v0.1 package is a local tarball. Generated apps include it when created from a complete framework package bundle; install Vitest separately if you choose that runner. AI SDK 7 is a peer dependency. Their `docs/EVALUATIONS.md` contains a complete no-credentials mock-model test and exact commands.

## A runner-neutral evaluation function

Save this as a server/test module and call it with a model constructed by your chosen AI SDK provider:

```ts
import type { LanguageModel } from 'ai';
import { defineTool, defineTools, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { assertChat, start } from '@angular-mcp-bridge/testing';
import { z } from 'zod';

const tools = defineTools({
  find_note: defineTool({
    title: 'Find a note', description: 'Find a note by ID.',
    input: z.object({ id: z.string() }),
    output: z.object({ title: z.string() }),
    annotations: readOnlyAnnotations,
  }),
});

export async function evaluate(model: LanguageModel): Promise<string> {
  const chat = await start({
    app: {
      name: 'note-evaluation', tools, views: {},
      handlers: { find_note: ({ id }) => ({ data: { title: `Note ${id}` } }) },
    },
    model, maxSteps: 4, timeoutMs: 30_000,
  });
  try {
    await chat.send('Find note atlas');
    assertChat(chat).calledOnce('find_note', { id: 'atlas' });
    return chat.exportTranscript();
  } finally { await chat.close(); }
}
```

The assertion deliberately tests whether the supplied model selected the expected tool. A live model uses its provider's credentials and billing. For deterministic CI, the documentation's mock model scripts the call instead.

## Testing controls

| API | Purpose |
| --- | --- |
| `stubs: ToolStubs<typeof tools>` | Typed fixtures/functions inside real server authorization, middleware and input/output validation; undefined falls through. |
| `handlerOverrides` | Typed replacements for selected application handlers. |
| `calls`, `acceptedCalls`, `failedCalls` | All attempts and filtered outcomes, in model invocation order. |
| `replies`, `assistantTurns`, `messages` | Final replies, intermediate speech and committed conversation history. |
| `assertChat(chat)` | Typed once/with/never/failed/order/no-tools/speech assertions and `.not`. |
| `chatMatchers` | Runner-neutral matcher functions for explicit registration. |
| `createEvaluationSuite({ onTestFinished, defaults, extend })` | Optional injected lifecycle/defaults; no global `expect.chat` mutation. |
| `.judgment(criteria, { judge | model })` | Explicit custom or model grading; no hidden default paid call. |

`send()` serializes turns; `send(prompt, { signal })` supports cancellation. Steps/timeouts are bounded and cleanup is idempotent. Judge cancellation/provider failures are distinct `Judge unavailable` infrastructure errors. `context.authInfo` tests authorization with an already-verified identity; use HTTP tests for token verification.

Private tool-result `_meta` is available for local assertions and excluded from model, judge and exported transcripts. Public arguments/results/prompts/errors remain, so review public data before sharing transcripts.

See sibling [server documentation](../server/README.md) for application options and [contracts documentation](../contracts/README.md) for shared typing. Generated apps include detailed `docs/EVALUATIONS.md` and Angular recipes; local model mocks do not certify real-host rendering or production model quality.
