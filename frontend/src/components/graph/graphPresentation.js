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
      if (!nodeIds.has(historical.id)) {
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
          source: historical.id,
          target: evidence.currentEntityId,
          edgeType: 'historical_cross_case_evidence',
          isCrossCaseEvidence: true,
          displayConnectionType: 'historical_evidence',
          historicalCaseId: evidence.historicalCaseId,
          matchedIdentifier: evidence.matchedIdentifier,
          historicalRelationship: evidence.historicalRelationship,
          crossCaseEvidence: evidence,
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
