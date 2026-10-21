import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './contexts/AuthContext';
import { Layout } from './components/Layout';
import { ProtectedRoute, AdminRoute } from './components/ProtectedRoute';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Landing } from './pages/Landing';
import { Login } from './pages/Login';
import { OAuthCallback } from './pages/OAuthCallback';
import { Setup } from './pages/Setup';
import { McpOAuthConsent } from './pages/McpOAuthConsent';

import { I18nProvider } from './contexts/I18nContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { UiScaleProvider } from './contexts/UiScaleContext';
import { useDialogAutoHideScrollbar } from './hooks/useDialogAutoHideScrollbar';

// 路由级懒加载：减小首屏 bundle，按需加载页面
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Audit = lazy(() => import('./pages/Audit').then((m) => ({ default: m.Audit })));
const Accounts = lazy(() => import('./pages/Accounts').then((m) => ({ default: m.Accounts })));
const Domains = lazy(() => import('./pages/Domains').then((m) => ({ default: m.Domains })));
const Records = lazy(() => import('./pages/Records').then((m) => ({ default: m.Records })));
const Users = lazy(() => import('./pages/Users').then((m) => ({ default: m.Users })));
const Teams = lazy(() => import('./pages/Teams').then((m) => ({ default: m.Teams })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const Security = lazy(() => import('./pages/Security').then((m) => ({ default: m.Security })));
const Tunnels = lazy(() => import('./pages/Tunnels').then((m) => ({ default: m.Tunnels })));
const Tokens = lazy(() => import('./pages/Tokens').then((m) => ({ default: m.Tokens })));
const McpManagement = lazy(() => import('./pages/McpManagement').then((m) => ({ default: m.McpManagement })));
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })));
const System = lazy(() => import('./pages/System').then((m) => ({ default: m.System })));
const Workflows = lazy(() => import('./pages/Workflows').then((m) => ({ default: m.Workflows })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

// 路由级 fallback：避免页面切换时空白
function RouteFallback() {
  return <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>Loading…</div>;
}

function App() {
  useDialogAutoHideScrollbar();

  return (
    <ErrorBoundary>
      <UiScaleProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <I18nProvider>
              <AuthProvider>
                <BrowserRouter>
                  <Routes>
                    <Route path="/" element={<Landing />} />
                    <Route path="/setup" element={<Setup />} />
                    <Route path="/login" element={<Login />} />
                    <Route path="/oauth/callback" element={<OAuthCallback />} />
                    <Route path="/oauth/authorize" element={<McpOAuthConsent />} />
                    <Route element={<ProtectedRoute />}>
                      <Route element={<Layout />}>
                        <Route path="dash" element={<Suspense fallback={<RouteFallback />}><Dashboard /></Suspense>} />
                        <Route path="dash/accounts" element={<Suspense fallback={<RouteFallback />}><Accounts /></Suspense>} />
                        <Route path="dash/domains" element={<Suspense fallback={<RouteFallback />}><Domains activeTab="list" /></Suspense>} />
                        <Route path="dash/domains/servicemonitor" element={<Suspense fallback={<RouteFallback />}><Domains activeTab="servicemonitor" /></Suspense>} />
                        <Route path="dash/domains/ns-monitor" element={<Suspense fallback={<RouteFallback />}><Domains activeTab="ns-monitor" /></Suspense>} />
                        <Route path="dash/domains/renewal" element={<Suspense fallback={<RouteFallback />}><Domains activeTab="renewal" /></Suspense>} />
                        <Route path="dash/domains/:id/records" element={<Suspense fallback={<RouteFallback />}><Records /></Suspense>} />
                        <Route path="dash/tunnels" element={<Suspense fallback={<RouteFallback />}><Tunnels /></Suspense>} />
                        <Route path="dash/tokens" element={<Suspense fallback={<RouteFallback />}><Tokens /></Suspense>} />
                        <Route path="dash/mcp" element={<Suspense fallback={<RouteFallback />}><McpManagement /></Suspense>} />
                        <Route path="dash/teams" element={<Suspense fallback={<RouteFallback />}><Teams /></Suspense>} />
                        <Route path="dash/settings" element={<Suspense fallback={<RouteFallback />}><Settings /></Suspense>} />
                        <Route path="dash/security" element={<Suspense fallback={<RouteFallback />}><Security /></Suspense>} />
                        <Route path="dash/about" element={<Suspense fallback={<RouteFallback />}><About /></Suspense>} />
                        <Route element={<AdminRoute />}>
                          <Route path="dash/users" element={<Suspense fallback={<RouteFallback />}><Users /></Suspense>} />
                          <Route path="dash/audit" element={<Suspense fallback={<RouteFallback />}><Audit /></Suspense>} />
                          <Route path="dash/workflows" element={<Suspense fallback={<RouteFallback />}><Workflows /></Suspense>} />
                          <Route path="dash/system" element={<Suspense fallback={<RouteFallback />}><System activeTab="overview" /></Suspense>} />
                          <Route path="dash/system/database" element={<Suspense fallback={<RouteFallback />}><System activeTab="database" /></Suspense>} />
                          <Route path="dash/system/security" element={<Suspense fallback={<RouteFallback />}><System activeTab="security" /></Suspense>} />
                          <Route path="dash/system/access" element={<Suspense fallback={<RouteFallback />}><System activeTab="access" /></Suspense>} />
                          <Route path="dash/system/network" element={<Suspense fallback={<RouteFallback />}><System activeTab="network" /></Suspense>} />
                          <Route path="dash/system/notifications" element={<Suspense fallback={<RouteFallback />}><System activeTab="notifications" /></Suspense>} />
                          <Route path="dash/system/workflow" element={<Suspense fallback={<RouteFallback />}><System activeTab="workflow" /></Suspense>} />
                        </Route>
                      </Route>
                    </Route>
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </BrowserRouter>
              </AuthProvider>
            </I18nProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </UiScaleProvider>
    </ErrorBoundary>
  );
}

export default App;
