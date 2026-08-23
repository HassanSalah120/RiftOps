import { Images, UserRound } from 'lucide-react';
import { useState } from 'react';
import { WorkspaceSwitcher } from './DesignPrimitives';
import ProfileStudio from './ProfileStudio';
import SkinShowcase from './SkinShowcase';

type CollectionView = 'library' | 'profile';

const OPTIONS = [
  { value: 'library' as const, label: 'Skin library', description: 'Owned, missing, shards & wishlist', icon: Images },
  { value: 'profile' as const, label: 'Profile studio', description: 'Background & profile icon', icon: UserRound },
];

export default function CollectionWorkspace({ remoteClient = false }: { remoteClient?: boolean }) {
  const [view, setView] = useState<CollectionView>('library');
  return (
    <div className="collection-workspace">
      {!remoteClient && <WorkspaceSwitcher value={view} options={OPTIONS} onChange={setView} label="Collection workspaces" />}
      <div className="collection-workspace__body">{remoteClient || view === 'library' ? <SkinShowcase remoteReadOnly={remoteClient} /> : <ProfileStudio />}</div>
    </div>
  );
}
