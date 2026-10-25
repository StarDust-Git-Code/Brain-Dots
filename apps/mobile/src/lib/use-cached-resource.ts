import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth-context';
import { useOffline } from './offline-context';

interface ResourceState<T> {
  scope: string;
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  fromCache: boolean;
  error: string;
}

// Hydrate from AsyncStorage first, refresh over the authenticated API, and keep
// cached data visible after network failure. Scope/generation checks protect
// account changes and fast space/task switching from older responses.
export function useCachedResource<T>(path: string | null, key: string | null) {
  const { user } = useAuth();
  const { cache, online } = useOffline();
  const uid = user?.uid;
  const scope = `${uid ?? ''}:${key ?? ''}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const generation = useRef(0);
  const [state, setState] = useState<ResourceState<T>>({
    scope, data: null, loading: true, refreshing: false, fromCache: false, error: '',
  });

  const refresh = useCallback(async () => {
    if (!uid || !cache || !path || !key) return;
    const captured = scope;
    const version = ++generation.current;
    const current = () => scopeRef.current === captured && generation.current === version;
    setState((previous) => ({
      ...previous, scope: captured, data: previous.scope === captured ? previous.data : null,
      loading: previous.scope !== captured || previous.data === null,
      refreshing: true, error: '',
    }));
    let cached: T | null = null;
    let storageError = '';
    try {
      cached = await cache.read<T>(key);
      if (current() && cached !== null)
        setState({ scope: captured, data: cached, loading: false, refreshing: true, fromCache: true, error: '' });
    } catch (error) {
      storageError = error instanceof Error ? error.message : 'Local cache unavailable.';
    }
    if (!current()) return;
    if (!online) {
      setState((previous) => ({ ...previous, loading: false, refreshing: false, fromCache: true,
        error: cached === null ? 'Offline. Connect once to download this data.' : storageError }));
      return;
    }
    try {
      const data = await api<T>(path, 'GET', undefined, { uid });
      if (!current()) return;
      try { await cache.write(key, data); }
      catch { storageError = 'Loaded online, but could not store a local copy.'; }
      if (current()) setState({ scope: captured, data, loading: false, refreshing: false, fromCache: false, error: storageError });
    } catch (error) {
      if (current()) setState((previous) => ({ ...previous, loading: false, refreshing: false,
        fromCache: previous.data !== null,
        error: error instanceof Error ? error.message : 'Could not refresh. Cached data is retained.' }));
    }
  }, [uid, cache, path, key, scope, online]);

  useEffect(() => {
    if (!path || !key || !uid) {
      setState({ scope, data: null, loading: false, refreshing: false, fromCache: false, error: '' });
      return;
    }
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh, path, key, uid, scope]);

  useEffect(() => {
    if (!cache || !key) return;
    let active = true;
    const unsubscribe = cache.subscribe(key, () => {
      void cache.read<T>(key).then((data) => {
        if (active && scopeRef.current === scope && data !== null)
          setState((previous) => ({ ...previous, scope, data, loading: false }));
      }).catch(() => {});
    });
    return () => { active = false; unsubscribe(); };
  }, [cache, key, scope]);

  const visible = state.scope === scope ? state : {
    scope, data: null, loading: Boolean(path), refreshing: false, fromCache: false, error: '',
  };
  return { ...visible, refresh };
}
