import '@fontsource-variable/schibsted-grotesk';
import '@fontsource-variable/spline-sans-mono';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { ApiError } from './lib/api';
import { AppShell, PortalShell, useMe } from './shell';
import { Loading, ToastProvider } from './ui';

const Auth = lazy(() => import('./pages/auth'));
const Home = lazy(() => import('./pages/home'));
const Subscriptions = lazy(() => import('./pages/subscriptions'));
const Billing = lazy(() => import('./pages/billing'));
const Invoices = lazy(() => import('./pages/invoices'));
const Money = lazy(() => import('./pages/money'));
const Reconcile = lazy(() => import('./pages/reconcile'));
const Revenue = lazy(() => import('./pages/revenue'));
const Integrity = lazy(() => import('./pages/integrity'));
const Catalog = lazy(() => import('./pages/catalog'));
const Customers = lazy(() => import('./pages/customers'));
const Portal = lazy(() => import('./pages/portal'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

const Fallback = () => <div style={{ padding: 24 }}><Loading height={320} /></div>;

function RequireStaff() {
  const { data, isLoading } = useMe();
  if (isLoading) return <Fallback />;
  if (!data?.user) return <Navigate to="/login" replace />;
  if (data.user.role === 'customer') return <Navigate to="/portal" replace />;
  return <AppShell />;
}

function RequireCustomer() {
  const { data, isLoading } = useMe();
  if (isLoading) return <Fallback />;
  if (!data?.user) return <Navigate to="/login" replace />;
  if (data.user.role !== 'customer') return <Navigate to="/" replace />;
  return <PortalShell />;
}

function Bare() {
  return <Suspense fallback={<Fallback />}><Outlet /></Suspense>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Bare />}>
              <Route path="/login" element={<Auth mode="login" />} />
              <Route path="/signup" element={<Auth mode="signup" />} />
              <Route path="/forgot" element={<Auth mode="forgot" />} />
              <Route path="/reset/:token" element={<Auth mode="reset" />} />
            </Route>
            <Route element={<RequireStaff />}>
              <Route path="/" element={<Home />} />
              <Route path="/subscriptions/*" element={<Subscriptions />} />
              <Route path="/billing" element={<Billing />} />
              <Route path="/invoices/*" element={<Invoices />} />
              <Route path="/payments" element={<Money view="payments" />} />
              <Route path="/collections" element={<Money view="collections" />} />
              <Route path="/renewals" element={<Money view="renewals" />} />
              <Route path="/outbox" element={<Money view="outbox" />} />
              <Route path="/reconcile/*" element={<Reconcile />} />
              <Route path="/revenue" element={<Revenue />} />
              <Route path="/integrity" element={<Integrity />} />
              <Route path="/catalog/*" element={<Catalog />} />
              <Route path="/customers/*" element={<Customers />} />
            </Route>
            <Route element={<RequireCustomer />}>
              <Route path="/portal/*" element={<Portal />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
