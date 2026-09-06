const mongoose = require("mongoose");
const { Case, Entity, Edge, Pattern } = require("../models");
const { NotFoundError, ValidationError, BadRequestError } = require("../utils/AppError");
const {
  normalizePhone,
  normalizeVehicle,
  normalizeEmail,
  normalizeAccount,
  normalizeAddress,
} = require("./identifierNormalizationService");
const { buildExactCaseHistory } = require("./historicalContextService");

const MAX_HISTORICAL_CASES_PER_IDENTIFIER = 3;
const CROSS_CASE_IDENTIFIER_TYPES = {
  phone: { entityField: "normalizedPhones", normalize: normalizePhone },
  vehicle: { entityField: "normalizedVehicles", normalize: normalizeVehicle },
  email: { entityField: "normalizedEmails", normalize: normalizeEmail },
  account: { entityField: "normalizedAccounts", normalize: normalizeAccount },
  address: { entityField: "normalizedAddresses", normalize: normalizeAddress },
};

const effectiveStatus = (edge) => edge.reviewStatus || edge.systemStatus || edge.guardrailStatus || "unknown";

const mapEdge = (edge) => ({
  id: edge.edgeId || edge._id.toString(),
  databaseId: edge._id.toString(),
  source: edge.source,
  target: edge.target,
  edgeType: edge.edgeType,
  confidence: edge.confidence,
  timestamp: edge.timestamp || null,
  eventDate: edge.eventDate || null,
  eventTime: edge.eventTime || null,
  eventType: edge.eventType || null,
  relationReason: edge.relationReason || null,
  evidenceIds: edge.evidenceIds || [],
  dateConfidence: edge.dateConfidence || "none",
  evidence: edge.evidence || [],
  originalStatus: edge.systemStatus || edge.guardrailStatus || "unknown",
  systemStatus: edge.systemStatus || edge.guardrailStatus || null,
  reviewStatus: edge.reviewStatus || null,
  effectiveStatus: effectiveStatus(edge),
  latestNote: edge.reviewReason || null,
  reviewUpdatedBy: edge.reviewUpdatedBy || null,
  reviewUpdatedAt: edge.reviewUpdatedAt || null,
  reviewAudit: edge.reviewAudit || [],
  guardrailStatus: edge.guardrailStatus || null,
  guardrailRationale: edge.guardrailRationale || null,
  attributes: edge.attributes || {},
  associatedCases: edge.associatedCases || [],
  createdAt: edge.createdAt,
});

const decorateRecurrencePatterns = async (patterns, currentCaseId) => {
  const rows = Array.isArray(patterns) ? patterns : [];
  const referencedIds = [...new Set(rows.flatMap((pattern) => {
    if (pattern?.patternType !== "cross_case_recurrence") return [];
    const matches = Array.isArray(pattern.metadata?.exactMatches) ? pattern.metadata.exactMatches : [];
    return matches.flatMap((match) => Array.isArray(match?.historicalCaseIds) ? match.historicalCaseIds : []);
  }).filter((caseId) => typeof caseId === "string" && caseId && caseId !== currentCaseId))];

  const availableIds = new Set();
  if (referencedIds.length) {
    const availableCases = await Case.find(
      { caseId: { $in: referencedIds } },
      { caseId: 1 }
    ).lean();
    for (const caseDoc of availableCases || []) {
      if (caseDoc?.caseId) availableIds.add(caseDoc.caseId);
    }
  }

  return rows.map((pattern) => {
    if (pattern?.patternType !== "cross_case_recurrence") return pattern;
    const exactMatches = Array.isArray(pattern.metadata?.exactMatches)
      ? pattern.metadata.exactMatches
      : [];
    return {
      ...pattern,
      metadata: {
        ...(pattern.metadata || {}),
        exactMatches: exactMatches.map((match) => ({
          ...match,
          historicalCases: (Array.isArray(match?.historicalCaseIds) ? match.historicalCaseIds : [])
            .filter((caseId) => caseId && caseId !== currentCaseId)
            .map((caseId) => ({ caseId, available: availableIds.has(caseId) })),
        })),
      },
    };
  });
};

