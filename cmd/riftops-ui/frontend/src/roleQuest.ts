/**
 * Static metadata for Summoner's Rift Role Quests, updated through League
 * patch 26.16 (August 2026).
 *
 * Quest progress and rewards are owned by the League game client. The LCU does
 * not expose a supported role-quest endpoint, so this module deliberately
 * contains no guessed requests or client-side progress mutations. It only
 * describes the current rules and the one safe champ-select preparation that
 * RiftOps can offer: an explicit Flash + Teleport loadout for Top.
 */

export type RoleQuestPlan = {
  role: string;
  label: string;
  questName: string;
  progress: string;
  reward: string;
  details: string;
  assistant: string;
  recommendedSpells?: {
    spell1Id: number;
    spell2Id: number;
    spell1Name: string;
    spell2Name: string;
  };
};

const ROLE_QUEST_PLANS: Record<string, RoleQuestPlan> = {
  TOP: {
    role: 'TOP',
    label: 'Top',
    questName: 'Top lane role quest',
    progress: '1,200 points',
    reward: 'Enhanced Teleport reward',
    details: 'Completing the quest raises the level cap to 20, grants +600 XP, +80 flat XP on champion takedowns and +11% XP from other sources. With Teleport selected, arrivals grant a 35% max-health shield for 10 seconds; without it, League grants Unleashed Teleport on a 7-minute cooldown.',
    assistant: 'RiftOps can prepare Flash + Teleport during Champion Select. League owns quest progress and applies the reward in-game.',
    recommendedSpells: {
      spell1Id: 4,
      spell2Id: 12,
      spell1Name: 'Flash',
      spell2Name: 'Teleport',
    },
  },
  MIDDLE: {
    role: 'MIDDLE',
    label: 'Mid',
    questName: 'Mid lane role quest',
    progress: '1,350 points',
    reward: 'Tier 3 boots + 8% bonus AD/AP',
    details: 'The quest upgrades Tier 2 boots and grants 8% bonus attack damage and ability power, giving Mid a scaling reward instead of an empowered Recall.',
    assistant: 'Keep your preferred summoner spells. League applies the boot upgrade and bonus stats after completion.',
  },
  BOTTOM: {
    role: 'BOTTOM',
    label: 'Bot',
    questName: 'Bot lane role quest',
    progress: '1,350 points',
    reward: 'Role Quest slot (a practical 7th item slot)',
    details: 'Completion grants +300 gold, +2 gold per minion for the rest of the game and +40 gold per champion takedown. Boots move into the Role Quest slot, effectively opening a 7th item slot.',
    assistant: 'The extra slot is created by League in-game. RiftOps can show the rule, but cannot safely move items or change quest progress through LCU.',
  },
  JUNGLE: {
    role: 'JUNGLE',
    label: 'Jungle',
    questName: 'Jungle pet quest',
    progress: '35 pet counters',
    reward: 'Jungle movement speed + large-monster gold and XP',
    details: 'After completion, jungle or river movement speed increases by 4% (8% out of combat), and large monsters grant +10 gold and +10 XP.',
    assistant: 'League tracks the pet quest and applies these rewards automatically; no Champion Select mutation is required.',
  },
  UTILITY: {
    role: 'UTILITY',
    label: 'Support',
    questName: 'Support World Atlas quest',
    progress: 'World Atlas progress',
    reward: 'Two Control Wards in the Role Quest slot',
    details: 'Support Control Wards start in the Role Quest slot on Summoner\'s Rift; after the quest, they cost 40 gold and up to two can be stored there instead of in your item inventory.',
    assistant: 'League tracks World Atlas progress and owns the ward slot. RiftOps does not pretend to edit it through an undocumented endpoint.',
  },
};

export function roleQuestPlan(role: string | null | undefined): RoleQuestPlan | null {
  return ROLE_QUEST_PLANS[String(role || '').toUpperCase()] || null;
}

export function recommendedRoleQuestSpells(role: string | null | undefined): RoleQuestPlan['recommendedSpells'] | null {
  return roleQuestPlan(role)?.recommendedSpells || null;
}

export function roleQuestPlans(): RoleQuestPlan[] {
  return Object.values(ROLE_QUEST_PLANS);
}
