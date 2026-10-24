import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api } from '@/lib/api';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import type { Conversation, Dot, Message } from '@/types';
import { colors, radius, spacing } from '@/theme';

export default function ChatScreen() {
  const { user } = useAuth();
  const [dots, setDots] = useState<Dot[]>([]);
  const [dotId, setDotId] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState('');
  const listRef = useRef<FlatList<Message>>(null);

  useEffect(() => {
    if (!user) return;
    let active = true;
    (async () => {
      try {
        const list = await api<Dot[]>('/dots');
        if (!active) return;
        setDots(list);
        setDotId((prev) => prev || list[0]?.id || '');
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : 'Could not load dots.');
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    if (!dotId) {
      setConversations([]);
      setConversationId(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const list = await api<Conversation[]>('/conversations');
        if (!active) return;
        setConversations(list.filter((c) => c.dotId === dotId));
        setConversationId(
          list.find((c) => c.dotId === dotId)?.id ?? null,
        );
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : 'Could not load chats.');
      }
    })();
    return () => {
      active = false;
    };
  }, [dotId]);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    const q = query(
      collection(db, 'conversations', conversationId, 'messages'),
      orderBy('createdAt', 'asc'),
    );
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...(docSnap.data() as Omit<Message, 'id'>),
        }));
        setMessages(list);
        setPending((p) =>
          p.filter(
            (m) =>
              !list.some(
                (x) => x.role === 'user' && x.content === m.content,
              ),
          ),
        );
      },
      (e) => setError(e.message),
    );
  }, [conversationId]);

  const send = async () => {
    const text = input.trim();
    if (!text || !dotId || sending) return;
    setError('');
    let threadId = conversationId;
    try {
      if (!threadId) {
        const conv = await api<Conversation>('/conversations', 'POST', {
          dotId,
          title: text.slice(0, 60),
        });
        threadId = conv.id;
        setConversations((prev) => [conv, ...prev]);
        setConversationId(conv.id);
      }
      const temp: Message = {
        id: `local-${Date.now()}`,
        role: 'user',
        content: text,
        createdAt: Date.now(),
      };
      setPending((p) => [...p, temp]);
      setInput('');
      setSending(true);
      await api(`/copilotkit/agent/${dotId}/run`, 'POST', {
        threadId,
        messages: [{ role: 'user', content: text }],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
      setPending((p) => p.filter((m) => m.content !== text));
    } finally {
      setSending(false);
    }
  };

  const visible = [...messages, ...pending];

  if (booting)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );

  if (!dots.length)
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>
          No dots yet. Create one in the web app first.
        </Text>
      </View>
    );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.dotRow}
        contentContainerStyle={styles.dotRowContent}
      >
        {dots.map((dot) => (
          <Pressable
            key={dot.id}
            style={[
              styles.chip,
              dotId === dot.id && styles.chipActive,
            ]}
            onPress={() => setDotId(dot.id)}
          >
            <Text
              style={[
                styles.chipText,
                dotId === dot.id && styles.chipTextActive,
              ]}
            >
              {dot.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {conversations.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.threadRow}
          contentContainerStyle={styles.dotRowContent}
        >
          {conversations.map((conv) => (
            <Pressable
              key={conv.id}
              style={[
                styles.threadChip,
                conversationId === conv.id && styles.chipActive,
              ]}
              onPress={() => setConversationId(conv.id)}
            >
              <Text style={styles.threadText} numberOfLines={1}>
                {conv.title}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      {error ? (
        <Text style={styles.error} numberOfLines={2}>
          {error}
        </Text>
      ) : null}
      <FlatList
        ref={listRef}
        data={visible}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.muted}>
              Say something to get your second brain going.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View
            style={[styles.bubble, item.role === 'user' ? styles.user : styles.assistant]}
          >
            <Text
              style={[
                styles.bubbleText,
                item.role === 'user' && styles.userText,
              ]}
            >
              {item.content}
            </Text>
          </View>
        )}
      />
      {sending && (
        <View style={styles.thinking}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={styles.muted}>Thinking…</Text>
        </View>
      )}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder="Message your dot…"
          placeholderTextColor={colors.muted}
          multiline
          maxLength={4000}
          value={input}
          onChangeText={setInput}
        />
        <Pressable
          style={[styles.send, (!input.trim() || sending) && styles.sendDisabled]}
          disabled={!input.trim() || sending}
          onPress={() => void send()}
        >
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  dotRow: { maxHeight: 52, marginTop: spacing.sm },
  dotRowContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    alignItems: 'center',
  },
  chip: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontWeight: '600' },
  chipTextActive: { color: colors.bg },
  threadRow: { maxHeight: 44, marginTop: spacing.xs },
  threadChip: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    maxWidth: 160,
  },
  threadText: { color: colors.muted, fontSize: 12 },
  error: {
    color: colors.danger,
    fontSize: 12,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  listContent: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1 },
  bubble: {
    maxWidth: '85%',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  user: {
    alignSelf: 'flex-end',
    backgroundColor: colors.accent,
  },
  assistant: {
    alignSelf: 'flex-start',
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bubbleText: { color: colors.text, lineHeight: 20 },
  userText: { color: colors.bg },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  muted: { color: colors.muted },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  input: {
    flex: 1,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    maxHeight: 120,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: colors.bg, fontSize: 20, fontWeight: '800' },
});