const parseExactHistoryItem = (item, currentCaseId) => {
  if (!item || typeof item.canonicalId !== "string" || typeof item.lastSeenCaseId !== "string") return null;
  const separator = item.canonicalId.indexOf(":");
  if (separator < 1) return null;
  const identifierType = item.canonicalId.slice(0, separator).toLowerCase();
  const config = CROSS_CASE_IDENTIFIER_TYPES[identifierType];
  const historicalCaseId = item.lastSeenCaseId.trim();
  if (!config || !historicalCaseId || historicalCaseId === currentCaseId) return null;
  const normalizedValue = config.normalize(item.canonicalId.slice(separator + 1));
  if (!normalizedValue) return null;
  return {
    identifierType,
    normalizedValue,
    matchedIdentifier: `${identifierType}:${normalizedValue}`,
    historicalCaseId,
    entityField: config.entityField,
  };
};

/**
 * Build a read-only historical overlay for the entity graph.
 *
 * Every row starts with an exact identifier stored in Case.caseHistory, then
 * follows only one evidence-bearing relationship from the matching identifier
 * entity in the referenced historical case. No database edge is created and
 * no model or investigator status is changed.
 */
const buildCrossCaseEvidence = async (currentCaseId, caseHistory) => {
  const parsed = [];
  const seenHistory = new Set();
  const caseCountByIdentifier = new Map();

  for (const item of Array.isArray(caseHistory) ? caseHistory : []) {
    const match = parseExactHistoryItem(item, currentCaseId);
    if (!match) continue;
    const historyKey = `${match.matchedIdentifier}\u0000${match.historicalCaseId}`;
    if (seenHistory.has(historyKey)) continue;
    const count = caseCountByIdentifier.get(match.matchedIdentifier) || 0;
    if (count >= MAX_HISTORICAL_CASES_PER_IDENTIFIER) continue;
    seenHistory.add(historyKey);
    caseCountByIdentifier.set(match.matchedIdentifier, count + 1);
    parsed.push(match);
  }
  if (!parsed.length) return [];

  const referencedCaseIds = [...new Set(parsed.map((match) => match.historicalCaseId))];
  const historicalCases = await Case.find(
    { caseId: { $in: referencedCaseIds, $ne: currentCaseId } },
    { caseId: 1, title: 1 }
  ).lean();
  const availableCaseIds = new Set((historicalCases || []).map((item) => item.caseId).filter(Boolean));
  const historicalCaseNameById = new Map((historicalCases || []).map((item) => [
    item.caseId,
    typeof item.title === "string" && item.title.trim() ? item.title.trim() : "Historical case",
  ]));
  const rows = [];
  const seenRows = new Set();

  for (const match of parsed) {
    if (!availableCaseIds.has(match.historicalCaseId)) continue;
    const identifierQuery = { [match.entityField]: match.normalizedValue };
    const [currentIdentifierEntities, historicalIdentifierEntities] = await Promise.all([
      Entity.find(
        { associatedCases: currentCaseId, ...identifierQuery },
        { canonicalId: 1 }
      ).lean(),
      Entity.find(
        { associatedCases: match.historicalCaseId, ...identifierQuery },
        { canonicalId: 1 }
      ).lean(),
    ]);
    if (!currentIdentifierEntities?.length || !historicalIdentifierEntities?.length) continue;

    const historicalIdentifierIds = [...new Set(
      historicalIdentifierEntities.map((entity) => entity.canonicalId).filter(Boolean)
    )];
    const historicalEdges = await Edge.find({
      associatedCases: match.historicalCaseId,
      $or: [
        { source: { $in: historicalIdentifierIds } },
        { target: { $in: historicalIdentifierIds } },
      ],
    }).lean();
    const evidenceEdges = (historicalEdges || []).filter((edge) =>
      Array.isArray(edge.evidence) && edge.evidence.length &&
      (historicalIdentifierIds.includes(edge.source) || historicalIdentifierIds.includes(edge.target))
    );
    const otherEntityIds = [...new Set(evidenceEdges.flatMap((edge) => {
      if (historicalIdentifierIds.includes(edge.source)) return [edge.target];
      if (historicalIdentifierIds.includes(edge.target)) return [edge.source];
      return [];
    }).filter(Boolean))];
    if (!otherEntityIds.length) continue;

    const otherEntities = await Entity.find({
      canonicalId: { $in: otherEntityIds },
      associatedCases: match.historicalCaseId,
    }, {
      canonicalId: 1, type: 1, aliases: 1, attributes: 1, confidence: 1,
    }).lean();
    const otherEntityById = new Map((otherEntities || []).map((entity) => [entity.canonicalId, entity]));

    for (const currentEntity of currentIdentifierEntities) {
      if (!currentEntity?.canonicalId) continue;
      for (const edge of evidenceEdges) {
        const otherId = historicalIdentifierIds.includes(edge.source) ? edge.target : edge.source;
        const historicalEntity = otherEntityById.get(otherId);
        if (!historicalEntity || !otherId || historicalIdentifierIds.includes(otherId)) continue;
        const originalEdgeId = edge.edgeId || edge._id?.toString();
        if (!originalEdgeId) continue;
        const rowKey = [
          match.matchedIdentifier,
          match.historicalCaseId,
          currentEntity.canonicalId,
          otherId,
          originalEdgeId,
        ].join("\u0000");
        if (seenRows.has(rowKey)) continue;
        seenRows.add(rowKey);

        const virtualHistoricalId = `historical:${match.historicalCaseId}:${otherId}`;
        rows.push({
          id: `cross:${currentCaseId}:${currentEntity.canonicalId}:${match.historicalCaseId}:${originalEdgeId}`,
          currentEntityId: currentEntity.canonicalId,
          matchedIdentifier: match.matchedIdentifier,
          identifierType: match.identifierType,
          historicalCaseId: match.historicalCaseId,
          historicalCaseName: historicalCaseNameById.get(match.historicalCaseId) || "Historical case",
          historicalEntity: {
            id: virtualHistoricalId,
            canonicalId: otherId,
            name: historicalEntity.aliases?.find((alias) => typeof alias === "string" && alias.trim()) || otherId,
            type: historicalEntity.type,
            aliases: historicalEntity.aliases || [],
            attributes: historicalEntity.attributes || {},
            confidence: historicalEntity.confidence,
          },
          historicalRelationship: {
            edgeId: originalEdgeId,
            edgeType: edge.edgeType,
            modelStatus: edge.systemStatus || edge.guardrailStatus || "unknown",
            confidence: edge.confidence,
            relationReason: edge.relationReason || null,
            eventDate: edge.eventDate || null,
            eventTime: edge.eventTime || null,
            evidenceIds: edge.evidenceIds || [],
            evidence: edge.evidence,
          },
        });
      }
    }
  }
  return rows;
};

