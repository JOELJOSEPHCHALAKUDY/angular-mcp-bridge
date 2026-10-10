# @angular-mcp-bridge/server

Typed MCP tools, Angular UI resources and HTTP serving on the maintained MCP SDK. The Node server does not load Angular; Angular runs inside the registered UI resource.

This version is local and unpublished. Generated apps contain vendored framework tarballs and the dependencies needed below. From a generated app, follow `docs/GETTING-STARTED.md` first and use `docs/SERVER.md` for the complete server guide. Do not rely on an npm registry install for this version.

## Run the supplied app

From your app folder:

```sh
npm install
npm run dev
```

Open the printed workbench URL and run a server tool. Development picks available ports, builds the UI resources and watches the server and Angular views. Tool contracts live in `examples/shared/tools.ts`, handlers in `examples/server/app.ts`, and view/resource registrations in `examples/server/framework-app.ts`.

## A complete minimal server

For a small tool-only example, save this as `examples/server/minimal.ts`. Stop another server on port 3000 before running `npx tsx examples/server/minimal.ts`.

```ts
import { z } from 'zod';
import { defineTool, defineTools, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { serveBridge } from '@angular-mcp-bridge/server';

const tools = defineTools({
  hello: defineTool({
    title: 'Say hello',
    description: 'Use this when the user wants a greeting by name.',
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ message: z.string() }),
    annotations: readOnlyAnnotations,
  }),
});

const running = await serveBridge({
  name: 'hello-app',
  version: '0.1.0',
  tools,
  views: {},
  handlers: {
    hello: ({ name }) => ({
      data: { message: `Hello, ${name}!` },
      text: `Hello, ${name}!`,
    }),
  },
}, { port: 3000 });

console.log('MCP endpoint: http://127.0.0.1:3000/mcp');
process.once('SIGINT', () => { void running.close(); });
process.once('SIGTERM', () => { void running.close(); });
```

Connect an MCP client using Streamable HTTP and call `hello` with `{ "name": "Ada" }`. A direct `GET /mcp` is not a webpage. `/health` reports HTTP health.

To attach Angular, add `view: 'greeting'` to the shared contract and `views: { greeting: { htmlPath: 'dist/views/greeting.html', description: 'An interactive greeting.' } }` to the server options. Create that view with `npm run add-view -- greeting`, build it, and use the shared tool in its Angular component. The generated app's first-app tutorial provides this complete path, including the workbench runtime route.

## Server options

`serveBridge(options, httpOptions?)` starts HTTP serving and returns `{ server, notify, bus, close }`. `createBridgeServer(options, constructionContext?)` returns the official `McpServer` for a custom transport. Only inject `constructionContext.authInfo` after a trusted transport has verified it.

| Server option | Purpose |
| --- | --- |
| `name`, `version`, `instructions` | Server identity and optional model guidance. |
| `tools`, `handlers` | Shared Zod tool definitions and their typed handlers. |
| `views` | Angular HTML resources keyed by tool view names. |
| `oauth` | Token verification, discovery and default tool authorization. |
| `configure(server, context)` | Register official SDK resources, prompts and custom methods. |
| `middleware`, `telemetry` | Application protocol interception and response observations. |
| `skills` | Controlled Markdown discovery or a precomputed manifest. |
| `events` | Experimental signed webhook subscription/delivery definitions. |
| `sdkOptions` | Official MCP SDK options, including verified request state. |

HTTP options include `port`, `hostname`, `allowedHosts`, `allowedOrigins`, `authentication`, `workbenchPath`, `assets`, `handlerOptions` and `configureApp`. Defaults bind `127.0.0.1:3000` and accept local hostnames. Public serving requires the actual hostname in `allowedHosts`; browser origins use complete scheme/host/port values. These controls are separate from widget CSP and user authorization.

Optional hosted Angular builds pass `assets: { directory: 'dist/assets', manifest: buildManifest.assets }`. The server validates hashes and sizes, then serves only allowlisted public module assets with immutable caching and credential-free CORS. MCP origin/authentication rules stay separate. `createBridgeAssetMiddleware()` provides the same verified snapshot for an existing Express app. Asset delivery needs HTTPS and a host honoring the declared resource/base CSP; standalone HTML remains the default.

`configure` can run per HTTP request. Create database pools and durable/shared state outside it. `configureApp` adds Express routes after host/origin guards; authenticate custom routes yourself. The `/mcp` bearer gate does not automatically protect other routes.

## Responses, content and context

A handler returns `{ data, text?, content?, meta?, isError? }` or an SDK `InputRequiredResult`. Input and `data` are Zod validated. `data` becomes `structuredContent`, `text`/`content` are model-visible, and `meta` becomes widget-visible `_meta` outside model context.

