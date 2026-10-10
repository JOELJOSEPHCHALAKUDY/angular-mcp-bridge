import { computed, inject, linkedSignal, signal, DestroyRef, type Resource, type ResourceSnapshot, type Signal } from '@angular/core';
import type { FileResourceContent, FileWriteResult } from './extensions.js';
import type { FileResourceHandle, FileResourceValue } from './file-resource.js';

/** Retains the last available value through loading/errors. Supply resetKey for account/connection changes. */
export function retainedResourceValue<T>(source: Resource<T>, options: { initialValue?: T; resetKey?: () => unknown } = {}): Signal<T | undefined> {
  return linkedSignal<{ snapshot: ResourceSnapshot<T>; key: unknown }, T | undefined>({
    source: () => ({ snapshot: source.snapshot(), key: options.resetKey?.() }),
    computation: (next, previous) => next.snapshot.status === 'resolved' || next.snapshot.status === 'local' || next.snapshot.status === 'reloading'
      ? next.snapshot.value : previous && Object.is(next.key, previous.source.key) ? previous.value : options.initialValue,
  }).asReadonly();
}
interface DraftState {
  uri?: string;
  base?: FileResourceValue;
  content: FileResourceContent;
  conflict: boolean;
  remoteChanged: boolean;
}
const contentOf = (value: FileResourceValue): FileResourceContent => 'text' in value ? { text: value.text } : { blob: value.blob };
const sameContent = (first: FileResourceContent, second: FileResourceContent) => 'text' in first && 'text' in second ? first.text === second.text : 'blob' in first && 'blob' in second && first.blob === second.blob;
const dirtyState = (state: DraftState) => !!state.base && !sameContent(state.content, contentOf(state.base));

/** Native linked state keeps the draft's base etag when a resource subscription refreshes the server value. */
export function injectResourceDraft(file: FileResourceHandle) {
  const destroyRef = inject(DestroyRef);
  const saving = signal(false);
  const error = signal<Error | null>(null);
  let disposed = false;
  destroyRef.onDestroy(() => { disposed = true; });
  const state = linkedSignal<FileResourceValue | undefined, DraftState>({
    source: () => file.resource.hasValue() ? file.resource.value() : undefined,
    computation: (remote, previous) => {
      const old = previous?.value;
      if (!remote) return old ?? { content: { text: '' }, conflict: false, remoteChanged: false };
      if (old && dirtyState(old)) {
        return { ...old, remoteChanged: remote.resourceUri !== old.uri || remote.etag !== old.base?.etag || !sameContent(contentOf(remote), contentOf(old.base!)) };
      }
      return { uri: remote.resourceUri, base: remote, content: contentOf(remote), conflict: false, remoteChanged: false };
    },
    debugName: 'MCP resource draft',
  });
  const check = () => { if (disposed) throw new Error('This resource draft has been destroyed.'); };
  return {
    content: computed(() => state().content),
    baseEtag: computed(() => state().base?.etag),
    dirty: computed(() => dirtyState(state())),
    conflict: computed(() => state().conflict),
    remoteChanged: computed(() => state().remoteChanged),
    saving: saving.asReadonly(), error: error.asReadonly(),
    canSave: computed(() => !!state().base?.writable && file.selectedUri() === state().uri && file.resource.hasValue() && file.resource.value()?.resourceUri === state().uri),
    set(content: FileResourceContent): void {
      check();
      if (!state().base) throw new Error('Load a resource before editing.');
      state.update(previous => ({ ...previous, content })); error.set(null);
    },
    /** Refresh server data without discarding local edits or advancing their original etag. */
    reload(): boolean { check(); return file.reload(); },
    /** Explicitly adopt the current server version. This is the only operation that discards a dirty draft. */
    discard(): void {
      check();
      if (saving()) throw new Error('Wait for the current save before discarding.');
      const remote = file.resource.hasValue() ? file.resource.value() : undefined;
      if (!remote) throw new Error('Load a resource before discarding.');
      state.set({ uri: remote.resourceUri, base: remote, content: contentOf(remote), conflict: false, remoteChanged: false }); error.set(null);
    },
    async save(): Promise<FileWriteResult> {
      check();
      if (saving()) throw new Error('A draft save is already in progress.');
      const original = state();
      if (!original.base || file.selectedUri() !== original.uri || !file.resource.hasValue() || file.resource.value()?.resourceUri !== original.uri) throw new Error('The selected resource changed. Discard or finish the original draft before saving.');
      saving.set(true); error.set(null);
      try {
        const result = await file.save(original.content, { ifMatch: original.base.etag });
        if (!disposed) {
          if (result.outcome === 'saved') state.update(current => {
            if (current.uri !== original.uri) return current;
            const remote = file.resource.hasValue() ? file.resource.value() : undefined;
            if (sameContent(current.content, original.content) && remote && remote.resourceUri !== original.uri) {
              return { uri: remote.resourceUri, base: remote, content: contentOf(remote), conflict: false, remoteChanged: false };
            }
            return { ...current, base: { ...original.base!, ...original.content, etag: result.etag }, conflict: false, remoteChanged: false };
          });
          else if (result.outcome === 'conflict') {
            state.update(current => current.uri === original.uri ? { ...current, conflict: true } : current);
            if (file.resource.hasValue() && file.resource.value()?.resourceUri === original.uri) file.reload();
          }
        }
        return result;
      } catch (cause) {
        if (!disposed) error.set(cause instanceof Error ? cause : new Error(String(cause)));
        throw cause;
      } finally { if (!disposed) saving.set(false); }
    },
  };
}
