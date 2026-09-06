import axios from 'axios';
import { clearStoredAuthSession, SESSION_EXPIRED_EVENT } from '../state/authSession.js';

/**
 * Centralized API client.
 * In development: requests go to Vite's dev server proxy (/api → localhost:5000/api).
 * In production: set VITE_API_URL to your deployed backend URL.
 */
const rawApiUrl = import.meta.env.VITE_API_URL || '';
const cleanApiUrl = rawApiUrl.endsWith('/') ? rawApiUrl.slice(0, -1) : rawApiUrl;
const BASE_URL = `${cleanApiUrl}/api`;

const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach the stored JWT to every outgoing request
apiClient.interceptors.request.use(
  (config) => {
    const token = sessionStorage.getItem('auth_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Clear stale credentials when the backend rejects a token
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && sessionStorage.getItem('auth_token')) {
      clearStoredAuthSession();
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    return Promise.reject(error);
  }
);

export default apiClient;
