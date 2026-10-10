import { InjectionToken, makeEnvironmentProviders } from '@angular/core';

export interface FileMetadata { fileId: string; fileName?: string; mimeType?: string; }
export interface UploadFileOptions { library?: boolean; }
export interface ModalOptions {
  title?: string; params?: Record<string, unknown>; template?: string;
  anchor?: { top?: number; left?: number; width?: number; height?: number };
}
export interface FollowUpOptions { target?: 'active' | 'new'; scrollToBottom?: boolean; }
export interface OpenExternalOptions { redirectUrl?: false; }
/** Optional host additions. Every method is feature-detected at invocation. */
export interface ChatGptExtensions {
  requestClose?: () => Promise<void>;
  sendFollowUpMessage?: (args: { prompt: string; scrollToBottom?: boolean }) => Promise<void>;
  openExternal?: (args: { href: string; redirectUrl?: false }) => void;
  requestModal?: (args: ModalOptions) => void | Promise<void>;
  uploadFile?: (file: File, options?: UploadFileOptions) => Promise<FileMetadata>;
  selectFiles?: () => Promise<FileMetadata[]>;
  getFileDownloadUrl?: (file: FileMetadata) => Promise<{ downloadUrl: string }>;
  setOpenInAppUrl?: (args: { href: string }) => Promise<void>;
  widgetState?: Record<string, unknown> | null;
  setWidgetState?: (state: Record<string, unknown>) => Promise<void>;
  view?: { mode: 'inline' | 'fullscreen' | 'pip' | 'modal'; params?: Record<string, unknown> };
}
/** An adapter can be supplied for tests or a host with an equivalent extension surface. */
export const CHATGPT_EXTENSIONS = new InjectionToken<ChatGptExtensions>('ChatGPT extensions', {
  factory: () => typeof window === 'undefined' ? {} : (window as Window & { openai?: ChatGptExtensions }).openai ?? {},
});
export function provideChatGptExtensions(adapter: ChatGptExtensions) {
  return makeEnvironmentProviders([{ provide: CHATGPT_EXTENSIONS, useValue: adapter }]);
}
/** Enables an iframe-local Angular modal; it cannot portal outside the host iframe. */
export const LOCAL_MODAL_ENABLED = new InjectionToken<boolean>('Local MCP modal enabled', { factory: () => false });
export function provideLocalMcpModal() {
  return makeEnvironmentProviders([{ provide: LOCAL_MODAL_ENABLED, useValue: true }]);
}
export type FileResourceContent = { text: string } | { blob: string };
export type FileResource = FileResourceContent & { mimeType?: string; writable: boolean; etag?: string };
export type FileWriteResult = { outcome: 'saved' | 'conflict'; etag: string } | { outcome: 'too-large'; maxBytes: number };
export type ResourceRepresentation = 'text' | 'blob';
