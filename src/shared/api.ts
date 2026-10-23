// Calls the Supabase database functions over HTTP, with retries for congested networks.
// Every visitor action carries an idempotency key, so a retry never acts twice.

const URL_BASE = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const KEY = (import.meta.env.VITE_SUPABASE_KEY as string | undefined) ?? '';

export const configured = Boolean(URL_BASE && KEY);

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

type NetListener = (reconnecting: boolean) => void;
let netListener: NetListener = () => {};
export const onNetwork = (fn: NetListener) => { netListener = fn; };

const DELAYS = [0, 1000, 2000, 4000, 6000];
const TIMEOUT_MS = 12000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function request<T>(path: string, body: unknown, token?: string): Promise<T> {
  let last: unknown;
  for (let i = 0; i < DELAYS.length; i++) {
    if (DELAYS[i]) {
      netListener(true);
      await sleep(DELAYS[i]);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { apikey: KEY, 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${URL_BASE}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal, cache: 'no-store',
      });
      clearTimeout(timer);
      if (res.ok) {
        netListener(false);
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      const err = await res.json().catch(() => ({}));
      // Server busy or gateway trouble: retry. Anything else is a real answer.
      if (res.status >= 500 || res.status === 408 || res.status === 429) {
        last = new ApiError(err.message || res.statusText, res.status, err.code);
        continue;
      }
      netListener(false);
      throw new ApiError(err.message || err.msg || err.error_description || res.statusText, res.status, err.code);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ApiError) throw e;
      last = e;
    }
  }
  netListener(false);
  throw last instanceof Error ? last : new Error('network');
}

export const rpc = <T>(fn: string, args: Record<string, unknown>, token?: string) =>
  request<T>(`/rest/v1/rpc/${fn}`, args, token);

export const newKey = () =>
  (crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
