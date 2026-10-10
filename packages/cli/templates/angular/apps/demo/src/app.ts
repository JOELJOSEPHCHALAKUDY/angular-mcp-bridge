import { Component, computed, effect, inject, signal } from '@angular/core';
import { createToolClient, injectViewState, McpBridge } from '@angular-mcp-bridge/angular';
import { tools, type Project } from '../../../examples/shared/tools.js';
const client = createToolClient(tools);
@Component({
  selector: 'bridge-root', standalone: true,
  template: `
    <main [attr.data-theme]="bridge.theme()">
      <header><div class="mark">A<span>↗</span></div><span class="eyebrow">ANGULAR MCP BRIDGE / DEMO VIEW</span><span class="connection" [class.live]="bridge.connected()">{{ bridge.status() }}</span></header>
      <section class="heading"><div><p class="eyebrow">YOUR WORKSPACE</p><h1>Projects<span>.</span></h1><p class="muted">A small Angular app, inside your conversation.</p></div><span class="count">{{ projects().length }}<small>PROJECTS</small></span></section>
      @if (bridge.error()) { <div class="notice" role="alert">{{ bridge.error()?.message }}</div> }
      <nav aria-label="Filter projects">
        @for (filter of filters; track filter.value) { <button [class.active]="activeFilter() === filter.value" [disabled]="list.pending() || !bridge.connected()" (click)="filterProjects(filter.value)">{{ filter.label }}</button> }
      </nav>
      @if (actionError()) { <p class="notice" role="alert">{{ actionError() }}</p> }
      @if (!projects().length) { <div class="empty">{{ bridge.connected() ? 'Run Project overview in the host to load projects.' : 'Waiting for an MCP Apps host.' }}</div> }
      <div class="projects" [attr.aria-busy]="list.pending()">
        @for (project of projects(); track project.id) {
          <button class="project" [class.selected]="selected()?.id === project.id" (click)="selectProject(project.id)" [disabled]="detail.isLoading()">
            <span class="project-icon">{{ project.name.charAt(0) }}</span><span class="project-body"><strong>{{ project.name }}</strong><span>{{ project.description }}</span><span class="progress"><span [style.width.%]="project.progress"></span></span></span><span class="project-end"><span class="status">{{ label(project.status) }}</span><span class="arrow">↗</span></span>
          </button>
        }
      </div>
      @if (selected(); as project) {
        <section class="detail" aria-live="polite"><div><p class="eyebrow">SELECTED PROJECT</p><h2>{{ project.name }}</h2><p>{{ project.progress }}% complete · {{ label(project.status) }}</p></div><button class="primary" (click)="discuss(project)" [disabled]="!bridge.capabilities().message">Discuss this project ↗</button></section>
      }
      <footer><span><span class="dot"></span> Angular signals + MCP Apps</span><button (click)="shareSelection()" [disabled]="!selected() || !bridge.capabilities().updateModelContext">Share selection with model ↗</button></footer>
    </main>`,
})
export class DemoComponent {
  readonly bridge = inject(McpBridge);
  readonly list = client.inject('list_projects');
  readonly selection = injectViewState<{ selectedId: string | null }>({ selectedId: null });
  readonly detail = client.resource('get_project', { params: () => {
    const id = this.selection.value().selectedId;
    return id ? { id } : undefined;
  } });
  readonly actionError = signal('');
  readonly filters = [{ value: 'all', label: 'All projects' }, { value: 'ready', label: 'Ready' }, { value: 'in-progress', label: 'In progress' }, { value: 'planned', label: 'Planned' }] as const;
  private readonly initial = computed(() => {
    const parsed = tools.list_projects.output.safeParse(this.bridge.toolOutput());
    return parsed.success ? parsed.data : null;
  });
  readonly projects = computed(() => this.list.data()?.projects ?? this.initial()?.projects ?? []);
  readonly activeFilter = computed(() => this.list.data()?.filter ?? this.initial()?.filter ?? 'all');
  readonly selected = computed(() => (this.detail.hasValue() ? this.detail.value()?.project : null) ?? this.projects().find(project => project.id === this.selection.value().selectedId) ?? null);
  constructor() {
    // A new host result supersedes results from earlier local filter interactions.
    effect(() => { if (this.initial()) { this.list.reset(); void this.selection.set({ selectedId: null }); } });
    effect(() => { const error = this.detail.error(); if (error) this.actionError.set(error.message); });
  }
  label(status: string) { return status === 'in-progress' ? 'In progress' : status.charAt(0).toUpperCase() + status.slice(1); }
  async filterProjects(status: 'all' | 'ready' | 'in-progress' | 'planned') {
    this.actionError.set(''); await this.selection.set({ selectedId: null });
    try { await this.list.execute({ status }); } catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
  }
  async selectProject(id: string) {
    this.actionError.set('');
    try { await this.selection.set({ selectedId: id }); } catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
  }
  async discuss(project: Project) { try { await this.bridge.sendMessage(`Help me plan the next steps for ${project.name}.`); } catch (error) { this.actionError.set(String(error)); } }
  async shareSelection() { try { await this.selection.share(); } catch (error) { this.actionError.set(String(error)); } }
}
