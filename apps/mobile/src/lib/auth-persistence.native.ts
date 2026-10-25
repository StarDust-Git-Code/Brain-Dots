import AsyncStorage from '@react-native-async-storage/async-storage';
import { getReactNativePersistence } from 'firebase/auth';

// Metro selects Firebase's React Native entry; auth sessions survive app restarts.
export const authPersistence = getReactNativePersistence(AsyncStorage);
