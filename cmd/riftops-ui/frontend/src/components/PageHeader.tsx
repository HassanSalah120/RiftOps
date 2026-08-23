import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type PageHeaderProps = {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  variant?: 'workspace' | 'status' | 'collection' | 'data';
  meta?: ReactNode;
  actions?: ReactNode;
};

/** Shared page framing for non-live workspaces. The live dashboard and QoL
 * deck keep their bespoke hero treatment, while catalogue pages use this
 * compact field-brief header so navigation feels like one product. */
export default function PageHeader({ icon: Icon, eyebrow, title, description, variant = 'workspace', meta, actions }: PageHeaderProps) {
  return (
    <header className={`page-header page-header--${variant}`}>
      <span className="page-header__riftline" aria-hidden="true" />
      <div className="page-header__identity">
        <span className="page-header__icon"><Icon /></span>
        <div className="page-header__copy">
          <span className="page-header__eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      {(meta || actions) && (
        <div className="page-header__tools">
          {meta && <div className="page-header__meta">{meta}</div>}
          {actions && <div className="page-header__actions">{actions}</div>}
        </div>
      )}
    </header>
  );
}
