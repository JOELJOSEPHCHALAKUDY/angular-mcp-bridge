# Build the MCP server

Start with [Getting started](GETTING-STARTED.md), then [Build your first tool and view](FIRST-APP.md). This guide explains how to connect a backend, customize server registration and enable optional capabilities. All paths are relative to your app folder; the same files exist in a generated app. The [documentation index](index.md) shows the full learning path.

The server runs Node.js and TypeScript. Angular runs inside the UI resource. Both use the Zod contracts in `examples/shared/tools.ts`, so a tool's input and output types stay consistent across the boundary.

## Find the right file

| File | Change it when you want to… |
| --- | --- |
| `examples/shared/tools.ts` | Add or change a typed tool contract. |
| `examples/server/app.ts` | Replace project demo handlers with your data source. |
| `examples/server/framework-app.ts` | Configure views, prompts, resources and extensions. |
| `examples/server/main.ts` | Set HTTP options or start a different server factory. |
| `apps/*/src/app.ts` | Build the Angular UI. |
| `views/*/view.json` | Map a view name to its Angular application. |
| `bridge.config.json` | Choose the server entry, default view and preferred ports. |

The supplied server loads the build manifest rather than hardcoding all view paths. Keep its `publicRuntime()` route when using the local workbench: that route tells the workbench which views and development URLs are available.

## Replace the starter server with a small factory

For an ordinary new tool, follow [the first-app tutorial](FIRST-APP.md): keep the active `frameworkOptions()` factory, define the shared contract, and add its handler to that factory. Editing a handler that is never registered will not change the running server.

The following is an optional alternative for an app that replaces the complete starter registry. It serves only a notes tool/view; the supplied project/lab tools, prompts and resources are no longer registered. Stop `npm run dev` before adding the new view, then run this from your app folder:

```sh
npm run add-view -- notes
```

Create `examples/server/notes.ts` with this complete server-only module. This example replaces the generated `open_notes` tool with `list_notes`; update the generated view below to match the replacement.

```ts
import { z } from 'zod';
import {
  defineTool, defineTools, readOnlyAnnotations,
} from '@angular-mcp-bridge/contracts';
import type { BridgeServerOptions } from '@angular-mcp-bridge/server';

export const noteTools = defineTools({
  list_notes: defineTool({
    title: 'List notes',
    description: 'Use this when the user asks to browse their demo notes.',
    input: z.object({ query: z.string().default('') }),
    output: z.object({ notes: z.array(z.string()), total: z.number() }),
    annotations: readOnlyAnnotations,
    view: 'notes',
    invoking: 'Finding notes…',
    invoked: 'Notes ready',
  }),
});

export function notesOptions(htmlPath: string): BridgeServerOptions<typeof noteTools> {
  const notes = ['Plan the release', 'Review the Angular view', 'Write the guide'];
  return {
    name: 'my-notes',
    version: '0.1.0',
    tools: noteTools,
    views: { notes: { htmlPath, description: 'Browse and filter demo notes.' } },
    handlers: {
      list_notes: ({ query }) => {
        const found = notes.filter(note => note.toLowerCase().includes(query.toLowerCase()));
        return { data: { notes: found, total: found.length }, text: `Found ${found.length} notes.` };
      },
    },
  };
}
```

Replace `apps/notes/src/app.ts` with this complete component. Keep its generated `main.ts` and bridge provider. It displays the server's structured result without importing server-only code:

```ts
import { JsonPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { McpBridge } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'bridge-root',
  standalone: true,
  imports: [JsonPipe],
  template: `<main><h1>Notes</h1><pre>{{ bridge.toolResult()?.structuredContent | json }}</pre></main>`,
})
export class AppComponent {
  readonly bridge = inject(McpBridge);
}
```

In `examples/server/main.ts`, import `resolve` from `node:path` and `notesOptions` from `./notes.js`. Replace the `frameworkOptions()` argument to `serveBridge` with `notesOptions(resolve('dist/views/notes.html'))`. Keep the remaining HTTP options and shutdown handlers. Set `defaultView` in `bridge.config.json` to `notes`, then restart `npm run dev`.

When using `npm run preview`, apply the same factory replacement in `tooling/preview.ts`, importing `notesOptions` from `../examples/server/notes.js`. This starter's production preview has its own server entry; keep its workbench path and runtime route.

