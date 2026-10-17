import { resolvePstackInstall } from '../../src/pstack.mjs';

export function pstackAvailable() {
  try {
    resolvePstackInstall();
    return true;
  } catch {
    return false;
  }
}
