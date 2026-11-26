// What the keyed tier serves from items.external_ids and items.source_meta.
// Both columns are free-form JSON objects, so each value is checked and copied
// by name: a key nobody listed here, or a value of the wrong type, never
// reaches a response.

const QID = /^Q\d+$/;
const ULAN = /^\d+$/;

export interface ServedExternalIds {
  accession?: string;
  wikidata?: string;
  creators?: { ulan?: string; wikidata?: string }[];
}

export interface ServedSourceMeta {
  date_start?: number;
  date_end?: number;
  dimensions?: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function creator(value: unknown) {
  const person = asObject(value);
  if (!person) return null;
  const entry = {
    ulan: matching(person.ulan, ULAN),
    wikidata: matching(person.wikidata, QID),
  };
  return entry.ulan || entry.wikidata ? withoutUndefined(entry) : null;
}

function withoutUndefined<T extends object>(entry: T): T {
  return Object.fromEntries(
    Object.entries(entry).filter(([, v]) => v !== undefined),
  ) as T;
}

export function servedExternalIds(value: unknown): ServedExternalIds | null {
  const ids = asObject(value);
  if (!ids) return null;
  const creators = (Array.isArray(ids.creators) ? ids.creators : [])
    .map(creator)
    .filter((c): c is NonNullable<ReturnType<typeof creator>> => c !== null);
  const served = withoutUndefined({
    accession: text(ids.accession),
    wikidata: matching(ids.wikidata, QID),
    creators: creators.length ? creators : undefined,
  });
  return Object.keys(served).length ? served : null;
}

export function servedSourceMeta(value: unknown): ServedSourceMeta | null {
  const meta = asObject(value);
  if (!meta) return null;
  const year = (v: unknown) =>
    Number.isInteger(v) ? (v as number) : undefined;
  const served = withoutUndefined({
    date_start: year(meta.date_start),
    date_end: year(meta.date_end),
    dimensions: text(meta.dimensions),
  });
  return Object.keys(served).length ? served : null;
}
