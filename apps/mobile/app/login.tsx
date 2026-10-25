import { Redirect } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { signIn, signUp } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { colors, radius, spacing } from '@/theme';

export default function Login() {
  const { user, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);

  const run = async (mode: 'in' | 'up') => {
    if (busyRef.current) return;
    if (!email.trim() || password.length < 6) {
      setError(!email.trim() ? 'Enter your email address.' : 'Password must be at least 6 characters.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (mode === 'in') await signIn(email.trim(), password);
      else await signUp(email.trim(), password);
    } catch (e) {
      setError(
        e instanceof Error ? friendly(e.message) : 'Could not sign in.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (loading) return <View style={styles.screen}><ActivityIndicator color={colors.accent} /></View>;
  if (user) return <Redirect href="/(tabs)/chat" />;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.brand}>Brain-Dots</Text>
        <Text style={styles.tag}>Your second brain, in your pocket.</Text>
        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          editable={!busy}
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.muted}
          secureTextEntry
          editable={!busy}
          value={password}
          onChangeText={setPassword}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          disabled={busy}
          onPress={() => void run('in')}
        >
          {busy ? (
            <ActivityIndicator color={colors.bg} />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonGhost, busy && styles.buttonDisabled]}
          disabled={busy}
          onPress={() => void run('up')}
        >
          <Text style={styles.buttonGhostText}>Create account</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function friendly(message: string): string {
  if (message.includes('invalid-credential') || message.includes('wrong-password'))
    return 'Incorrect email or password.';
  if (message.includes('email-already-in-use'))
    return 'That email already has an account. Sign in instead.';
  if (message.includes('invalid-email')) return 'Enter a valid email address.';
  if (message.includes('weak-password'))
    return 'Password must be at least 6 characters.';
  if (message.includes('network')) return 'Network error. Check your connection.';
  return message;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    backgroundColor: colors.panel,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    gap: spacing.md,
  },
  brand: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '800',
    textAlign: 'center',
  },
  tag: {
    color: colors.muted,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.panel2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  error: {
    color: colors.danger,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: colors.bg,
    fontWeight: '700',
  },
  buttonGhost: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonGhostText: {
    color: colors.accent,
    fontWeight: '600',
  },
});
