// Every retained realtime source owner needs one private append permit.
// Keep both admission and flattened append composition bounded by the same limit.
export const MAX_RETAINED_REALTIME_SOURCE_OWNERS = 128;