```ts
import { embeddedResource, resourceLink, text } from '@angular-mcp-bridge/server';

export function noteContent(note: string) {
  return [
    text('A note is ready.'),
    embeddedResource({ uri: 'bridge://note', text: note, mimeType: 'text/plain' }),
    resourceLink({ uri: 'bridge://note', name: 'Note', mimeType: 'text/plain' }),
  ];
}
```

`image(data, mimeType)` and `audio(data, mimeType)` encode `Uint8Array` inputs; string inputs are already base64. `FileRef` validates host-managed file references without downloading them.

Handler context includes cancellation, request/session IDs, optional locale/user-agent hints, sanitized HTTP headers and verified `auth` identity/scopes. `sdk` exposes the official request context for progress, input responses and request state. Raw SDK authentication fields may contain a token; do not log the full context or put credentials into results/HTML.

Views support `htmlPath` or `html`, title, description, border preference, domain, CSP and permissions. HTML is content hashed into immutable resource URIs; `getViewManifest(server)` exposes the URI, digest and byte count. Standard MCP Apps metadata and ChatGPT compatibility metadata are generated together.

## OAuth

```ts
import { customProvider, type OAuthProvider } from '@angular-mcp-bridge/server';

export function notesOAuth(): OAuthProvider {
  return customProvider({
    resource: 'https://notes.example.com/mcp',
    issuer: 'https://identity.example.com/',
    jwksUri: 'https://identity.example.com/.well-known/jwks.json',
    scopes: ['notes:read'],
  });
}
```

Replace those placeholder URLs and pass the returned provider as `oauth`. Tools default to OAuth when a provider exists. Declare `securitySchemes: [{ type: 'oauth2', scopes: ['notes:read'] }]` on protected tool contracts, or `[{ type: 'noauth' }]` for public tools. OAuth alternatives use OR; scopes within one alternative use AND. With both `noauth` and OAuth, anonymous calls are allowed and supplied identities must satisfy an OAuth alternative.

JWT verification uses `jose` and checks signature, issuer, expiry, subject and audience. Custom providers default audience to the configured resource. Presets include Auth0, Clerk, WorkOS, Stytch, Descope and Authplane. They configure metadata/verifiers rather than create provider accounts or client registrations. Clerk's preset intentionally skips audience checking for supported tokens. Opaque-token introspection needs an application-supplied trusted `TokenVerifier`.

Mixed public/private tools default the HTTP gate to optional, with per-tool enforcement and sign-in challenges. `authentication: 'required'` enforces an endpoint-wide gate. On a mixed endpoint, authorize resources, prompts and custom methods separately. Protected-resource discovery is served at the root and resource-specific well-known paths. See [OpenAI OAuth setup](https://developers.openai.com/plugins/build/auth) for host callback/client-registration requirements.

## Optional capabilities

| Capability | Public API and behavior |
| --- | --- |
| Middleware | `MiddlewareEntry`, `getToolError`, `TelemetryObserver`; filters apply around registered application handlers, outside transport negotiation. |
| Forms | `requestFormInput` validates accepted answers and preserves cancel/decline; `requestOpenAIFormInput` requires the advertised rich-form extension. |
| Request state | `createRequestStateCodec` with `sdkOptions.requestState.verify` protects client-echoed state used across input retries. |
| File views | Shared `defineFileViewerTool`, or `registerFileViewer` in `configure`; typed `{ file: { name, resourceUri } }` input. |
| Composer search | `registerMentions`; app-only search returns validated resource links. |
| Settings | `registerSettings`; required primitive/string-enum fields, validated partial updates and application-owned persistence. |
| Skills | `discoverSkills`, `registerSkills`; controlled Markdown snapshots exposed as resources, never executed. |
| Events | `defineEvent`, `createEventPublisher`, `deliverEvent`; experimental authenticated subscriptions and signed HTTPS callbacks. Storage/retries are application-owned. |
| Resources/prompts | Official SDK registration through `configure`; running `notify` publishes change notices. |

ChatGPT entrypoints/display modes/quick actions are typed on tool `openai` options. Global/thread entrypoints must accept `{}`; quick actions need a valid registered target and icons. Resource writes use the optional `openai/resources/write` host extension. These features require host support; standard MCP tool execution alone does not imply every host extension is available.

The generated app's `docs/SERVER.md` contains complete examples for these APIs, and `docs/HOST-SETUP.md` covers local inspection, public HTTPS and OAuth. Local protocol tests do not certify a production identity provider or host submission.
