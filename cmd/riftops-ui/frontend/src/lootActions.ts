export function recipeActionLabel(recipe: any): string {
  const value = `${recipe?.type || ''} ${recipe?.recipeName || ''} ${recipe?.name || ''}`.toLowerCase();
  if (value.includes('reroll') || value.includes('re-roll')) return 'Reroll';
  if (value.includes('disenchant')) return 'Disenchant';
  if (value.includes('open') || value.includes('unlock')) return 'Open';
  if (value.includes('upgrade')) return 'Upgrade';
  return 'Craft';
}
