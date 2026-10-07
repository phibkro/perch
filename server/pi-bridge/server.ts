import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startBridge } from './bridge';

const cli = resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
function args(): string[] {
  const value: unknown = JSON.parse(process.env.PI_ARGS_JSON ?? '[]');
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) throw new Error('PI_ARGS_JSON must be a JSON array of CLI arguments.');
  if (value.includes('--mode')) throw new Error('The bridge owns --mode rpc; remove --mode from PI_ARGS_JSON.');
  return value;
}
const bridge = await startBridge({
  token: process.env.PERCH_BRIDGE_TOKEN ?? '',
  binary: process.env.PI_BIN || process.execPath,
  args: [...(process.env.PI_BIN ? [] : [cli]), ...args(), '--mode', 'rpc'],
  cwd: resolve(process.env.PI_CWD ?? process.cwd()),
  version: process.env.PI_BIN ? undefined : '1.0.4',
  host: process.env.PERCH_BRIDGE_HOST ?? '127.0.0.1',
  port: Number(process.env.PERCH_BRIDGE_PORT ?? '8787'),
  allowedOrigins: (process.env.PERCH_ALLOWED_ORIGINS ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
});
const address = bridge.address;
console.log(`Perch pi bridge ready at ${typeof address === 'object' && address ? `${address.address}:${address.port}` : address}/session. Token is not logged.`);
const stop = () => { void bridge.close().then(() => process.exit(0)); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