/**
 * Retrieve the full graph (nodes + edges) for a given case
 *
 * @param {string} caseId - Case identifier
 * @returns {Promise<{ caseId: string, status: string, nodes: any[], edges: any[] }>}
 */
const getCaseGraph = async (caseId) => {
  if (!caseId || typeof caseId !== "string" || !caseId.trim()) {
    throw new ValidationError("A valid caseId parameter is required", "INVALID_CASE_ID");
  }

  const normalizedCaseId = caseId.trim();

  // Verify Case exists
  const caseDoc = await Case.findOne({ caseId: normalizedCaseId }).lean();
  if (!caseDoc) {
    throw new NotFoundError(`Case '${normalizedCaseId}' not found`, "CASE_NOT_FOUND");
  }

  // Fetch edges associated only with this case
  const edges = await Edge.find({ associatedCases: normalizedCaseId }).lean();
  const endpointIds = [...new Set(edges.flatMap((edge) => [edge.source, edge.target]).filter(Boolean))];
  // Include endpoints of deterministic cross-case recurrence edges without
  // mutating the historical entity's case membership.
  const entities = await Entity.find({
    $or: [{ associatedCases: normalizedCaseId }, { canonicalId: { $in: endpointIds } }],
  }).lean();
  const patterns = await Pattern.find({ caseId: normalizedCaseId }).lean();
  const decoratedPatterns = await decorateRecurrencePatterns(patterns, normalizedCaseId);
  const exactCaseHistory = Array.isArray(caseDoc.caseHistory) && caseDoc.caseHistory.length
    ? caseDoc.caseHistory
    : await buildExactCaseHistory(normalizedCaseId, caseDoc.normalizedIdentifiers || {});
  const crossCaseEvidence = await buildCrossCaseEvidence(normalizedCaseId, exactCaseHistory);

  const nodes = entities.map((entity) => ({
    canonicalId: entity.canonicalId,
    type: entity.type,
    aliases: entity.aliases || [],
    attributes: entity.attributes || {},
    confidence: entity.confidence,
    associatedCases: entity.associatedCases || [],
    createdAt: entity.createdAt,
  }));

  const mappedEdges = edges.map(mapEdge);

  return {
    caseId: normalizedCaseId,
    status: caseDoc.status,
    title: caseDoc.title || null,
    metadata: caseDoc.metadata || {},
    retrievalSummary: caseDoc.retrievalSummary || null,
    textReports: caseDoc.textReports || [],
    similarCaseLeads: caseDoc.similarCaseLeads || [],
    nodes,
    edges: mappedEdges,
    patterns: decoratedPatterns,
    crossCaseEvidence,
  };
};