Open the printed workbench URL, select `list_notes` and call it with `{ "query": "Angular" }`. The result should contain one note, and the `notes` view should show that result. For typed Angular rendering and tool calls, continue with [Angular API](ANGULAR-API.md).

Move the shared `noteTools` registry to `examples/shared/tools.ts` when importing it from Angular. Importing an entire server module into a widget can pull Node-only code into the browser bundle.

## Tool responses and request context

A handler returns `{ data, text?, content?, meta?, isError? }`. `data` becomes validated `structuredContent`; `text` and `content` are model-visible MCP content. `meta` becomes `_meta`, available to the widget outside model context. Never put access tokens, secrets or unrestricted private records in any of these fields. An `InputRequiredResult` is also supported for forms.

Inputs are parsed before the handler runs, including Zod defaults and transforms. Outputs are parsed before they reach the host. Declare annotations that match the operation: `readOnlyAnnotations` fits reads; a tool that mutates data needs accurate write/destructive/idempotent hints. These hints help a host describe an action; authorization still belongs on the server.

Handlers receive a `BridgeRequestContext`:

| Property | Use |
| --- | --- |
| `signal` | Cancel fetches or other abortable work when the request is cancelled. |
| `requestId`, `sessionId` | Correlate a request with your own logs. The session ID can be absent. |
| `auth` | Verified subject, client ID, scopes and claims, when authenticated. |
| `http` | Request URL, method and a limited header allowlist excluding tokens and cookies. |
| `locale`, `userAgent`, `meta` | Optional client hints; treat them as untrusted hints. |
| `sdk` | Official SDK context for progress, input responses, request state and custom protocol features. |

`context.sdk.http.authInfo` can include the raw access token. Avoid logging the raw SDK context or copying its fields into a response.

## Return images, audio and links

The helpers build standard MCP content; they do not fetch files or infer MIME types. Binary `Uint8Array` values are encoded as base64. Strings passed to `image` or `audio` must already be base64.

```ts
import {
  audio, embeddedResource, image, resourceLink, text,
} from '@angular-mcp-bridge/server';

export function attachmentContent(png: Uint8Array, wav: Uint8Array) {
  return [
    text('Generated attachments'),
    image(png, 'image/png'),
    audio(wav, 'audio/wav'),
    embeddedResource({ uri: 'bridge://notes/readme', mimeType: 'text/plain', text: 'Notes guide' }),
    resourceLink({ uri: 'bridge://notes/readme', name: 'Notes guide', mimeType: 'text/plain' }),
  ];
}
```

`FileRef` is an exported Zod schema for `{ file_id, download_url, mime_type?, file_name? }`. It validates a host-managed reference. Fetching that URL requires your own access checks, URL policy, limits and cancellation handling.

## View metadata, CSP and caching

`views` maps the same identifiers used by tool `view` fields to `ViewDefinition` objects. Choose `htmlPath` for built Angular HTML or `html` for an adapter/test-generated document. The framework hashes HTML into its `ui://` URI, registers the MCP Apps MIME type and adds both standard MCP Apps and ChatGPT compatibility metadata.

```ts
import type { ViewDefinition } from '@angular-mcp-bridge/server';

export const notesView: ViewDefinition = {
  htmlPath: 'dist/views/notes.html',
  title: 'Notes',
  description: 'An Angular note browser with filtering and details.',
  prefersBorder: true,
  csp: {
    connectDomains: ['https://api.example.com'],
    resourceDomains: ['https://cdn.example.com'],
  },
};
```

Replace example domains with origins your widget actually uses, or use empty arrays for a self-contained widget. `connectDomains` controls widget network requests; `resourceDomains` controls external assets; `frameDomains` declares embedded frame origins. `domain` and `permissions` are optional host metadata. They do not host the app or grant server authorization. See [host setup](HOST-SETUP.md) before exposing an endpoint.

`getViewManifest(server)` returns each registered view's URI, byte size and SHA-256 digest. Use it when a custom registration needs the URI; do not reconstruct the hash yourself. Tools sharing a view must agree on available/preferred display modes.

## Resources, prompts and change notifications

