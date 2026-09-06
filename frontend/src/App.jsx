import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './state/authContext.jsx';
import LoginPage from './pages/LoginPage.jsx';
import CaseListPage from './pages/CaseListPage.jsx';
import CaseDetailPage from './pages/CaseDetailPage.jsx';

/** Guard: redirects unauthenticated users to /login */
function PrivateRoute({ children }) {
  const { token } = useAuth();
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/cases"
        element={
          <PrivateRoute>
            <CaseListPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/cases/:caseId"
        element={
          <PrivateRoute>
            <CaseDetailPage />
          </PrivateRoute>
        }
      />
      <Route path="*" element={<Navigate to={sessionStorage.getItem('auth_token') ? '/cases' : '/login'} replace />} />
    </Routes>
  );
}
