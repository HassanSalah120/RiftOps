import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';

export type RiotAssetRecord = {
  id: number;
  name?: string;
  iconPath?: string;
  splashPath?: string;
  previewAssetPath?: string;
};

// Riot's LCU catalogues return paths in several equivalent shapes. Keep the
// mapping in one place and only accept paths that remain inside the local
// lol-game-data proxy. This avoids guessed CDN filenames and broken assets.
function riotAssetURL(rawPath?: string | null): string {
  const value = String(rawPath || '').trim().replaceAll('\\', '/');
  if (!value || value.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
  if (value.startsWith('/lol-game-data/')) return value;
  if (value.startsWith('lol-game-data/')) return `/${value}`;

  const path = value.replace(/^\/+/, '');
  if (/^(?:ASSETS|DATA)\//i.test(path)) return `/lol-game-data/assets/${path}`;
  if (/^assets\//i.test(path)) return `/lol-game-data/assets/${path.slice('assets/'.length)}`;
  if (/^v1\//i.test(path)) return `/lol-game-data/assets/${path}`;
  return `/lol-game-data/assets/v1/${path}`;
}

type RiotAssetImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  path?: string | null;
  fallback?: ReactNode;
};

export function RiotAssetImage({ path, fallback = null, onError, ...props }: RiotAssetImageProps) {
  const [failed, setFailed] = useState(false);
  const source = riotAssetURL(path);
  useEffect(() => setFailed(false), [source]);
  if (!source || failed) return <>{fallback}</>;
  return (
    <img
      {...props}
      src={source}
      onError={(event) => {
        setFailed(true);
        onError?.(event);
      }}
    />
  );
}
