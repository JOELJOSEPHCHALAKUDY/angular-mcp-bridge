# Angular Signal Forms and browser WebMCP

Start with [your first app](FIRST-APP.md). These optional entrypoints add native Angular features to an existing app; ordinary widgets do not need them. The examples target Angular 22.2.2.

## Submit a tool through a native Signal Form

Install the forms package if your app does not already include it:

```sh
npm install @angular/forms@22.2.2
```

The widget must already provide `provideMcpBridge()` at bootstrap. Save this component as `examples/forms/tool-form.component.ts`; the starter already includes that file and the `get_project` contract in `examples/shared/tools.ts`.

```ts
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { required } from '@angular/forms/signals';
import { FormField, FormRoot, injectToolForm } from '@angular-mcp-bridge/angular/forms';
import { tools } from '../shared/tools.js';

@Component({
  selector: 'project-tool-form',
  standalone: true,
  imports: [FormField, FormRoot],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form [formRoot]="project.fields">
      <label for="project-id">Project ID</label>
      <input id="project-id" [formField]="project.fields.id"
        [attr.aria-invalid]="project.fields.id().touched() && project.fields.id().invalid()"
        aria-describedby="project-id-errors" />
      <div id="project-id-errors">
        @if (project.fields.id().touched()) {
          @for (issue of project.fields.id().errors(); track $index) {
            <p>{{ issue.message }}</p>
          }
        }
      </div>
      <button type="submit" [disabled]="project.pending() || project.validating()">
        {{ project.pending() ? 'Loading…' : 'Load project' }}
      </button>
      @if (project.pending()) {
        <button type="button" (click)="project.cancel()">Cancel</button>
      }
      @if (project.status() === 'error') {
        <p role="alert">{{ project.error()?.message }}</p>
      }
      @if (project.status() === 'error' || project.status() === 'cancelled') {
        <button type="button" (click)="project.submit()">Retry</button>
      }
      <p role="status" aria-live="polite">
        @if (project.status() === 'cancelled') { Request cancelled. }
        @if (project.status() === 'success') { Loaded {{ project.data()?.project?.name }}. }
      </p>
    </form>
  `,
})
export class ProjectToolFormComponent {
  readonly project = injectToolForm('get_project', tools.get_project, { id: 'atlas' }, {
    schema: path => required(path.id),
  });
}
```

In `apps/demo/src/app.ts`, import `ProjectToolFormComponent` from `../../../examples/forms/tool-form.component.js`, add it to the component's `imports`, and render `<project-tool-form />`. Choose an ID returned by `list_projects`. The library validates the shared Zod contract through Angular's native `validateStandardSchema`; extra `schema` rules provide Angular field metadata such as `required`. `FormRoot` handles the DOM submit event, and invalid submissions focus the first bound field with an error. [Angular's Signal Forms guide](https://angular.dev/guide/forms/signals/overview) explains the native field bindings; [Standard Schema validation](https://angular.dev/api/forms/signals/validateStandardSchema) describes the schema adapter.

Native submit events require the host iframe's `allow-forms` sandbox permission, which the workbench provides. If your target host blocks that permission, use an explicit `<button type="button" (click)="project.submit()">Load project</button>` to invoke the same validated command without a native submit event. The workbench separately blocks network form navigation with CSP `form-action 'none'`.

The model and fields use `ToolInput`, the JSON sent to the server. A Zod transform or default validates locally but does not rewrite that model or request. For example, a string transformed to a number remains a string on the wire, and omitted defaults stay omitted. The server performs its own parsing. Returned `data()` uses the contract's parsed `ToolOutput`.

| API | Meaning |
| --- | --- |
| `model`, `fields` | Writable model signal and typed native `FieldTree` |
| `valid()`, `validating()` | Native validation state, including asynchronous refinements |
| `pending()` | Native submission state; concurrent submissions are refused |
| `canSubmit()` | Valid, active, and not already submitting |
| `errors()` | Native field and submission error summary |
| `data()`, `result()` | Last validated output and full MCP result |
| `error()`, `status()` | Invocation error and adapter lifecycle state |
| `submit(event?)` | Submit programmatically; returns whether this request succeeded |
| `cancel()` | Abort the active request and ignore its late result |
| `reset(value?)` | Cancel, reset fields, clear results; defaults to the initial model |

Use `submit()` for retries with unchanged values: it clears the previous submission error before validating again. A changed form also clears its prior submission error through Angular's field state. Component destruction aborts pending work. Cancellation cannot undo a server operation that has already completed.

You can supply an existing writable signal instead of initial values. `timeoutMs` sets the MCP invocation timeout. Create the form in an Angular injection context, such as a component field initializer. The starter's compileable example lives at `examples/forms/tool-form.component.ts` when included by your project.

## Expose selected tools to a browser agent

Browser WebMCP is a separate browser-agent interface from the iframe MCP Apps connection. This adapter uses Angular's experimental `declareExperimentalWebMcpTool` API. It registers nothing unless you pass `enabled: true`; unsupported browsers and SSR resolve `ready` to `false`. Tool registration and in-flight execution follow Angular injector destruction. Angular documents the feature and its experimental status in its [WebMCP guide](https://angular.dev/ai/webmcp).

### A local Angular tool

Place this in a file imported by your application configuration. A local handler receives the validated, parsed input and runs in Angular's injection context. This example explicitly exposes one browser-local counter command:

```ts
import { inject, Injectable, signal } from '@angular/core';
import { defineTool, defineTools } from '@angular-mcp-bridge/contracts';
import { provideWebMcpTools } from '@angular-mcp-bridge/angular/webmcp';
import { z } from 'zod';

