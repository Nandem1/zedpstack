/** Mutex async por runId para serializar lectura/escritura del manifest. */
const chains = new Map();

export async function withManifestLock(runId, fn) {
  const prev = chains.get(runId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  chains.set(runId, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export function resetManifestLock(runId) {
  chains.delete(runId);
}
