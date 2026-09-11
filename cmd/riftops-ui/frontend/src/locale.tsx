import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { LocaleContext } from './localeContext';

export type Locale = 'en' | 'ar';
type Messages = Record<string, string>;

const messages: Record<Locale, Messages> = {
  en: {
    'nav.command': 'Home', 'nav.play': 'Play & Draft', 'nav.live': 'Live Game', 'nav.social': 'Friends',
    'nav.history': 'Match History', 'nav.skins': 'Skins & Splash', 'nav.loot': 'Hextech Loot', 'nav.qol': 'Automations',
    'nav.remote': 'Phone Companion', 'nav.settings': 'Settings', 'nav.socialHint': 'Friends and invitations',
    'social.title': 'Social Center', 'social.description': 'Friends, requests, and lobby invitations from the local League Client.',
    'social.search': 'Search friends or Riot ID…', 'social.all': 'All', 'social.online': 'Online', 'social.favorites': 'Favorites',
    'social.invite': 'Invite selected', 'social.remove': 'Remove selected', 'social.requests': 'Friend requests',
    'social.accept': 'Accept', 'social.decline': 'Decline', 'social.empty': 'No friends match this view.', 'social.offline': 'League is offline',
    'settings.language': 'App language', 'settings.languageHelp': 'Choose English or Arabic. The layout mirrors automatically for Arabic.',
  },
  ar: {
    'nav.command': 'الرئيسية', 'nav.play': 'الردهة والاختيار', 'nav.live': 'اللعبة المباشرة', 'nav.social': 'الأصدقاء',
    'nav.history': 'سجل المباريات', 'nav.skins': 'المظاهر والملف', 'nav.loot': 'غنائم هيكستيك', 'nav.qol': 'الأتمتة والأدوات',
    'nav.remote': 'مرافق الهاتف', 'nav.settings': 'الإعدادات', 'nav.socialHint': 'الأصدقاء والدعوات',
    'social.title': 'مركز الأصدقاء', 'social.description': 'الأصدقاء والطلبات ودعوات الردهة من عميل League المحلي.',
    'social.search': 'ابحث عن صديق أو Riot ID…', 'social.all': 'الكل', 'social.online': 'متصل', 'social.favorites': 'المفضلة',
    'social.invite': 'دعوة المحددين', 'social.remove': 'إزالة المحددين', 'social.requests': 'طلبات الصداقة',
    'social.accept': 'قبول', 'social.decline': 'رفض', 'social.empty': 'لا يوجد أصدقاء يطابقون هذا العرض.', 'social.offline': 'League غير متصل',
    'settings.language': 'لغة التطبيق', 'settings.languageHelp': 'اختر العربية أو الإنجليزية. سينعكس اتجاه الواجهة تلقائياً للعربية.',
  },
};

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem('riftops.locale');
    if (saved === 'ar' || saved === 'en') return saved;
  } catch { /* localStorage is optional */ }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const setLocale = (next: Locale) => {
    setLocaleState(next);
    try { localStorage.setItem('riftops.locale', next); } catch { /* localStorage is optional */ }
  };
  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = locale === 'ar' ? 'rtl' : 'ltr';
    root.dataset.locale = locale;
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t: (key: string) => messages[locale][key] || messages.en[key] || key }), [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
