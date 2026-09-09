export type FacetFilters = {
  hostnames?: string[];
  sources?: string[];
  models?: string[];
  projects?: string[];
};

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

function allowed(selected: string[] | undefined, value: string | undefined): boolean {
  if (!selected || selected.length === 0) return true;
  if (!hasValue(value)) return false;
  return selected.includes(value as string);
}

export function filterByFacets<
  T extends {
    hostname?: string;
    source: string;
    model?: string;
    project?: string;
  },
>(items: T[], facets: FacetFilters): T[] {
  return items.filter(
    (item) =>
      allowed(facets.hostnames, item.hostname) &&
      allowed(facets.sources, item.source) &&
      allowed(facets.models, item.model) &&
      allowed(facets.projects, item.project),
  );
}

export function filterSessionsByFacets<
  T extends {
    hostname?: string;
    source: string;
    model?: string;
    project?: string;
  },
>(items: T[], facets: FacetFilters): T[] {
  const { models: _models, ...rest } = facets;
  return filterByFacets(items, rest);
}

export function uniqueValues<T>(items: T[], key: keyof T): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const value = String(item[key] ?? '');
    if (value) seen.add(value);
  }
  return [...seen].sort();
}
