import { useState, useEffect } from 'react';
import { fetchLuaScripts, saveLuaScript, deleteLuaScript, toggleLuaScript, runLuaScript, type LuaScript } from '../api';
import { Code, Play, Trash2, Plus, X, CheckCircle2, AlertCircle } from 'lucide-react';

const EVENT_LABELS: Record<string, string> = {
  'manual': 'Manual',
  'pre-launch': 'Before Launch',
  'post-launch': 'After Launch',
  'queue-pop': 'Queue Pop',
  'game-end': 'Game End',
  'tick': 'Every Tick',
};

export default function ScriptsManager() {
  const [scripts, setScripts] = useState<LuaScript[]>([]);
  const [editing, setEditing] = useState<LuaScript | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const load = async () => {
    try {
      const s = await fetchLuaScripts();
      setScripts(s);
    } catch { showToast('Failed to load scripts', false); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    if (!editing) return;
    try {
      await saveLuaScript(editing.name, code, editing.enabled);
      showToast('Script saved', true);
      setEditing(null);
      load();
    } catch { showToast('Failed to save script', false); }
  };

  const handleDelete = async (name: string) => {
    try {
      await deleteLuaScript(name);
      showToast('Script deleted', true);
      load();
    } catch { showToast('Failed to delete script', false); }
  };

  const handleToggle = async (name: string, enabled: boolean) => {
    try {
      await toggleLuaScript(name, enabled);
      setScripts((prev) => prev.map((s) => s.name === name ? { ...s, enabled } : s));
    } catch { showToast('Failed to toggle', false); }
  };

  const handleRun = async (name: string) => {
    try {
      await runLuaScript(name);
      showToast('Script executed', true);
    } catch { showToast('Script error', false); }
  };

  const newScript = () => {
    const name = `script-${Date.now()}`;
    const defaultCode = `-- RiftOps Lua Script\n-- Available API:\n-- riot.get_status() -> string\n-- riot.set_status(status)\n-- riot.get_game() -> string\n-- riot.set_masking(enabled)\n-- riot.is_masking() -> bool\n-- riot.log(message)\n\nfunction on_queue_pop()\n    riot.log("Queue pop detected!")\n    riot.auto_accept(true)\nend\n`;
    setEditing({ name, code: defaultCode, enabled: true, onEvent: 'queue-pop' });
    setCode(defaultCode);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Code className="w-4 h-4 text-primary" />
          <span className="text-sm text-text-muted font-semibold">Lua Scripts</span>
          <span className="text-xs text-text-dim bg-white/[0.04] px-2 py-0.5 rounded-lg">{scripts.length}</span>
        </div>
        <button
          onClick={newScript}
          className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-primary hover:bg-primary-hover text-white transition cursor-pointer"
        >
          <Plus className="w-3 h-3" />
          New Script
        </button>
      </div>

      <p className="text-xs text-text-dim leading-relaxed">
        Write Lua scripts that react to events like queue pops, game launches, and more.
      </p>

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="glass-card max-w-xl w-full p-4 my-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-white">{editing.name}</h4>
              <button onClick={() => setEditing(null)} className="p-1 rounded-lg hover:bg-white/[0.06] text-text-dim cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full h-64 font-mono text-[11px] p-3 rounded-xl bg-black/40 border border-white/[0.06] text-text outline-none resize-y"
              spellCheck={false}
            />
            <div className="flex items-center justify-between mt-3">
              <div className="flex items-center gap-2">
                <label className="toggle">
                  <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                  <span className="slider" />
                </label>
                <span className="text-xs text-text-muted">Auto-run</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setEditing(null)} className="px-3 py-1.5 rounded-xl text-xs font-medium text-text-muted hover:text-white bg-surface-hover transition cursor-pointer">
                  Cancel
                </button>
                <button onClick={handleSave} className="btn-primary px-3 py-1.5 text-xs">
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Script list */}
      {loading ? (
        <div className="space-y-1.5">
          {[1, 2].map((i) => (
            <div key={i} className="glass-card p-3 animate-pulse">
              <div className="h-4 w-32 rounded bg-white/[0.06] mb-2" />
              <div className="h-3 w-48 rounded bg-white/[0.04]" />
            </div>
          ))}
        </div>
      ) : scripts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-text-dim gap-2">
          <Code className="w-8 h-8 opacity-20" />
          <p className="text-sm">No scripts yet</p>
          <p className="text-xs text-text-dim/60">Create one to automate queue acceptance, status changes, and more</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {scripts.map((s) => (
            <div key={s.name} className="glass-card p-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <label className="toggle">
                    <input type="checkbox" checked={s.enabled} onChange={(e) => handleToggle(s.name, e.target.checked)} />
                    <span className="slider" />
                  </label>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white truncate">{s.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/[0.04] text-text-dim">
                        {EVENT_LABELS[s.onEvent] || s.onEvent}
                      </span>
                      <span className="text-[9px] text-text-dim/50">{s.code.length} chars</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => { setEditing(s); setCode(s.code); }}
                    className="p-1.5 rounded-lg hover:bg-white/[0.06] text-text-dim hover:text-white transition cursor-pointer"
                    title="Edit"
                  >
                    <Code className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleRun(s.name)}
                    className="p-1.5 rounded-lg hover:bg-white/[0.06] text-text-dim hover:text-primary transition cursor-pointer"
                    title="Run"
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(s.name)}
                    className="p-1.5 rounded-lg hover:bg-danger/10 text-text-dim hover:text-danger transition cursor-pointer"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-xl glass shadow-2xl animate-[fadeIn_0.2s_ease-out]">
          {toast.ok ? <CheckCircle2 className="w-4 h-4 text-success" /> : <AlertCircle className="w-4 h-4 text-danger" />}
          <span className="text-xs font-medium text-white">{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
