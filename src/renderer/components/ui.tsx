/**
 * The design system, expressed as React components.
 *
 * Every component here maps onto the token-driven classes in
 * `styles/app.css` — the same tokens drive light/dark theme and the three
 * density modes, so screens never hard-code colours or spacing.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, Check, ChevronDown, Info, Loader2, Search, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'default' | 'primary' | 'navy' | 'danger' | 'ghost' | 'link';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly block?: boolean;
  readonly loading?: boolean;
  readonly icon?: ReactNode;
}

export function Button({
  variant = 'default',
  size = 'md',
  block = false,
  loading = false,
  icon,
  children,
  className = '',
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : size === 'lg' ? 'btn--lg' : '',
    block ? 'btn--block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 size={16} className="spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  active = false,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'icon-btn--active' : ''} ${className}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  required = false,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <label className={`field ${className}`}>
      <span className="field__label">
        {label}
        {required ? <span aria-hidden className="text-danger"> *</span> : null}
      </span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
  readonly numeric?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
}

export function Input({ invalid = false, numeric = false, className = '', ...rest }: InputProps): JSX.Element {
  return (
    <input
      className={`input ${numeric ? 'input--numeric' : ''} ${className}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function TextArea({ className = '', rows = 3, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className={`textarea ${className}`} rows={rows} {...rest} />;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly options: ReadonlyArray<{ value: string | number; label: string }>;
  readonly placeholder?: string;
}

export function Select({ options, placeholder, className = '', ...rest }: SelectProps): JSX.Element {
  return (
    <select className={`select ${className}`} {...rest}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
}): JSX.Element {
  const id = useId();
  return (
    <label className="checkbox" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch__track" aria-hidden>
        <span className="switch__thumb" />
      </span>
      <span>{label}</span>
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  autoFocus = false,
}: {
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  autoFocus?: boolean;
}): JSX.Element {
  return (
    <div className="search">
      <Search size={16} className="search__icon" aria-hidden />
      <input
        className="input"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
      {value ? (
        <button type="button" className="search__clear" aria-label="Clear search" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  title,
  subtitle,
  actions,
  footer,
  children,
  className = '',
  padded = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}): JSX.Element {
  return (
    <section className={`card ${className}`}>
      {title || actions || subtitle ? (
        <header className="card__header">
          <div>
            {title ? <h2 className="card__title">{title}</h2> : null}
            {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded ? 'card__body' : undefined}>{children}</div>
      {footer ? <footer className="card__footer">{footer}</footer> : null}
    </section>
  );
}

const STATUS_TONES: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'accent' | null> = {
  active: 'success',
  paid: 'success',
  completed: 'success',
  confirmed: 'success',
  arrived: 'info',
  in_queue: 'accent',
  waiting: 'accent',
  called: 'info',
  in_progress: 'info',
  scheduled: 'info',
  pending: 'warning',
  partial: 'warning',
  draft: 'warning',
  low: 'warning',
  expiring: 'warning',
  inactive: null,
  cancelled: 'danger',
  no_show: 'danger',
  void: 'danger',
  expired: 'danger',
  overdue: 'danger',
  blocked: 'danger',
  archived: null,
  skipped: 'warning',
  done: 'success',
};

export function StatusBadge({ status, label }: { status: string; label?: string }): JSX.Element {
  const tone = STATUS_TONES[status] ?? null;
  const text = label ?? status.replace(/_/g, ' ');
  return (
    <span className={`badge ${tone ? `badge--${tone}` : ''}`}>
      <span className="badge--dot" aria-hidden />
      {text}
    </span>
  );
}

export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
}): JSX.Element {
  return <span className={`badge ${tone === 'default' ? '' : `badge--${tone}`}`}>{children}</span>;
}

export function Chip({
  children,
  onRemove,
  selected = false,
  onClick,
}: {
  children: ReactNode;
  onRemove?: () => void;
  selected?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <span className={`chip ${selected ? 'chip--selected' : ''}`}>
      <span onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>
        {children}
      </span>
      {onRemove ? (
        <button type="button" className="chip__remove" aria-label="Remove" onClick={onRemove}>
          <X size={12} />
        </button>
      ) : null}
    </span>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  actions,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  const Icon = tone === 'danger' || tone === 'warning' ? AlertTriangle : tone === 'success' ? Check : Info;
  return (
    <div className={`banner banner--${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={18} aria-hidden />
      <div className="grow">
        {title ? <strong>{title}</strong> : null}
        {title && children ? ' ' : null}
        {children}
      </div>
      {actions}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  onClick,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
  onClick?: () => void;
  icon?: ReactNode;
}): JSX.Element {
  const classes = `stat ${tone !== 'default' ? `stat--${tone}` : ''} ${onClick ? 'stat--interactive' : ''}`;
  const body = (
    <>
      <div className="row row--between">
        <span className="stat__label">{label}</span>
        {icon}
      </div>
      <span className="stat__value">{value}</span>
      {hint ? <span className="stat__hint">{hint}</span> : null}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

export function Empty({
  title,
  text,
  action,
  icon,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
  icon?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty__icon">{icon ?? <Info size={26} aria-hidden />}</div>
      <div className="empty__title">{title}</div>
      {text ? <p className="empty__text">{text}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="center row" role="status">
      <span className="spinner" aria-hidden />
      {label ? <span className="muted">{label}</span> : null}
    </div>
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }): JSX.Element {
  return (
    <div className="stack" aria-busy>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton" style={{ height: 18, width: `${100 - index * 6}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <Banner tone="danger" title="Something went wrong." actions={onRetry ? <Button size="sm" onClick={onRetry}>Try again</Button> : undefined}>
      {message}
    </Banner>
  );
}

export function ProgressBar({ percent, label }: { percent: number; label?: string }): JSX.Element {
  return (
    <div className="stack stack--sm">
      {label ? <span className="small muted">{label}</span> : null}
      <div className="progress" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress__bar" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
    </div>
  );
}

export function Avatar({ name, size = 36, src }: { name: string; size?: number; src?: string | null }): JSX.Element {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials || '?'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = 'default',
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'narrow' | 'default' | 'wide';
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, open]);

  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const target = dialog.current?.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea, button',
    );
    target?.focus();
  }, [open]);

  if (!open) return null;
  const sizeClass = width === 'narrow' ? 'modal--narrow' : width === 'wide' ? 'modal--wide' : '';
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`modal ${sizeClass}`} role="dialog" aria-modal="true" aria-label={title} ref={dialog}>
        <header className="modal__header">
          <div>
            <h2 className="modal__title">{title}</h2>
            {description ? <p className="modal__description">{description}</p> : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="modal__body scroll-y">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </aside>
    </div>
  );
}

export function Menu({
  label,
  children,
  align = 'end',
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={container} style={{ position: 'relative' }}>
      <Button onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu">
        {label}
        <ChevronDown size={15} aria-hidden />
      </Button>
      {open ? (
        <div
          className="menu"
          role="menu"
          style={{ position: 'absolute', top: 'calc(100% + 6px)', [align === 'end' ? 'right' : 'left']: 0 }}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu__item ${danger ? 'menu__item--danger' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: ReadonlyArray<{ key: string; label: string; count?: number }>;
  active: string;
  onChange(key: string): void;
}): JSX.Element {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          className={`tabs__tab ${tab.key === active ? 'is-active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {typeof tab.count === 'number' ? <span className="badge">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Segmented({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange(value: string): void;
}): JSX.Element {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented__item ${option.value === value ? 'is-active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Pagination({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage(page: number): void;
}): JSX.Element {
  const pages: number[] = [];
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  for (let index = start; index < start + 5 && index <= pageCount; index += 1) pages.push(index);
  return (
    <div className="pagination">
      <span>
        Page {page} of {Math.max(1, pageCount)} · {total} record{total === 1 ? '' : 's'}
      </span>
      <div className="pagination__pages">
        <Button size="sm" onClick={() => onPage(1)} disabled={page <= 1} aria-label="First page">
          «
        </Button>
        <Button size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          Previous
        </Button>
        {pages.map((value) => (
          <Button key={value} size="sm" variant={value === page ? 'navy' : 'default'} onClick={() => onPage(value)}>
            {value}
          </Button>
        ))}
        <Button size="sm" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>
          Next
        </Button>
        <Button size="sm" onClick={() => onPage(pageCount)} disabled={page >= pageCount} aria-label="Last page">
          »
        </Button>
      </div>
    </div>
  );
}

export function DefinitionList({ items }: { items: ReadonlyArray<{ label: string; value: ReactNode }> }): JSX.Element {
  return (
    <dl className="definition">
      {items.map((item) => (
        <div key={item.label} className="definition__row" style={{ display: 'contents' }}>
          <dt className="muted">{item.label}</dt>
          <dd>{item.value || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Timeline({
  items,
}: {
  items: ReadonlyArray<{ key: string; title: ReactNode; detail?: ReactNode; date?: ReactNode; tone?: 'default' | 'accent' | 'danger' | 'success' }>;
}): JSX.Element {
  return (
    <div className="timeline">
      {items.map((item) => (
        <div key={item.key} className="timeline__item">
          <span className={`timeline__dot ${item.tone && item.tone !== 'default' ? `timeline__dot--${item.tone}` : ''}`} aria-hidden />
          <div className="timeline__title">{item.title}</div>
          {item.detail ? <div className="timeline__detail">{item.detail}</div> : null}
          {item.date ? <div className="timeline__date">{item.date}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function TableWrap({ children }: { children: ReactNode }): JSX.Element {
  return <div className="table-wrap">{children}</div>;
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: readonly { id: number; tone: string; title: string; body?: string }[];
  onDismiss(id: number): void;
}): JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {toasts.map((item) => (
        <div key={item.id} className={`toast toast--${item.tone}`} role="status">
          <div className="grow">
            <div className="toast__title">{item.title}</div>
            {item.body ? <div className="toast__body">{item.body}</div> : null}
          </div>
          <IconButton label="Dismiss" onClick={() => onDismiss(item.id)}>
            <X size={15} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function Page({
  title,
  description,
  actions,
  children,
  flush = false,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}): JSX.Element {
  return (
    <div className={`page ${flush ? 'page--flush' : ''}`}>
      <header className="page__header">
        <div>
          <h1 className="page__heading">{title}</h1>
          {description ? <p className="page__description">{description}</p> : null}
        </div>
        {actions ? <div className="page__toolbar">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
