import type { HarnessCapabilities, HarnessMetadata } from '../session/types';

export const DEMO_HARNESS: HarnessMetadata = { id: 'demo', name: 'Demo', transport: 'simulation' };
export const OMP_HARNESS: HarnessMetadata = { id: 'omp', name: 'OMP', transport: 'omp-collab' };
export const PI_HARNESS: HarnessMetadata = { id: 'pi', name: 'pi', transport: 'pi-rpc' };
export const OPENCODE_HARNESS: HarnessMetadata = { id: 'opencode', name: 'OpenCode', transport: 'opencode-http' };
export const DURABLE_HARNESS: HarnessMetadata = { id: 'pi-durable', name: 'Pi Durable', transport: 'durable-http' };
export const REMOTE_HARNESS: HarnessMetadata = { id: 'omp', name: 'Remote sessions', transport: 'remote-http' };
export const DEMO_CAPABILITIES: HarnessCapabilities = { prompt: true, interrupt: true, questions: true, steer: false, attachments: false, modelSelection: false, sessionSelection: true, sessionCreation: true };
export const OMP_CAPABILITIES: HarnessCapabilities = { prompt: true, interrupt: true, questions: true, steer: false, attachments: false, modelSelection: false, sessionSelection: false, sessionCreation: false };
export const PI_CAPABILITIES: HarnessCapabilities = { prompt: true, interrupt: true, questions: true, steer: false, attachments: false, modelSelection: true, sessionSelection: false, sessionCreation: false };
export const OPENCODE_CAPABILITIES: HarnessCapabilities = { prompt: true, interrupt: true, questions: true, steer: false, attachments: false, modelSelection: true, sessionSelection: true, sessionCreation: true };
export const DURABLE_CAPABILITIES: HarnessCapabilities = { prompt: true, interrupt: true, questions: false, steer: false, attachments: false, modelSelection: true, sessionSelection: true, sessionCreation: true };
export const REMOTE_CAPABILITIES: HarnessCapabilities = { prompt: false, interrupt: false, questions: false, steer: false, attachments: false, modelSelection: false, sessionSelection: true, sessionCreation: false };
