/** Web/Node build: unchanged upstream WebCrypto codec, with a named key type. */
export { generateRoomKey, importRoomKey, seal, open } from './codec.web.reference';
export type RoomKey = CryptoKey;
import { importRoomKey, open } from './codec.web.reference';
import { REFERENCE_KEY, referenceBytes } from '../../session/crypto-vector';

export async function verifyCodec(): Promise<void> {
  const key = await importRoomKey(REFERENCE_KEY);
  const frame = await open(key, referenceBytes());
  if (frame.t !== 'abort') throw new Error('AES-GCM compatibility check failed.');
}
