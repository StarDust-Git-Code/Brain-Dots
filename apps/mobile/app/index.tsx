import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '@/lib/auth-context';
import { colors, spacing } from '@/theme';

export default function Index() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.brand}>OpenDots</Text>
      </View>
    );
  if (!user) return <Redirect href="/login" />;
  return <Redirect href="/(tabs)/chat" />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    gap: spacing.md,
  },
  brand: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
});
