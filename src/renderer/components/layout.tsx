/**
 * Application shell: the fixed sidebar, the header and the global command
 * palette. Navigation is permission-aware — a link the role cannot use is not
 * rendered at all, and the matching screen would refuse to load it anyway.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  Banknote,
  Bell,
  CalendarDays,
  ClipboardList,
  Coins,
  FileText,
  History,
  LayoutDashboard,
  Lock,
  LogOut,
  Package,
  Pill,
  Search,
  Settings,
  ShieldCheck,
  Stethoscope,
  ClipboardCheck,
  UserCog,
  Users,
  UsersRound,
  Wrench,
} from 'lucide-react';
import type { Notification } from '@shared/types';
import { permissionMatches } from '@shared/permissions';
import { resolveScreenPath, SCREEN_ROUTES } from '@shared/api';
import { bridge } from '@renderer/lib/bridge';
import { fmtDate, fmtRelative } from '@renderer/lib/format';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { Avatar, Badge, Button, IconButton, Input, Menu, MenuItem, Empty, Spinner } from './ui';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly permission: string;
}

interface NavSection {
  readonly title: string;
  readonly items: readonly NavItem[];
}

const ICON = 17;

const SECTIONS: readonly NavSection[] = [
  {
    title: 'Practice',
    items: [
      { to: SCREEN_ROUTES.dashboard, label: 'Dashboard', icon: <LayoutDashboard size={ICON} />, permission: 'dashboard.view' },
      { to: SCREEN_ROUTES.patients, label: 'Patients', icon: <Users size={ICON} />, permission: 'patient.view' },
      { to: SCREEN_ROUTES.appointments, label: 'Appointments', icon: <CalendarDays size={ICON} />, permission: 'appointment.view' },
      { to: SCREEN_ROUTES.queue, label: 'Queue', icon: <ClipboardList size={ICON} />, permission: 'queue.view' },
      { to: SCREEN_ROUTES.referral, label: 'Referrals', icon: <Stethoscope size={ICON} />, permission: 'patient.view' },
    ],
  },
  {
    title: 'Clinical',
    items: [
      { to: SCREEN_ROUTES.visits, label: 'Visits', icon: <ClipboardCheck size={ICON} />, permission: 'visit.view' },
      { to: SCREEN_ROUTES.prescriptions, label: 'Prescriptions', icon: <Pill size={ICON} />, permission: 'prescription.view' },
      { to: SCREEN_ROUTES.treatments, label: 'Treatments', icon: <Wrench size={ICON} />, permission: 'treatment.view' },
    ],
  },
  {
    title: 'Billing',
    items: [
      { to: SCREEN_ROUTES.invoices, label: 'Invoices', icon: <FileText size={ICON} />, permission: 'invoice.view' },
      { to: SCREEN_ROUTES.payments, label: 'Payments', icon: <Banknote size={ICON} />, permission: 'payment.view' },
      { to: SCREEN_ROUTES.inventory, label: 'Inventory', icon: <Package size={ICON} />, permission: 'inventory.view' },
      { to: SCREEN_ROUTES.accounting, label: 'Accounting', icon: <Coins size={ICON} />, permission: 'accounting.view' },
      { to: SCREEN_ROUTES.reports, label: 'Reports', icon: <BarChart3 size={ICON} />, permission: 'report.operational.view' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: SCREEN_ROUTES.staff, label: 'Staff & dentists', icon: <UsersRound size={ICON} />, permission: 'staff.view' },
      { to: SCREEN_ROUTES.users, label: 'Users & roles', icon: <UserCog size={ICON} />, permission: 'user.view' },
      { to: SCREEN_ROUTES.backup, label: 'Backup & data', icon: <ShieldCheck size={ICON} />, permission: 'backup.create' },
      { to: SCREEN_ROUTES.audit, label: 'Audit log', icon: <History size={ICON} />, permission: 'audit.view' },
      { to: SCREEN_ROUTES.settings, label: 'Settings', icon: <Settings size={ICON} />, permission: 'settings.view' },
    ],
  },
];

export function Sidebar(): JSX.Element {
  const { session, clinic, bootstrap } = useApp();
  const granted = session?.permissions ?? [];
  const visible = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => permissionMatches(granted, item.permission)),
  })).filter((section) => section.items.length > 0);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__logo" aria-hidden>
          ৳
        </span>
        <div className="grow">
          <div className="sidebar__clinic">{clinic?.name ?? 'Dentiva Pro'}</div>
          <div className="sidebar__tagline">
            {bootstrap ? `v${bootstrap.appVersion} · build ${bootstrap.appBuild}` : 'Dental clinic system'}
          </div>
        </div>
      </div>
      <nav className="sidebar__nav" aria-label="Main navigation">
        {visible.map((section) => (
          <div key={section.title}>
            <div className="sidebar__section">{section.title}</div>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `sidebar__link ${isActive ? 'is-active' : ''}`}
              >
                {item.icon}
                <span className="grow">{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar__footer">
        <NavLink to={SCREEN_ROUTES.about} className="sidebar__link">
          <ShieldCheck size={ICON} />
          <span className="grow">About Dentiva Pro</span>
        </NavLink>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function Header({ onOpenSearch }: { onOpenSearch(): void }): JSX.Element {
  const navigate = useNavigate();
  const { session, clinic, settings, signOut, lock, toast } = useApp();
  const { run } = useAction();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const unread = useApi('notifications.unreadCount', undefined);
  const list = useApi('notifications.list', notificationsOpen ? { onlyUnread: true, limit: 12 } : null);

  const unreadCount = unread.data?.total ?? 0;
  const items = list.data ?? [];

  useEffect(() => {
    const unsubscribe = bridge.on('notifications.changed', () => unread.reload());
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNotification = async (notification: Notification) => {
    if (!notification.isRead) {
      await run(() => bridge.invoke('notifications.markRead', { ids: [notification.id] }), {});
      unread.reload();
    }
    setNotificationsOpen(false);
    if (notification.target) {
      void navigate(resolveScreenPath(notification.target.screen, notification.target.id ?? null));
    }
  };

  const today = useMemo(() => new Date(), []);

  return (
    <header className="header">
      <div className="header__search">
        <IconButton label="Search (Ctrl+K)" onClick={onOpenSearch}>
          <Search size={17} />
        </IconButton>
        <div className="grow">
          <div className="header__title">{clinic?.name ?? 'Dentiva Pro'}</div>
          <div className="header__subtitle">
            {fmtDate(today.toISOString().slice(0, 10))}
            {settings?.timeZone ? ` · ${settings.timeZone}` : ''}
          </div>
        </div>
      </div>
      <div className="header__actions">
        <div className="menu-wrap" style={{ position: 'relative' }}>
          <IconButton
            label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ''}`}
            active={notificationsOpen}
            onClick={() => setNotificationsOpen((value) => !value)}
          >
            <Bell size={17} />
            {unreadCount > 0 ? (
              <span className="notification-dot" aria-hidden>
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            ) : null}
          </IconButton>
          {notificationsOpen ? (
            <div
              className="menu"
              role="dialog"
              aria-label="Notifications"
              style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 380 }}
            >
              <div className="row row--between" style={{ padding: '6px 8px' }}>
                <strong>Notifications</strong>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void run(() => bridge.invoke('notifications.markAllRead')).then(() => unread.reload())}
                >
                  Mark all read
                </Button>
              </div>
              <div className="menu__separator" />
              {list.loading ? (
                <Spinner label="Loading…" />
              ) : items.length === 0 ? (
                <Empty title="You are all caught up" text="Reminders and alerts appear here as they happen." />
              ) : (
                <div className="stack stack--sm" style={{ maxHeight: 380, overflowY: 'auto' }}>
                  {items.map((notification) => (
                    <button
                      key={notification.id}
                      type="button"
                      className="menu__item"
                      style={{ display: 'block', textAlign: 'left' }}
                      onClick={() => void openNotification(notification)}
                    >
                      <div className="row row--between">
                        <strong>{notification.title}</strong>
                        {!notification.isRead ? <Badge tone="accent">New</Badge> : null}
                      </div>
                      <div className="small muted">{notification.message}</div>
                      <div className="tiny muted">{fmtRelative(notification.createdAt)}</div>
                    </button>
                  ))}
                </div>
              )}
              <div className="menu__separator" />
              <Button
                size="sm"
                variant="ghost"
                block
                onClick={() => {
                  setNotificationsOpen(false);
                  void navigate('/settings?tab=notifications');
                }}
              >
                Notification settings
              </Button>
            </div>
          ) : null}
        </div>

        <Menu
          label={
            <span className="row" style={{ gap: 8 }}>
              <Avatar name={session?.fullName ?? 'User'} size={26} />
              <span className="header__user">{session?.fullName ?? 'Signed out'}</span>
            </span>
          }
        >
          {(close) => (
            <>
              <div style={{ padding: '8px 10px' }}>
                <div>{session?.fullName}</div>
                <div className="small muted">
                  {session?.roleNames.join(', ') || '—'} · {session?.username}
                </div>
              </div>
              <div className="menu__separator" />
              <MenuItem
                onClick={() => {
                  close();
                  void run(() => lock());
                }}
              >
                <span className="row">
                  <Lock size={15} /> Lock now
                </span>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  void navigate(SCREEN_ROUTES.settings);
                }}
              >
                <span className="row">
                  <Settings size={15} /> My settings
                </span>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  void navigate('/change-password');
                }}
              >
                <span className="row">
                  <ShieldCheck size={15} /> Change password
                </span>
              </MenuItem>
              <div className="menu__separator" />
              <MenuItem
                danger
                onClick={() => {
                  close();
                  void run(async () => {
                    await signOut();
                    toast('info', 'Signed out', 'Your session has ended.');
                  });
                }}
              >
                <span className="row">
                  <LogOut size={15} /> Sign out
                </span>
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Global search (command palette)
// ---------------------------------------------------------------------------

export function GlobalSearch({ open, onClose }: { open: boolean; onClose(): void }): JSX.Element | null {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTerm('');
      setDebounced('');
      window.setTimeout(() => input.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(term.trim()), 180);
    return () => window.clearTimeout(timeout);
  }, [term]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, open]);

  const results = useApi('search.global', open && debounced.length >= 2 ? { query: debounced, limit: 8 } : null);

  if (!open) return null;
  const groups = results.data?.groups ?? [];

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Search" style={{ alignSelf: 'flex-start', marginTop: 80 }}>
        <div className="modal__header">
          <div className="grow">
            <Input
              ref={input}
              value={term}
              placeholder="Search patients, invoices, prescriptions, appointments…"
              onChange={(event) => setTerm(event.target.value)}
            />
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Esc
          </Button>
        </div>
        <div className="modal__body">
          {debounced.length < 2 ? (
            <Empty title="Type at least two characters" text="Results respect your role: only records you may open are listed." />
          ) : results.loading ? (
            <Spinner label="Searching…" />
          ) : results.error ? (
            <div className="muted">{results.error}</div>
          ) : groups.length === 0 ? (
            <Empty title="No matches" text={`Nothing matched “${debounced}”.`} />
          ) : (
            <div className="stack">
              {groups.map((group) => (
                <div key={group.key}>
                  <div className="sidebar__section" style={{ color: 'var(--ink-500)', padding: 0 }}>
                    {group.label}
                  </div>
                  <div className="stack stack--sm" style={{ marginTop: 6 }}>
                    {group.items.map((item) => (
                      <button
                        key={`${item.screen}:${item.id}`}
                        type="button"
                        className="menu__item"
                        onClick={() => {
                          onClose();
                          void navigate(resolveScreenPath(item.screen, item.id));
                        }}
                      >
                        <div className="row row--between">
                          <span>{item.title}</span>
                          <span className="small muted">{item.subtitle}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
