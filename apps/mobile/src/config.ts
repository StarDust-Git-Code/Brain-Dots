import Constants from 'expo-constants';

type FirebaseExtra = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

const extra = Constants.expoConfig?.extra as
  | { firebase?: FirebaseExtra; apiBaseUrl?: string }
  | undefined;

export const FIREBASE_CONFIG: FirebaseExtra = {
  apiKey: extra?.firebase?.apiKey ?? 'AIzaSyALRu24cp-2IzU2S8DMPuMgue1MD_X6xF4',
  authDomain: extra?.firebase?.authDomain ?? 'brain-dots-pvt.firebaseapp.com',
  projectId: extra?.firebase?.projectId ?? 'brain-dots-pvt',
  appId: extra?.firebase?.appId ?? '1:4686168926:web:c9985842b8a44912efc5cf',
};

export const API_BASE_URL = (extra?.apiBaseUrl as string) ?? 'https://brain-dots.vercel.app';
