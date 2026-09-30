/**
 * The application root: state gate → shell → routes.
 *
 * The gate is deliberately strict — activation first, then the setup wizard,
 * then sign-in, then the (optional) lock screen. No screen behind the gate is
 * reachable without an authenticated, unlocked session.
 */
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { SCREEN_ROUTES } from '@shared/api';
import { APP_NAME } from '@shared/app-info';
import { useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { Button, ErrorState, LoadingBlock, Spinner, Toasts } from '@renderer/components/ui';
import { GlobalSearch, Header, Sidebar } from '@renderer/components/layout';
import { ActivationScreen, LoginScreen, LockScreen } from '@renderer/screens/gate';
import { SetupWizard } from '@renderer/screens/setup-wizard';
import { ChangePasswordScreen } from '@renderer/screens/change-password';
import { DashboardScreen } from '@renderer/screens/dashboard';
import { PatientsScreen } from '@renderer/screens/patients';
import { PatientDetailScreen } from '@renderer/screens/patient-detail';
import { AppointmentsScreen } from '@renderer/screens/appointments';
import { QueueScreen } from '@renderer/screens/queue';
import { VisitsScreen } from '@renderer/screens/visits';
import { PrescriptionsScreen } from '@renderer/screens/prescriptions';
import { TreatmentsScreen } from '@renderer/screens/treatments';
import { InvoicesScreen } from '@renderer/screens/invoices';
import { PaymentsScreen } from '@renderer/screens/payments';
import { InventoryScreen } from '@renderer/screens/inventory';
import { AccountingScreen } from '@renderer/screens/accounting';
import { ReportsScreen } from '@renderer/screens/reports';
import { StaffScreen } from '@renderer/screens/staff';
import { UsersScreen } from '@renderer/screens/users';
import { BackupScreen } from '@renderer/screens/backup';
import { SettingsScreen } from '@renderer/screens/settings';
import { AuditScreen } from '@renderer/screens/audit';
import { ReferralsScreen } from '@renderer/screens/referrals';
import { AboutScreen } from '@renderer/screens/about';
import { ConfirmHost } from '@renderer/screens/confirm-host';
import { FieldIssueHost } from '@renderer/screens/field-issue-host';

function Splash(): JSX.Element {
  return (
    <div className="gate">
      <div className="gate__panel" style={{ maxWidth: 460 }}>
        <div className="row" style={{ gap: 12 }}>
          <span className="spinner" aria-hidden />
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>{APP_NAME}</h1>
            <p className="muted" style={{ margin: 0 }}>
              Opening the clinic database…
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Shell(): JSX.Element {
  const navigate = useNavigate();
  const { session } = useApp();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (modifier && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        void bridge.invoke('auth.lock').then(() => navigate(SCREEN_ROUTES.dashboard));
      }
    };
    window.addEventListener('keydown', handler);
    const unsubscribe = bridge.on('shortcut.invoke', (payload) => {
      if (payload.shortcut === 'global-search') setSearchOpen(true);
      if (payload.shortcut === 'lock') void bridge.invoke('auth.lock');
    });
    return () => {
      window.removeEventListener('keydown', handler);
      unsubscribe();
    };
  }, [navigate]);

  if (session?.mustChangePassword) {
    return (
      <>
        <ChangePasswordScreen forced />
        <ToastsHost />
      </>
    );
  }

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <Header onOpenSearch={() => setSearchOpen(true)} />
        <div className="scroll-y" style={{ flex: 1 }}>
          <Routes>
            <Route path={SCREEN_ROUTES.dashboard} element={<DashboardScreen />} />
            <Route path={SCREEN_ROUTES.patients} element={<PatientsScreen />} />
            <Route path={SCREEN_ROUTES.patient} element={<PatientDetailScreen />} />
            <Route path={SCREEN_ROUTES.appointments} element={<AppointmentsScreen />} />
            <Route path={SCREEN_ROUTES.queue} element={<QueueScreen />} />
            <Route path={SCREEN_ROUTES.visits} element={<VisitsScreen />} />
            <Route path={SCREEN_ROUTES.prescriptions} element={<PrescriptionsScreen />} />
            <Route path={SCREEN_ROUTES.treatments} element={<TreatmentsScreen />} />
            <Route path={SCREEN_ROUTES.invoices} element={<InvoicesScreen />} />
            <Route path={SCREEN_ROUTES.payments} element={<PaymentsScreen />} />
            <Route path={SCREEN_ROUTES.inventory} element={<InventoryScreen />} />
            <Route path={SCREEN_ROUTES.accounting} element={<AccountingScreen />} />
            <Route path={SCREEN_ROUTES.reports} element={<ReportsScreen />} />
            <Route path={SCREEN_ROUTES.staff} element={<StaffScreen />} />
            <Route path={SCREEN_ROUTES.users} element={<UsersScreen />} />
            <Route path={SCREEN_ROUTES.backup} element={<BackupScreen />} />
            <Route path={SCREEN_ROUTES.settings} element={<SettingsScreen />} />
            <Route path={SCREEN_ROUTES.audit} element={<AuditScreen />} />
            <Route path={SCREEN_ROUTES.referral} element={<ReferralsScreen />} />
            <Route path="/change-password" element={<ChangePasswordScreen />} />
            <Route path={SCREEN_ROUTES.about} element={<AboutScreen />} />
            <Route path="*" element={<Navigate to={SCREEN_ROUTES.dashboard} replace />} />
          </Routes>
        </div>
      </div>
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ToastsHost />
      <ConfirmHost />
      <FieldIssueHost />
    </div>
  );
}

function ToastsHost(): JSX.Element | null {
  const { toasts, dismissToast } = useApp();
  return <Toasts toasts={toasts} onDismiss={dismissToast} />;
}

export function App(): JSX.Element {
  const { ready, fatal, state, bootstrap, refresh } = useApp();

  if (fatal && !ready) {
    return (
      <div className="gate">
        <div className="gate__panel" style={{ maxWidth: 560 }}>
          <h1 style={{ marginTop: 0 }}>Dentiva Pro could not start</h1>
          <ErrorState message={fatal} onRetry={() => void refresh()} />
          <p className="muted small">
            If this keeps happening, check that the data folder is writable and try again. Your records are untouched.
          </p>
        </div>
      </div>
    );
  }

  if (!ready || !bootstrap) return <Splash />;

  if (state === 'activation_required') {
    return (
      <>
        <ActivationScreen />
        <ConfirmHost />
      </>
    );
  }

  if (state === 'setup_required') {
    return (
      <>
        <SetupWizard />
        <ConfirmHost />
        <ToastsHost />
      </>
    );
  }

  if (state === 'locked') {
    return (
      <>
        {bootstrap.session ? <LockScreen /> : <LoginScreen />}
        <ConfirmHost />
        <ToastsHost />
      </>
    );
  }

  return <Shell />;
}

export function MissingScreen({ name }: { name: string }): JSX.Element {
  return (
    <div className="page">
      <h1 className="page__heading">{name}</h1>
      <LoadingBlock />
      <div className="row">
        <Spinner />
        <span className="muted">Loading…</span>
      </div>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </div>
  );
}
