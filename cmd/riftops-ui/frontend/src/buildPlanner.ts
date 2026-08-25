export type BuildItem = { id: number; name: string; description?: string; iconPath?: string };
export type BuildPlan = { championId: number; role: string; itemIds: number[]; updatedAt: string };

export function normalizeBuildItems(raw: unknown): BuildItem[] {
  const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>) : [];
  return values.map((entry: any) => ({
    id: Number(entry?.id || entry?.itemId || 0),
    name: String(entry?.name || entry?.displayName || '').trim(),
    description: typeof entry?.description === 'string' ? entry.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : undefined,
    iconPath: entry?.iconPath || entry?.image?.full,
  })).filter((item) => item.id > 0 && item.name).sort((a, b) => a.name.localeCompare(b.name));
}
