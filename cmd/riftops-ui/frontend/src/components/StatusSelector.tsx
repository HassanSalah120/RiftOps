import { Eye, EyeOff, Smartphone } from 'lucide-react';

const STATUSES = [
  { key: 'online', label: 'Online', icon: Eye, color: '#10b981' },
  { key: 'offline', label: 'Offline', icon: EyeOff, color: '#9ca3af' },
  { key: 'mobile', label: 'Mobile', icon: Smartphone, color: '#06b6d4' },
];

export default function StatusSelector({
  current,
  onChange,
  disabled = false,
  offlineUnavailable = false,
}: {
  current: string;
  onChange: (status: string) => void;
  disabled?: boolean;
  offlineUnavailable?: boolean;
}) {
  return (
    <div className="presence-picker" role="group" aria-label="Chat availability">
      {STATUSES.map((s) => {
        const active = current.toLowerCase() === s.key;
        const Icon = s.icon;
        return (
          <button
            type="button"
            aria-pressed={active}
            key={s.key}
            disabled={disabled || (offlineUnavailable && s.key === 'offline')}
            title={offlineUnavailable && s.key === 'offline' ? 'Offline requires the secure chat proxy. Close Riot and relaunch using the published Windows release.' : undefined}
            onClick={() => onChange(s.key)}
            className={`relative flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold transition duration-200 cursor-pointer border disabled:opacity-40 disabled:cursor-not-allowed ${
              active
                ? 'text-white border-primary/40 shadow-lg'
                : 'text-text-dim border-white/[0.06] hover:text-white hover:bg-white/[0.04]'
            }`}
            style={{
              background: active ? `${s.color}1e` : 'rgba(18, 18, 30, 0.5)',
              borderColor: active ? s.color : undefined,
              boxShadow: 'none',
            }}
          >
            <Icon className="w-3.5 h-3.5" style={{ color: active ? s.color : undefined }} />
            <span style={{ color: active ? s.color : undefined }}>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
