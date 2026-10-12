import { useState } from 'react';
import { Check, UserRound } from 'lucide-react';

export default function ChampionCollectionPortrait({ champion, selected, onSelect, shardsKnown }: {
  champion: { id: number; name: string; total: number; owned: number; shards: number };
  selected: boolean;
  onSelect: () => void;
  shardsKnown: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const complete = champion.total > 0 && champion.owned === champion.total;
  const ownedPercent = champion.total ? champion.owned / champion.total * 100 : 0;
  const shardPercent = champion.total ? champion.shards / champion.total * 100 : 0;
  return (
    <button type="button" id={`collection-champion-${champion.id}`} className={`collection-champion ${complete ? 'is-complete' : ''} ${selected ? 'is-selected' : ''} ${champion.owned + champion.shards === 0 ? 'is-empty' : ''}`}
      onClick={onSelect} aria-expanded={selected} aria-controls="collection-champion-skins"
      aria-label={`${champion.name}: ${champion.owned} of ${champion.total} skins owned, ${shardsKnown ? `${champion.shards} shard-only skins` : 'shard inventory unavailable'}${complete ? ', complete collection' : ''}. Show skins`}>
      <span className="collection-champion__portrait">
        {imageFailed ? <UserRound aria-hidden="true" /> : <img src={`/lol-game-data/assets/v1/champion-icons/${champion.id}.png`} alt="" width="104" height="104" loading="lazy" onError={() => setImageFailed(true)} />}
        <svg className="collection-champion__ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="collection-ring__track" cx="60" cy="60" r="56" />
          {ownedPercent > 0 && <circle className="collection-ring__owned" cx="60" cy="60" r="56" pathLength="100" strokeDasharray={`${ownedPercent} ${100 - ownedPercent}`} />}
          {shardPercent > 0 && <circle className="collection-ring__shards" cx="60" cy="60" r="56" pathLength="100" strokeDasharray={`${shardPercent} ${100 - shardPercent}`} strokeDashoffset={-ownedPercent} />}
        </svg>
        {complete && <span className="collection-champion__complete"><Check aria-hidden="true" /></span>}
      </span>
      <strong>{champion.name}</strong>
      <span className="collection-champion__count"><b>{champion.owned} / {champion.total}</b> skins</span>
      <span className="collection-champion__shards">{champion.shards > 0 ? `${champion.shards} shard${champion.shards === 1 ? '' : 's'} to unlock` : complete ? 'Complete collection' : '\u00a0'}</span>
    </button>
  );
}
