export const MANIFEST_SCHEMA_VERSION = 1;
export const ZEDPSTACK_VERSION = '0.4.1';
export const RUNS_DIR = '.zedpstack/runs';
export const DEFAULT_TIMEOUT_MS = 600_000;

export const PERMISSION_PROFILES = {
  'read-only': {
    id: 'read-only',
    description: 'No repo writes; workers must not use dangerous bypass flags',
  },
};
