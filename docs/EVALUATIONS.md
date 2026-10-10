# Test MCP conversations

Start with a deterministic, no-credentials test. It exercises a real in-memory MCP server/client, tool schemas and conversation execution. After that, supply a live model to evaluate its tool choices. Angular component/rendering tests are separate from these server conversation evaluations.

[Documentation map](index.md) · [Getting started](GETTING-STARTED.md) · [Angular APIs](ANGULAR-API.md)

## Run your first evaluation

The framework checkout already includes Vitest and AI SDK 7. A generated app includes the local testing package and AI SDK; add the optional runner there:

```sh
npm install --save-dev vitest
```

The current framework packages are local v0.1 tarballs. If you assembled an app manually, install the testing tarball from your release bundle and its `ai` peer before using this guide; the package is not yet published to the npm registry. The runner itself does not depend on Vitest.

Create `tests/evaluation-fixture.ts`. This uses the generated app's existing server definition, replaces built widget HTML with an inline fixture, and supplies a fresh deterministic model per test. No widget build or provider credentials are needed for this fixture.

```ts
import { MockLanguageModelV4 } from 'ai/test';
import { demoOptions } from '../examples/server/app.js';

export function evaluationApp() {
  return {
    ...demoOptions(),
    views: { projects: { html: '<html><body>Test view</body></html>', description: 'Test view' } },
  };
}

export function evaluationModel() {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return new MockLanguageModelV4({ doGenerate: [
    {
      content: [{ type: 'tool-call', toolCallId: 'projects-1', toolName: 'list_projects', input: '{"status":"ready"}' }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
    },
    {
      content: [{ type: 'text', text: 'Atlas is ready.' }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [],
    },
  ] });
}
```

Create `tests/projects.evaluation.test.ts`:

```ts
import { test } from 'vitest';
import { assertChat, start } from '@angular-mcp-bridge/testing';
import { evaluationApp, evaluationModel } from './evaluation-fixture.js';

test('executes the project tool through real MCP', async () => {
  const chat = await start({ app: evaluationApp(), model: evaluationModel(), maxSteps: 4, timeoutMs: 10_000 });
  try {
    await chat.send('Show ready projects');
    assertChat(chat).calledOnce('list_projects', { status: 'ready' });
    assertChat(chat).neverCalled('get_project');
    assertChat(chat).said('Atlas is ready');
  } finally {
    await chat.close();
  }
});
```

Run from the app root:

```sh
npx vitest run tests/projects.evaluation.test.ts
```

A mock model deliberately specifies the tool call; this test verifies runner/server behavior, not a production model's reasoning. Update the fixture/imports when you change the shared tools or server factory. A view needs inline `html` or an existing `htmlPath`; evaluations using production paths need a prior build.

## Choose what to test

| Goal | Approach |
| --- | --- |
| Verify tool validation, authorization or handler behavior | Deterministic model plus real application handlers. |
| Make a model scenario repeatable without external data | Typed tool stubs inside the real server. |
| Replace a dependency while keeping the normal handler path | `handlerOverrides` or an application-owned dependency adapter. |
| Evaluate whether a real model chooses the right tool | Pass your chosen AI SDK provider model explicitly. |
| Check exact tool calls, failures, order or speech | `assertChat(chat)` deterministic assertions. |
| Grade qualitative behavior | Explicit custom `judge` or explicit judgment model. |
| Test Angular templates, UI interactions or real hosts | Angular/component/browser tests; these evaluations do not render widgets. |

## Sessions and bounded execution

`start({ app, model, instructions?, maxSteps?, timeoutMs?, temperature?, context?, stubs?, handlerOverrides? })` accepts the same `BridgeServerOptions` as production. `model` is mandatory. The package does not discover credentials, choose a paid provider, or silently pick a judge model.

`send(prompt, { signal }?)` returns final assistant text and serializes concurrent turns in one chat. Successful history carries into the next turn. A rejected/cancelled turn does not commit its messages; observed tool attempts and completed speech remain available as evidence. `close()` is idempotent, aborts active work and closes MCP endpoints.