/**
 * Retrieve detailed entity profile with its related edges within the case
 *
 * @param {string} caseId - Case identifier
 * @param {string} entityId - Entity canonicalId
 * @returns {Promise<{ caseId: string, entity: Object, relatedEdges: any[] }>}
 */
const getEntityDetail = async (caseId, entityId) => {
  if (!caseId || typeof caseId !== "string" || !caseId.trim()) {
    throw new ValidationError("A valid caseId parameter is required", "INVALID_CASE_ID");
  }
  if (!entityId || typeof entityId !== "string" || !entityId.trim()) {
    throw new ValidationError("A valid entityId parameter is required", "INVALID_ENTITY_ID");
  }

  const normalizedCaseId = caseId.trim();
  const normalizedEntityId = entityId.trim();

  // Verify Case exists
  const caseDoc = await Case.findOne({ caseId: normalizedCaseId }).lean();
  if (!caseDoc) {
    throw new NotFoundError(`Case '${normalizedCaseId}' not found`, "CASE_NOT_FOUND");
  }

  // Fetch target entity globally (master graph)
  const entity = await Entity.findOne({
    canonicalId: normalizedEntityId,
  }).lean();

  if (!entity) {
    throw new NotFoundError(
      `Entity '${normalizedEntityId}' not found`,
      "ENTITY_NOT_FOUND"
    );
  }

  // Fetch only related edges globally (master graph)
  const relatedEdges = await Edge.find({
    associatedCases: normalizedCaseId,
    $or: [{ source: normalizedEntityId }, { target: normalizedEntityId }],
  }).lean();

  const mappedEdges = relatedEdges.map(mapEdge);

  return {
    caseId: normalizedCaseId,
    entity: {
      canonicalId: entity.canonicalId,
      type: entity.type,
      aliases: entity.aliases || [],
      attributes: entity.attributes || {},
      confidence: entity.confidence,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    },
    relatedEdges: mappedEdges,
  };
};

