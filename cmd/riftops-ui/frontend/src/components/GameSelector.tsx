import { Check } from 'lucide-react';
import { GAMES } from '../types';

export default function GameSelector({ value, onChange, disabled }: { value: string; onChange: (game: string) => void; disabled: boolean }) {
  return <div className="game-picker" role="group" aria-label="Launch game">{GAMES.map((game) => <button type="button" key={game.value} disabled={disabled} aria-pressed={value === game.value} onClick={() => onChange(game.value)}><span className="game-picker__dot" style={{ backgroundColor: game.color }} aria-hidden="true" /><span>{game.label}</span>{value === game.value && <Check aria-hidden="true" />}</button>)}</div>;
}
