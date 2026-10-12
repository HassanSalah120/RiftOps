export interface CollectionSkin {
  id: number;
  championId: number;
  championName: string;
  owned: boolean;
  shard: boolean;
  rental?: boolean;
  unavailable?: boolean;
}

// Only call after a successful account inventory read. The public catalogue
// supplies missing skins and denominators, never account ownership.
export function completeSkinInventory(
  inventory: Array<{ id: number; [key: string]: unknown }>,
  catalogue: Array<{ id: number; championId: number; assetChampionId?: number }>,
) {
  const ids = new Set(inventory.map((skin) => Number(skin.id)));
  return [...inventory, ...catalogue.filter((skin) => !ids.has(skin.id)).map((skin) => ({
    ...skin, championId: skin.assetChampionId || skin.championId, owned: false, ownership: { owned: false },
  }))];
}

export function uniqueCollectionSkins<T extends CollectionSkin>(skins: T[]): T[] {
  const unique = new Map<number, T>();
  for (const skin of skins) {
    const previous = unique.get(skin.id);
    const owned = skin.owned || Boolean(previous?.owned);
    const rental = !owned && Boolean(skin.rental || previous?.rental);
    unique.set(skin.id, { ...previous, ...skin, owned, rental, shard: !owned && Boolean(skin.shard || previous?.shard) });
  }
  return [...unique.values()];
}

export function skinShardIds(loot: unknown): Set<number> {
  const ids = new Set<number>();
  if (!Array.isArray(loot)) return ids;
  for (const item of loot) {
    const match = /^CHAMPION_SKIN_(?:RENTAL_)?(\d+)$/.exec(String(item?.lootId ?? ''));
    if (match && Number(item.count) > 0) ids.add(Number(match[1]));
  }
  return ids;
}

export function buildChampionTotals(skins: CollectionSkin[]) {
  const totals = new Map<number, { id: number; name: string; total: number; owned: number; shards: number; rentals: number; unavailable: number }>();
  for (const skin of uniqueCollectionSkins(skins)) {
    const champion = totals.get(skin.championId) ?? { id: skin.championId, name: skin.championName, total: 0, owned: 0, shards: 0, rentals: 0, unavailable: 0 };
    champion.total++;
    if (skin.owned) champion.owned++;
    else if (skin.shard) champion.shards++;
    if (skin.rental) champion.rentals++;
    if (skin.unavailable) champion.unavailable++;
    totals.set(skin.championId, champion);
  }
  return [...totals.values()];
}
