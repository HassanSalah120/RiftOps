import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Eye, RefreshCw, Shield, Swords, Users, WifiOff } from 'lucide-react';
import { fetchLCUChampSelect } from '../api';
import { useLCUConnection } from './lcuConnectionContext';

type TeamMember = { cellId?: number; championId?: number; championName?: string; summonerId?: string; summonerName?: string; selectedSkinIndex?: number };
type SelectAction = { actorCellId?: number; championId?: number; completed?: boolean; isAllyAction?: boolean; type?: string; pickTurn?: number };
type Session = { timer?: { phase?: string; timeLeft?: number }; myTeam?: TeamMember[]; theirTeam?: TeamMember[]; actions?: SelectAction[][]; localPlayerCellId?: number; };

function championLabel(member: TeamMember): string {
  if (member.championName) return member.championName;
  if (member.championId && member.championId > 0) return `Champion ${member.championId}`;
  return 'Unassigned';
}

function flattenActions(actions: SelectAction[][] | undefined): SelectAction[] {
  return (actions || []).flatMap((group) => group || []);
}

export default function ChampSelectWorkspace({ connected, active }: { connected: boolean; active: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const loadedOnce = useRef(false);
  const { pageVisible, realtimeInterval } = useLCUConnection();

  const refresh = useCallback(async () => {
    if (!connected || !active || !pageVisible) return;
    if (!loadedOnce.current) setLoading(true);
    try {
      setSession((await fetchLCUChampSelect()) as Session);
      setError('');
    } catch (reason: any) {
      setSession(null);
      setError(reason?.message || 'Champion Select session is unavailable.');
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [active, connected, pageVisible]);

  useEffect(() => {
    void refresh();
    if (!active || !pageVisible) return undefined;
    const timer = window.setInterval(() => void refresh(), realtimeInterval);
    return () => window.clearInterval(timer);
  }, [active, pageVisible, realtimeInterval, refresh]);

  const actions = useMemo(() => flattenActions(session?.actions), [session?.actions]);
  const pending = actions.find((action) => !action.completed && action.actorCellId === session?.localPlayerCellId);
  const phase = session?.timer?.phase || (active ? 'Champion Select' : 'Waiting');
  const seconds = Math.max(0, Math.floor((session?.timer?.timeLeft || 0) / 1000));

  return (
    <section className="champ-select-workspace">
      <div className="champ-select-workspace__header">
        <div className="champ-select-workspace__title"><span className="champ-select-workspace__icon"><Swords /></span><span><small>LIVE CLIENT VIEW</small><strong>Champion Select</strong></span></div>
        <div className="champ-select-workspace__status"><span className={`champ-select-workspace__dot ${active && session ? 'is-online' : ''}`} />{active && session ? phase : 'Waiting for champion select'}<button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh champion select"><RefreshCw className={loading ? 'animate-spin' : ''} /></button></div>
      </div>

      {!connected && <div className="champ-select-workspace__empty"><WifiOff /><span>Connect to League Client to see picks, bans, and timers.</span></div>}
      {connected && !active && <div className="champ-select-workspace__empty"><Eye /><span>This workspace becomes live when League enters Champion Select.</span></div>}
      {connected && active && !session && <div className="champ-select-workspace__empty"><Clock3 /><span>{error || 'Waiting for the Champion Select session…'}</span></div>}

      {session && (
        <>
          <div className="champ-select-workspace__timer"><span>{pending ? 'Your action' : phase}</span><strong>{seconds > 0 ? `${seconds}s` : '—'}</strong><small>{pending?.type ? pending.type.replaceAll('_', ' ') : 'Live session'}</small></div>
          <div className="champ-select-workspace__teams">
            <div><h4><Users /> Your team</h4>{(session.myTeam || []).map((member, index) => <div className="champ-select-workspace__member" key={member.cellId || member.summonerId || index}><span className="champ-select-workspace__avatar">{member.championId ? '◆' : '·'}</span><span>{member.summonerName || `Player ${index + 1}`}</span><small>{championLabel(member)}</small></div>)}</div>
            <div><h4><Shield /> Opponents</h4>{(session.theirTeam || []).map((member, index) => <div className="champ-select-workspace__member" key={member.cellId || member.summonerId || index}><span className="champ-select-workspace__avatar champ-select-workspace__avatar--enemy">{member.championId ? '◆' : '·'}</span><span>{member.summonerName || `Opponent ${index + 1}`}</span><small>{championLabel(member)}</small></div>)}</div>
          </div>
        </>
      )}
    </section>
  );
}
