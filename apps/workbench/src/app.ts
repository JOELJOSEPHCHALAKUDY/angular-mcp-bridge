import { AfterViewInit, Component, ElementRef, inject, DestroyRef, computed, signal, viewChild } from '@angular/core';
import { Client, StreamableHTTPClientTransport, type Tool, type CallToolResult, type Resource, type ReadResourceResult, type Prompt, type GetPromptResult } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { z } from 'zod';
import { Tabs, TabList, Tab, TabPanel, TabContent } from '@angular/aria/tabs';
import { hostProfiles, type HostProfile } from './host-profiles.js';
import { parseFixture, serializeFixture } from './fixtures.js';
import { ResourceSubscriptions } from './resource-subscriptions.js';
import { WorkbenchAuth } from './browser-auth.js';
import { registerWebMcpTools, webMcpSupported, type WebMcpRegistration } from './webmcp.js';
import { SchemaFormComponent, schemaDefaults, parseSchemaInput } from './schema-form.js';
import { SavedInputStore, type SavedToolInput } from './saved-inputs.js';
import { checkContextBudget, CONTEXT_WARNING_DEFAULTS } from '@angular-mcp-bridge/angular';

interface Runtime { mcpUrl?: string; views?: Record<string, { devUrl?: string }> }
interface LogEntry { id: number; time: string; method: string; data: unknown; }
function sampleInput(schema: Tool['inputSchema']): Record<string, unknown> {
  const defaults = schemaDefaults(schema);
  const input = defaults && typeof defaults === 'object' && !Array.isArray(defaults) ? defaults as Record<string, unknown> : {};
  if (schema.properties?.['id'] && input['id'] === '') input['id'] = 'atlas';
  return input;
}
@Component({
  selector: 'bridge-root', standalone: true, imports: [SchemaFormComponent, Tabs, TabList, Tab, TabPanel, TabContent],
  template: `
    <div class="shell">
      <header class="topbar"><a class="brand" href="/" aria-label="Angular MCP Bridge workbench"><span class="brand-mark">A↗</span>Angular MCP Bridge<span class="version">v0.1</span></a><div class="topbar-right"><span class="status-dot" [class.live]="status() === 'connected'"></span><span role="status" aria-live="polite" aria-atomic="true">{{ status() }}</span><a href="https://apps.extensions.modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Protocol docs ↗</a></div></header>
      <aside class="sidebar">
        <p class="section-label">DEVELOPMENT</p><div class="nav-item active"><span>◫</span> Workbench</div><div class="endpoint"><span class="section-label">MCP ENDPOINT</span><code>/mcp</code></div>
        <div class="tools-heading"><span class="section-label">SERVER TOOLS</span><span>{{ tools().length }}</span></div>
        @for (tool of tools(); track tool.name) { <button class="tool-link" [class.selected]="selectedTool()?.name === tool.name" (click)="selectTool(tool)"><span class="tool-glyph">⌘</span><span><strong>{{ tool.title || tool.name }}</strong><small>{{ tool.name }}</small></span></button> }
        <div class="sidebar-bottom"><span class="angular-logo">△</span><span>Built for Angular<strong>Signals. Services. Standards.</strong></span></div>
      </aside>
      <main>
        <div class="workspace-heading"><div><p class="section-label">LOCAL DEVELOPMENT / MCP APPS</p><h1>Workbench<span>.</span></h1><p>Call a tool. Inspect the result. See your Angular view.</p></div><button class="secondary" (click)="reconnect()" [disabled]="busy()">↻ Reconnect</button></div>
        <select class="mobile-tools" aria-label="Server tool" [value]="selectedTool()?.name ?? ''" (change)="selectToolByName($any($event.target).value)">@for (tool of tools(); track tool.name) { <option [value]="tool.name">{{ tool.title || tool.name }}</option> }</select>
        @if (error()) { <div class="error" role="alert">{{ error() }}</div> }
        @for (warning of contextWarnings(); track warning) { <p class="context-warning" role="status">{{ warning }}</p> }
        <div class="workspace">
          <section class="controls"><div class="section-heading"><h2>Tool input</h2><span class="tag">{{ selectedTool()?.annotations?.readOnlyHint ? 'READ ONLY' : 'TOOL' }}</span></div><h3>{{ selectedTool()?.title }}</h3><p>{{ selectedTool()?.description }}</p><label for="input-mode">ARGUMENTS</label><select id="input-mode" aria-label="Input mode" [value]="inputMode()" (change)="inputMode.set($any($event.target).value)"><option value="json">JSON editor</option><option value="form">Schema form</option></select>@if (inputMode() === 'form' && selectedTool(); as tool) { <bridge-schema-form [schema]="tool.inputSchema" [value]="formInput()" (valueChange)="input.set(json($event))" (validityChange)="formValid.set($event)" /> } @else { <label for="arguments">ARGUMENTS <span>JSON</span></label><textarea id="arguments" spellcheck="false" [value]="input()" (input)="input.set($any($event.target).value)" rows="8"></textarea> }<button class="run" (click)="runTool()" [disabled]="busy() || !selectedTool() || (inputMode() === 'form' && !formValid())">{{ busy() ? 'Running…' : 'Run tool' }}<span>↗</span></button>
            <details class="scenario"><summary>Saved tool inputs</summary><p>Save named arguments in this browser. They are scoped to the tool and schema.</p><input aria-label="Saved input name" placeholder="Scenario name" [value]="savedName()" (input)="savedName.set($any($event.target).value)"><button class="secondary" (click)="saveInput()" [disabled]="!savedName().trim() || (inputMode() === 'form' && !formValid())">Save arguments</button><select aria-label="Saved input" [value]="savedName()" (change)="loadInput($any($event.target).value)"><option value="">Select saved arguments</option>@for (saved of savedInputs(); track saved.name) { <option [value]="saved.name">{{ saved.name }}</option> }</select><button class="secondary" (click)="removeInput()" [disabled]="!savedName().trim()">Delete saved arguments</button></details>
            <div class="scenario"><span class="section-label">HOST PROFILE</span><select aria-label="Host profile" [value]="profile()" (change)="changeProfile($any($event.target).value)">@for (preset of profileChoices; track preset.key) { <option [value]="preset.key">{{ preset.label }}</option> }</select><p>Editable simulations of capabilities, not real-host certification.</p><select aria-label="Host locale" [value]="locale()" (change)="changeLocale($any($event.target).value)"><option value="en-US">English · US</option><option value="de-DE">Deutsch</option><option value="ja-JP">日本語</option><option value="ar-SA">العربية</option></select><select aria-label="Host device" [value]="device()" (change)="changeDevice($any($event.target).value)"><option value="desktop">Desktop</option><option value="mobile">Mobile</option><option value="tablet">Tablet</option></select></div>
            <div class="scenario"><span class="section-label">PREVIEW SOURCE</span><select aria-label="Preview source" [value]="source()" (change)="changeSource($any($event.target).value)"><option value="resource">Bundled MCP resource</option><option value="development">Angular dev server · HMR</option></select><p>{{ source() === 'resource' ? 'The same HTML resource returned to an MCP host.' : 'Run npm run dev. Per-view URLs and available ports are discovered automatically.' }}</p></div>
            <details class="scenario"><summary>OAuth connection</summary><p>Use your server's public OAuth client. Credentials are scoped to this browser tab.</p><label>Pre-registered client ID (optional)<input aria-label="OAuth client ID" [value]="oauthClientId()" (input)="oauthClientId.set($any($event.target).value)"></label><button class="secondary" (click)="signIn()" [disabled]="busy() || auth.busy()">Sign in</button><button class="secondary" (click)="signOut()" [disabled]="busy() || !auth.signedIn()">Sign out</button><span>{{ auth.signedIn() ? 'Token available' : 'Anonymous' }}</span></details>
            <div class="scenario webmcp-settings"><label><input type="checkbox" aria-label="Enable experimental WebMCP" aria-describedby="webmcp-help" [checked]="webMcpEnabled()" [disabled]="!webMcpAvailable || status() !== 'connected'" (change)="changeWebMcp($any($event.target).checked)"> Enable experimental WebMCP</label><p id="webmcp-help">{{ webMcpAvailable ? 'Opt in to exposing model-visible server tools to a browser agent.' : 'This browser does not expose the proposed WebMCP API.' }}</p></div>
            <button class="secondary" (click)="cancelTool()" [disabled]="!busy()">Cancel tool call</button>
          </section>
          <section class="preview"><div class="preview-toolbar"><div><span class="section-label">ANGULAR VIEW</span><span class="preview-status" role="status" aria-live="polite" aria-atomic="true">{{ viewStatus() }}</span></div><div class="preview-actions"><button aria-label="Toggle preview theme" (click)="toggleTheme()">{{ theme() === 'light' ? '◐ Dark' : '◑ Light' }}</button><button [class.active]="mobile()" aria-label="Toggle mobile preview" (click)="mobile.set(!mobile())">▯ Mobile</button><button aria-label="Reload preview" (click)="reloadPreview()">↻</button></div></div><div class="preview-stage" [class.dark]="theme() === 'dark'" [class.fullscreen]="displayMode() === 'fullscreen'"><div class="preview-frame" [class.mobile]="mobile()"><iframe #frame title="Angular MCP app preview" sandbox="allow-scripts allow-forms" [style.height.px]="frameHeight()"></iframe></div></div><div class="preview-caption"><span>Official MCP Apps handshake</span><code>{{ resourceUri() || 'Waiting for server…' }}</code></div></section>
        </div>
        <section class="inspector" ngTabs><div class="inspector-toolbar"><div class="inspector-tabs" ngTabList #inspectorTabs="ngTabList" aria-label="Protocol inspector" selectionMode="explicit" [selectedTab]="tab()" (selectedTabChange)="selectInspectorTab($event)"><button ngTab value="events" (click)="inspectorTabs.open('events')" [class.active]="tab() === 'events'">Events <span>{{ logs().length }}</span></button><button ngTab value="result" (click)="inspectorTabs.open('result')" [class.active]="tab() === 'result'">Tool result</button><button ngTab value="context" (click)="inspectorTabs.open('context')" [class.active]="tab() === 'context'">Model context</button><button ngTab value="view-tools" (click)="inspectorTabs.open('view-tools')" [class.active]="tab() === 'view-tools'">View tools</button><button ngTab value="resources" (click)="inspectorTabs.open('resources')" [class.active]="tab() === 'resources'">Resources</button><button ngTab value="prompts" (click)="inspectorTabs.open('prompts')" [class.active]="tab() === 'prompts'">Prompts</button><button ngTab value="fixtures" (click)="inspectorTabs.open('fixtures')" [class.active]="tab() === 'fixtures'">Fixtures</button></div><button class="clear" (click)="logs.set([])">Clear events</button></div><div class="inspector-content">
          <div ngTabPanel value="events" [hidden]="tab() !== 'events'"><ng-template ngTabContent>@if (tab() === 'events') { @for (log of logs(); track log.id) { <details><summary><time>{{ log.time }}</time><span>{{ log.method }}</span><span class="event-indicator">↗</span></summary><pre>{{ json(log.data) }}</pre></details> } @empty { <p class="empty">Protocol events will appear here.</p> } } </ng-template></div>
          <div ngTabPanel value="result" [hidden]="tab() !== 'result'"><ng-template ngTabContent>@if (tab() === 'result') { <pre>{{ json(result()) }}</pre> } </ng-template></div>
          <div ngTabPanel value="context" [hidden]="tab() !== 'context'"><ng-template ngTabContent>@if (tab() === 'context') { <pre>{{ json(modelContext()) }}</pre> } </ng-template></div>
          <div ngTabPanel value="view-tools" [hidden]="tab() !== 'view-tools'"><ng-template ngTabContent>@if (tab() === 'view-tools') { <div class="inspector-form"><label>Registered Angular view tools<select aria-label="View tool" [value]="selectedViewTool()" (change)="selectViewTool($any($event.target).value)"><option value="">Select a tool</option>@for (tool of viewTools(); track tool.name) { <option [value]="tool.name">{{ tool.title || tool.name }}</option> }</select></label><textarea aria-label="View tool arguments" [value]="viewToolInput()" (input)="viewToolInput.set($any($event.target).value)"></textarea><button class="secondary" (click)="callViewTool()" [disabled]="!selectedViewTool()">Call view tool</button><pre>{{ json(viewToolResult()) }}</pre></div> } </ng-template></div>
          <div ngTabPanel value="resources" [hidden]="tab() !== 'resources'"><ng-template ngTabContent>@if (tab() === 'resources') { <div class="inspector-form"><label>Server resources<select aria-label="Resource" (change)="readResource($any($event.target).value)"><option value="">Select a resource</option>@for (resource of resources(); track resource.uri) { <option [value]="resource.uri">{{ resource.name }} · {{ resource.uri }}</option> }</select></label><pre>{{ json(resourceResult()) }}</pre></div> } </ng-template></div>
          <div ngTabPanel value="prompts" [hidden]="tab() !== 'prompts'"><ng-template ngTabContent>@if (tab() === 'prompts') { <div class="inspector-form"><label>Server prompts<select aria-label="Prompt" [value]="selectedPrompt()" (change)="selectPrompt($any($event.target).value)"><option value="">Select a prompt</option>@for (prompt of prompts(); track prompt.name) { <option [value]="prompt.name">{{ prompt.title || prompt.name }}</option> }</select></label><textarea aria-label="Prompt arguments" [value]="promptInput()" (input)="promptInput.set($any($event.target).value)"></textarea><button class="secondary" (click)="getPrompt()" [disabled]="!selectedPrompt()">Get prompt</button><pre>{{ json(promptResult()) }}</pre></div> } </ng-template></div>
          <div ngTabPanel value="fixtures" [hidden]="tab() !== 'fixtures'"><ng-template ngTabContent>@if (tab() === 'fixtures') { <div class="inspector-form"><p>Replay saved initial data without repeating a server tool call. View actions still use the connected server. Private metadata is excluded.</p><button class="secondary" (click)="exportFixture()" [disabled]="!result()">Export current fixture</button><button class="secondary" (click)="downloadFixture()" [disabled]="!fixtureText()">Download JSON</button><label class="file-label">Import JSON<input aria-label="Import fixture" type="file" accept="application/json,.json" (change)="importFixture($event)"></label><textarea aria-label="Fixture JSON" [value]="fixtureText()" (input)="fixtureText.set($any($event.target).value)"></textarea><button class="secondary" (click)="replayFixture()">Replay fixture</button></div> } </ng-template></div>
        </div></section><p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement() }}</p>
        <footer><span>ANGULAR 22 · MCP APPS SDK 2</span><span>Local host simulator. Verify deployment in your target host.</span></footer>
      </main>
    </div>`,
})
export class WorkbenchComponent implements AfterViewInit {
  readonly auth = inject(WorkbenchAuth);
  readonly oauthClientId = signal(this.auth.getProvider().publicClientId() ?? '');
  readonly webMcpAvailable = webMcpSupported();
  readonly webMcpEnabled = signal(false);
  private webMcpRegistration?: WebMcpRegistration;
  private webMcpController?: AbortController;
  readonly frame = viewChild.required<ElementRef<HTMLIFrameElement>>('frame');
  readonly tools = signal<Tool[]>([]);
  readonly selectedTool = signal<Tool | null>(null);
  readonly input = signal('{}');
  readonly inputMode = signal<'json' | 'form'>('json');
  readonly formValid = signal(true);
  readonly formInput = computed<Record<string, unknown>>(() => {
    try { const value: unknown = JSON.parse(this.input()); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
    catch { return {}; }
  });
  readonly savedName = signal('');
  readonly savedInputs = signal<SavedToolInput[]>([]);
  private readonly savedInputStore = new SavedInputStore();
  readonly status = signal('disconnected');
  readonly viewStatus = signal('waiting');
  readonly error = signal('');
  readonly announcement = signal('');
  readonly busy = signal(false);
  readonly theme = signal<'light' | 'dark'>('light');
  readonly mobile = signal(false);
  readonly profile = signal<HostProfile>('standard');
  readonly profileChoices = Object.entries(hostProfiles).map(([key, value]) => ({ key, label: value.label }));
  readonly locale = signal('en-US');
  readonly device = signal<'desktop' | 'mobile' | 'tablet'>('desktop');
  readonly source = signal<'resource' | 'development'>('resource');
  readonly displayMode = signal<'inline' | 'fullscreen' | 'pip'>('inline');
  readonly frameHeight = signal(670);
  readonly resourceUri = signal('');
  readonly result = signal<CallToolResult | null>(null);
  readonly modelContext = signal<unknown>(null);
  readonly contextWarnings = computed(() => {
    const warnings: string[] = [];
    for (const [label, value, budgetTokens] of [
      ['Tool output', this.result(), CONTEXT_WARNING_DEFAULTS.toolResultTokens],
      ['Shared model context', this.modelContext(), CONTEXT_WARNING_DEFAULTS.modelContextTokens],
    ] as const) {
      if (value === null) continue;
      const size = checkContextBudget(value, { budgetTokens });
      if (size.exceeded) warnings.push(`${label} is approximately ${size.estimatedTokens?.toLocaleString()} tokens, above the ${budgetTokens.toLocaleString()} developer warning budget. This is an estimate; private metadata is excluded.`);
    }
    return warnings;
  });
  readonly tab = signal<'events' | 'result' | 'context' | 'resources' | 'view-tools' | 'prompts' | 'fixtures'>('events');
  readonly viewTools = signal<Tool[]>([]);
  readonly selectedViewTool = signal('');
  readonly viewToolInput = signal('{}');
  readonly viewToolResult = signal<unknown>(null);
  readonly resources = signal<Resource[]>([]);
  readonly prompts = signal<Prompt[]>([]);
  readonly selectedPrompt = signal('');
  readonly promptInput = signal('{}');
  readonly promptResult = signal<GetPromptResult | null>(null);
  readonly resourceResult = signal<ReadResourceResult | null>(null);
  readonly fixtureText = signal('');
  readonly logs = signal<LogEntry[]>([]);
  private client?: Client;
  private resourceSubscriptions?: ResourceSubscriptions;
  private bridge?: AppBridge;
  private html = '';
  private sequence = 0;
  private closed = false;
  private loadGeneration = 0;
  private inputSnapshot: Record<string, unknown> = {};
  private resultSnapshot?: CallToolResult;
  private runtime: Runtime = {};
  private requestAbort?: AbortController;
  constructor() { inject(DestroyRef).onDestroy(() => { this.closed = true; void this.dispose(); }); }
  ngAfterViewInit() { void this.initialize(); }
  private async initialize() {
    try { await this.auth.finishCallback(); await this.reconnect(); }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); this.status.set('error'); }
  }
  async signIn() {
    this.error.set(''); this.auth.configure(this.oauthClientId());
    try { await this.auth.signIn(); await this.reconnect(); }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
  }
  async signOut() { this.auth.signOut(); await this.reconnect(); }
  async changeWebMcp(enabled: boolean) {
    this.webMcpController?.abort(); this.webMcpController = undefined;
    this.webMcpRegistration?.close(); this.webMcpRegistration = undefined; this.webMcpEnabled.set(false);
    const client = this.client; if (!enabled || !client) return;
    const controller = this.webMcpController = new AbortController();
    try {
      const registration = await registerWebMcpTools({ enabled: true, tools: this.tools(), signal: controller.signal,
        callTool: (name, input, options) => client.callTool({ name, arguments: input }, options) as Promise<CallToolResult>,
      });
      if (controller.signal.aborted) { registration.close(); return; }
      this.webMcpRegistration = registration; this.webMcpEnabled.set(registration.supported);
    } catch (error) { if (!controller.signal.aborted) this.error.set(error instanceof Error ? error.message : String(error)); }
  }
  selectInspectorTab(value: string | undefined) {
    const allowed = ['events', 'result', 'context', 'view-tools', 'resources', 'prompts', 'fixtures'] as const;
    const selected = allowed.find(tab => tab === value);
    if (!selected) return;
    if (this.tab() === selected) return;
    this.tab.set(selected);
    if (selected === 'view-tools') void this.showViewTools();
    if (selected === 'resources') void this.showResources();
    if (selected === 'prompts') void this.showPrompts();
  }
  json(value: unknown) { return JSON.stringify(value, null, 2); }
  private log(method: string, data: unknown) {
    this.logs.update(logs => [{ id: ++this.sequence, time: new Date().toLocaleTimeString('en-GB'), method, data }, ...logs].slice(0, 100));
  }
  private async dispose() {
    this.webMcpController?.abort(); this.webMcpController = undefined;
    this.webMcpRegistration?.close(); this.webMcpRegistration = undefined; this.webMcpEnabled.set(false);
    this.requestAbort?.abort();
    if (this.bridge && this.viewStatus() === 'connected') await this.bridge.teardownResource({}, { timeout: 1000 }).catch(() => {});
    await this.bridge?.close().catch(() => {}); this.bridge = undefined;
    await this.resourceSubscriptions?.close(); this.resourceSubscriptions = undefined;
    await this.client?.close().catch(() => {}); this.client = undefined;
  }
  async reconnect() {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(''); this.status.set('connecting');
    try {
      await this.dispose();
      const client = this.client = new Client({ name: 'angular-mcp-workbench', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
      try { const response = await fetch('/__bridge/runtime'); if (response.ok) this.runtime = await response.json(); } catch { this.runtime = {}; }
      const authProvider = this.auth.getProvider();
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', window.location.origin), { authProvider: authProvider.tokens() ? authProvider : undefined }));
      client.setNotificationHandler('notifications/resources/updated', async notification => {
        this.log('notifications/resources/updated', notification.params);
        await this.bridge?.notification(notification);
      });
      const { tools } = await client.listTools();
      if (this.closed) return;
      this.tools.set(tools); this.status.set('connected'); this.log('mcp/connected', { tools: tools.map(tool => tool.name) });
      const selected = tools.find(tool => tool._meta?.['ui']) ?? tools[0];
      if (selected) { this.selectTool(selected); await this.executeTool(); }
    } catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); this.status.set('error'); }
    finally { this.busy.set(false); }
  }
  selectToolByName(name: string) { const tool = this.tools().find(candidate => candidate.name === name); if (tool) this.selectTool(tool); }
  selectTool(tool: Tool) { this.selectedTool.set(tool); this.input.set(this.json(sampleInput(tool.inputSchema))); this.savedName.set(''); void this.refreshSavedInputs(tool); }
  private async refreshSavedInputs(tool: Tool) {
    const inputs = await this.savedInputStore.list(tool.name, tool.inputSchema);
    if (this.selectedTool() === tool) this.savedInputs.set(inputs);
  }
  async saveInput() {
    const tool = this.selectedTool(); if (!tool) return;
    try { await this.savedInputStore.save(tool.name, tool.inputSchema, this.savedName(), parseSchemaInput(tool.inputSchema, this.input())); await this.refreshSavedInputs(tool); this.error.set(''); }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
  }
  loadInput(name: string) { const saved = this.savedInputs().find(saved => saved.name === name); if (saved) { this.input.set(this.json(saved.arguments)); this.savedName.set(name); } }
  async removeInput() {
    const tool = this.selectedTool(); if (!tool) return;
    try { await this.savedInputStore.remove(tool.name, tool.inputSchema, this.savedName()); this.savedName.set(''); await this.refreshSavedInputs(tool); }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
  }
  async runTool() {
    if (this.busy() || this.inputMode() === 'form' && !this.formValid()) return;
    this.busy.set(true); this.error.set('');
    try { await this.executeTool(); } catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); this.log('tool/error', this.error()); }
    finally { this.busy.set(false); }
  }
  private async executeTool() {
    const tool = this.selectedTool(); if (!tool || !this.client) return;
    const args: unknown = JSON.parse(this.input());
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be a JSON object.');
    const input = args as Record<string, unknown>;
    this.log('tools/call', { name: tool.name, arguments: input });
    this.requestAbort = new AbortController();
    const response = await this.client.callTool({ name: tool.name, arguments: input }, { signal: this.requestAbort.signal }) as CallToolResult;
    this.result.set(response); this.log('tools/result', response);
    this.announcement.set(response.isError ? 'Tool returned an error.' : `${this.selectedTool()?.title ?? 'Tool'} completed. ${response.content.length} result blocks available.`);
    if (response.isError) throw new Error(response.content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Tool failed.');
    const uri = (tool._meta?.['ui'] as { resourceUri?: string } | undefined)?.resourceUri;
    if (uri) {
      this.inputSnapshot = input; this.resultSnapshot = response;
      if (uri !== this.resourceUri() || !this.bridge) {
        const resource = await this.client.readResource({ uri });
        const content = resource.contents.find(item => 'text' in item);
        if (!content || !('text' in content)) throw new Error('The view resource did not return HTML.');
        this.html = content.text; this.resourceUri.set(uri); await this.mountPreview();
      } else {
        await this.bridge.sendToolInput({ arguments: input }); await this.bridge.sendToolResult(response);
      }
    }
  }
  private hostContext() {
    return { theme: this.theme(), locale: this.locale(), displayMode: this.displayMode(), availableDisplayModes: hostProfiles[this.profile()].modes,
      platform: 'web' as const, deviceCapabilities: { touch: this.device() !== 'desktop', hover: this.device() === 'desktop' },
      containerDimensions: { width: this.mobile() ? 390 : 850, maxHeight: 1000 } };
  }
  private async mountPreview() {
    const generation = ++this.loadGeneration;
    if (this.bridge && this.viewStatus() === 'connected') await this.bridge.teardownResource({}, { timeout: 1000 }).catch(() => {});
    await this.bridge?.close().catch(() => {});
    await this.resourceSubscriptions?.close(); this.resourceSubscriptions = undefined;
    if (!this.client || this.closed || generation !== this.loadGeneration) return;
    this.viewStatus.set('connecting');
    const frame = this.frame().nativeElement;
    this.viewTools.set([]); this.selectedViewTool.set(''); this.viewToolResult.set(null);
    const preset = hostProfiles[this.profile()];
    const bridge = this.bridge = new AppBridge(null, { name: `angular-workbench-${this.profile()}-simulation`, version: '0.1.0' }, preset.capabilities, { hostContext: this.hostContext() });
    bridge.oninitialized = () => {
      if (generation !== this.loadGeneration) return;
      this.viewStatus.set('connected'); this.log('ui/initialized', { profile: this.profile() });
      void (async () => { await bridge.sendToolInput({ arguments: this.inputSnapshot }); if (this.resultSnapshot) await bridge.sendToolResult(this.resultSnapshot); })().catch(error => this.error.set(String(error)));
    };
    bridge.oncalltool = async (params, context) => {
      this.log('view/tools/call', params);
      const response = await this.client!.callTool(params, { signal: context.mcpReq.signal }) as CallToolResult;
      this.log('view/tools/result', response); return response;
    };
    if (preset.capabilities.message) {
      bridge.onmessage = async params => { this.log('ui/message', params); return {}; };
    }
    if (preset.capabilities.updateModelContext) {
      bridge.onupdatemodelcontext = async params => { this.modelContext.set(params); this.log('ui/update-model-context', params); return {}; };
    }
    if (preset.capabilities.serverResources) {
      bridge.onlistresources = params => this.client!.listResources(params);
      bridge.onlistresourcetemplates = params => this.client!.listResourceTemplates(params);
      bridge.onreadresource = (params, context) => { this.log('view/resources/read', params); return this.client!.readResource(params, { signal: context.mcpReq.signal }); };
    }
    if (preset.capabilities.experimental?.['openai/resource']) {
      const subscriptions = this.resourceSubscriptions = new ResourceSubscriptions(this.client);
      bridge.setRequestHandler('resources/subscribe', { params: z.object({ uri: z.string() }), result: z.object({}).passthrough() }, params => subscriptions.subscribe(params.uri));
      bridge.setRequestHandler('resources/unsubscribe', { params: z.object({ uri: z.string() }), result: z.object({}).passthrough() }, params => subscriptions.unsubscribe(params.uri));
      bridge.setRequestHandler('openai/resources/write', {
        params: z.object({ uri: z.string(), text: z.string().optional(), blob: z.string().optional(), ifMatch: z.string().optional() }),
        result: z.object({ outcome: z.enum(['saved', 'conflict', 'too-large']), etag: z.string().optional(), maxBytes: z.number().optional() }),
      }, async (params, context) => {
        this.log('view/resources/write', params);
        return this.client!.request({ method: 'openai/resources/write', params }, z.object({ outcome: z.enum(['saved', 'conflict', 'too-large']), etag: z.string().optional(), maxBytes: z.number().optional() }), { signal: context.mcpReq.signal });
      });
    }
    if (preset.capabilities.openLinks) bridge.onopenlink = async params => { this.log('ui/open-link', params); return {}; };
    if (preset.capabilities.downloadFile) bridge.ondownloadfile = async params => {
      this.log('ui/download-file', params);
      for (const block of params.contents) {
        if (block.type !== 'resource') continue;
        const item = block.resource;
        if ('text' in item) this.downloadText(item.text, 'angular-view-export.txt', item.mimeType ?? 'text/plain');
        else this.downloadBlob(new Blob([Uint8Array.from(atob(item.blob), char => char.charCodeAt(0))], { type: item.mimeType ?? 'application/octet-stream' }), 'angular-view-export');
      }
      return {};
    };
    bridge.onrequestteardown = () => { void this.dismissView(bridge); };
    bridge.onrequestdisplaymode = async ({ mode }) => {
      const applied = preset.modes.includes(mode) ? mode : 'inline';
      this.displayMode.set(applied); this.log('ui/request-display-mode', { requested: mode, applied });
      return { mode: applied };
    };
    bridge.onsizechange = ({ height }) => { if (height) this.frameHeight.set(Math.min(1000, Math.max(400, height))); };
    bridge.onerror = error => { this.log('ui/error', error.message); this.error.set(error.message); };
    // Connect the listener BEFORE navigation so an immediate Angular bootstrap cannot race it.
    await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
    if (this.source() === 'development') {
      // Cross-origin localhost iframe permits Angular HMR. Never use this for untrusted resources.
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
      const viewName = Object.keys(this.runtime.views ?? {}).find(name => new URL(this.resourceUri()).pathname.slice(1).startsWith(name + '-'));
      const devUrl = viewName ? this.runtime.views?.[viewName]?.devUrl : undefined;
      if (!devUrl) throw new Error('No development URL was found for this view. Start npm run dev.');
      const parsedUrl = new URL(devUrl);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname)) throw new Error('Development previews require a loopback URL.');
      frame.removeAttribute('srcdoc'); frame.src = parsedUrl.href;
    } else {
      // Native FormRoot needs submit events. Block network form navigation;
      // Angular handles submission through the MCP bridge instead.
      const formPolicy = `<meta http-equiv="Content-Security-Policy" content="form-action 'none'">`;
      const html = /<head\b[^>]*>/i.test(this.html)
        ? this.html.replace(/<head\b[^>]*>/i, head => head + formPolicy) : formPolicy + this.html;
      frame.setAttribute('sandbox', 'allow-scripts allow-forms'); frame.removeAttribute('src'); frame.srcdoc = html;
    }
  }
  async reloadPreview() { try { if (this.html) await this.mountPreview(); } catch (error) { this.error.set(String(error)); } }
  toggleTheme() { this.theme.update(theme => theme === 'light' ? 'dark' : 'light'); this.bridge?.setHostContext(this.hostContext()); }
  changeProfile(profile: HostProfile) { if (!(profile in hostProfiles)) return; this.profile.set(profile); this.displayMode.set('inline'); void this.reloadPreview(); }
  changeSource(source: 'resource' | 'development') { this.source.set(source); void this.reloadPreview(); }
  changeLocale(locale: string) { this.locale.set(locale); this.bridge?.setHostContext(this.hostContext()); }
  changeDevice(device: 'desktop' | 'mobile' | 'tablet') { this.device.set(device); this.mobile.set(device === 'mobile'); this.bridge?.setHostContext(this.hostContext()); }
  cancelTool() { this.requestAbort?.abort(); void this.bridge?.sendToolCancelled({ reason: 'Cancelled in workbench' }); }
  private async dismissView(bridge: AppBridge) {
    this.log('ui/notifications/request-teardown', {});
    await bridge.teardownResource({}, { timeout: 2000 }).catch(() => {});
    if (bridge !== this.bridge) return;
    await bridge.close(); this.bridge = undefined; this.viewStatus.set('closed');
    await this.resourceSubscriptions?.close(); this.resourceSubscriptions = undefined;
    const frame = this.frame().nativeElement; frame.removeAttribute('src'); frame.srcdoc = '<p style="font:14px system-ui;padding:32px">View closed. Use Reload preview to reopen.</p>';
  }
  async showViewTools() {
    this.tab.set('view-tools'); this.error.set('');
    try { this.viewTools.set((await this.bridge?.listTools({}))?.tools ?? []); } catch (error) { this.error.set(String(error)); }
  }
  selectViewTool(name: string) { this.selectedViewTool.set(name); const tool = this.viewTools().find(tool => tool.name === name); this.viewToolInput.set(tool ? this.json(sampleInput(tool.inputSchema)) : '{}'); }
  async callViewTool() {
    this.error.set('');
    try {
      if (!this.bridge) throw new Error('No Angular view is connected.');
      const input = z.record(z.string(), z.unknown()).parse(JSON.parse(this.viewToolInput()));
      const result = await this.bridge.callTool({ name: this.selectedViewTool(), arguments: input });
      this.viewToolResult.set(result); this.log('host/view-tools/call', { name: this.selectedViewTool(), input, result });
    } catch (error) { this.error.set(String(error)); }
  }
  async showResources() {
    this.tab.set('resources'); this.error.set('');
    try { this.resources.set((await this.client?.listResources())?.resources ?? []); } catch (error) { this.error.set(String(error)); }
  }
  async showPrompts() {
    this.tab.set('prompts'); this.error.set('');
    try { this.prompts.set((await this.client?.listPrompts())?.prompts ?? []); }
    catch (error) { this.error.set(String(error)); }
  }
  selectPrompt(name: string) {
    this.selectedPrompt.set(name); const prompt = this.prompts().find(prompt => prompt.name === name);
    this.promptInput.set(this.json(Object.fromEntries((prompt?.arguments ?? []).map(arg => [arg.name, '']))));
  }
  async getPrompt() {
    try {
      const args = z.record(z.string(), z.string()).parse(JSON.parse(this.promptInput()));
      this.promptResult.set(await this.client!.getPrompt({ name: this.selectedPrompt(), arguments: args })); this.error.set('');
    } catch (error) { this.error.set(String(error)); }
  }
  async readResource(uri: string) { if (!uri) return; try { this.resourceResult.set(await this.client!.readResource({ uri })); } catch (error) { this.error.set(String(error)); } }
  exportFixture() {
    const tool = this.selectedTool(); const result = this.result(); if (!tool || !result) return;
    try { this.fixtureText.set(serializeFixture({ version: 1, name: tool.title ?? tool.name, tool: tool.name, arguments: JSON.parse(this.input()), result,
      host: { profile: this.profile(), theme: this.theme(), locale: this.locale() } })); } catch (error) { this.error.set(String(error)); }
  }
  async importFixture(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
    if (file.size > 2_000_000) { this.error.set('Fixture exceeds the 2 MB limit.'); return; }
    this.fixtureText.set(await file.text());
  }
  async replayFixture() {
    this.error.set('');
    try {
      const fixture = parseFixture(this.fixtureText()); const tool = this.tools().find(tool => tool.name === fixture.tool);
      if (!tool) throw new Error(`This server does not have tool ${fixture.tool}.`);
      this.profile.set(fixture.host.profile); this.locale.set(fixture.host.locale); this.theme.set(fixture.host.theme); this.selectedTool.set(tool);
      this.input.set(this.json(fixture.arguments)); this.inputSnapshot = fixture.arguments; this.resultSnapshot = fixture.result; this.result.set(fixture.result);
      const uri = (tool._meta?.['ui'] as { resourceUri?: string } | undefined)?.resourceUri;
      if (uri) { const resource = await this.client!.readResource({ uri }); const html = resource.contents.find(item => 'text' in item); if (!html || !('text' in html)) throw new Error('No HTML view resource.'); this.html = html.text; this.resourceUri.set(uri); await this.mountPreview(); }
      this.log('fixture/replayed', { name: fixture.name, tool: fixture.tool });
    } catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); }
  }
  downloadFixture() { this.downloadText(this.fixtureText(), 'angular-mcp-fixture.json', 'application/json'); }
  private downloadText(text: string, name: string, type: string) { this.downloadBlob(new Blob([text], { type }), name); }
  private downloadBlob(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
