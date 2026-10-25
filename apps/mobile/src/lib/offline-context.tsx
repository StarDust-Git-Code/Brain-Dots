import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import type { Page } from '../types';
import { api } from './api';
import { useAuth } from './auth-context';
import { UserCache, pageKey, pagesKey } from './cache';
import { auth } from './firebase';
import { PageSaveQueue, type PageDraft, type QueueSnapshot } from './page-save-queue';

interface OfflineState {
  online: boolean;
  cache: UserCache | null;
  queue: PageSaveQueue | null;
}

const OfflineContext = createContext<OfflineState>({ online: true, cache: null, queue: null });
const EMPTY: QueueSnapshot = { drafts: {}, storageError: '' };
const noSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid;
  const [online, setOnline] = useState(true);
  const onlineRef = useRef(online);
  // Reuse the same writer when this account signs out/in during an in-flight
  // save. Two queues for one UID could otherwise overwrite each other's drafts.
  const accounts = useRef(new Map<string, Pick<OfflineState, 'cache' | 'queue'>>());
  onlineRef.current = online;
  const resources = useMemo(() => {
    if (!uid) return { cache: null, queue: null };
    const existing = accounts.current.get(uid);
    if (existing) return existing;
    const cache = new UserCache(AsyncStorage, uid);
    const cachePage = async (page: Page) => {
      await cache.write(pageKey(page.spaceId, page.id), page);
      await cache.update<Page[]>(pagesKey(page.spaceId), (list) => {
        const previous = list ?? [];
        return previous.some((item) => item.id === page.id)
          ? previous.map((item) => item.id === page.id ? page : item)
          : [page, ...previous];
      });
    };
    const path = (spaceId: string, pageId: string) =>
      `/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`;
    const queue = new PageSaveQueue({
      load: () => cache.read<Record<string, PageDraft>>('page-drafts'),
      save: (drafts) => cache.write('page-drafts', drafts),
      cachePage,
    }, {
      canSync: () => onlineRef.current && auth.currentUser?.uid === uid,
      load: (spaceId, pageId) => api<Page>(path(spaceId, pageId), 'GET', undefined, { uid }),
      save: (draft) => api<Page>(path(draft.base.spaceId, draft.base.id), 'PATCH', {
        title: draft.title, content: draft.content, expectedRevision: draft.base.revision,
      }, { uid }),
    });
    const account = { cache, queue };
    accounts.current.set(uid, account);
    return account;
  }, [uid]);

  useEffect(() => NetInfo.addEventListener((state) => {
    const connected = state.isConnected !== false && state.isInternetReachable !== false;
    onlineRef.current = connected;
    setOnline(connected);
  }), []);

  useEffect(() => {
    const queue = resources.queue;
    if (!queue) return;
    const sync = () => { void queue.flush().catch(() => {}); };
    sync();
    const timer = setInterval(sync, 15000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') sync();
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [resources.queue, online]);

  return <OfflineContext.Provider value={{ ...resources, online }}>{children}</OfflineContext.Provider>;
}

export const useOffline = () => useContext(OfflineContext);

export function useDrafts(): QueueSnapshot {
  const { queue } = useOffline();
  return useSyncExternalStore(queue?.subscribe ?? noSubscribe, queue?.getSnapshot ?? emptySnapshot, emptySnapshot);
}