/**
 * Retrieve chronologically ordered interaction timeline for a case
 *
 * @param {string} caseId - Case identifier
 * @returns {Promise<{ caseId: string, totalEvents: number, timeline: any[] }>}
 */
const getCaseTimeline = async (caseId) => {
  if (!caseId || typeof caseId !== "string" || !caseId.trim()) {
    throw new ValidationError("A valid caseId parameter is required", "INVALID_CASE_ID");
  }

  const normalizedCaseId = caseId.trim();

  // Verify Case exists
  const caseDoc = await Case.findOne({ caseId: normalizedCaseId }).lean();
  if (!caseDoc) {
    throw new NotFoundError(`Case '${normalizedCaseId}' not found`, "CASE_NOT_FOUND");
  }

  const caseEdges = await Edge.find({ associatedCases: normalizedCaseId }).lean();
  const edgeById = new Map();
  for (const edge of caseEdges) {
    edgeById.set(edge._id.toString(), edge);
    if (edge.edgeId) edgeById.set(edge.edgeId, edge);
  }
  const represented = new Set();
  const timelineEvents = (Array.isArray(caseDoc.timelineEvents) ? caseDoc.timelineEvents : []).map((event) => {
    const edge = event.edgeId ? edgeById.get(event.edgeId) : null;
    if (event.edgeId) represented.add(event.edgeId);
    return edge ? { ...mapEdge(edge), ...event, id: event.edgeId || mapEdge(edge).id } : event;
  });
  for (const edge of caseEdges) {
    const id = edge.edgeId || edge._id.toString();
    // Investigator-created relationships are not present in the immutable
    // FastAPI timelineEvents array, so include them whether dated or undated.
    if (!represented.has(id)) timelineEvents.push({ ...mapEdge(edge), id, edgeId: id });
  }
  
  // Sort timelineEvents chronologically
  const sortedTimeline = timelineEvents.sort((a, b) => {
    if (!a.eventDate) return 1;
    if (!b.eventDate) return -1;
    const ta = new Date(a.eventDate).getTime();
    const tb = new Date(b.eventDate).getTime();
    if (ta !== tb) return ta - tb;
    return (a.eventTime || "99:99:99").localeCompare(b.eventTime || "99:99:99");
  });

  return {
    caseId: normalizedCaseId,
    totalEvents: sortedTimeline.length,
    timeline: sortedTimeline
  };
};

/**
 * Retrieve guardrail and evidence metadata for a specific edge in a case
 *
 * @param {string} caseId - Case identifier
 * @param {string} edgeId - Edge MongoDB _id
 * @returns {Promise<{ caseId: string, edgeId: string, edge: Object }>}
 */
const getGuardrailDetail = async (caseId, edgeId) => {
  if (!caseId || typeof caseId !== "string" || !caseId.trim()) {
    throw new ValidationError("A valid caseId parameter is required", "INVALID_CASE_ID");
  }
  if (!edgeId || typeof edgeId !== "string" || !edgeId.trim()) {
    throw new ValidationError("A valid edgeId parameter is required", "INVALID_EDGE_ID");
  }

  const normalizedCaseId = caseId.trim();
  const normalizedEdgeId = edgeId.trim();

  // Verify Case exists
  const caseDoc = await Case.findOne({ caseId: normalizedCaseId }).lean();
  if (!caseDoc) {
    throw new NotFoundError(`Case '${normalizedCaseId}' not found`, "CASE_NOT_FOUND");
  }

  const edgeIdentity = [{ edgeId: normalizedEdgeId }];
  if (mongoose.Types.ObjectId.isValid(normalizedEdgeId)) edgeIdentity.push({ _id: normalizedEdgeId });
  const edge = await Edge.findOne({
    associatedCases: normalizedCaseId,
    $or: edgeIdentity,
  }).lean();

  if (!edge) {
    throw new NotFoundError(
      `Edge '${normalizedEdgeId}' not found in case '${normalizedCaseId}'`,
      "EDGE_NOT_FOUND"
    );
  }

  return {
    caseId: normalizedCaseId,
    edgeId: edge.edgeId || edge._id.toString(),
    edge: mapEdge(edge),
  };
};

