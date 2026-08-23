import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

export type StatusTone = 'neutral' | 'live' | 'warning' | 'danger' | 'gold' | 'violet';

export function StatusBadge({
  tone = 'neutral',
  icon: Icon,
  children,
  pulse = false,
}: {
  tone?: StatusTone;
  icon?: LucideIcon;
  children: ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className={`ro-status ro-status--${tone}`}>
      {Icon ? <Icon aria-hidden="true" /> : <i className={pulse ? 'is-pulsing' : ''} aria-hidden="true" />}
      <span>{children}</span>
    </span>
  );
}

export type FeedbackState = { tone: 'working' | 'success' | 'error' | 'info'; message: string } | null;

export function ActionFeedback({ state, className = '' }: { state: FeedbackState; className?: string }) {
  if (!state) return null;
  const Icon = state.tone === 'working' ? Loader2 : state.tone === 'success' ? CheckCircle2 : state.tone === 'error' ? AlertCircle : null;
  return (
    <div className={`ro-feedback ro-feedback--${state.tone} ${className}`} role="status" aria-live="polite">
      {Icon ? <Icon className={state.tone === 'working' ? 'animate-spin' : ''} aria-hidden="true" /> : <i aria-hidden="true" />}
      <span>{state.message}</span>
    </div>
  );
}

export function WorkspaceSection({
  eyebrow,
  title,
  description,
  actions,
  children,
  className = '',
  id,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`ro-section ${className}`}>
      <header className="ro-section__header">
        <div>
          <span>{eyebrow}</span>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="ro-section__actions">{actions}</div>}
      </header>
      <div className="ro-section__body">{children}</div>
    </section>
  );
}

export function ContextPanel({
  eyebrow,
  title,
  description,
  children,
  footer,
  className = '',
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <aside className={`ro-inspector ${className}`}>
      <header>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div className="ro-inspector__body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </aside>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = 'neutral',
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  tone?: 'neutral' | 'error';
}) {
  return (
    <div className={`ro-empty ro-empty--${tone}`}>
      <span><Icon aria-hidden="true" /></span>
      <div><strong>{title}</strong><p>{description}</p></div>
      {action && <div className="ro-empty__action">{action}</div>}
    </div>
  );
}

export function WorkspaceSwitcher<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; description: string; icon: LucideIcon }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <nav className="ro-workspace-switcher" aria-label={label}>
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button type="button" key={option.value} className={active ? 'is-active' : ''} onClick={() => onChange(option.value)} aria-current={active ? 'page' : undefined}>
            <Icon aria-hidden="true" />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </button>
        );
      })}
    </nav>
  );
}
