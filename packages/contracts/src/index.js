import { z } from 'zod';
export function defineTool(definition) {
    return definition;
}
export function defineTools(tools) { return tools; }
export const readOnlyAnnotations = {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
};
/** Host-managed file reference. Fetching a download URL is an explicit application decision. */
export const FileRef = z.object({
    file_id: z.string().min(1), download_url: z.url(),
    mime_type: z.string().optional(), file_name: z.string().optional(),
});
export const FileEntrypointInput = z.object({ file: z.object({ name: z.string().min(1), resourceUri: z.string().trim().min(1) }) });
/** Typed shared contract for an Angular file viewer; register its view and handler normally. */
export function defineFileViewerTool(definition) {
    if (!definition.extensions.length || definition.extensions.some(extension => !/^\.[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(extension)))
        throw new Error('File extensions must start with a dot and contain a file suffix.');
    if (!definition.view)
        throw new Error('A file viewer needs an Angular view identifier.');
    const { extensions, openai, ...tool } = definition;
    return { ...tool, input: FileEntrypointInput, openai: { ...openai, entrypoints: [{ type: 'file', extensions }] } };
}
