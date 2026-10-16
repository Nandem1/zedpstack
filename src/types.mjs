/**
 * @typedef {Object} RoleBinding
 * @property {'claude'|'codex'} runtime
 * @property {string} model
 * @property {string} permissionProfile
 */

/**
 * @typedef {Object} TaskSpec
 * @property {string} goal
 * @property {{ path: string, hash?: string }[]} inputRefs
 * @property {string} outputContract
 * @property {number} timeout
 */

export {};
