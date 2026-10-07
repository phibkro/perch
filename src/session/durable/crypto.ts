/** Node/web implementation. Metro selects crypto.native.ts on Android/iOS. */
export const operationId = (): string => `op_${globalThis.crypto.randomUUID()}`;

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
