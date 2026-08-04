import { useCallback, useEffect, useState } from 'react';
import { Activity, Check, CircleStop, ExternalLink, Loader2, Play, RefreshCw, Wand2 } from 'lucide-react';
import {
  fetchQoLState,
  launchLCULeague,
  lcuAutoAccept,
  lcuAutoRequeue,
  lcuPlayAgain,
  lcuStopQueue,
  type QoLState,
} from '../api';

type Toast = (message: string, type?: 'info' | 'success' | 'error') => void;

function phaseLabel(phase: string): string {
  if (!phase) return 'Unavailable';
  return phase.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export default function QuickActions({ onOpenQoL, showToast }: { onOpenQoL: () => void; showToast: Toast }) {
  const [state, setState] = useState<QoLState | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await fetchQoLState());
    } catch {
      setState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = async (key: string, success: string, fn: () => Promise<unknown>) => {
    setAction(key);
    try {
      await fn();
      showToast(success, 'success');
      await refresh();
    } catch (error: any) {
      showToast(error?.message || 'League rejected the action.', 'error');
    } finally {
      setAction('');
    }
  };

  const phase = state?.phase || 'Disconnected';
  const isLobby = phase === 'Lobby';
  const isQueue = phase === 'Matchmaking';
  const isReady = phase === 'ReadyCheck';
  const isEnd = phase === 'EndOfGame';

  return (
    <section className="quick-actions">
      <div className="quick-actions__header">
        <div className="quick-actions__title"><span className="quick-actions__icon"><Activity /></span><span><small>LEAGUE CLIENT</small><strong>Quick actions</strong></span></div>
        <div className="quick-actions__connection">
          <span className={`quick-actions__dot ${state ? 'is-online' : ''}`} />
          <span>{state ? phaseLabel(phase) : 'Not connected'}</span>
          <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh League status"><RefreshCw className={loading ? 'animate-spin' : ''} /></button>
        </div>
      </div>

      <div className="quick-actions__body">
        <div className="quick-actions__summary">
          <strong>{state ? phaseLabel(phase) : 'Launch League to unlock controls'}</strong>
          <span>{state?.queueState || 'RiftOps reconnects automatically when the client is ready.'}</span>
        </div>
        <div className="quick-actions__buttons">
          <button type="button" className="quick-action quick-action--primary" onClick={() => void run('launch', 'League launch requested.', launchLCULeague)} disabled={action !== ''}>
            {action === 'launch' ? <Loader2 className="animate-spin" /> : <ExternalLink />}<span>Launch League</span>
          </button>
          <button type="button" className="quick-action quick-action--success" onClick={() => void run('accept', 'Ready check accepted.', lcuAutoAccept)} disabled={!isReady || action !== ''}>
            {action === 'accept' ? <Loader2 className="animate-spin" /> : <Check />}<span>Accept</span>
          </button>
          <button type="button" className="quick-action" onClick={() => void run('queue-start', 'Matchmaking started.', lcuAutoRequeue)} disabled={!isLobby || action !== ''}>
            {action === 'queue-start' ? <Loader2 className="animate-spin" /> : <Play />}<span>Start queue</span>
          </button>
          <button type="button" className="quick-action" onClick={() => void run('queue-stop', 'Matchmaking stopped.', lcuStopQueue)} disabled={!isQueue || action !== ''}>
            {action === 'queue-stop' ? <Loader2 className="animate-spin" /> : <CircleStop />}<span>Stop queue</span>
          </button>
          <button type="button" className="quick-action" onClick={() => void run('play-again', 'Returning to lobby.', lcuPlayAgain)} disabled={!isEnd || action !== ''}>
            {action === 'play-again' ? <Loader2 className="animate-spin" /> : <Play />}<span>Play again</span>
          </button>
          <button type="button" className="quick-action quick-action--neutral" onClick={onOpenQoL}>
            <Wand2 /><span>All QoL</span>
          </button>
        </div>
      </div>
    </section>
  );
}
