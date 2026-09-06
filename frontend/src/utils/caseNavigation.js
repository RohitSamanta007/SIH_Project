export function caseDetailPath(caseId) {
  if (typeof caseId !== 'string' || !caseId.trim()) return null;
  return `/cases/${encodeURIComponent(caseId.trim())}`;
}