`maxSteps` defaults to 6 and accepts integers from 1 to 100. `timeoutMs` defaults to 60,000 and must be positive/finite. Timeout and cancellation are forwarded to model and MCP calls. Use a fresh model/session for independent cases; reuse one chat when testing conversation history.

## Typed stubs and overrides

Create `tests/project-stubs.ts`:

```ts
import type { ToolStubs } from '@angular-mcp-bridge/testing';
import { tools } from '../examples/shared/tools.js';

export const projectStubs: ToolStubs<typeof tools> = {
  list_projects: ({ status }, context) => ({
    data: { projects: [], total: 0, filter: status },
    text: 'There are no matching projects.',
    // context.auth is available when a verified identity was supplied.
  }),
  get_project: ({ id }) => id === 'fixture'
    ? { data: { project: {
        id, name: 'Fixture', description: 'Controlled test data', status: 'ready', progress: 100,
      } } }
    : undefined,
};
```

Import `projectStubs` into the test and pass `stubs: projectStubs` to `start()`. For this fixture, adjust the assistant mock's reply to describe an empty result if you are asserting on the reply. Stubs affect tool execution; they do not rewrite a mock model's scripted speech.

A stub may be a constant `ToolResponse`, a synchronous function or an asynchronous function. Inputs have passed MCP/Zod validation, including defaults and transforms; output passes the real output schema. Authorization and middleware still execute. Returning undefined falls through to `handlerOverrides[name]`, when supplied, then to the application's handler. Overrides have the same typed `(parsedInput, requestContext) => ToolResponse` signature as normal handlers, including SDK input-required responses where supported.

Unknown names reject session creation. Invalid output or a thrown error becomes a failed attempt. Stubbing cannot turn malformed data into a valid result or bypass authorization. `context.authInfo` injects an already-verified identity for authorization tests; use HTTP tests for bearer-token verification.

## Evidence and assertions

`calls` includes all observed attempts in model invocation order, including failures and parallel calls. Each record has raw model `input`, name, call ID, duration, result, and the fields below. Raw input is what the model sent; handler defaults/transforms are not backfilled into it.

| Field | Meaning |
| --- | --- |
| `status: 'accepted'` | MCP completed without an in-band error. |
| `status: 'failed'` | Server/transport/model validation failed. |
| `status: 'pending'` | A call is currently executing. |
| `source` | `server`, `stub`, `override`, `model-validation` or `transport`. |
| `failure` | Human-readable failure evidence when present. |

Model-validation/transport failures have a synthetic error envelope; that result does not mean a handler ran. Denied authorization has source `server` and never invokes a stub. Call IDs are distinct across conversation turns even if the provider reuses an ID.

`acceptedCalls`/`failedCalls` filter outcomes. `chat.called(name, input?)` checks accepted calls with contract-typed input. `replies` contains successful final replies; `assistantTurns` includes intermediate completed speech. `messages` is committed AI SDK history. `exportTranscript()` returns versioned JSON with public results.

`assertChat(chat)` retains contract-typed names/partial input and offers `.not` for every assertion:

| Assertion | Semantics |
| --- | --- |
| `.calledWith(name, partialInput)` | An accepted call matches the argument subset. |
| `.calledOnce(name, partialInput?)` | Exactly one accepted call to that tool, optionally matching input. |
| `.neverCalled(name)` | No attempt, including a failed attempt, used that name. |
| `.failedCall(name)` | At least one failed attempt used that name. |
| `.callsInOrder(first, ...rest)` | Accepted calls contain this ordered subsequence; intervening calls are allowed. |
| `.noTools()` | No attempts were observed. |
| `.said(textOrRegex)` | A completed assistant step matches; strings ignore case/collapse whitespace. |
| `.judgment(criteria, options)` | An explicit judge returns a passing verdict. |

The runner-neutral `chatMatchers` exposes the corresponding `toHaveCalledToolWith`, `toHaveCalledToolOnce`, `toNeverHaveCalledTool`, `toHaveFailedToolCall`, `toHaveCalledToolsInOrder`, `toHaveCalledNoTools`, `toHaveSaid`, and asynchronous `toPassJudgment`. Each returns `{ pass, message }`. Regular expression state is preserved. Importing the package does not change runner globals.

