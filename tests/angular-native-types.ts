import { signal } from '@angular/core';
import { defineTool, defineTools, readOnlyAnnotations } from '@angular-mcp-bridge/contracts';
import { injectToolForm } from '@angular-mcp-bridge/angular/forms';
import { declareWebMcpTool, provideWebMcpTools } from '@angular-mcp-bridge/angular/webmcp';
import { z } from 'zod';

// Compile-only regressions. These functions intentionally are never executed.
const tool = defineTool({ title: 'Typed tool', description: 'Typed contract', annotations: readOnlyAnnotations,
  input: z.object({ amount: z.string().transform(Number), limit: z.number().default(5) }),
  output: z.object({ total: z.number() }),
});
function verifyNativeFormTypes() {
  const native = injectToolForm('typed', tool, { amount: '3' });
  native.fields.amount().value.set('4');
  const value: string = native.fields.amount().value();
  const output: number | undefined = native.data()?.total;
  native.reset({ amount: '5', limit: 10 });
  injectToolForm('typed', tool, signal({ amount: '3' }));
  // @ts-expect-error Native field editing requires a writable signal.
  injectToolForm('typed', tool, signal({ amount: '3' }).asReadonly());
  // @ts-expect-error The form stores wire strings before Zod transforms.
  native.fields.amount().value.set(4);
  // @ts-expect-error Initial values must match the tool's wire input.
  injectToolForm('typed', tool, { amount: 3 });
  // @ts-expect-error Only fields declared by the shared contract exist.
  native.fields.missing;
  // @ts-expect-error Reset accepts input rather than parsed output.
  native.reset({ amount: 5 });
  return [value, output];
}
function verifyWebMcpTypes() {
  declareWebMcpTool('typed', tool, (parsed, client) => {
    const amount: number = parsed.amount;
    const limit: number = parsed.limit;
    const cancellation: AbortSignal = client.signal;
    return { total: cancellation.aborted ? 0 : amount * limit };
  }, { enabled: true });
  // @ts-expect-error Browser handlers must return the declared output shape.
  declareWebMcpTool('typed', tool, () => ({ total: 'wrong' }));
  // @ts-expect-error Registry providers require a handler for each selected tool.
  provideWebMcpTools(defineTools({ typed: tool }), {}, { enabled: true });
  provideWebMcpTools(defineTools({ typed: tool }), { typed: input => ({ total: input.amount * input.limit }) }, { enabled: true });
}
void verifyNativeFormTypes; void verifyWebMcpTypes;
