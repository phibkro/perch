import { CryptoDigestAlgorithm, digest, randomUUID } from 'expo-crypto';

export const operationId = (): string => `op_${randomUUID()}`;

export async function sha256(bytes: Uint8Array): Promise<string> {
  const result = await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes).buffer);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
