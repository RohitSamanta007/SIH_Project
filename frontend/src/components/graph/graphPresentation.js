export function deriveDisplayConnectionType(edge) {
  if (edge?.isCrossCaseEvidence) return 'historical_evidence';
  const review = edge?.reviewStatus;
  if (review && review !== 'unspecified') {
    if (['verified', 'possible_connection', 'cross_connection', 'unverified', 'unknown'].includes(review)) return review;
  }
  const rawStatus = edge?.effectiveStatus || edge?.systemStatus || edge?.guardrailStatus;
  if (rawStatus === 'verified' || rawStatus === 'approved') return 'verified';
  if (rawStatus === 'possible_connection') return 'possible_connection';
  if (rawStatus === 'unverified' || rawStatus === 'rejected') return 'unverified';
  if (rawStatus === 'unknown' || rawStatus === 'unknown_connection') return 'unknown';
  if (rawStatus === 'cross_case' || rawStatus === 'cross_connection') return 'cross_connection';
  return 'unknown';
}

export const isDashedConnectionType = (displayType) =>
  ['possible_connection', 'cross_connection', 'historical_evidence'].includes(displayType);

export const shouldShowCrossCaseEvidenceByDefault = (graphData) =>
  Array.isArray(graphData?.crossCaseEvidence) && graphData.crossCaseEvidence.length > 0;

export const historicalNodeLabel = (node, baseLabel) =>
  node?.isHistoricalEvidence
    ? `${baseLabel} · Historical ${node.historicalCaseName || 'case'}`
    : baseLabel;

const CANDIDATE_IDENTITY_IDENTIFIER_TYPES = new Set([
  'phone', 'address', 'vehicle', 'email', 'account',
]);

export function normalizeEntityName(value) {
  return typeof value === 'string'
    ? value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
    : '';
}

function levenshteinDistance(left, right) {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[right.length];
}

export function entityNameSimilarity(left, right) {
  const normalizedLeft = normalizeEntityName(left);
  const normalizedRight = normalizeEntityName(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  const longest = Math.max(normalizedLeft.length, normalizedRight.length);
  return longest ? 1 - (levenshteinDistance(normalizedLeft, normalizedRight) / longest) : 1;
}

function primaryEntityName(entity) {
  const alias = Array.isArray(entity?.aliases)
    ? entity.aliases.find((value) => typeof value === 'string' && value.trim())
    : null;
  return alias || entity?.name || '';
}

export function findCandidateIdentityMerge(nodes, evidence, threshold = 0.9) {
  const historical = evidence?.historicalEntity;
  if (!historical || String(historical.type || '').toLowerCase() !== 'person') return null;
  if (!CANDIDATE_IDENTITY_IDENTIFIER_TYPES.has(String(evidence?.identifierType || '').toLowerCase())) return null;
  const historicalName = primaryEntityName(historical);
  const candidates = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => !node?.isHistoricalEvidence && String(node?.type || '').toLowerCase() === 'person')
    .map((node) => ({ node, similarity: entityNameSimilarity(primaryEntityName(node), historicalName) }))
    .filter((candidate) => candidate.similarity >= threshold)
    .sort((left, right) => right.similarity - left.similarity || String(left.node.id).localeCompare(String(right.node.id)));
  return candidates[0] || null;
}

export function buildRenderableGraphData(graphData, showCrossCaseEvidence = false) {
  const nodes = (Array.isArray(graphData?.nodes) ? graphData.nodes : []).map((node) => ({
    ...node,
    id: node.id || node.canonicalId,
    degree: 0,
  }));
  const links = (Array.isArray(graphData?.edges) ? graphData.edges : []).map((edge) => ({
    ...edge,
    id: edge.id || edge.edgeId,
    source: edge.source || edge.sourceEntityId,
    target: edge.target || edge.targetEntityId,
    displayConnectionType: deriveDisplayConnectionType(edge),
  }));

  if (showCrossCaseEvidence) {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const linkIds = new Set(links.map((link) => link.id));
    for (const evidence of Array.isArray(graphData?.crossCaseEvidence) ? graphData.crossCaseEvidence : []) {
      const historical = evidence?.historicalEntity;
      if (!evidence?.id || !evidence?.currentEntityId || !historical?.id || !nodeIds.has(evidence.currentEntityId)) continue;
      const candidateMerge = findCandidateIdentityMerge(nodes, evidence);
      const overlaySourceId = candidateMerge?.node?.id || historical.id;
      if (candidateMerge?.node) {
        const mergeRecord = {
          similarity: candidateMerge.similarity,
          historicalCaseId: evidence.historicalCaseId,
          historicalCaseName: evidence.historicalCaseName,
          historicalEntityId: historical.id,
          matchedIdentifier: evidence.matchedIdentifier,
        };
        const existingMerges = Array.isArray(candidateMerge.node.candidateIdentityMerges)
          ? candidateMerge.node.candidateIdentityMerges
          : [];
        if (!existingMerges.some((item) =>
          item.historicalEntityId === mergeRecord.historicalEntityId &&
          item.matchedIdentifier === mergeRecord.matchedIdentifier
        )) {
          candidateMerge.node.candidateIdentityMerges = [...existingMerges, mergeRecord];
        }
      } else if (!nodeIds.has(historical.id)) {
        nodes.push({
          ...historical,
          id: historical.id,
          canonicalId: historical.id,
          aliases: [historical.name, ...(historical.aliases || [])].filter(Boolean),
          historicalCaseId: evidence.historicalCaseId,
          historicalCaseName: evidence.historicalCaseName,
          matchedIdentifier: evidence.matchedIdentifier,
          isHistoricalEvidence: true,
          crossCaseEvidence: evidence,
          degree: 0,
        });
        nodeIds.add(historical.id);
      }
      if (!linkIds.has(evidence.id)) {
        links.push({
          id: evidence.id,
          source: overlaySourceId,
          target: evidence.currentEntityId,
          edgeType: 'historical_cross_case_evidence',
          isCrossCaseEvidence: true,
          displayConnectionType: 'historical_evidence',
          historicalCaseId: evidence.historicalCaseId,
          matchedIdentifier: evidence.matchedIdentifier,
          historicalRelationship: evidence.historicalRelationship,
          crossCaseEvidence: evidence,
          candidateIdentityMerge: Boolean(candidateMerge),
          identitySimilarity: candidateMerge?.similarity || null,
          historicalEntityId: historical.id,
        });
        linkIds.add(evidence.id);
      }
    }
  }

  links.forEach((link) => {
    const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
    const targetId = typeof link.target === 'object' ? link.target.id : link.target;
    const sourceNode = nodes.find((node) => node.id === sourceId);
    const targetNode = nodes.find((node) => node.id === targetId);
    if (sourceNode) sourceNode.degree += 1;
    if (targetNode) targetNode.degree += 1;
  });
  return { nodes, links };
}
