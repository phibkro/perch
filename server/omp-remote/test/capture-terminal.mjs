/** The real OMP TUI writes here; this is an output recorder, not a VT emulator. */
export class CaptureTerminal {
  columns = 120;
  rows = 48;
  kittyProtocolActive = false;
  kittyEnableSequence = null;
  output = '';
  start(onInput, onResize) { this.onInput = onInput; this.onResize = onResize; }
  stop() { this.onInput = undefined; this.onResize = undefined; }
  async drainInput() {}
  write(text) { this.output = (this.output + text).slice(-4_000_000); }
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
