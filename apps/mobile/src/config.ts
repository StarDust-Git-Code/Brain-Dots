import Constants from 'expo-constants';

type FirebaseExtra = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

const extra = Constants.expoConfig?.extra as
  | { firebase?: FirebaseExtra }
  | undefined;

export const FIREBASE_CONFIG: FirebaseExtra = {
  apiKey: extra?.firebase?.apiKey ?? '',
  authDomain: extra?.firebase?.authDomain ?? '',
  projectId: extra?.firebase?.projectId ?? '',
  appId: extra?.firebase?.appId ?? '',
};

export const API_BASE_URL = 'https://your-vercel-app.vercel.app';
