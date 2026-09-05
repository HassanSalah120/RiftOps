import { useState } from 'react';
import { GAMES } from '../types';

const GAME_IMGS: Record<string, string> = {
  'lol': '/games/lol.jpg',
  'valorant': '/games/valorant.jpg',
  'lor': '/games/lor.jpg',
  'lion': '/games/lion.jpg',
  'riot-client': '/games/riot-client.jpg',
};

export default function GameSelector({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (game: string) => void;
  disabled: boolean;
}) {
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({});

  return (
    <div className="grid grid-cols-2 gap-2.5">
      {GAMES.map((g, index) => {
        const selected = value === g.value;
        const img = GAME_IMGS[g.value];
        const imgFailed = imgErrors[g.value];
        const isFullWidth = g.value === 'riot-client' || (index === GAMES.length - 1 && GAMES.length % 2 !== 0);
        return (
          <button
            key={g.value}
            disabled={disabled}
            onClick={() => onChange(g.value)}
            className={`relative overflow-hidden rounded-2xl h-24 transition duration-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed group border ${
              isFullWidth ? 'col-span-2' : ''
            } ${
              selected
                ? 'border-[#c8aa6e] shadow-[0_0_25px_rgba(200,170,110,0.35)] scale-[1.02]'
                : 'border-white/[0.08] hover:border-white/20 hover:scale-[1.01]'
            }`}
          >
            {img && !imgFailed ? (
              <img
                src={img}
                alt=""
                width="640"
                height="360"
                className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                loading="lazy"
                onError={() => setImgErrors((prev) => ({ ...prev, [g.value]: true }))}
              />
            ) : (
              <div
                className="absolute inset-0"
                style={{ background: `linear-gradient(135deg, ${g.color}33, ${g.color}11)` }}
              />
            )}
            
            {/* Hextech Gradient Overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-base via-base/60 to-transparent" />
            {selected && <div className="absolute inset-0 bg-[#c8aa6e]/15 backdrop-blur-[1px]" />}

            <div className="relative h-full flex flex-col justify-end p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-white drop-shadow-md tracking-tight">{g.label}</span>
                {selected && (
                  <span className="w-2 h-2 rounded-full bg-[#c8aa6e] shadow-[0_0_8px_#c8aa6e]" />
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: g.color }} />
                <span className="text-[10px] text-text-muted font-semibold capitalize">{selected ? 'Active Game' : g.value}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
