# Connect your app to a host

First get the demo working locally with [Getting started](GETTING-STARTED.md) and [Your first app](FIRST-APP.md). This guide covers the next step: letting a real host reach your MCP endpoint. You can finish local development without a public URL, OAuth account or tunnel provider.

## Choose the connection you need

| Use | URL and setup |
| --- | --- |
| Local workbench | Use the URL printed by `npm run dev`. Its proxy and view mappings are configured automatically. |
| Local MCP inspection | Connect an MCP client to the printed MCP URL, such as `http://127.0.0.1:3000/mcp`. |
| A host running on your computer | Use its MCP connection settings and the local MCP URL if it supports Streamable HTTP. |
| ChatGPT or another remote host | Provide a publicly reachable HTTPS MCP URL, ending in `/mcp`. |

Ports in this guide are examples. Development selects free ports; use the printed URLs or `.bridge-runtime.json`. A remote host cannot reach your computer's `localhost` directly.

## Test the local protocol first

With the app running, check its printed API origin:

```sh
curl http://127.0.0.1:3000/health
```

This should return `status: "ok"` and the server name. It confirms HTTP reachability, not tool authorization or widget compatibility. Open the local workbench and verify that a tool renders its Angular view. The supplied lab also lets you inspect schemas, resources, prompts, forms and capability-dependent actions.

For independent protocol inspection, the official guide recommends MCP Inspector:

```sh
npx @modelcontextprotocol/inspector@latest
```

