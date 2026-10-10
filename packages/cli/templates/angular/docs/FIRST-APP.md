# Build your first tool and view

One command creates a working tool and Angular view. Then you edit one file on each side. Start in a working starter from [Getting started](GETTING-STARTED.md).

## 1. Create it

Stop `npm run dev` if it is running, then:

```sh
npm run add-view -- greeting
npm run dev
```

Open the printed Workbench URL, select **open_greeting**, click **Run tool**. The preview shows **Hello, World!** (the default `name`) with the bridge **connected**. Nothing else is needed for this to work.

The command created:

| Side | File | What it holds |
| --- | --- | --- |
| Tool | `examples/generated/open_greeting/contract.ts` | Input and output schemas (Zod), shared with the view |
| Tool | `examples/generated/open_greeting/handler.ts` | The server function that returns the result |
| View | `apps/greeting/src/app.ts` | The Angular component |

The contract and handler are separate on purpose: the view imports the contract, so a handler that talks to a database or API must never live in the same file.

## 2. Edit the tool

In `contract.ts`, change the schemas. In `handler.ts`, return data that matches the output schema; the generated handler is already:

```ts
input => ({
  data: { message: `Hello, ${input.name}!` },
  text: `Hello, ${input.name}!`,
})
```

`data` becomes validated `structuredContent`; `text` is what the model reads. The generator already registered both files, so there is nothing to wire up. Misspelled view names fail type checking.

## 3. Edit the view

In `apps/greeting/src/app.ts`, read the result with a typed signal:

```ts
readonly info = client.info('open_greeting');   // typed from the contract
```

and render `info().output.message` in the template (the generated template already does). `client.info()` is a validated signal of the invocation that opened the view. To call the tool again from a button, see the [typed command recipe](RECIPES.md). Choose **Angular dev server · HMR** under Preview source in the workbench, edit the template, save, and the view updates.

## 4. Check and build

```sh
npm run check
npm run build
```

The view appears in `dist/bridge-manifest.json` and `dist/views/greeting.html`.

Continue with [Angular recipes](RECIPES.md), [server features](SERVER.md), or [real-host setup](HOST-SETUP.md).
