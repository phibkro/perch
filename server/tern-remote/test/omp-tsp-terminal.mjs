/**
 * A protocol recorder for the opt-in OMP owner-request verifier.
 * It uses OMP's actual reference document to apply frames. It is not a Tern
 * window, a VT emulator, or a production remote-control implementation.
 */
export class OmpTspTerminal {
  columns = 120;
  rows = 48;
  kittyProtocolActive = false;
  kittyEnableSequence = null;
  tspExpected = true;
  tspProbePending = true;
  appearance = 'dark';
  documents = new Map();
  errors = [];
  events = [];
  surface;
  #onInput;
  #hello;
  #helloHandlers = [];
  #chunks = new Map();
  #TspDocument;
  #splitTspMessage;
  #kinds;

  constructor({ TspDocument, splitTspMessage, kinds }) {
    this.#TspDocument = TspDocument;
    this.#splitTspMessage = splitTspMessage;
    this.#kinds = kinds;
  }

  start(onInput) {
    this.#onInput = onInput;
    queueMicrotask(() => {
      if (!this.#onInput) return;
      this.tspProbePending = false;
      this.#hello = { r: 'hello', v: 1, term: 'perch-upstream-verifier',
        kinds: this.#kinds, features: ['dock'], credits: 64, cols: this.columns,
        dark: true, reduceMotion: true };
      for (const handler of this.#helloHandlers) handler(this.#hello);
    });
  }

  onTspHello(handler) { this.#helloHandlers.push(handler); if (this.#hello) handler(this.#hello); }
  stop() { this.#onInput = undefined; this.#helloHandlers = []; }
  async drainInput() {}
  event(event) {
    this.events.push(structuredClone(event));
    this.#onInput?.(`\x1b_tsp;e;${JSON.stringify(event)}\x1b\\`);
  }

  write(data) {
    let offset = 0;
    for (;;) {
      const start = data.indexOf('\x1b_tsp;', offset);
      if (start < 0) return;
      const end = data.indexOf('\x1b\\', start);
      if (end < 0) throw new Error('OMP wrote an incomplete TSP message.');
      const raw = this.#splitTspMessage(data.slice(start, end + 2));
      if (!raw) throw new Error('OMP wrote an invalid TSP message.');
      let text = raw.body;
      if (raw.params.c !== undefined) {
        text = (this.#chunks.get(raw.params.c) ?? '') + text;
        if (raw.params.m === '1') { this.#chunks.set(raw.params.c, text); offset = end + 2; continue; }
        this.#chunks.delete(raw.params.c);
      }
      const body = raw.verb === 'b' ? undefined : JSON.parse(text);
      if (raw.verb === 'o') {
        this.documents.set(body.id, new this.#TspDocument(body.id));
        this.surface = body.id;
      } else if (raw.verb === 'f') {
        const doc = this.documents.get(body.sf);
        if (!doc) throw new Error('OMP sent a frame for an unopened surface.');
        this.errors.push(...doc.applyFrame(body));
        queueMicrotask(() => this.#onInput?.(`\x1b_tsp;e;${JSON.stringify({ ev: 'ack', sf: body.sf, s: body.s })}\x1b\\`));
      } else if (raw.verb === 'x') {
        if (body.keep) this.documents.get(body.id)?.close(); else this.documents.delete(body.id);
        if (this.surface === body.id) this.surface = [...this.documents.keys()].at(-1);
      } else if (raw.verb === 'q' && body.q === 'blobs') {
        queueMicrotask(() => this.#onInput?.('\x1b_tsp;r;{"r":"blobs","have":[]}\x1b\\'));
      }
      offset = end + 2;
    }
  }

  snapshot() { return this.documents.get(this.surface)?.snapshot(); }
  find(predicate) {
    const visit = node => {
      if (!node) return undefined;
      if (predicate(node)) return node;
      for (const child of node.c ?? []) { const found = visit(child); if (found) return found; }
    };
    return visit(this.snapshot());
  }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  onAppearanceChange() {}
}
