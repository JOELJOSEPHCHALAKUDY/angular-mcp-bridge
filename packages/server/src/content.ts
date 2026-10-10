import type { Annotations, AudioContent, EmbeddedResource, ImageContent, ResourceLink, TextContent } from '@modelcontextprotocol/server';
const encoded = (data: Uint8Array | string) => typeof data === 'string' ? data : Buffer.from(data).toString('base64');
/** Strings supplied to image/audio are already base64; Uint8Array is encoded. */
export const text = (value: string, annotations?: Annotations): TextContent => ({ type: 'text', text: value, ...(annotations ? { annotations } : {}) });
export const image = (data: Uint8Array | string, mimeType: string, annotations?: Annotations): ImageContent => ({ type: 'image', data: encoded(data), mimeType, ...(annotations ? { annotations } : {}) });
export const audio = (data: Uint8Array | string, mimeType: string, annotations?: Annotations): AudioContent => ({ type: 'audio', data: encoded(data), mimeType, ...(annotations ? { annotations } : {}) });
export const embeddedResource = (resource: EmbeddedResource['resource'], annotations?: Annotations): EmbeddedResource => ({ type: 'resource', resource, ...(annotations ? { annotations } : {}) });
export const resourceLink = (link: Omit<ResourceLink, 'type' | 'annotations'>, annotations?: Annotations): ResourceLink => ({ type: 'resource_link', ...link, ...(annotations ? { annotations } : {}) });
