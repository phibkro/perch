import * as SecureStore from 'expo-secure-store';
import { secureWorkspacePersistence } from './persistence';

const options: SecureStore.SecureStoreOptions = { keychainService: 'dev.perch.assistant.workspaces', keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const workspacePersistence = secureWorkspacePersistence({
  get: key => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  remove: key => SecureStore.deleteItemAsync(key, options),
});
