/**
 * Perch native platform adapter for OMP's AES-256-GCM codec.
 * The wire layout is unchanged: [12-byte nonce][ciphertext][16-byte tag].
 * Uses Expo's native crypto implementation, not browser WebCrypto or custom AES.
 */
import { AESEncryptionKey, AESSealedData, aesEncryptAsync, aesDecryptAsync, getRandomBytes } from 'expo-crypto';
import type { WireFrame } from './wire';
import { REFERENCE_FRAME, REFERENCE_KEY, REFERENCE_NONCE, referenceBytes } from '../../session/crypto-vector';

export type RoomKey = AESEncryptionKey;

export function generateRoomKey(): Uint8Array { return getRandomBytes(32); }

export async function importRoomKey(raw: Uint8Array): Promise<RoomKey> {
  if (raw.byteLength !== 32) throw new Error('Room key must contain 32 bytes.');
  return AESEncryptionKey.import(raw);
}

export async function seal(key: RoomKey, frame: WireFrame): Promise<Uint8Array> {
  return sealWithNonce(key, frame, getRandomBytes(12));
}

async function sealWithNonce(key: RoomKey, frame: WireFrame, iv: Uint8Array): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode(JSON.stringify(frame));
  const sealed = await aesEncryptAsync(plaintext, key, { nonce: { bytes: iv }, tagLength: 16 });
  const encrypted = await sealed.ciphertext({ includeTag: true });
  const result = new Uint8Array(12 + encrypted.byteLength);
  result.set(iv); result.set(encrypted, 12);
  return result;
}

export async function open(key: RoomKey, data: Uint8Array): Promise<WireFrame> {
  if (data.byteLength < 29) throw new Error('Encrypted frame is too short.');
  const sealed = AESSealedData.fromParts(data.slice(0, 12), data.slice(12), 16);
  const plaintext = await aesDecryptAsync(sealed, key, { output: 'bytes' });
  return JSON.parse(new TextDecoder().decode(plaintext)) as WireFrame;
}

/** Checks native bytes against an independent Node/OpenSSL reference, without a network request. */
export async function verifyCodec(): Promise<void> {
  const key = await importRoomKey(REFERENCE_KEY);
  const encrypted = await sealWithNonce(key, REFERENCE_FRAME, REFERENCE_NONCE);
  const reference = referenceBytes();
  if (encrypted.length !== reference.length || !encrypted.every((byte, index) => byte === reference[index])) throw new Error('Native AES-GCM wire compatibility check failed.');
  const frame = await open(key, reference);
  if (frame.t !== 'abort') throw new Error('Native AES-GCM decryption compatibility check failed.');
}
