# @angular-mcp-bridge/contracts

Shared Zod 4 tool definitions for the Angular UI and MCP server. Keep this module safe to bundle into the browser: schemas, annotations and types belong here; server handlers, credentials and database clients belong in the server module.

This v0.1 package is a local tarball, not an npm registry release. Generated apps already install it through their `vendor` manifest entries. Read their `docs/FIRST-APP.md` for a complete tool → handler → Angular view walkthrough.

## Define one shared contract

Create a browser-safe file such as `examples/shared/note-tools.ts`:

```ts
import { defineTool, defineTools, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { z } from 'zod';

export const noteTools = defineTools({
  find_note: defineTool({
    title: 'Find a note',
    description: 'Use when the user asks for a note by its ID.',
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ note: z.object({ id: z.string(), title: z.string() }) }),
    annotations: readOnlyAnnotations,
  }),
});

export type NoteTools = typeof noteTools;
```

`title`, `description`, `input`, `output` and `annotations` are required. Input/output schemas must be Zod objects. `defineTools()` retains literal tool names for client inference. The example defines a new contract; it is not registered with the server until you add its handler to server options.

| Type / field | Meaning |
| --- | --- |
| `ToolInput<typeof definition>` | Wire input accepted by the schema, before defaults/transforms. |
| `ToolParsedInput<typeof definition>` | Parsed handler input after defaults/transforms. |
| `ToolOutput<typeof definition>` | Parsed output returned to callers. |
| `view` | Optional named Angular UI resource; the server must register that view. |
| `securitySchemes` | OAuth/noauth alternatives declared and enforced by the server. |
| `visibility` | Optional `model`/`app` visibility; app-only tools are excluded from evaluation model discovery. |
| `icons`, `invoking`, `invoked`, `meta` | Tool presentation/status/extra host metadata. |
| `openai` | Typed entrypoints and display preferences for hosts that support them. |

`readOnlyAnnotations` declares read-only, non-destructive, idempotent, closed-world behavior. For a mutation, provide all four annotation booleans explicitly and set `readOnlyHint: false`; Angular resources reject mutating tools. Annotations are descriptive and do not replace authorization.

## Use the same map on both sides

The [server package](../server/README.md) accepts `tools: noteTools` and a `handlers` map keyed by exactly `find_note`. Its handler receives parsed input and returns `{ data: { note }, text?, meta? }`. Public data becomes `structuredContent`; `meta` becomes private UI `_meta`.

The [Angular package](../angular/README.md) consumes `createToolClient(noteTools)`. Create `.inject('find_note')` or `.resource('find_note', { params })` in a component injection context, or `.info(name)` for the tool that opened that view. See the generated app's `docs/ANGULAR-API.md` for complete component examples.

A `view` must match the server's `views` key and the application's view marker. Optional `defineFileViewerTool()` supplies the host-managed file-entrypoint input schema; `FileEntrypointInput` and `FileRef` describe file references and do not download file contents automatically. Host-specific metadata alone does not guarantee a host supports the feature.
