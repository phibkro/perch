import type { WireFrame } from '../vendor/omp/wire';

/** Synthetic public fixture, not a credential. Generated independently with Node/OpenSSL. */
export const REFERENCE_KEY = new Uint8Array(32).fill(0x11);
export const REFERENCE_NONCE = new Uint8Array(12).fill(0x22);
export const REFERENCE_FRAME: WireFrame = { t: 'abort' };
const REFERENCE_HEX = '2222222222222222222222226cd5736bfaedfe3d8a4daa1e354aaa33eafa07b1069b1eb07c28311c30';
export function referenceBytes(): Uint8Array {
  return Uint8Array.from(REFERENCE_HEX.match(/../g)!, pair => parseInt(pair, 16));
}