@Injectable({ providedIn: 'root' })
export class CounterState {
  readonly value = signal(0);
}

export const browserTools = defineTools({
  increase_counter: defineTool({
    title: 'Increase counter',
    description: 'Increase the counter displayed in this browser tab.',
    input: z.object({ amount: z.number().int().min(1).max(10).default(1) }),
    output: z.object({ value: z.number() }),
    annotations: {
      readOnlyHint: false, destructiveHint: false,
      idempotentHint: false, openWorldHint: false,
    },
  }),
});

export const browserToolProviders = provideWebMcpTools(browserTools, {
  increase_counter(input, client) {
    client.signal.throwIfAborted();
    const counter = inject(CounterState);
    counter.value.update(value => value + input.amount);
    return { value: counter.value() };
  },
}, { enabled: true, onError: error => console.error('WebMCP registration failed', error) });
```

Add `browserToolProviders` to the application or route `providers`. Local handlers own their business rules and authorization. Shared server OAuth metadata is not an authorization mechanism for browser-local code. For an individual component-scoped tool, call `declareWebMcpTool(name, definition, handler, options)` in that component's injection context; it returns a registration with `status()`, `error()`, `ready`, and `dispose()`.

### A browser tool backed by your MCP server

To expose an existing server tool, use `injectWebMcpTool` from a component or service owned by the widget. The normal MCP bridge must be configured. This retains the server's authorization and validation, passes raw wire input, and returns validated output without widget-private `_meta`.

```ts
import { Injectable } from '@angular/core';
import { injectWebMcpTool } from '@angular-mcp-bridge/angular/webmcp';
import { tools } from '../shared/tools.js';

@Injectable()
export class ProjectBrowserTool {
  readonly registration = injectWebMcpTool('get_project', tools.get_project, {
    enabled: true,
    timeoutMs: 10_000,
  });
}
```

Provide and inject this service in the view that should expose it; Angular services are instantiated on demand. Both local and server adapters validate input before execution and output before returning it. They reject invalid input, failed server calls, and app-only contracts (`visibility: ['app']`). Browser-client cancellation aborts the command; destruction removes the registration and aborts active calls.

## Let Angular expose the form itself

For a simple form, Angular can also infer a browser tool from its field tree. Add `provideExperimentalWebMcpForms()` to the bootstrap providers and opt into a specific form:

```ts
import { provideExperimentalWebMcpForms } from '@angular-mcp-bridge/angular/forms';

export const nativeWebMcpFormProviders = [provideExperimentalWebMcpForms()];
```

```ts
import { injectToolForm } from '@angular-mcp-bridge/angular/forms';
import { tools } from '../shared/tools.js';

export function createBrowserProjectForm() {
  return injectToolForm('get_project', tools.get_project, { id: 'atlas' }, {
    experimentalWebMcpTool: {
      name: 'submit-project-form',
      description: 'Set the project ID and submit the project detail form.',
      annotations: { consequentialHint: false },
    },
  });
}
```

Call `createBrowserProjectForm()` in a component injection context. When WebMCP is absent, the form continues to work normally. Native form inference needs concrete initial values: it does not support `null`, `undefined`, or empty arrays. Its inferred schema describes current fields rather than all Zod constraints; the shared contract still validates submission. Native Angular form tools return a submission summary, and Angular 22.2 does not forward the browser client's abort signal into the submission action. Manual `cancel()` and destruction still cancel this adapter's pending tool call. Use `injectWebMcpTool` when you need contract-derived JSON Schema, structured tool output, and browser-client cancellation.

Keep WebMCP opt-in, choose tool names that do not collide, and expose only the intended registry. For a generated project, add `@angular/forms` before importing the forms entrypoint; the base Angular bridge does not require it.
