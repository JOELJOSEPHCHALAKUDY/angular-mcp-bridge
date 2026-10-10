import { Component, inject } from '@angular/core';
import { injectFileResource, McpBridge } from '@angular-mcp-bridge/angular';

@Component({
  selector: 'bridge-deferred-details',
  standalone: true,
  template: `
    <section aria-live="polite">
      <h2>Deferred Angular details</h2>
      <p>This standalone component mounts when requested. In the hosted-assets build, Angular also loads its JavaScript chunk on demand.</p>
      <p>A native Angular resource owns this read: parameters decide when it runs, obsolete requests are cancelled, and signals expose its status.</p>
      @if (note.isLoading()) { <p>Reading the shared note…</p> }
      @if (note.error(); as error) { <p role="alert">{{ error.message }}</p> }
      @else if (note.hasValue()) { <p>Shared note loaded. Resource state: {{ note.status() }}.</p> }
      @else { <p>Waiting for a connected host with resource-read support.</p> }
      <p>Writes remain explicit actions. A read capability does not grant permission to modify a resource.</p>
    </section>
  `,
})
export class DeferredDetailsComponent {
  private readonly bridge = inject(McpBridge);
  readonly note = injectFileResource({
    uri: () => this.bridge.connected() && this.bridge.capabilities().serverResources ? 'bridge://lab/notes' : undefined,
    watch: false,
  }).resource;
}
