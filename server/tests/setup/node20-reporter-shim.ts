// vitest 5 declares engines `^22.12.0 || ^24.0.0 || >=26.0.0`, while this plugin's own floor is
// Node 20 (`engines: >=20`), so CI still runs the suite on Node 20. The suite itself runs there,
// but vitest's reporter calls `Map.groupBy` (Node 21+): on Node 20 a failing test printed only
// "TypeError: Map.groupBy is not a function" instead of its assertion (measured, Node 20.20.2).
// globalSetup runs in the main process, where the reporter runs; this fills that one method.
export default function setup(): void {
  const mapCtor = Map as unknown as { groupBy?: unknown };
  if (typeof mapCtor.groupBy === 'function') {
    return;
  }
  Object.defineProperty(Map, 'groupBy', {
    configurable: true,
    writable: true,
    value: function groupBy<K, T>(items: Iterable<T>, keyOf: (item: T, index: number) => K): Map<K, T[]> {
      const groups = new Map<K, T[]>();
      let index = 0;
      for (const item of items) {
        const key = keyOf(item, index++);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
      }
      return groups;
    },
  });
}
