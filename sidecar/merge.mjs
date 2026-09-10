export function dropCloudRows(items) {
  return (items || []).filter((item) => item?.hostname !== 'cursor-cloud');
}

export function bucketIdentity(b) {
  return `${b.source}|${b.model}|${b.project}|${b.hostname}|${b.bucketStart}`;
}

export function sessionIdentity(s) {
  return `${s.source}|${s.sessionHash}|${s.hostname || ''}`;
}

export function rowsForHost(items, hostname) {
  return (items || []).filter((item) => item?.hostname === hostname);
}

export function upsertByIdentity(previous, incoming, idFn) {
  const map = new Map();
  for (const item of previous || []) map.set(idFn(item), item);
  for (const item of incoming || []) map.set(idFn(item), item);
  return [...map.values()];
}

export function mergeSnapshotBySource(previous, collected) {
  const succeeded = new Set(collected.succeededSources || []);
  const prevBuckets = Array.isArray(previous?.buckets) ? previous.buckets : [];
  const prevSessions = Array.isArray(previous?.sessions) ? previous.sessions : [];
  return {
    buckets: [
      ...(collected.buckets || []),
      ...prevBuckets.filter((item) => !succeeded.has(item?.source)),
    ],
    sessions: [
      ...(collected.sessions || []),
      ...prevSessions.filter((item) => !succeeded.has(item?.source)),
    ],
    syncedAt: collected.syncedAt,
  };
}

export function mergeSnapshotBySourceForHost(previous, collected, hostname) {
  return mergeSnapshotBySource(
    {
      buckets: rowsForHost(previous?.buckets, hostname),
      sessions: rowsForHost(previous?.sessions, hostname),
      syncedAt: previous?.syncedAt,
    },
    collected,
  );
}

export function mergeLocalAndRemote(local, remote, hostname) {
  const otherBuckets = (remote?.buckets || []).filter((item) => item?.hostname && item.hostname !== hostname);
  const otherSessions = (remote?.sessions || []).filter((item) => item?.hostname && item.hostname !== hostname);
  return {
    buckets: dropCloudRows([...(otherBuckets), ...(local?.buckets || [])]),
    sessions: dropCloudRows([...(otherSessions), ...(local?.sessions || [])]),
  };
}
