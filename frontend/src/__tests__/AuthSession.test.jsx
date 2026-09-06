import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App.jsx';
import { AuthProvider, useAuth } from '../state/authContext.jsx';
import { SESSION_EXPIRED_EVENT } from '../state/authSession.js';

vi.mock('../pages/LoginPage.jsx', () => ({ default: () => <div>Login page</div> }));
vi.mock('../pages/CaseListPage.jsx', () => ({ default: () => <div>Cases page</div> }));
vi.mock('../pages/CaseDetailPage.jsx', () => ({ default: () => <div>Case detail page</div> }));

function jwtWithExpiry(exp) {
  const encode = (value) => btoa(JSON.stringify(value))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp })}.signature`;
}

function SessionProbe() {
  const { token } = useAuth();
  return <div>{token ? 'Authenticated' : 'Unauthenticated'}</div>;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe('expired authentication sessions', () => {
  it('redirects a protected page to login after reload with an expired JWT', async () => {
    sessionStorage.setItem('auth_token', jwtWithExpiry(Math.floor(Date.now() / 1000) - 60));
    sessionStorage.setItem('auth_user', JSON.stringify({ username: 'investigator' }));

    render(
      <MemoryRouter initialEntries={['/cases']}>
        <AuthProvider><App /></AuthProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText('Login page')).toBeDefined();
    expect(sessionStorage.getItem('auth_token')).toBeNull();
    expect(sessionStorage.getItem('auth_user')).toBeNull();
  });

  it('updates React authentication state when a live API request reports expiration', () => {
    sessionStorage.setItem('auth_token', jwtWithExpiry(Math.floor(Date.now() / 1000) + 3600));
    sessionStorage.setItem('auth_user', JSON.stringify({ username: 'investigator' }));
    render(<AuthProvider><SessionProbe /></AuthProvider>);
    expect(screen.getByText('Authenticated')).toBeDefined();

    act(() => window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)));

    expect(screen.getByText('Unauthenticated')).toBeDefined();
    expect(sessionStorage.getItem('auth_token')).toBeNull();
  });
});
