export class RuntimeExitedError extends Error {}

export function assertRuntimeRunning(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    throw new RuntimeExitedError(`celld ${proc.label} exited (code ${proc.exitCode}, signal ${proc.signalCode}).\n${proc.logs().slice(-4000)}`);
  }
}

export async function probeRuntimeReadiness(origin) {
  const response = await fetch(`${origin}/.well-known/celld/health`, {
    signal: AbortSignal.timeout(3000), redirect: 'error',
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`celld readiness returned ${response.status}: ${text.slice(0, 500)}`);
  const health = JSON.parse(text);
  if (health?.ok !== true) throw new Error(`celld readiness was not ready: ${text.slice(0, 500)}`);
  return health;
}
