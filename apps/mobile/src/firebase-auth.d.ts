import 'firebase/auth';
import type { Persistence, ReactNativeAsyncStorage } from 'firebase/auth';

// Firebase 10 publishes browser-only root typings, but its RN entry exports this
// function. Keep the exact SDK signature here rather than using an untyped cast.
declare module 'firebase/auth' {
  export function getReactNativePersistence(
    storage: ReactNativeAsyncStorage,
  ): Persistence;
}
