import { useState } from 'react';
import { Search, Copy, Trash2, Terminal, Check } from 'lucide-react';
import type { LogLine } from '../types';

export default function LogViewer({ logs, onClear: _onClear }: { logs: LogLine[]; onClear?: () => void }) {
  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);

  const filtered = logs.filter((l) => {
    const lvl = filter === 'all' || l.level === filter;
    const s = l.message.toLowerCase().includes(search.toLowerCase());
    return lvl && s;
  });

  const handleCopy = () => {
    if (filtered.length === 0) return;
    const text = filtered.map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const totalByLevel = (level: string) =>
    level === 'all' ? logs.length : logs.filter((l) => l.level === level).length;

  return (
    <div className="glass-card p-3.5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <span className="text-xs text-text-muted font-bold tracking-tight">Engine Console</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.04] text-text-dim font-bold">{filtered.length} lines</span>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-xl hover:bg-white/[0.06] text-text-dim hover:text-white transition cursor-pointer flex items-center gap-1 text-[11px] font-semibold"
            title="Copy logs to clipboard"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={_onClear}
            className="p-1.5 rounded-xl hover:bg-danger/10 text-text-dim hover:text-danger transition cursor-pointer"
            title="Clear logs"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-dim" />
          <input
            type="text" placeholder="Filter console output..." value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl"
          />
        </div>
        <div className="flex gap-1 shrink-0">
          {(['all', 'info', 'warn', 'error'] as const).map((lvl) => (
            <button
              key={lvl}
              onClick={() => setFilter(lvl)}
              className={`px-2.5 py-1 rounded-xl text-[10px] font-bold transition cursor-pointer flex items-center gap-1 border ${
                filter === lvl
                  ? 'bg-primary/20 text-primary border-primary/30 shadow-[0_0_10px_rgba(168,85,247,0.2)]'
                  : 'text-text-dim border-transparent hover:text-white hover:bg-white/[0.04]'
              }`}
              aria-pressed={filter === lvl}
            >
              {lvl === 'error' ? 'err' : lvl}
              <span className="text-[9px] opacity-60">({totalByLevel(lvl)})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="bg-[#040408] border border-white/[0.06] rounded-xl p-3 font-mono text-[11px] leading-relaxed overflow-y-auto max-h-[160px] select-text space-y-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-text-dim gap-2">
            <Terminal className="w-6 h-6 opacity-20" />
            <span className="text-xs italic">
              {logs.length === 0 ? 'Engine output stream idle' : 'No logs match filter'}
            </span>
          </div>
        ) : (
          filtered.map((l, i) => (
            <div key={i} className="flex gap-2 hover:bg-white/[0.02] rounded px-1 -mx-1 py-0.5">
              <span className="text-text-dim/40 shrink-0 select-none text-[10px]">{l.timestamp}</span>
              <span className={`shrink-0 font-bold text-[10px] ${
                l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warning' : 'text-primary'
              }`}>
                [{l.level.toUpperCase()}]
              </span>
              <span className="text-text/90 break-all select-all font-medium">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
