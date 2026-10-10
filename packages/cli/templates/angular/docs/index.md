# Documentation

Start locally, build one tool and view, then add the capabilities your app needs. All guides use Angular APIs and npm. Generated projects include these guides and the same working examples.

## Start here

1. [Getting started](GETTING-STARTED.md): prerequisites, two-command startup, the workbench and the folder map.
2. [Your first tool and view](FIRST-APP.md): a complete greeting tool rendered by a standalone Angular component.
   Already have an Angular app? Use [Add MCP Apps to an existing Angular app](EXISTING-APP.md) instead.
3. [Angular recipes](RECIPES.md): common tasks such as loading data, sharing state and registering UI tools.

## Build and test

| Guide | Use it for |
| --- | --- |
| [Angular API](ANGULAR-API.md) | Providers, host signals, typed commands/resources, state, files, directives and modals. |
| [Runtime recipes](RUNTIME.md) | Compose reads, share in-flight requests, invalidate cached data and preserve editing drafts. |
| [Server](SERVER.md) | Tool handlers, outputs, resources, authentication and optional extensions. |
| [Tooling](TOOLING.md) | Doctor, CLI help, add-view, builds, ports, tunnels and container artifacts. |
| [Native Angular tooling](TOOLING-NATIVE.md) | Add the bridge to an existing app, generate a typed tool/view and configure optional hosted assets. |
| [Signal Forms and WebMCP](FORMS-AND-WEBMCP.md) | Typed form validation/submission and opt-in experimental browser-agent tools. |
| [Performance](PERFORMANCE.md) | Measure resource sizes, local startup and tool reads. |
| [Evaluations](EVALUATIONS.md) | Model-driven MCP calls, stubs, assertions and runner integration. |
| [Host setup](HOST-SETUP.md) | Connect a prepared app to a real host and configure its public endpoint. |
| [Troubleshooting](TROUBLESHOOTING.md) | Fix installation, missing tools, iframe, HMR, OAuth and build problems. |
| [Architecture](ARCHITECTURE.md) | Understand how the contracts, Angular view, host and server fit together. |

## Which project am I in?

A generated app has `apps/`, `examples/`, `views/`, `vendor/` and `tooling/bridge/`. Edit it to build your product. The framework workspace also has `packages/` and framework tests. Its main README explains creating an app and maintaining the packages.

For a coding agent, start with [llms.txt](../llms.txt) and the included [Angular MCP app skill](../.agents/skills/angular-mcp-app/SKILL.md).
