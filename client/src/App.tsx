import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from './lib/theme';
import { RequireAdmin } from './app/require-admin';
import { ProtectedShell } from './app/protected-shell';
import { RedirectIfAuthed } from './app/redirect-if-authed';
// 首屏直达的两个页面保持同步加载：落地页与登录页是冷启动必经路径，
// 再套一层 lazy 只会让首屏多一次往返。
import { LandingPage } from './features/marketing/landing-page';
import { LoginPage } from './features/auth/login-page';

/**
 * 控制台内部一律路由级懒加载：主包只保留 shell + 首屏页面，
 * 各 feature 页面各自成块（此前全部静态导入，主包 619 kB）。
 */
const DashboardPage = lazy(() => import('./features/dashboard/dashboard-page').then((m) => ({ default: m.DashboardPage })));
const DomainsPage = lazy(() => import('./features/domains/domains-page').then((m) => ({ default: m.DomainsPage })));
const DomainMonitoringPage = lazy(() => import('./features/domains/monitoring-page').then((m) => ({ default: m.DomainMonitoringPage })));
const RecordsPage = lazy(() => import('./features/records/records-page').then((m) => ({ default: m.RecordsPage })));
const AccountsPage = lazy(() => import('./features/accounts/accounts-page').then((m) => ({ default: m.AccountsPage })));
const TokensPage = lazy(() => import('./features/tokens/tokens-page').then((m) => ({ default: m.TokensPage })));
const SecurityPage = lazy(() => import('./features/security/security-page').then((m) => ({ default: m.SecurityPage })));
const SettingsPage = lazy(() => import('./features/settings/settings-page').then((m) => ({ default: m.SettingsPage })));
const AuditPage = lazy(() => import('./features/audit/audit-page').then((m) => ({ default: m.AuditPage })));
const TeamsPage = lazy(() => import('./features/teams/teams-page').then((m) => ({ default: m.TeamsPage })));
const UsersPage = lazy(() => import('./features/users/users-page').then((m) => ({ default: m.UsersPage })));
const SystemPage = lazy(() => import('./features/system/system-page').then((m) => ({ default: m.SystemPage })));
const WorkflowsPage = lazy(() => import('./features/workflows/workflows-page').then((m) => ({ default: m.WorkflowsPage })));
const McpPage = lazy(() => import('./features/mcp/mcp-page').then((m) => ({ default: m.McpPage })));
const AboutPage = lazy(() => import('./features/about/about-page').then((m) => ({ default: m.AboutPage })));
const SetupPage = lazy(() => import('./features/setup/setup-page').then((m) => ({ default: m.SetupPage })));
const OAuthCallbackPage = lazy(() => import('./features/oauth/oauth-callback-page').then((m) => ({ default: m.OAuthCallbackPage })));
const McpConsentPage = lazy(() => import('./features/oauth/mcp-consent-page').then((m) => ({ default: m.McpConsentPage })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/** 路由级 fallback：与页面骨架一致的浅色占位，避免切换时闪白 */
function RouteFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
        加载中…
      </div>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              {/* 已登录时直接进面板（含 return_to 落点），不再停留在登录页 */}
              <Route path="/login" element={<RedirectIfAuthed><LoginPage /></RedirectIfAuthed>} />
              <Route path="/setup" element={<SetupPage />} />
              <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
              <Route path="/oauth/authorize" element={<McpConsentPage />} />

              <Route element={<ProtectedShell />}>
                <Route path="dash" element={<DashboardPage />} />
                <Route path="dash/accounts" element={<AccountsPage />} />
                <Route path="dash/domains" element={<DomainsPage />} />
                <Route path="dash/domains/servicemonitor" element={<DomainMonitoringPage activeTab="servicemonitor" />} />
                <Route path="dash/domains/ns-monitor" element={<DomainMonitoringPage activeTab="ns-monitor" />} />
                <Route path="dash/domains/renewal" element={<DomainMonitoringPage activeTab="renewal" />} />
                <Route path="dash/domains/:id/records" element={<RecordsPage />} />
                <Route path="dash/tokens" element={<TokensPage />} />
                <Route path="dash/mcp" element={<McpPage />} />
                <Route path="dash/teams" element={<TeamsPage />} />
                <Route path="dash/settings" element={<SettingsPage />} />
                <Route path="dash/security" element={<SecurityPage />} />
                <Route path="dash/about" element={<AboutPage />} />

                <Route element={<RequireAdmin />}>
                  <Route path="dash/users" element={<UsersPage />} />
                  <Route path="dash/audit" element={<AuditPage />} />
                  <Route path="dash/workflows" element={<WorkflowsPage />} />
                  <Route path="dash/system" element={<SystemPage activeTab="overview" />} />
                  <Route path="dash/system/database" element={<SystemPage activeTab="database" />} />
                  <Route path="dash/system/security" element={<SystemPage activeTab="security" />} />
                  <Route path="dash/system/access" element={<SystemPage activeTab="access" />} />
                  <Route path="dash/system/network" element={<SystemPage activeTab="network" />} />
                  <Route path="dash/system/notifications" element={<SystemPage activeTab="notifications" />} />
                  <Route path="dash/system/workflow" element={<SystemPage activeTab="workflow" />} />
                </Route>
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
