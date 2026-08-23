import { RadioTower, ShieldCheck, Smartphone, Wifi } from 'lucide-react';
import { StatusBadge, WorkspaceSection } from './DesignPrimitives';
import PageHeader from './PageHeader';
import RemoteAccessCard from './RemoteAccessCard';

export default function RemoteAccessPage({ showToast }: { showToast: (message: string, type?: 'info' | 'success' | 'error') => void }) {
  return (
    <div className="remote-page">
      <PageHeader variant="workspace" icon={RadioTower} eyebrow="PHONE CONTROL" title="Remote access" description="Pair, inspect, and revoke phone sessions from one controlled workspace." meta={<StatusBadge tone="gold" icon={ShieldCheck}>Desktop administration</StatusBadge>} />
      <div className="remote-page__layout">
        <WorkspaceSection eyebrow="PAIRING FLOW" title="Desktop to phone, directly" description="RiftOps keeps League access on this computer. Your phone sends actions over the same private Wi-Fi.">
          <ol className="remote-page__steps">
            <li><span>01</span><Wifi /><div><strong>Enable the listener</strong><small>Phone control remains off until you turn it on.</small></div></li>
            <li><span>02</span><Smartphone /><div><strong>Scan once</strong><small>The QR expires and becomes invalid after one successful pairing.</small></div></li>
            <li><span>03</span><ShieldCheck /><div><strong>Manage the session here</strong><small>Connected devices and revoke controls remain together.</small></div></li>
          </ol>
          <div className="remote-page__boundary"><ShieldCheck /><span><strong>Private network only</strong><small>LAN traffic uses HTTP. Never expose the RiftOps phone port to the internet or a public Wi-Fi network.</small></span></div>
        </WorkspaceSection>
        <RemoteAccessCard showToast={showToast} />
      </div>
    </div>
  );
}