## Automatic cleanup and suite defaults

If you prefer automatic cleanup, replace `tests/projects.evaluation.test.ts` with:

```ts
import { expect, onTestFinished, test } from 'vitest';
import { createEvaluationSuite } from '@angular-mcp-bridge/testing';
import { evaluationApp, evaluationModel } from './evaluation-fixture.js';

const suite = createEvaluationSuite({
  onTestFinished,
  extend: matchers => expect.extend(matchers), // Optional matcher registration.
  defaults: () => ({ model: evaluationModel(), temperature: 0, maxSteps: 4 }),
});

test('queries ready projects', async () => {
  const chat = await suite.start({ app: evaluationApp() });
  await chat.send('Show ready projects');
  suite.assert(chat).calledOnce('list_projects', { status: 'ready' });
});
```

Call `suite.start()` inside the test so its lifecycle belongs to that test. The getter creates a fresh model for each session. An explicit per-session model overrides defaults. `suite.assert` stays typed without augmenting Vitest; the optional extension is useful for a runner's own matcher integration. No global `expect.chat` method is installed. Without a lifecycle function, close the session yourself.

## Custom judgment and explicit live models

Inside a test with a `chat`, add this before cleanup:

```ts
await assertChat(chat).judgment('Mentions the project by name', {
  judge: ({ transcript }) => ({
    pass: transcript.includes('Atlas'),
    reasoning: 'Checked the public transcript for the project name.',
  }),
});
```

The custom judge receives `{ criteria, transcript, signal }` and returns `{ pass: boolean, reasoning?: string }`. It can call your own scoring service; honor its signal. When both `judge` and `model` are present, the custom judge takes precedence. Prefer exact deterministic assertions when they fully express the requirement.

For a live evaluation, save `tests/live-evaluation.ts` and call `evaluateProjects()` from your test/script with an AI SDK model constructed by your chosen provider. Supplying `judgmentModel` explicitly opts into an additional provider call; omitting it performs only exact assertions.

```ts
import type { LanguageModel } from 'ai';
import { assertChat, start } from '@angular-mcp-bridge/testing';
import { evaluationApp } from './evaluation-fixture.js';

export async function evaluateProjects(model: LanguageModel, judgmentModel?: LanguageModel): Promise<string> {
  const chat = await start({ app: evaluationApp(), model, maxSteps: 6, timeoutMs: 30_000 });
  try {
    await chat.send('Show ready projects');
    assertChat(chat).calledWith('list_projects', { status: 'ready' });
    if (judgmentModel) {
      await assertChat(chat).judgment('Answers using the project result and avoids inventing projects', {
        model: judgmentModel, timeoutMs: 20_000, maxTranscriptChars: 20_000,
      });
    }
    return chat.exportTranscript();
  } finally { await chat.close(); }
}
```

Live model calls use that provider's credentials and normal billing. Keep provider configuration in test/server code. No model-quality claim follows from the deterministic mock fixture.

Judgment requests a structured verdict and treats a fenced transcript as untrusted evidence. Fence tags are escaped and evidence is bounded: `maxTranscriptChars` defaults to 30,000 (minimum 100), and judgment `timeoutMs` defaults to 60,000. `signal` supports caller cancellation. Timeout/cancellation also stops waiting for a custom judge that ignores its signal.

A negative verdict fails with its reasoning. Invalid verdicts, provider/scoring errors and cancellation throw a distinct `Judge unavailable` infrastructure error, rather than grading the app as a failure or pass.

## Transcript privacy

Tool-result `_meta` stays available in local `chat.calls[i].result`, but is excluded from model tool results, exported transcripts and judgment evidence. Public content/structured data, prompts, assistant text, arguments and error text remain. Review public data before saving or sharing transcripts; the runner does not redact application-specific secrets.

These evaluations verify tool wiring and conversation behavior. Use Angular/browser tests, [host setup](HOST-SETUP.md) and the [recipes](RECIPES.md) for rendering, lifecycle and host actions. Live-host certification and real-model reliability require their corresponding environments.
