import { ChangeDetectionStrategy, Component } from '@angular/core';
import { required } from '@angular/forms/signals';
import { FormField, FormRoot, injectToolForm } from '@angular-mcp-bridge/angular/forms';
import { tools } from '../shared/tools.js';

/** Add <project-tool-form> to a view that already provides provideMcpBridge(). */
@Component({
  selector: 'project-tool-form', standalone: true,
  imports: [FormField, FormRoot], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form [formRoot]="project.fields">
      <label for="project-form-id">Project ID</label>
      <input id="project-form-id" [formField]="project.fields.id"
        [attr.aria-invalid]="project.fields.id().touched() && project.fields.id().invalid()"
        aria-describedby="project-form-id-errors" />
      <div id="project-form-id-errors">
        @if (project.fields.id().touched()) {
          @for (error of project.fields.id().errors(); track $index) {
            <p>{{ error.message }}</p>
          }
        }
      </div>
      <button type="submit" [disabled]="project.pending() || project.validating()">
        {{ project.pending() ? 'Loading…' : 'Load project' }}
      </button>
      @if (project.pending()) { <button type="button" (click)="project.cancel()">Cancel</button> }
      @if (project.status() === 'error') {
        <p role="alert">{{ project.error()?.message }}</p>
      }
      @if (project.status() === 'error' || project.status() === 'cancelled') {
        <button type="button" (click)="project.submit()">Retry</button>
      }
      <p role="status" aria-live="polite">
        @if (project.status() === 'cancelled') { Request cancelled. }
        @if (project.status() === 'success') { Loaded {{ project.data()?.project?.name }}. }
      </p>
    </form>
  `,
})
export class ProjectToolFormComponent {
  readonly project = injectToolForm('get_project', tools.get_project, { id: 'atlas' }, {
    schema: path => required(path.id),
  });
}
