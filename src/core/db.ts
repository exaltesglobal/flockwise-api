// In-memory database the engine reads and writes. Each adapter persists the changes:
// the API writes them through to MySQL, the web demo saves them to localStorage.
import { KINDS, type Collections, type Kind } from './types.js';

export type Change = { kind: Kind; id: string; value: Collections[Kind] | null };
export type Dump = { [K in Kind]?: Collections[K][] };

export class Db {
  private maps = new Map<Kind, Map<string, unknown>>();
  private listeners = new Set<(c: Change) => void>();

  constructor(dump?: Dump) {
    for (const k of KINDS) this.maps.set(k, new Map());
    if (dump) this.load(dump);
  }

  load(dump: Dump) {
    for (const k of KINDS) {
      const m = new Map<string, unknown>();
      for (const row of (dump[k] ?? []) as { id: string }[]) m.set(row.id, row);
      this.maps.set(k, m);
    }
  }

  dump(): Dump {
    const out: Dump = {};
    for (const k of KINDS) (out as Record<string, unknown[]>)[k] = [...this.maps.get(k)!.values()];
    return out;
  }

  all<K extends Kind>(kind: K): Collections[K][] {
    return [...(this.maps.get(kind)!.values() as Iterable<Collections[K]>)];
  }

  get<K extends Kind>(kind: K, id: string | null | undefined): Collections[K] | undefined {
    return id ? (this.maps.get(kind)!.get(id) as Collections[K] | undefined) : undefined;
  }

  count(kind: Kind) {
    return this.maps.get(kind)!.size;
  }

  /** Inserts or replaces a record. Always call it after changing a record you read. */
  put<K extends Kind>(kind: K, value: Collections[K]): Collections[K] {
    this.maps.get(kind)!.set(value.id, value);
    this.emit({ kind, id: value.id, value });
    return value;
  }

  del(kind: Kind, id: string) {
    if (this.maps.get(kind)!.delete(id)) this.emit({ kind, id, value: null });
  }

  onChange(fn: (c: Change) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(c: Change) {
    for (const l of this.listeners) l(c);
  }
}
