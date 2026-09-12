export const MAX_TAG_LEN = 40;
export const MAX_TAGS_PER_JOB = 24;

export function normalizeTagName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return null;
  if ([...name].length > MAX_TAG_LEN) return null;
  return name;
}

export function jobTags(tags: string[] | undefined | null): string[] {
  return tags ?? [];
}

export function tagKey(name: string): string {
  return name.toLowerCase();
}

export function jobHasTag(tags: string[], name: string): boolean {
  const key = tagKey(name);
  return tags.some((t) => tagKey(t) === key);
}

export function addTag(tags: string[], catalog: string[], raw: string): string[] | null {
  const name = normalizeTagName(raw);
  if (!name) return null;
  if (jobHasTag(tags, name)) return tags;
  if (tags.length >= MAX_TAGS_PER_JOB) return null;
  const existing = catalog.find((t) => tagKey(t) === tagKey(name));
  return [...tags, existing ?? name];
}

export function removeTag(tags: string[], name: string): string[] {
  const key = tagKey(name);
  return tags.filter((t) => tagKey(t) !== key);
}

export function suggestTags(catalog: string[], assigned: string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  const taken = new Set(assigned.map(tagKey));
  return catalog.filter((t) => !taken.has(tagKey(t))).filter((t) => !q || t.toLowerCase().includes(q)).slice(0, limit);
}

export function createLabel(catalog: string[], assigned: string[], query: string): string | null {
  const name = normalizeTagName(query);
  if (!name || jobHasTag(assigned, name)) return null;
  if (catalog.some((t) => tagKey(t) === tagKey(name))) return null;
  return name;
}

/** Enter commits typed text unless the user arrowed to a suggestion. */
export function tagToCommit(query: string, highlighted: string | undefined, usedList: boolean): string | null {
  if (usedList && highlighted) {
    return highlighted.startsWith("__create:") ? highlighted.slice(9) : highlighted;
  }
  return normalizeTagName(query);
}

export function mergeCatalog(catalog: { name: string }[], jobs: { tags?: string[] }[]): string[] {
  const map = new Map<string, string>();
  for (const t of catalog) {
    const name = normalizeTagName(t.name);
    if (name && !map.has(tagKey(name))) map.set(tagKey(name), name);
  }
  for (const job of jobs) {
    for (const t of jobTags(job.tags)) {
      if (!map.has(tagKey(t))) map.set(tagKey(t), t);
    }
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function jobMatchesTagFilter(tags: string[] | undefined, selected: string[]): boolean {
  if (!selected.length) return true;
  const keys = new Set(jobTags(tags).map(tagKey));
  return selected.some((t) => keys.has(tagKey(t)));
}

export function tagCounts(jobs: { tags?: string[] }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    const seen = new Set<string>();
    for (const t of jobTags(job.tags)) {
      const key = tagKey(t);
      if (seen.has(key)) continue;
      seen.add(key);
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

export function bumpTagCounts(
  counts: { name: string; count: number }[],
  before: string[] | undefined,
  after: string[],
): { name: string; count: number }[] {
  const map = new Map<string, { name: string; count: number }>();
  for (const t of counts) map.set(tagKey(t.name), { name: t.name, count: t.count });
  const beforeKeys = new Set(jobTags(before).map(tagKey));
  const afterList = jobTags(after);
  const afterKeys = new Set(afterList.map(tagKey));
  for (const name of afterList) {
    const key = tagKey(name);
    if (beforeKeys.has(key)) continue;
    const cur = map.get(key);
    map.set(key, { name: cur?.name ?? name, count: (cur?.count ?? 0) + 1 });
  }
  for (const name of jobTags(before)) {
    const key = tagKey(name);
    if (afterKeys.has(key)) continue;
    const cur = map.get(key);
    if (!cur) continue;
    if (cur.count <= 1) map.delete(key);
    else map.set(key, { ...cur, count: cur.count - 1 });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
