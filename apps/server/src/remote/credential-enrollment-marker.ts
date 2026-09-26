/** Uses the Rust v15 idempotency table without changing the copied database schema. */
export const ONLINE_ENROLLMENT_MARKER_NAMESPACE = 'remote.credential.online'
export const ONLINE_ENROLLMENT_MARKER_EPOCH = '00000000-0000-0000-0000-000000000001'
export const ONLINE_REPLACEMENT_MARKER_NAMESPACE = 'remote.credential.replace'
export const ONLINE_REPLACEMENT_CLEANUP_NAMESPACE = 'remote.credential.cleanup'
/** Durable intent that the old live credential is Rust v1 and must never be mutated. */
export const ONLINE_V1_REPLACEMENT_NAMESPACE = 'remote.credential.replace.v1'
/** A live new-target intent; recovery may touch only its exact v2 item. */
export const LIVE_NEW_ENROLLMENT_NAMESPACE = 'remote.credential.live.new'
