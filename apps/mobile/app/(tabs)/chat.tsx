import { useIsFocused } from '@react-navigation/native';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { chatScope, matchTurn, mergeMessages, renderMessages, ScopeGuard, type ChatBubble, type PendingTurn } from '@/lib/chat-messages';
import { db } from '@/lib/firebase';
import { useOffline } from '@/lib/offline-context';
import type { Conversation, Dot, Message } from '@/types';
import { colors, radius, spacing } from '@/theme';

type Selection = { dotId: string; threadId: string | null };
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Request failed. Please retry.';

export default function ChatScreen() {
  const { user } = useAuth();
  const uid = user?.uid ?? '';
  const focused = useIsFocused();
  const { online } = useOffline();
  const [dots, setDots] = useState<Dot[]>([]);
  const [selection, setSelection] = useState<Selection>({ dotId: '', threadId: null });
  const selected = useRef(selection);
  const guard = useRef(new ScopeGuard());
  const scope = chatScope(uid, selection.dotId, selection.threadId);
  guard.current.select(scope);
  const [conversations, setConversations] = useState<{ dotId: string; list: Conversation[]; loading: boolean; error: string }>({ dotId: '', list: [], loading: false, error: '' });
  const [history, setHistory] = useState<{ scope: string; messages: Message[] }>({ scope, messages: [] });
  const messagesRef = useRef<Message[]>([]);
  const [turns, setTurns] = useState<PendingTurn[]>([]);
  const [input, setInput] = useState('');
  const inputRef = useRef('');
  const inputDrafts = useRef(new Map<string, string>());
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [dotsReload, setDotsReload] = useState(0);
  const [chatsReload, setChatsReload] = useState(0);
  const [messageState, setMessageState] = useState({ scope, loading: false, error: '', liveError: '' });
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const locks = useRef(new Set<string>());
  const [busyScopes, setBusyScopes] = useState(new Set<string>());
  const mounted = useRef(true);
  const listRef = useRef<FlatList<ChatBubble>>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const choose = useCallback((next: Selection) => {
    const old = selected.current;
    inputDrafts.current.set(chatScope(uid, old.dotId, old.threadId), inputRef.current);
    selected.current = next;
    const nextScope = chatScope(uid, next.dotId, next.threadId);
    guard.current.select(nextScope); // Synchronous invalidation before the next render.
    messagesRef.current = [];
    const draft = inputDrafts.current.get(nextScope) ?? '';
    inputRef.current = draft;
    setInput(draft);
    setSelection(next);
  }, [uid]);

  useEffect(() => {
    if (!uid) return;
    let active = true;
    setBooting(true);
    setBootError('');
    void api<Dot[]>('/dots', 'GET', undefined, { uid }).then((list) => {
      if (!active) return;
      setDots(list);
      if (!list.some((dot) => dot.id === selected.current.dotId))
        choose({ dotId: list[0]?.id ?? '', threadId: null });
    }).catch((error: unknown) => { if (active) setBootError(errorText(error)); })
      .finally(() => { if (active) setBooting(false); });
    return () => { active = false; };
  }, [uid, dotsReload, choose]);

  useEffect(() => {
    const dotId = selection.dotId;
    if (!dotId) return;
    let active = true;
    const token = guard.current.capture();
    setConversations((previous) => ({ dotId, list: previous.dotId === dotId ? previous.list : [], loading: true, error: '' }));
    void api<Conversation[]>('/conversations', 'GET', undefined, { uid }).then((all) => {
      if (!active || !guard.current.isCurrent(token)) return;
      const list = all.filter((conversation) => conversation.dotId === dotId);
      setConversations({ dotId, list, loading: false, error: '' });
      const threadId = list.some((conversation) => conversation.id === selected.current.threadId)
        ? selected.current.threadId : list[0]?.id ?? null;
      if (threadId !== selected.current.threadId) choose({ dotId, threadId });
    }).catch((error: unknown) => {
      if (active && guard.current.isCurrent(token))
        setConversations((previous) => ({ ...previous, loading: false, error: errorText(error) }));
    });
    return () => { active = false; };
  }, [selection.dotId, chatsReload, uid, choose]);

  const refreshMessages = useCallback(async () => {
    const current = selected.current;
    if (!current.threadId || !uid || !online) return;
    const token = guard.current.capture();
    const capturedScope = chatScope(uid, current.dotId, current.threadId);
    try {
      const incoming = await api<Message[]>(`/conversations/${encodeURIComponent(current.threadId)}/messages`, 'GET', undefined, { uid });
      if (!mounted.current || !guard.current.isCurrent(token)) return;
      const merged = mergeMessages(messagesRef.current, incoming);
      messagesRef.current = merged;
      setHistory({ scope: capturedScope, messages: merged });
      setMessageState((previous) => ({ ...previous, scope: capturedScope, loading: false, error: '' }));
      return merged;
    } catch (error) {
      if (mounted.current && guard.current.isCurrent(token))
        setMessageState((previous) => ({ ...previous, scope: capturedScope, loading: false, error: errorText(error) }));
    }
  }, [uid, online]);

  useEffect(() => {
    if (!selection.threadId || !focused || !online) return;
    let active = true;
    const token = guard.current.capture();
    setMessageState({ scope, loading: true, error: '', liveError: '' });
    void refreshMessages();
    const q = query(collection(db, 'conversations', selection.threadId, 'messages'), orderBy('createdAt', 'asc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!active || !guard.current.isCurrent(token)) return;
      const incoming: Message[] = snapshot.docs.flatMap((document) => {
        const data = document.data();
        if ((data.role !== 'user' && data.role !== 'assistant') || typeof data.content !== 'string') return [];
        const createdAt = typeof data.createdAt === 'number' ? data.createdAt : data.createdAt?.toMillis?.();
        if (typeof createdAt !== 'number') return [];
        return [{ id: document.id, role: data.role, content: data.content, createdAt }];
      });
      // Append-only history is merged by identity. A cache snapshot arriving
      // after REST must not erase a newer API response or duplicate its bubbles.
      const merged = mergeMessages(messagesRef.current, incoming);
      messagesRef.current = merged;
      setHistory({ scope, messages: merged });
    }, (error) => {
      if (active && guard.current.isCurrent(token))
        setMessageState((previous) => ({ ...previous, scope, liveError: error.message }));
    });
    // Authenticated REST remains a working fallback when Firestore rules deny
    // a live subscription or the stream is temporarily unavailable.
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void refreshMessages().finally(() => { polling = false; });
    }, 10000);
    return () => { active = false; unsubscribe(); clearInterval(timer); };
  }, [scope, selection.threadId, focused, online, refreshMessages]);

  const newChat = async () => {
    const dotId = selected.current.dotId;
    if (!dotId || !online || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    guard.current.invalidate(); // Initial thread loading must not hijack New Chat.
    const token = guard.current.capture();
    try {
      const conversation = await api<Conversation>('/conversations', 'POST', { dotId, title: 'New chat' }, { uid });
      if (!mounted.current || selected.current.dotId !== dotId) return;
      setConversations((previous) => ({ dotId, list: [conversation, ...(previous.dotId === dotId ? previous.list : [])], loading: false, error: '' }));
      if (guard.current.isCurrent(token)) choose({ dotId, threadId: conversation.id });
    } catch (error) {
      if (mounted.current && guard.current.isCurrent(token))
        setConversations((previous) => ({ ...previous, dotId, loading: false, error: errorText(error) }));
    } finally {
      creatingRef.current = false;
      if (mounted.current) setCreating(false);
    }
  };

  const send = async (retry?: PendingTurn) => {
    const current = selected.current;
    const text = retry?.content ?? inputRef.current.trim();
    if (!text || !current.threadId || !current.dotId || !online) return;
    const capturedScope = chatScope(uid, current.dotId, current.threadId);
    if (retry && retry.scope !== capturedScope) return;
    if (!retry && (messageState.scope !== capturedScope || messageState.loading)) return;
    if (locks.current.has(capturedScope)) return;
    locks.current.add(capturedScope);
    setBusyScopes(new Set(locks.current));
    const token = guard.current.capture();
    let turn: PendingTurn | null = null;
    try {
      let baseline = messagesRef.current;
      if (retry) {
        // An interrupted HTTP response may already have persisted a full turn.
        // Check before resubmitting; failure to check keeps the failed draft.
        baseline = await api<Message[]>(`/conversations/${encodeURIComponent(current.threadId)}/messages`, 'GET', undefined, { uid });
        if (!mounted.current || !guard.current.isCurrent(token)) return;
        messagesRef.current = mergeMessages(messagesRef.current, baseline);
        setHistory({ scope: capturedScope, messages: messagesRef.current });
        const persisted = matchTurn(baseline, retry);
        if (persisted.user && persisted.assistant) {
          setTurns((previous) => previous.map((item) => item.id === retry.id ? { ...item, status: 'sent', reply: persisted.assistant!.content, error: undefined } : item));
          return;
        }
      }
      turn = {
        id: `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        scope: capturedScope, content: text, startedAt: Date.now(),
        baselineIds: baseline.map((message) => message.id), status: 'sending',
      };
      const sendingTurn = turn;
      if (mounted.current) setTurns((previous) => [...previous.filter((item) => item.id !== retry?.id), sendingTurn]);
      if (!retry && guard.current.isCurrent(token)) {
        inputRef.current = '';
        inputDrafts.current.set(capturedScope, '');
        setInput('');
      }
      const result = await api<{ text: string }>(`/copilotkit/agent/${encodeURIComponent(current.dotId)}/run`, 'POST', {
        threadId: current.threadId, messages: [{ role: 'user', content: text }],
      }, { uid, timeoutMs: 110000 });
      if (mounted.current) setTurns((previous) => previous.map((item) => item.id === sendingTurn.id ? { ...item, status: 'sent', reply: result.text, error: undefined } : item));
      if (guard.current.isCurrent(token)) await refreshMessages();
    } catch (error) {
      const failedId = turn?.id ?? retry?.id;
      if (mounted.current && failedId) setTurns((previous) => previous.map((item) => item.id === failedId ? { ...item, status: 'failed', error: errorText(error) } : item));
    } finally {
      locks.current.delete(capturedScope);
      if (mounted.current) setBusyScopes(new Set(locks.current));
    }
  };

  const messages = history.scope === scope ? history.messages : [];
  const visible = renderMessages(messages, turns, scope);
  const chats = conversations.dotId === selection.dotId ? conversations : { list: [], loading: true, error: '' };
  const messageError = messageState.scope === scope ? messageState.error : '';
  const loadingMessages = Boolean(selection.threadId) && (messageState.scope !== scope || messageState.loading);
  const sending = busyScopes.has(scope);
  const canSend = Boolean(input.trim() && selection.threadId && online && !sending && !loadingMessages);

  if (booting) return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.heading}>Chat</Text>
        <Pressable disabled={!selection.dotId || !online || creating} onPress={() => void newChat()}><Text style={styles.link}>{creating ? 'Creating…' : '＋ New Chat'}</Text></Pressable>
      </View>
      {bootError ? <View style={styles.errorRow}><Text style={styles.error}>{bootError}</Text><Pressable onPress={() => setDotsReload((value) => value + 1)}><Text style={styles.link}>Retry loading Dots</Text></Pressable></View> : null}
      {!online ? <Text style={styles.note}>Offline · reconnect to send or load chats</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dotRow} contentContainerStyle={styles.rowContent}>
        {dots.map((dot) => <Pressable key={dot.id} style={[styles.chip, selection.dotId === dot.id && styles.chipActive]} onPress={() => { if (selected.current.dotId !== dot.id) choose({ dotId: dot.id, threadId: null }); }}><Text style={[styles.chipText, selection.dotId === dot.id && styles.chipTextActive]}>{dot.name}</Text></Pressable>)}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.threadRow} contentContainerStyle={styles.rowContent}>
        {chats.list.map((conversation) => <Pressable key={conversation.id} style={[styles.threadChip, selection.threadId === conversation.id && styles.chipActive]} onPress={() => { if (selected.current.threadId !== conversation.id) choose({ dotId: selection.dotId, threadId: conversation.id }); }}><Text style={[styles.threadText, selection.threadId === conversation.id && styles.chipTextActive]} numberOfLines={1}>{conversation.title}</Text></Pressable>)}
      </ScrollView>
      {chats.error ? <View style={styles.errorRow}><Text style={styles.error}>{chats.error}</Text><Pressable onPress={() => setChatsReload((value) => value + 1)}><Text style={styles.link}>Retry chats</Text></Pressable></View> : null}
      {messageError ? <View style={styles.errorRow}><Text style={styles.error}>{messageError}</Text><Pressable onPress={() => void refreshMessages()}><Text style={styles.link}>Retry messages</Text></Pressable></View> : null}
      {messageState.scope === scope && messageState.liveError ? <Text style={styles.note}>Live updates unavailable · syncing through the API</Text> : null}
      <FlatList ref={listRef} data={visible} keyExtractor={(item) => item.id} contentContainerStyle={styles.listContent} onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })} ListEmptyComponent={<View style={styles.center}><Text style={styles.muted}>{!dots.length ? 'No Dots yet. Create a Dot in the web app, then retry.' : chats.loading || loadingMessages ? 'Loading chat…' : !selection.threadId ? 'Tap New Chat to start a conversation.' : 'Say something to get your second brain going.'}</Text>{!dots.length ? <Pressable onPress={() => setDotsReload((value) => value + 1)}><Text style={styles.link}>Refresh Dots</Text></Pressable> : null}</View>} renderItem={({ item }) => (
        <View style={[styles.bubble, item.role === 'user' ? styles.user : styles.assistant]}>
          <Text style={[styles.bubbleText, item.role === 'user' && styles.userText]}>{item.content}</Text>
          {item.sendStatus === 'failed' ? <View style={styles.failed}><Text style={styles.failedText}>{item.error || 'Send failed. Message retained.'}</Text><Pressable disabled={!online || sending} onPress={() => { const turn = turns.find((entry) => entry.id === item.turnId); if (turn) void send(turn); }}><Text style={styles.retryText}>Retry</Text></Pressable></View> : null}
        </View>
      )} />
      {sending ? <View style={styles.thinking}><ActivityIndicator size="small" color={colors.accent} /><Text style={styles.muted}>Thinking…</Text></View> : null}
      <View style={styles.composer}>
        <TextInput style={styles.input} placeholder={selection.threadId ? 'Message your dot…' : 'Create or select a chat first'} placeholderTextColor={colors.muted} multiline maxLength={4000} value={input} onChangeText={(text) => { inputRef.current = text; setInput(text); }} />
        <Pressable style={[styles.send, !canSend && styles.sendDisabled]} disabled={!canSend} onPress={() => void send()}><Text style={styles.sendText}>↑</Text></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.lg },
  heading: { color: colors.text, fontSize: 24, fontWeight: '800' },
  link: { color: colors.accent, fontWeight: '600', fontSize: 12 },
  dotRow: { maxHeight: 44 },
  threadRow: { maxHeight: 42, marginTop: spacing.xs },
  rowContent: { paddingHorizontal: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  chip: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2 },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontWeight: '600' },
  chipTextActive: { color: colors.bg },
  threadChip: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, maxWidth: 160 },
  threadText: { color: colors.text, fontSize: 12 },
  errorRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xs, gap: spacing.xs },
  error: { color: colors.danger, fontSize: 12 },
  note: { color: colors.muted, fontSize: 12, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  listContent: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1 },
  bubble: { maxWidth: '85%', borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  user: { alignSelf: 'flex-end', backgroundColor: colors.accent },
  assistant: { alignSelf: 'flex-start', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  bubbleText: { color: colors.text, lineHeight: 20 },
  userText: { color: colors.bg },
  failed: { borderTopWidth: 1, borderTopColor: colors.bg, paddingTop: spacing.sm, marginTop: spacing.sm, gap: spacing.sm },
  failedText: { color: colors.bg, fontSize: 12 },
  retryText: { color: colors.bg, fontSize: 12, fontWeight: '800' },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.xs },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, padding: spacing.lg },
  input: { flex: 1, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, color: colors.text, padding: spacing.md, maxHeight: 120 },
  send: { backgroundColor: colors.accent, borderRadius: radius.sm, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: colors.bg, fontSize: 20, fontWeight: '800' },
});