Use `configure(server, constructionContext)` for the maintained MCP SDK's public APIs. The following complete registration function can be passed as `configure`. It exposes a small process-local note and a prompt, plus a function your application can call when the note changes.

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { BridgeConstructionContext } from '@angular-mcp-bridge/server';

export function createNoteRegistrations() {
  let note = 'Welcome to the notes app.';
  const notifiers = new Set<NonNullable<BridgeConstructionContext['notify']>>();
  return {
    configure(server: McpServer, { notify }: BridgeConstructionContext) {
      if (notify) notifiers.add(notify);
      server.registerResource('Welcome note', 'bridge://notes/welcome',
        { mimeType: 'text/plain' }, uri => ({
          contents: [{ uri: uri.href, mimeType: 'text/plain', text: note }],
        }));
      server.registerPrompt('explain-note', {
        description: 'Explain a note clearly.',
        argsSchema: z.object({ topic: z.string().min(1) }),
      }, ({ topic }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Explain this note: ${topic}` } }],
      }));
    },
    async replaceNote(value: string) {
      note = value;
      await Promise.all([...notifiers].map(notify => notify.resourceUpdated('bridge://notes/welcome')));
    },
  };
}
```

Create this object once outside the server factory. The HTTP adapter creates MCP server instances per request, so `configure` can run repeatedly; initialize connection pools and durable storage outside it. The example state disappears when the process restarts. In a production app, load and update records in your own store.

`serveBridge()` also returns `notify`, `bus`, the Node HTTP `server`, and async `close()`. Call `running.notify.toolsChanged()`, `resourcesChanged()` or `promptsChanged()` when their lists change. Standard change streams use the SDK's `subscriptions/listen` support; hosts must forward subscriptions for widgets to observe updates. Supply `handlerOptions.bus` for a shared multi-process event bus.

Resource mutation is a host extension: `openai/resources/write`. The lab example in `examples/server/framework-app.ts` shows schema validation, optimistic concurrency with `ifMatch`, bounded note size and update notifications. Register custom methods with `server.server.setRequestHandler(method, { params: z.object(...) }, handler)`. A host must advertise the relevant extension before the Angular client uses it.

## Ask for form input

This complete factory asks for confirmation without performing a write. Add real writes only after an accepted, validated answer and your usual authorization checks.

```ts
import { z } from 'zod';
import { defineTool, defineTools, readOnlyAnnotations, type ToolRegistry } from '@angular-mcp-bridge/contracts';
import { requestFormInput, type BridgeServerOptions } from '@angular-mcp-bridge/server';

export function confirmationOptions(): BridgeServerOptions<ToolRegistry> {
  const tools = defineTools({
    confirm: defineTool({
      title: 'Confirm', description: 'Ask whether the user wants to proceed.',
      input: z.object({}), output: z.object({ confirmed: z.boolean() }),
      annotations: readOnlyAnnotations,
    }),
  });
  return {
    name: 'confirmation-example', tools, views: {},
    handlers: {
      confirm: (_input, context) => {
        const answer = requestFormInput(context.sdk, {
          key: 'confirmation', message: 'Proceed?',
          schema: z.object({ confirmed: z.boolean() }),
        });
        if ('resultType' in answer) return answer;
        return { data: { confirmed: answer.action === 'accept' && answer.content.confirmed } };
      },
    },
  };
}
```

`requestFormInput` uses the official SDK's modern retry flow and legacy input shim. Keep each form key stable across retries. Cancel and decline are explicit outcomes; accepted content is schema validated.

`requestOpenAIFormInput` accepts `{ key, message, requestedSchema, requestState?, meta? }` for richer JSON-schema forms. It requires modern protocol support and the `openai/elicitation` client extension. Offered-resource selections are validated when free selection is disabled. Use the standard form for hosts without that extension. If echoed state influences authorization, seal it with `createRequestStateCodec` and install its verifier in `sdkOptions.requestState.verify`; unverified client-echoed state is untrusted.

## Add OAuth when the app needs private data

Keep the public demo running first, then configure your identity provider. This complete factory adds a public description and an authenticated profile tool. The placeholder URLs below are configuration examples, not live services.

```ts
import { z } from 'zod';
import { defineTool, defineTools, readOnlyAnnotations, type ToolRegistry } from '@angular-mcp-bridge/contracts';
import { customProvider, type BridgeServerOptions } from '@angular-mcp-bridge/server';

export function secureOptions(config: {
  resource: string; issuer: string; jwksUri: string;
}): BridgeServerOptions<ToolRegistry> {
  const tools = defineTools({
    about: defineTool({
      title: 'About', description: 'Describe the app before sign-in.',
      input: z.object({}), output: z.object({ description: z.string() }),
      annotations: readOnlyAnnotations, securitySchemes: [{ type: 'noauth' }],
    }),
    profile: defineTool({
      title: 'Profile', description: 'Read the verified caller identity after sign-in.',
      input: z.object({}), output: z.object({ subject: z.string() }),
      annotations: readOnlyAnnotations,
      securitySchemes: [{ type: 'oauth2', scopes: ['profile:read'] }],
    }),
  });
  return {
    name: 'secure-example', tools, views: {},
    oauth: customProvider({ ...config, scopes: ['profile:read'] }),
    handlers: {
      about: () => ({ data: { description: 'A notes app with optional sign-in.' } }),
      profile: (_input, context) => {
        if (!context.auth?.subject) throw new Error('A verified subject is required.');
        return { data: { subject: context.auth.subject } };
      },
    },
  };
}
```

Example configuration: `resource: 'https://notes.example.com/mcp'`, `issuer: 'https://identity.example.com/'`, `jwksUri: 'https://identity.example.com/.well-known/jwks.json'`. The access token's `aud` must match `resource` unless you explicitly configure a different audience. Preserve your provider's exact issuer string.

| Provider function | Required provider configuration, in addition to `resource` |
| --- | --- |
| `customProvider` | `issuer`; discovery locates JWKS unless `jwksUri` or local `jwks` is supplied. |
| `auth0Provider` | `domain`, `audience`. Adds the audience parameter through an authorization-metadata facade. |
| `clerkProvider` | `domain`. Preset deliberately omits audience checking for supported Clerk JWT OAuth tokens. |
| `workosProvider` | `domain`, `audience`. |
| `stytchProvider` | `domain`, `audience`. |
| `descopeProvider` | `url`, the agentic MCP discovery URL. |
| `authplaneProvider` | `issuer`; audience defaults to `resource`. |

Presets configure verification and discovery; they do not create tenants, register clients, enable DCR or introspect opaque tokens. Use a custom `OAuthProvider.resolve()` and trusted `TokenVerifier` for an opaque-token provider. JWT verification uses `jose` with signing-key, issuer, expiry, subject and audience checks. `verifyAudience: false` is an explicit opt-out for a provider that issues no audience.

The server exposes protected-resource metadata at `/.well-known/oauth-protected-resource` and the resource-specific path. Invalid/missing tokens receive an HTTP bearer challenge. Protected tool failures include `mcp/www_authenticate` metadata for host sign-in recovery. The exact public `resource` is configured explicitly; forwarding headers do not change it.

With a provider, tools without explicit schemes require OAuth. A tool with `noauth` permits anonymous callers; declaring both `noauth` and OAuth also requires a supplied identity to satisfy an OAuth alternative. OAuth alternatives are OR; scopes within one alternative are AND. With any explicitly public tool, the HTTP endpoint defaults to optional authentication. `authentication: 'required'` in HTTP options enforces an endpoint-wide gate. Invalid supplied tokens still fail on a mixed endpoint.

On a mixed endpoint, secure resources, prompts, custom methods and custom HTTP routes in their own handlers or middleware. Tool schemes do not protect those surfaces automatically. Convenience file/settings/mentions registrations inherit the configured OAuth requirement unless you override their schemes. See [host setup](HOST-SETUP.md#oauth-and-identity-provider-setup) for client registration and callbacks.

## Middleware and telemetry

```ts
import { getToolError, type MiddlewareEntry, type TelemetryObserver } from '@angular-mcp-bridge/server';

export const middleware: MiddlewareEntry[] = [{
  filter: 'tools/*',
  handle: async (_request, context, next) => {
    const result = await next();
    if (getToolError(context)) console.warn('A tool handler failed.');
    return result;
  },
}];
export const telemetry: TelemetryObserver = event => {
  console.info({ method: event.method, tool: event.toolName, ms: event.durationMs, status: event.status });
};
```

Pass these exports as server options. Filters accept exact methods, `prefix/*`, `request`, `notification`, `*` or an array. Middleware runs in registration order around application handlers, including custom methods, resources, prompts and lists. Call `next()` once; return its result or your own valid protocol result. Transport initialization/negotiation is handled by the SDK and is outside this chain. Telemetry observers cannot break responses and receive no arguments or tokens automatically; custom logging is your responsibility.

`configureApp(app)` in HTTP options registers Express routes after host/origin guards and OAuth setup. The `/mcp` bearer middleware applies to `/mcp`; authenticate other routes explicitly when needed.

## ChatGPT file entrypoints, mentions and settings

These are optional host extensions. A standard MCP host can expose the underlying tools while lacking composer/file/settings UI. Capability-check client actions before use.

Use a shared `defineFileViewerTool` contract so Angular gets the same typed file input:

```ts
import { z } from 'zod';
import { defineTools, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { defineFileViewerTool } from '@angular-mcp-bridge/server';

export const fileTools = defineTools({
  open_note_file: defineFileViewerTool({
    title: 'Open note', description: 'Open a host-provided note file.',
    extensions: ['.md', '.txt'], view: 'notes',
    output: z.object({ name: z.string(), resourceUri: z.string() }),
    annotations: readOnlyAnnotations,
    openai: { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' },
  }),
});
```

The handler receives `{ file: { name, resourceUri } }`; register the `notes` view and return the declared output normally. The helper advertises a file entrypoint; it does not read arbitrary local paths. Put this shared contract in `examples/shared/`, and import `defineFileViewerTool` from `@angular-mcp-bridge/contracts` when Angular also imports the module. The server re-export is convenient for server-only modules.

Alternatively use `registerFileViewer` in `configure`, with a URI obtained from `getViewManifest(server)`. `openai` tool options also support global/thread/settings entrypoints and quick actions. Global/thread entrypoints must accept `{}`. Quick actions require a registered target, valid arguments and at least one icon.

This complete `configure` function adds mentions and process-local settings:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerMentions, registerSettings, resourceLink } from '@angular-mcp-bridge/server';

export function createSettingsRegistrations() {
  let values: { units: 'mm' | 'in'; grid: boolean } = { units: 'mm', grid: true };
  return (server: McpServer) => {
    registerMentions(server, {
      name: 'notes.search',
      handler: ({ query }) => ({ items: query.trim() ? [resourceLink({
        uri: 'bridge://notes/welcome', name: 'Welcome note', mimeType: 'text/plain',
      })] : [] }),
    });
    registerSettings(server, {
      fields: {
        units: { title: 'Units', schema: z.enum(['mm', 'in']) },
        grid: { title: 'Show grid', schema: z.boolean() },
      },
      read: () => values,
      update: set => { values = { ...values, ...set }; return values; },
    });
  };
}
```

Create the callback once and pass it as `configure`. Register the linked resource with the resource example above. Mentions search is an app-only tool returning resource links. Settings expose read/update tools and the `openai/settings` capability. Fields must be required primitives or string enums, without defaults. Updates contain a nonempty partial `set`, and callbacks return all current values. Unknown keys and invalid layout references are rejected. Replace the shared in-memory object with storage keyed to the verified user before using private settings.

## Skills

Create a controlled directory such as `examples/skills/notes/SKILL.md`:

```md
---
name: notes
description: Help the user browse and organize notes.
---

Use list_notes to browse notes before suggesting a next action.
```

Set `skills: { directory: 'examples/skills' }` in server options. Each immediate skill folder needs a matching frontmatter name and a description. Markdown resources are exposed through `skills/list`, `skills/get` and `resources/directory/read`; hidden files, symlinks, scripts and binaries are skipped. Discovery snapshots contents and hashes. The server never executes a skill.

For non-filesystem deployment or explicit discovery limits, call `discoverSkills(directory, options)` yourself and pass its `SkillsManifest` as `skills`. Limits cover file count, size and traversal depth; choose controlled directories rather than accepting a user-supplied path.

## Experimental webhook events

Events require a verified caller, a trusted callback origin and host support for the experimental event protocol. This complete module defines an event, stores subscriptions in memory and exposes a publish function. It does not enable OAuth by itself; add the returned `events` to an authenticated server's options.

```ts
import { z } from 'zod';
import {
  createEventPublisher, defineEvent, type EventSubscription,
} from '@angular-mcp-bridge/server';

export function createNoteEvents(callbackOrigin: string) {
  const subscriptions = new Map<string, { noteId: string; subscription: EventSubscription }>();
  const changed = defineEvent({
    name: 'note.changed',
    description: 'A subscribed note changed.',
    input: z.object({ noteId: z.string().min(1) }),
    payload: z.object({ text: z.string() }),
    onSubscribe: (input, { subscription }) => {
      subscriptions.set(subscription.id, { noteId: input.noteId, subscription });
    },
    onUnsubscribe: (_input, { subscription }) => { subscriptions.delete(subscription.id); },
  });
  const delivery = { allowedOrigins: [callbackOrigin] };
  const publish = createEventPublisher(changed, delivery);
  return {
    events: { definitions: [changed], delivery },
    async publishNote(noteId: string, occurrenceId: string, text: string) {
      const targets = [...subscriptions.values()].filter(item => item.noteId === noteId);
      return Promise.all(targets.map(({ subscription }) =>
        publish(subscription, { id: occurrenceId, data: { text } })));
    },
  };
}
```

Before storing a subscription, authorize `input.noteId` for the principal from `sdk.http.authInfo`. The example uses identifiers only and has no private data policy. Production hooks must enforce ownership, quotas and durable storage. Inspect each delivery result and implement bounded retries using the same occurrence ID. Subscription secrets belong in server storage, never tool output or widget HTML.

The implementation exposes `events/list`, `events/subscribe`, `events/unsubscribe`, a signed nonce verification challenge and Standard Webhooks delivery. It validates filters/payloads/secrets, bounds TTL and payload size, and uses exact HTTPS callback origins with public-IP checks, pinned DNS and no redirect following. `allowInsecureLocalhost` is available for local callback tests only. `deliverEvent` supports secret rotation; `createEventPublisher` adds payload-schema validation. There is no bundled hosted queue or durable retry worker. The protocol follows an [experimental upstream draft](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md), so host support and future compatibility must be checked separately.

## HTTP defaults and other transports

`serveBridge(options, httpOptions)` serves `/mcp` and `/health`, binds to `127.0.0.1:3000` by default, and accepts only local hostnames unless configured. HTTP options are `port`, `hostname`, `allowedHosts`, `allowedOrigins`, `authentication`, `workbenchPath`, `assets`, `handlerOptions` and `configureApp`. A hostname allowlist uses names without scheme/port; an origin allowlist uses complete origins with scheme and any port.

For stdio or your own transport, call `createBridgeServer(options)` and connect the returned official `McpServer` to that transport. Only pass construction `authInfo` if a trusted transport already verified it; it is an identity-injection seam, not a token verifier. HTTP serving is the included runner; a stdio executable and non-HTTP identity plumbing belong to your application.

## Public Angular module assets

Standalone HTML is the default. Optional [asset delivery](TOOLING-NATIVE.md) preserves Angular's lazy chunks and uses an explicit HTTPS asset origin. The starter server reads the build manifest and enables asset serving automatically for that mode.

For your own server, pass `assets: { directory, manifest }` to `serveBridge()`: `directory` is the build's `dist/assets` directory and `manifest` is the `assets` property of `dist/bridge-manifest.json`. For an existing Express server, mount the awaited `createBridgeAssetMiddleware()` at `manifest.routePrefix` instead. Use a verified build manifest, never one supplied by a request.

The middleware checks every allowlisted file's SHA-256 and length before serving an immutable snapshot. It rejects path escapes and unsupported MIME types. Public module assets allow anonymous cross-origin GET/HEAD reads, including iframe `Origin: null`, with immutable caching and ETags. This policy applies only to public build assets; MCP authentication and origin restrictions still apply. Do not include private data in static assets. Deploy behind HTTPS and preserve the exact origin and route prefix declared in the widget CSP, including `baseUriDomains`.

Use [host setup](HOST-SETUP.md) to connect the finished app. Local workbench and protocol tests establish local behavior; they do not certify a production identity provider or every host extension.
