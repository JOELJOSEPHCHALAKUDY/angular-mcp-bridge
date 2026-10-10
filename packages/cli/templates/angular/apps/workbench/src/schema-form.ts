import { Component, ElementRef, Injector, afterNextRender, computed, effect, forwardRef, inject, input, linkedSignal, output, signal, viewChild, viewChildren } from '@angular/core';

export type JsonSchema = Record<string, unknown>;
export type SchemaInputKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'array' | 'object' | 'json';
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const properties = (schema: JsonSchema): Record<string, JsonSchema> => isObject(schema['properties']) ? Object.fromEntries(Object.entries(schema['properties']).map(([key, value]) => [key, isObject(value) ? value : value === false ? { not: {} } : {}])) : {};
const required = (schema: JsonSchema): string[] => Array.isArray(schema['required']) ? schema['required'].filter((key): key is string => typeof key === 'string') : [];
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, i) => same(value, b[i]));
  return isObject(a) && isObject(b) && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && same(value, b[key]));
};

/** Complex/ref/union schemas remain available through a JSON editor. */
export function schemaInputKind(schema: JsonSchema): SchemaInputKind {
  if (schema['$ref'] || schema['oneOf'] || schema['anyOf'] || schema['allOf'] || Array.isArray(schema['type'])) return 'json';
  if (Array.isArray(schema['enum']) && schema['enum'].length && schema['enum'].every(value => value === null || ['string', 'boolean', 'number'].includes(typeof value))) return 'enum';
  const type = schema['type'];
  if (['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(String(type))) return type as SchemaInputKind;
  return schema['properties'] ? 'object' : 'json';
}

/** Initial field values; optional fields are omitted unless they declare a default. */
export function schemaDefaults(schema: JsonSchema, depth = 0): unknown {
  if (depth > 20) return null;
  if (Object.hasOwn(schema, 'default')) return structuredClone(schema['default']);
  if (Object.hasOwn(schema, 'const')) return structuredClone(schema['const']);
  if (Array.isArray(schema['enum'])) return structuredClone(schema['enum'][0]);
  switch (schemaInputKind(schema)) {
    case 'object': return Object.fromEntries(Object.entries(properties(schema)).filter(([key, child]) => required(schema).includes(key) || Object.hasOwn(child, 'default')).map(([key, child]) => [key, schemaDefaults(child, depth + 1)]));
    case 'array': return Array.from({ length: Math.min(100, typeof schema['minItems'] === 'number' ? schema['minItems'] : 0) }, () => schemaDefaults(isObject(schema['items']) ? schema['items'] : {}, depth + 1));
    case 'boolean': return false;
    case 'integer': case 'number': return typeof schema['minimum'] === 'number' ? schema['minimum'] : 0;
    case 'string': return '';
    default: return null;
  }
}

/**
 * Local validation for schema form values, including local references/unions.
 * This is a UI check, not a replacement for authoritative MCP server validation.
 */
export function validateSchemaValue(schema: JsonSchema, value: unknown, options: { rootSchema?: JsonSchema; path?: string } = {}): string[] {
  const issues: string[] = [];
  const validate = (node: JsonSchema, actual: unknown, path: string, depth: number, target = issues): void => {
    const fail = (message: string) => target.push(`${path}: ${message}`);
    if (depth > 40) { fail('schema nesting exceeds the local limit'); return; }
    if (typeof node['$ref'] === 'string') {
      if (!node['$ref'].startsWith('#/')) { fail('external references need server validation'); return; }
      let resolved: unknown = options.rootSchema ?? schema;
      for (const part of node['$ref'].slice(2).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) resolved = isObject(resolved) && Object.hasOwn(resolved, part) ? resolved[part] : undefined;
      if (!isObject(resolved)) { fail('unresolved schema reference'); return; }
      validate(resolved, actual, path, depth + 1, target);
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) if (Array.isArray(node[keyword])) {
      const matches = node[keyword].filter(branch => {
        const branchErrors: string[] = [];
        if (!isObject(branch)) return branch === true;
        validate(branch, actual, path, depth + 1, branchErrors); return !branchErrors.length;
      }).length;
      if (keyword === 'oneOf' ? matches !== 1 : matches === 0) fail(`does not match ${keyword}`);
    }
    if (Array.isArray(node['allOf'])) for (const branch of node['allOf']) if (isObject(branch)) validate(branch, actual, path, depth + 1, target);
    if (Array.isArray(node['allOf']) && node['allOf'].includes(false)) fail('matches a forbidden schema');
    if (isObject(node['not'])) { const forbidden: string[] = []; validate(node['not'], actual, path, depth + 1, forbidden); if (!forbidden.length) fail('matches a forbidden schema'); }
    if (Array.isArray(node['enum']) && !node['enum'].some(option => same(actual, option))) fail('choose one of the allowed values');
    if (Object.hasOwn(node, 'const') && !same(actual, node['const'])) fail('must match the fixed value');
    const matchesType = (type: unknown) => type === 'null' ? actual === null : type === 'object' ? isObject(actual) : type === 'array' ? Array.isArray(actual) : type === 'integer' ? Number.isInteger(actual) : type === 'number' ? typeof actual === 'number' && Number.isFinite(actual) : typeof actual === type;
    const types = Array.isArray(node['type']) ? node['type'] : node['type'] ? [node['type']] : [];
    if (types.length && !types.some(matchesType)) { fail(`expected ${types.join(' or ')}`); return; }
    if (isObject(actual)) {
      const children = properties(node);
      for (const key of required(node)) if (!Object.hasOwn(actual, key)) fail(`missing required field ${key}`);
      if (typeof node['minProperties'] === 'number' && Object.keys(actual).length < node['minProperties']) fail(`needs at least ${node['minProperties']} fields`);
      if (typeof node['maxProperties'] === 'number' && Object.keys(actual).length > node['maxProperties']) fail(`allows at most ${node['maxProperties']} fields`);
      for (const [key, entry] of Object.entries(actual)) {
        if (Object.hasOwn(children, key)) validate(children[key], entry, `${path}.${key}`, depth + 1, target);
        else if (node['additionalProperties'] === false) fail(`unknown field ${key}`);
        else if (isObject(node['additionalProperties'])) validate(node['additionalProperties'], entry, `${path}.${key}`, depth + 1, target);
      }
    }
    if (Array.isArray(actual)) {
      if (typeof node['minItems'] === 'number' && actual.length < node['minItems']) fail(`needs at least ${node['minItems']} items`);
      if (typeof node['maxItems'] === 'number' && actual.length > node['maxItems']) fail(`allows at most ${node['maxItems']} items`);
      if (node['uniqueItems'] === true && actual.some((entry, index) => actual.slice(0, index).some(prior => same(entry, prior)))) fail('items must be unique');
      if (node['items'] === false && actual.length) fail('array items are forbidden');
      if (isObject(node['items'])) actual.forEach((entry, index) => validate(node['items'] as JsonSchema, entry, `${path}[${index}]`, depth + 1, target));
    }
    if (typeof actual === 'number') {
      for (const [key, passes] of [['minimum', (bound: number) => actual >= bound], ['maximum', (bound: number) => actual <= bound], ['exclusiveMinimum', (bound: number) => actual > bound], ['exclusiveMaximum', (bound: number) => actual < bound]] as const) if (typeof node[key] === 'number' && !passes(node[key])) fail(`violates ${key} ${node[key]}`);
      if (typeof node['multipleOf'] === 'number' && node['multipleOf'] > 0 && Math.abs(actual / node['multipleOf'] - Math.round(actual / node['multipleOf'])) > 1e-8) fail(`must be a multiple of ${node['multipleOf']}`);
    }
    if (typeof actual === 'string') {
      const length = [...actual].length;
      if (typeof node['minLength'] === 'number' && length < node['minLength']) fail(`needs at least ${node['minLength']} characters`);
      if (typeof node['maxLength'] === 'number' && length > node['maxLength']) fail(`allows at most ${node['maxLength']} characters`);
      if (typeof node['pattern'] === 'string') { try { if (!new RegExp(node['pattern'], 'u').test(actual)) fail('does not match the required pattern'); } catch { fail('schema pattern is invalid'); } }
    }
  };
  validate(schema, value, options.path ?? '$', 0);
  return issues;
}
export function parseSchemaInput(schema: JsonSchema, text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error('Tool arguments must be a JSON object.');
  const issues = validateSchemaValue(schema, parsed);
  if (issues.length) throw new Error(issues.join('\n'));
  return parsed;
}

let nextFieldId = 0;
let nextArrayId = 0;
@Component({
  selector: 'bridge-schema-field', standalone: true,
  imports: [forwardRef(() => SchemaFieldComponent)],
  template: `
    @switch (kind()) {
      @case ('boolean') { <label [for]="fieldId"><input [id]="fieldId" type="checkbox" [attr.aria-describedby]="describedBy()" [attr.aria-invalid]="!valid()" [attr.aria-required]="requiredField()" [checked]="value() === true" (change)="valueChange.emit($any($event.target).checked)"> {{ label() }}</label> }
      @case ('enum') { <label [for]="fieldId">{{ label() }}<select [id]="fieldId" [attr.aria-label]="label()" [attr.aria-describedby]="describedBy()" [attr.aria-invalid]="!valid()" [attr.aria-required]="requiredField()" [value]="enumIndex()" (change)="selectEnum($any($event.target).value)">@for (option of enumValues(); track $index) { <option [value]="$index">{{ display(option) }}</option> }</select></label> }
      @case ('string') { <label [for]="fieldId">{{ label() }}<input [id]="fieldId" type="text" [attr.aria-label]="label()" [attr.aria-describedby]="describedBy()" [attr.aria-invalid]="!valid()" [attr.aria-required]="requiredField()" [value]="value() ?? ''" (input)="valueChange.emit($any($event.target).value)"></label> }
      @case ('number') { <label [for]="fieldId">{{ label() }}<input [id]="fieldId" type="number" [attr.aria-label]="label()" [attr.aria-describedby]="describedBy()" [attr.aria-invalid]="!valid()" [attr.aria-required]="requiredField()" [value]="value() ?? ''" [attr.min]="schema()['minimum']" [attr.max]="schema()['maximum']" (input)="number($any($event.target).value)"></label> }
      @case ('integer') { <label [for]="fieldId">{{ label() }}<input [id]="fieldId" type="number" step="1" [attr.aria-label]="label()" [attr.aria-describedby]="describedBy()" [attr.aria-invalid]="!valid()" [attr.aria-required]="requiredField()" [value]="value() ?? ''" [attr.min]="schema()['minimum']" [attr.max]="schema()['maximum']" (input)="number($any($event.target).value)"></label> }
      @case ('object') { <fieldset [attr.aria-describedby]="describedBy()"><legend>{{ label() }}</legend>@for (field of fields(); track field.key) {
        @if (!field.required) { <label class="optional"><input type="checkbox" [checked]="has(field.key)" (change)="toggle(field.key, field.schema, $any($event.target).checked)"> Include {{ field.key }}</label> }
        @if (field.required || has(field.key)) { <bridge-schema-field [schema]="field.schema" [rootSchema]="validationRoot()" [fieldPath]="fieldPath() + '.' + field.key" [requiredField]="field.required" [value]="objectValue()[field.key]" [label]="field.key + (field.required ? ' *' : '')" (valueChange)="objectChange(field.key, $event)" (validityChange)="childValidity(field.key, $event)" /> }
      }</fieldset> }
      @case ('array') { <fieldset [attr.aria-describedby]="describedBy()"><legend>{{ label() }}</legend>@for (row of arrayRows(); track row.id) { <div #arrayRow class="array-item"><bridge-schema-field [schema]="itemSchema()" [rootSchema]="validationRoot()" [fieldPath]="fieldPath() + '[' + $index + ']'" [requiredField]="true" [value]="row.value" [label]="label() + '[' + $index + ']'" (valueChange)="arrayChange($index, $event)" (validityChange)="childValidity('' + row.id, $event)" /><button type="button" (click)="remove($index)" [attr.aria-label]="'Remove ' + label() + ' item ' + $index">Remove</button></div> }<button #addButton type="button" (click)="add()">Add {{ label() }} item</button></fieldset> }
      @default { <label [for]="fieldId">{{ label() }} · JSON<textarea [id]="fieldId" [attr.aria-label]="label() + ' JSON'" [attr.aria-describedby]="describedBy()" [attr.aria-invalid]="!valid()" [attr.aria-required]="requiredField()" [value]="display(value())" (input)="json($any($event.target).value)"></textarea></label> }
    }
    @if (schema()['description']) { <small [id]="fieldId + '-description'">{{ schema()['description'] }}</small> }
    @if (fieldErrors().length) { <ul [id]="fieldId + '-errors'" aria-live="polite">@for (error of fieldErrors(); track $index) { <li>{{ error }}</li> }</ul> }
  `,
  styles: `:host { display:block; margin:.45rem 0 } label { display:grid; gap:.3rem } input:not([type=checkbox]),select,textarea { width:100%; box-sizing:border-box; padding:.4rem; font:inherit; color:inherit; background:transparent; border:1px solid #a6a6a6; border-radius:.2rem } input[type=checkbox] { width:auto } fieldset { min-width:0; border:1px solid #bdbdbd; padding:.6rem } legend,small { font-size:.8rem } .optional { display:block; font-size:.8rem; margin:.4rem 0 } .array-item { display:flex; gap:.4rem; align-items:center } .array-item bridge-schema-field { flex:1 } button { font:inherit; font-size:.8rem; padding:.3rem .5rem } p { color:#b3261e; font-size:.8rem }`,
})
export class SchemaFieldComponent {
  private readonly injector = inject(Injector);
  readonly fieldId = 'schema-field-' + nextFieldId++;
  readonly rootSchema = input<JsonSchema>();
  readonly fieldPath = input('$');
  readonly requiredField = input(false);
  readonly schema = input.required<JsonSchema>();
  readonly value = input<unknown>();
  readonly label = input('Arguments');
  readonly valueChange = output<unknown>();
  readonly validityChange = output<boolean>();
  private readonly jsonFailure = signal<{ source: unknown; schema: JsonSchema } | undefined>(undefined);
  private readonly childValidityState = signal<Record<string, boolean>>({});
  readonly jsonError = computed(() => { const failure = this.jsonFailure(); return this.kind() === 'json' && failure && failure.source === this.value() && failure.schema === this.schema() ? 'Enter valid JSON.' : ''; });
  readonly kind = computed(() => schemaInputKind(this.schema()));
  readonly enumValues = computed(() => this.schema()['enum'] as unknown[] ?? []);
  readonly enumIndex = computed(() => this.enumValues().findIndex(value => same(value, this.value())));
  readonly objectValue = computed(() => isObject(this.value()) ? this.value() as Record<string, unknown> : {});
  readonly arrayValue = computed(() => Array.isArray(this.value()) ? this.value() as unknown[] : []);
  readonly itemSchema = computed(() => isObject(this.schema()['items']) ? this.schema()['items'] as JsonSchema : {});
  readonly fields = computed(() => Object.entries(properties(this.schema())).map(([key, schema]) => ({ key, schema, required: required(this.schema()).includes(key) })));
  readonly validationRoot = computed(() => this.rootSchema() ?? this.schema());
  readonly validationErrors = computed(() => validateSchemaValue(this.schema(), this.value(), { rootSchema: this.validationRoot(), path: this.fieldPath() }));
  readonly fieldErrors = computed(() => this.jsonError() ? [this.jsonError()] : ['object', 'array'].includes(this.kind()) ? [] : this.validationErrors());
  readonly describedBy = computed(() => [this.schema()['description'] ? this.fieldId + '-description' : '', this.fieldErrors().length ? this.fieldId + '-errors' : ''].filter(Boolean).join(' ') || null);
  private readonly arrayKeys = linkedSignal<unknown[], number[]>({ source: this.arrayValue, computation: (values, previous) => values.map((_value, index) => previous?.value[index] ?? nextArrayId++) });
  readonly arrayRows = computed(() => this.arrayValue().map((value, index) => ({ id: this.arrayKeys()[index], value })));
  readonly arrayElements = viewChildren<ElementRef<HTMLElement>>('arrayRow');
  readonly addElement = viewChild<ElementRef<HTMLButtonElement>>('addButton');
  readonly valid = computed(() => {
    if (this.jsonError() || this.validationErrors().length) return false;
    const children = this.childValidityState();
    const keys = this.kind() === 'object' ? this.fields().filter(field => field.required || this.has(field.key)).map(field => field.key) : this.kind() === 'array' ? this.arrayKeys().map(String) : [];
    return keys.every(key => children[key] !== false);
  });
  constructor() { effect(() => this.validityChange.emit(this.valid())); }
  childValidity(key: string, valid: boolean): void { this.childValidityState.update(previous => ({ ...previous, [key]: valid })); if (!valid) this.validityChange.emit(false); }
  display(value: unknown): string { return value === undefined ? 'null' : JSON.stringify(value, null, 2); }
  has(key: string): boolean { return Object.hasOwn(this.objectValue(), key); }
  selectEnum(index: string): void { this.valueChange.emit(this.enumValues()[Number(index)]); }
  number(text: string): void { this.valueChange.emit(text === '' ? undefined : Number(text)); }
  objectChange(key: string, value: unknown): void { const next = { ...this.objectValue() }; if (value === undefined) delete next[key]; else Object.defineProperty(next, key, { value, configurable: true, enumerable: true, writable: true }); this.valueChange.emit(next); }
  toggle(key: string, schema: JsonSchema, included: boolean): void { this.childValidityState.update(previous => ({ ...previous, [key]: true })); this.objectChange(key, included ? schemaDefaults(schema) : undefined); }
  arrayChange(index: number, value: unknown): void { this.valueChange.emit(this.arrayValue().map((entry, i) => i === index ? value : entry)); }
  private focusRow(index: number): void { afterNextRender(() => { const row = this.arrayElements()[index]?.nativeElement; const target = row?.querySelector<HTMLElement>('input,select,textarea,button') ?? this.addElement()?.nativeElement; target?.focus(); }, { injector: this.injector }); }
  add(): void { const index = this.arrayValue().length; this.arrayKeys.set([...this.arrayKeys(), nextArrayId++]); this.valueChange.emit([...this.arrayValue(), schemaDefaults(this.itemSchema())]); this.focusRow(index); }
  remove(index: number): void { const removed = this.arrayKeys()[index]; this.arrayKeys.set(this.arrayKeys().filter((_key, i) => i !== index)); this.childValidityState.update(previous => { const next = { ...previous }; delete next[String(removed)]; return next; }); this.valueChange.emit(this.arrayValue().filter((_entry, i) => i !== index)); this.focusRow(Math.min(index, this.arrayValue().length - 2)); }
  json(text: string): void { try { const parsed = JSON.parse(text); this.jsonFailure.set(undefined); this.valueChange.emit(parsed); } catch { this.jsonFailure.set({ source: this.value(), schema: this.schema() }); this.validityChange.emit(false); } }
}

@Component({
  selector: 'bridge-schema-form', standalone: true, imports: [SchemaFieldComponent],
  template: `<bridge-schema-field [schema]="schema()" [value]="draft()" [label]="'Arguments'" (valueChange)="change($event)" (validityChange)="fieldValidity.set($event)" />@if (errors().length) { <ul role="alert">@for (error of errors(); track $index) { <li>{{ error }}</li> }</ul> }`,
  styles: `ul { font-size:.8rem; color:#b3261e; padding-left:1.2rem }`,
})
export class SchemaFormComponent {
  readonly schema = input.required<JsonSchema>();
  readonly value = input<Record<string, unknown>>({});
  readonly valueChange = output<Record<string, unknown>>();
  readonly validityChange = output<boolean>();
  readonly fieldValidity = signal(true);
  private readonly draftState = signal<{ source: Record<string, unknown>; schema: JsonSchema; value: unknown } | undefined>(undefined);
  readonly draft = computed(() => { const state = this.draftState(); return state?.source === this.value() && state.schema === this.schema() ? state.value : this.value(); });
  readonly errors = computed(() => validateSchemaValue(this.schema(), this.draft()));
  readonly valid = computed(() => this.fieldValidity() && isObject(this.draft()) && !this.errors().length);
  constructor() { effect(() => {
    const valid = this.valid(), draft = this.draft();
    this.validityChange.emit(valid);
    // A nested JSON parser may reject text without changing the last valid value.
    // Keep the complete draft local until every child has recovered its validity.
    if (valid && draft !== this.value()) this.valueChange.emit(draft as Record<string, unknown>);
  }); }
  change(value: unknown): void {
    this.draftState.set({ source: this.value(), schema: this.schema(), value });
    const valid = isObject(value) && validateSchemaValue(this.schema(), value).length === 0;
    this.validityChange.emit(valid && this.fieldValidity());
  }
}
