'use client';

import { useState } from 'react';
import { signIn, signUp } from '../lib/client';
import { Button, Input } from './ui';

function friendlyError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.';
    case 'auth/email-already-in-use':
      return 'That email already has an account. Try signing in.';
    case 'auth/weak-password':
      return 'Password should be at least 6 characters.';
    case 'auth/invalid-email':
      return 'That email address looks invalid.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Try again shortly.';
    case 'auth/network-request-failed':
      return 'Network problem. Check your connection and try again.';
    default:
      return error instanceof Error ? error.message : 'Something went wrong. Try again.';
  }
}

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'in' | 'up' | null>(null);

  const submit = async (mode: 'in' | 'up') => {
    if (busy) return;
    setError(null);
    setBusy(mode);
    try {
      if (mode === 'in') {
        await signIn(email.trim(), password);
      } else {
        await signUp(email.trim(), password);
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="login-screen">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit('in');
        }}
      >
        <div className="login-brand">OpenDots</div>
        <h1 className="login-title">Your second brain</h1>
        <p className="login-sub">Sign in or create an account to start your second brain with Spaces, Dots, and Memories.</p>
        <label className="form-field">
          <span className="form-label">Email</span>
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
        </label>
        <label className="form-field">
          <span className="form-label">Password</span>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            required
            minLength={6}
          />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="login-actions">
          <Button type="submit" disabled={busy !== null}>
            {busy === 'in' ? 'Signing in…' : 'Sign in'}
          </Button>
          <Button variant="ghost" disabled={busy !== null} onClick={() => void submit('up')}>
            {busy === 'up' ? 'Creating…' : 'Create account'}
          </Button>
        </div>
      </form>
    </div>
  );
}
