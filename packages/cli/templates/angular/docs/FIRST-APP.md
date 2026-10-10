# Build your first tool and view

Add a `greet` tool that returns a typed message and opens a standalone Angular greeting view. Start in a working starter from [Getting started](GETTING-STARTED.md). Stop `npm run dev` before adding a view.

A shared contract defines input/output and the view to open. A handler supplies its result. An Angular component reads that result through a typed signal. The generator connects these pieces for you.

## 1. Generate the tool and Angular view

```sh
npx ng generate @angular-mcp-bridge/cli:view greeting --tool greet
```

This creates `apps/greeting/`, `views/greeting/view.json` and `examples/generated/greet/`. It registers the tool and handler in the registries configured by `bridge.config.json.native` and updates the literal view-name type. No manual server registration is needed. The generated greeting already works; the following steps customize it.

The CLI package is installed by the local creator. For an existing Angular app, use [the native setup guide](TOOLING-NATIVE.md) first. `npm run add-view -- greeting` is a shortcut that chooses the tool name `open_greeting`; this tutorial uses `greet` explicitly.

## 2. Customize the shared contract

Replace **`examples/generated/greet/contract.ts`** with this complete content:

```ts
import { defineTool, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { z } from 'zod';
import type { ViewName } from '../../../generated/view-names.js';

export const greetTool = defineTool({
  title: 'Greet someone',
  description: 'Use this when the user wants a greeting. Opens the Angular greeting view.',
  input: z.object({ name: z.string().min(1).default('Angular') }),
  output: z.object({ message: z.string() }),
  annotations: readOnlyAnnotations,
  view: 'greeting' satisfies ViewName,
});
```

The shared file contains schemas, never backend credentials or implementation imports. `view` matches the generated name, so misspellings fail type checking. The feature folder is editable source despite its name; only `generated/view-names.ts` and `dist/` are regenerated build output.

## 3. Customize the typed server handler

Replace **`examples/generated/greet/handler.ts`** with this complete content:

```ts
import type { ToolHandlers } from '@angular-mcp-bridge/server';
import { greetTool } from './contract.js';

export const greetHandler: ToolHandlers<{ greet: typeof greetTool }>['greet'] = ({ name }) => ({
  data: { message: `Hello, ${name}!` },
  text: `Greeted ${name}.`,
});
```

The generator has already imported this handler into `examples/server/generated-handlers.ts`. The starter merges that registry with its existing handlers. `data` becomes validated `structuredContent` seen by the model and view; `text` supplies brief narration. The manifest discovers the new view automatically.

## 4. Render the result in Angular

Replace **`apps/greeting/src/app.ts`** with this complete content. Keep the generated `main.ts` and its `provideMcpBridge()` provider.

```ts
import { Component, inject } from '@angular/core';
import { createToolClient, McpBridge } from '@angular-mcp-bridge/angular';
import { greetTool } from '../../../examples/generated/greet/contract.js';

const client = createToolClient({ greet: greetTool });

@Component({
  selector: 'bridge-root',
  standalone: true,
  template: `
    <main>
      <p>Bridge: {{ bridge.status() }}</p>
      @let result = greeting();
      @switch (result.status) {
        @case ('success') { <h1>{{ result.output.message }}</h1> }
        @case ('error') { <p role="alert">{{ result.error.message }}</p> }
        @case ('cancelled') { <p role="status">Request cancelled.</p> }
        @default { <p>Run Greet someone in the workbench.</p> }
      }
    </main>
  `,
})
export class AppComponent {
  readonly bridge = inject(McpBridge);
  readonly greeting = client.info('greet');
}
```

`client.info()` is a computed, validated signal of the invocation that opened this view. It reads the host result. To initiate another request from a button, see the [typed command recipe](RECIPES.md).

## 5. Run it

```sh
npm run check
npm run dev
```

In the printed Workbench URL, select **Greet someone**, enter `Ada` in the `name` input (or use `{"name":"Ada"}` in the JSON editor), and click **Run tool**. The preview should show **Hello, Ada!** and **connected**. **Tool result** should contain `structuredContent.message`.

Select **Angular dev server · HMR**, change the template and save to iterate. For a production check, stop dev and run `npm run build`; the new view appears in `dist/bridge-manifest.json` and `dist/views/greeting.html`. Both build and dev compile Angular templates.

Continue with [Angular recipes](RECIPES.md), [server features](SERVER.md), or [real-host setup](HOST-SETUP.md).