/**
 * Retrieve all investigation cases (newest first) with per-case entity/edge counts
 * for the dashboard list view.
 *
 * Counts are computed with batched aggregations to avoid N+1 queries.
 *
 * @returns {Promise<{ total: number, cases: any[] }>}
 */
const getCasesList = async () => {
  const caseDocs = await Case.find(
    {},
    { caseId: 1, status: 1, title: 1, metadata: 1, retrievalSummary: 1, sourceUploads: 1, createdAt: 1, updatedAt: 1 }
  )
    .sort({ updatedAt: -1 })
    .lean();

  if (!Array.isArray(caseDocs) || caseDocs.length === 0) {
    return { total: 0, cases: [] };
  }

  const caseIds = caseDocs.map((caseDoc) => caseDoc.caseId);

  const [entityCounts, edgeCounts, patternsList] = await Promise.all([
    Entity.aggregate([
      { $match: { associatedCases: { $in: caseIds } } },
      { $unwind: "$associatedCases" },
      { $match: { associatedCases: { $in: caseIds } } },
      { $group: { _id: "$associatedCases", count: { $sum: 1 } } },
    ]),
    Edge.aggregate([
      { $match: { associatedCases: { $in: caseIds } } },
      { $unwind: "$associatedCases" },
      { $match: { associatedCases: { $in: caseIds } } },
      { $group: { _id: "$associatedCases", count: { $sum: 1 } } },
    ]),
    Pattern.find({ caseId: { $in: caseIds } }).lean(),
  ]);

  const entityCountMap = new Map(entityCounts.map((row) => [row._id, row.count]));
  const edgeCountMap = new Map(edgeCounts.map((row) => [row._id, row.count]));
  
  const patternMap = new Map();
  for (const p of patternsList) {
    if (!patternMap.has(p.caseId)) {
      patternMap.set(p.caseId, []);
    }
    patternMap.get(p.caseId).push({
      patternType: p.patternType,
      description: p.description,
      severity: p.severity,
      confidence: p.confidence
    });
  }

  const cases = caseDocs.map((caseDoc) => {
    const uploads = Array.isArray(caseDoc.sourceUploads) ? caseDoc.sourceUploads : [];

    const recordCount = uploads.reduce(
      (sum, upload) => sum + (typeof upload?.recordCount === "number" ? upload.recordCount : 0),
      0
    );

    let lastUploadAt = null;
    for (const upload of uploads) {
      if (!upload?.uploadedAt) continue;
      const uploadedAt = new Date(upload.uploadedAt);
      if (!Number.isNaN(uploadedAt.getTime()) && (!lastUploadAt || uploadedAt > lastUploadAt)) {
        lastUploadAt = uploadedAt;
      }
    }

    return {
      caseId: caseDoc.caseId,
      status: caseDoc.status || "pending",
      title: caseDoc.title || null,
      metadata: caseDoc.metadata || {},
      retrievalSummary: caseDoc.retrievalSummary || null,
      recordCount,
      uploadsCount: uploads.length,
      lastUploadAt,
      entitiesCount: entityCountMap.get(caseDoc.caseId) || 0,
      edgesCount: edgeCountMap.get(caseDoc.caseId) || 0,
      patterns: patternMap.get(caseDoc.caseId) || [],
      createdAt: caseDoc.createdAt,
      updatedAt: caseDoc.updatedAt,
    };
  });

  return {
    total: cases.length,
    cases,
  };
};

module.exports = {
  NotFoundError,
  ValidationError,
  getCaseGraph,
  getEntityDetail,
  getCaseTimeline,
  getGuardrailDetail,
  getCasesList,
  decorateRecurrencePatterns,
  buildCrossCaseEvidence,
};
