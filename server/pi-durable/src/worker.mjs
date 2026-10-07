import { createBackend } from './backend.mjs';
import { productionRuntime } from './provider.mjs';

const backend = createBackend({ createRuntime: productionRuntime });
export const PerchCatalog = backend.PerchCatalog;
export const PerchSession = backend.PerchSession;
export default { fetch: backend.fetch };
