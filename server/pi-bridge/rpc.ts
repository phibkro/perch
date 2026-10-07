import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import { record } from '../../src/harness/protocol';

/** Strict LF-delimited RPC subprocess I/O; Unicode U+2028 is message content. */
export class PiRpc extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private exited = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(binary: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
    super();
    this.child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child.stdout.on('data', (bytes: Buffer) => {
      this.buffer += this.decoder.write(bytes);
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) return this.fail(new Error('pi emitted an oversized RPC record.'));
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, ''); this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        try {
          const event: unknown = JSON.parse(line);
          if (!record(event) || typeof event.type !== 'string') throw new Error('Invalid RPC record.');
          if (event.type === 'response' && typeof event.id === 'string' && this.pending.has(event.id)) {
            const request = this.pending.get(event.id)!; this.pending.delete(event.id); clearTimeout(request.timer);
            if (event.success === true) request.resolve(event.data);
            else request.reject(new Error(typeof event.error === 'string' ? event.error : 'pi rejected the command.'));
          } else this.emit('record', event);
        } catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid pi RPC output.')); return; }
      }
    });
    // Drain continuously, but do not relay potentially sensitive server diagnostics to clients.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(new Error('The pi input stream closed.')));
    this.child.on('error', () => this.fail(new Error('Could not start pi. Check the bridge binary and working directory.')));
    this.child.on('exit', (code, signal) => this.fail(new Error(`pi exited (${signal ?? code ?? 'unknown'}). Restart the bridge to resume a configured session.`)));
  }
  private fail(error: Error) {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('failure', error);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
  }
  write(record: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const next = this.writing.then(() => new Promise<void>((resolve, reject) => {
      if (this.exited || !this.child.stdin.writable) { reject(new Error('pi is not running.')); return; }
      // The write callback waits until the complete record has been accepted by the pipe.
      this.child.stdin.write(line, error => error ? reject(error) : resolve());
    }));
    this.writing = next.catch(() => {}); return next;
  }
  command(type: string, fields: Record<string, unknown> = {}, timeout = 120_000): Promise<unknown> {
    const id = `bridge:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('pi did not acknowledge this command before the deadline. It may have been accepted; check the session before trying again.')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...fields, type, id }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 2000);
    const hard = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    await new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    clearTimeout(timer); clearTimeout(hard);
  }
}