Choose Streamable HTTP and enter the full MCP URL. Check discovery and a tool call; use authentication if configured. [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Make an HTTPS endpoint reachable

Use either an existing HTTPS deployment or an explicitly opened development tunnel. The CLI supports already installed `cloudflared` and `ngrok`; it does not install them or sign in to their services.

A simple development tunnel workflow uses two terminals:

1. In terminal A, build and start the app:

   ```sh
   npm run build
   npm run start
   ```

2. In terminal B, open a tunnel to the API port printed in terminal A:

   ```sh
   npm run tunnel -- --provider cloudflared --port 3000
   ```

   Use `--provider ngrok` if that is your configured provider. Keep this terminal running. The command prints the public MCP URL, for example `https://your-host.example/mcp`.

3. Stop only the server in terminal A and restart it with that public **hostname** allowed:

   ```sh
   ALLOWED_HOSTS='localhost,127.0.0.1,[::1],your-host.example' npm run start
   ```

4. Check the public origin before configuring a host:

   ```sh
   curl https://your-host.example/health
   ```

Replace `your-host.example` with the actual tunnel hostname; do not include `https://` or `/mcp` in `ALLOWED_HOSTS`. A new ephemeral tunnel may get a new hostname, requiring an allowlist update and host connection update. This workflow intentionally exposes the built server rather than Angular development servers. Stop the tunnel when you finish testing.

For stable hosting, run `npm run build` and `npm run deploy` to generate a local container artifact. Read its generated instructions and configure HTTPS, your actual hostname and any identity provider in your hosting service. The command writes files; it does not publish, purchase hosting or configure a cloud account.

A submitted ChatGPT plugin needs stable public hosting; a development tunnel is for testing. [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Add the server in ChatGPT

Checked 10 October 2026: OpenAI currently uses **Plugins** terminology. Availability and labels can vary by account/workspace.

1. Open **Plugins** → plus → **Add custom MCP server**.
2. Enter a name/description and the public connection URL: `https://your-host.example/mcp`.
3. Choose authentication, review access information and create the plugin.
4. Inspect tools/metadata, install it and select it with `@` in a new conversation.
5. Try “Browse my demo projects,” then interact with the Angular view.

After schema/UI changes, restart/deploy the server, refresh the connection and use a new conversation. [Current OpenAI steps](https://developers.openai.com/plugins/deploy/connect-chatgpt)

ChatGPT also documents its own Secure MCP Tunnel connection type. That is an external host feature; this project's `npm run tunnel` command opens a public HTTP tunnel through cloudflared or ngrok.

## Keep HTTP access, widget CSP and OAuth separate

| Setting | What it controls | Example |
| --- | --- | --- |
| `HOST` / `hostname` | Which local network interface the Node server binds. | `127.0.0.1` locally; `0.0.0.0` inside a container. |
| `ALLOWED_HOSTS` / `allowedHosts` | Hostnames accepted in requests to your server. | `notes.example.com`, without scheme or port. |
| `ALLOWED_ORIGINS` / `allowedOrigins` | Additional browser origins permitted to call your HTTP server. | `https://admin.example.com`, including scheme and any port. |
| View `csp.connectDomains` | Origins the embedded Angular widget may contact. | `https://api.example.com`. |
| View `csp.resourceDomains` | Origins the widget may load external assets from. | `https://cdn.example.com`. |
| View `csp.frameDomains` | Origins allowed for frames embedded by the widget. | Only a required frame origin. |
| View `domain` | Host metadata for the widget's dedicated origin. | Your approved widget origin. |
| OAuth `resource` | The public MCP identity/audience used in OAuth. | `https://notes.example.com/mcp`. |

The default Angular build bundles its JavaScript and CSS into the HTML resource. Keep CSP domains empty unless your UI needs external connections/assets. The server generates standard MCP Apps CSP metadata and ChatGPT compatibility fields from the view configuration. Declaring domains allows the widget to use them; it does not deploy those domains or authenticate their APIs. [OpenAI resource metadata reference](https://developers.openai.com/plugins/reference)

Remote MCP calls usually arrive server-to-server without a browser `Origin`; adding a ChatGPT web origin is not automatically necessary. Configure browser origins only for clients that actually make cross-origin browser requests. Same-origin requests are accepted by the server. HTTP host/origin allowlists do not authorize users or tool actions.

## OAuth and identity provider setup

Use the complete [server OAuth example](SERVER.md#add-oauth-when-the-app-needs-private-data) to choose a verifier and declare per-tool schemes/scopes. Keep the resource URL equal to the public MCP URL. The framework supplies protected-resource discovery and challenges; your identity provider supplies authorization, token issuance and client registration.

For ChatGPT, configure authorization-code flow with PKCE S256 and resource-bound access tokens. Copy the **exact redirect URI shown in MCP server management** into the provider's allowlist. ChatGPT may show a connection-specific callback or a stable callback depending on issuer identification. Preserve the exact issuer value and advertise `authorization_response_iss_parameter_supported` when supported. Use the registration mechanism your provider and host support, such as client metadata documents or DCR; preset selection alone does not enable it. [OpenAI authentication setup](https://developers.openai.com/plugins/build/auth)

For the local workbench:

1. Configure a public OAuth client with no client secret, or enable compatible DCR at the provider.
2. Allow the callback for the **actual printed workbench origin**. At the default root page it is `http://127.0.0.1:4200/?oauth_callback=true`; a different selected port changes that URI.
3. Open the workbench's authentication controls. Enter the pre-registered public client ID, or leave it blank to use DCR, then choose sign-in.
4. Finish the provider flow in the same tab and retry the protected tool. Sign out to return to anonymous calls.

The workbench uses the official MCP client's OAuth flow, validates state, persists the PKCE verifier across redirects and keeps credentials in tab-scoped session storage. Changing the public client ID clears saved credentials. The workbench client and ChatGPT are separate OAuth clients with separate callback registrations. Do not put a client secret into Angular code or the workbench.

Check protected-resource metadata at your public origin's `/.well-known/oauth-protected-resource/mcp`. Missing/invalid bearer tokens should trigger discovery challenges, and insufficient scopes should prevent protected handlers from running. A successful `/health` response does not prove sign-in works. Validate your actual provider with its issued tokens before using private data.

## If the host connects but the UI does not render

| Symptom | Check |
| --- | --- |
| Public `/health` returns 403 | Add the public hostname to `ALLOWED_HOSTS` and restart the server. |
| Host reports an unreachable server | Keep the server/tunnel running; verify public HTTPS and the full `/mcp` path. |
| A direct `GET /mcp` is not a normal web page | Use an MCP client; this is a protocol endpoint, not the widget URL. |
| Tools work but no view appears | Confirm the tool declares `view`, the build contains that view and the host supports MCP Apps UI. |
| An old view/schema remains | Rebuild/restart, refresh the host connection and open a new conversation. |
| External images or API calls fail in the widget | Check view CSP, the external server's CORS/auth and the requested origin. |
| OAuth redirects fail | Compare the exact callback, issuer, public client configuration, audience and requested scopes. |
| A lab action is unavailable | The host may lack that optional extension; check advertised capabilities. |

Local tests cover this framework's protocol behavior, Angular lifecycle and mocked OAuth flow. A real deployment still needs validation against its chosen host, identity provider and hosting environment. Experimental events, rich forms, file/settings entrypoints and resource writes depend on host support. Passing local tests or seeing a widget in the workbench does not imply ChatGPT submission approval or production certification.
