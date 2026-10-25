import { FirebaseError, getApp, getApps, initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  initializeAuth,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { FIREBASE_CONFIG } from '../config';
import { authPersistence } from './auth-persistence';

export const app = getApps().length ? getApp() : initializeApp(FIREBASE_CONFIG);

function createAuth(): Auth {
  try {
    return initializeAuth(app, { persistence: authPersistence });
  } catch (error) {
    // Fast Refresh can run initialization again. Do not mask other auth errors.
    if (error instanceof FirebaseError && error.code === 'auth/already-initialized')
      return getAuth(app);
    throw error;
  }
}

export const auth = createAuth();

// The Firebase JS SDK uses memory here. IndexedDB persistence is not supported
// in React Native; offline pages/tasks/drafts use our explicit AsyncStorage cache.
export const db = getFirestore(app);

export async function signIn(email: string, password: string): Promise<User> {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signUp(email: string, password: string): Promise<User> {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}
