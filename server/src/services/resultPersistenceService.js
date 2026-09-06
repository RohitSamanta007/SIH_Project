"use strict";

const mongoose = require("mongoose");
const { Case, Entity, Edge, Pattern } = require("../models");
const { AppError } = require("../utils/AppError");
const { buildEntityNormalizedIdentifiers } = require("./identifierNormalizationService");
const {
  normalizePhone,
  normalizeVehicle,
  normalizeEmail,
  normalizeAccount,
  normalizeAddress,
} = require("./identifierNormalizationService");

/**
 * Custom error class representing persistence validation or database failures
 */
class PersistenceError extends AppError {
  constructor(message, code = "PERSISTENCE_DATABASE_ERROR", statusCode = 500, details = null) {
    super(message, code, statusCode, details);
  }
}

/**
 * Deduplicate evidence item — serialize to a stable key for Set-based collision checking.
 * Field names MUST match EvidenceItem Pydantic model in reasoning-service AND Edge.js.
 *   sourceReportId  ← FastAPI field
 *   matchedField    ← FastAPI field
 *   record          ← unchanged
 */
const serializeEvidenceItem = (item) => {
  if (!item || typeof item !== "object") return "";
  return JSON.stringify({
    sourceReportId: item.sourceReportId || "",
    matchedField:   item.matchedField   || "",
    record:         item.record !== undefined ? item.record : "",
  });
};

/**
 * Map the FastAPI guardrailStatus of an edge to the initial investigator reviewStatus.
 *
 * Mapping rules (per spec):
 *   "verified"            → "verified"
 *   "possible_connection" → "possible_connection"
 *   anything else / null  → "unverified"
 *
 * The mapping is only applied on INITIAL creation — never overwrites an
 * existing reviewStatus set by an investigator.
 *
 * @param {string|undefined} guardrailStatus
 * @returns {"verified"|"possible_connection"|"unverified"}
 */
function mapInitialReviewStatus(guardrailStatus) {
  if (guardrailStatus === "verified" || guardrailStatus === "approved") return "verified";
  if (guardrailStatus === "possible_connection") return "possible_connection";
  return "unverified";
}

/**
 * Validate incoming FastAPI AI reasoning payload prior to database mutation.
 *
 * @param {Object} fastApiResult — AI payload returned by FastAPI
 * @param {string} [expectedCaseId] — Expected Case ID from intake
 */
const validateFastApiResult = (fastApiResult, expectedCaseId = null) => {
  if (!fastApiResult || typeof fastApiResult !== "object") {
    throw new PersistenceError(
      "Invalid AI response: Expected payload object",
      "PERSISTENCE_CONTRACT_ERROR",
      422
    );
  }

  const caseId = fastApiResult.caseId?.trim();
  if (!caseId) {
    throw new PersistenceError(
      "Missing required caseId in FastAPI result",
      "PERSISTENCE_VALIDATION_ERROR",
      422
    );
  }

  if (expectedCaseId && caseId !== expectedCaseId) {
    throw new PersistenceError(
      `Mismatched Case ID: Payload contains '${caseId}', expected '${expectedCaseId}'`,
      "PERSISTENCE_VALIDATION_ERROR",
      400
    );
  }

  // Pre-validate: every edge must contain non-empty evidence[]
  const relationships = fastApiResult.relationships || fastApiResult.edges || [];
  if (Array.isArray(relationships)) {
    for (let i = 0; i < relationships.length; i++) {
      const rel = relationships[i];
      if (!rel || typeof rel !== "object") {
        throw new PersistenceError(
          `Invalid relationship entry at index ${i}`,
          "PERSISTENCE_VALIDATION_ERROR",
          422
        );
      }
      if (!Array.isArray(rel.evidence) || rel.evidence.length === 0) {
        throw new PersistenceError(
          `Relationship from '${rel.source || rel.sourceEntityId || "unknown"}' to '${
            rel.target || rel.targetEntityId || "unknown"
          }' violates hard invariant: evidence[] must be a non-empty array`,
          "INVALID_EVIDENCE_ERROR",
          422
        );
      }
    }
  }
};


/**
 * Normalize case-level identifiers from entities for the Case document.
 * Aggregates all normalized identifier arrays across all persisted entities.
 *
 * @param {Object[]} savedEntities
 * @returns {{ phones: string[], vehicles: string[], emails: string[], accounts: string[], addresses: string[] }}
 */
function aggregateCaseIdentifiers(savedEntities) {
  const phones    = new Set();
  const vehicles  = new Set();
  const emails    = new Set();
  const accounts  = new Set();
  const addresses = new Set();

  for (const entity of savedEntities) {
    (entity.normalizedPhones    || []).forEach((v) => phones.add(v));
    (entity.normalizedVehicles  || []).forEach((v) => vehicles.add(v));
    (entity.normalizedEmails    || []).forEach((v) => emails.add(v));
    (entity.normalizedAccounts  || []).forEach((v) => accounts.add(v));
    (entity.normalizedAddresses || []).forEach((v) => addresses.add(v));
  }

  return {
    phones:    [...phones],
    vehicles:  [...vehicles],
    emails:    [...emails],
    accounts:  [...accounts],
    addresses: [...addresses],
  };
}

function mergeSemanticLeads(incomingLeads, existingLeads = []) {
  const priorByCase = new Map((existingLeads || []).map((lead) => [lead.matchedCaseId, lead]));
  return (incomingLeads || []).map((incoming) => {
    const prior = priorByCase.get(incoming?.matchedCaseId);
    if (!prior) return incoming;
    return {
      ...incoming,
      investigatorStatus: prior.investigatorStatus,
      investigatorReason: prior.investigatorReason,
      investigatorUpdatedBy: prior.investigatorUpdatedBy,
      investigatorUpdatedAt: prior.investigatorUpdatedAt,
      referencedCaseReviewedAt: prior.referencedCaseReviewedAt,
      reviewAudit: prior.reviewAudit || [],
    };
  });
}

/**
 * Persist and accumulate AI reasoning results into MongoDB.
 *
 * Persistence is idempotent (upsert semantics) and safe to re-run.
 * Existing investigator reviewStatus decisions are NEVER overwritten on re-processing.
 *
 * @param {Object} fastApiResult  — Validated AI reasoning result from fastApiClient
 * @param {Object} [intakeMetadata] — Ingestion source info (textReports, csvRecords, etc.)
 * @returns {Promise<Object>} Persistence summary and Case record
 */
const persistCaseResults = async (fastApiResult, intakeMetadata = {}) => {
  // ── 1. Validate payload ──────────────────────────────────────────────────
  const expectedCaseId = intakeMetadata.caseId;
  validateFastApiResult(fastApiResult, expectedCaseId);

  const caseId = fastApiResult.caseId.trim();
  const fastApiResponseSnapshot = {
    ...fastApiResult,
    caseId,
    receivedAt: new Date(),
  };
  const exactCaseHistory = Array.isArray(intakeMetadata.caseHistory)
    ? intakeMetadata.caseHistory
    : [];

  // Build per-edge guardrail lookup (edgeId → GuardrailItem)
  const guardrailMap = new Map(
    Array.isArray(fastApiResult.guardrail)
      ? fastApiResult.guardrail
          .filter((g) => g && typeof g.edgeId === "string" && g.edgeId.trim())
          .map((g) => [g.edgeId.trim(), g])
      : []
  );
  const timelineMap = new Map(
    (Array.isArray(fastApiResult.timelineEvents) ? fastApiResult.timelineEvents : [])
      .filter((event) => event && typeof event.edgeId === "string")
      .map((event) => [event.edgeId.trim(), event])
  );

  // Transaction session (optional — degrades gracefully on standalone deployments)
  let session = null;
  let useTransaction = false;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
    useTransaction = true;
  } catch {
    session = null;
    useTransaction = false;
  }

  try {
    const sessionOption = session ? { session } : {};

    // ── 2. Persist / Update Case Document ───────────────────────────────────
    let caseDoc = await Case.findOne({ caseId }, null, sessionOption);

    const newUploadRecord = {
      uploadId:    `UPL-${Date.now()}`,
      type:        intakeMetadata.csvRecords?.length ? "csv" : "text",
      recordCount: (intakeMetadata.textReports?.length || 0) + (intakeMetadata.csvRecords?.length || 0),
      uploadedAt:  new Date(),
      metadata: {
        sourceCount: {
          text: intakeMetadata.textReports?.length || 0,
          csv:  intakeMetadata.csvRecords?.length  || 0,
        },
      },
    };

    if (!caseDoc) {
      const newMetadata = {};
      if (intakeMetadata.category)    newMetadata.category = intakeMetadata.category;
      if (fastApiResult.priority)     newMetadata.priority = fastApiResult.priority;

      const createdCases = await Case.create(
        [
          {
            caseId,
            status:           "completed",
            title:            intakeMetadata.title,
            // Preserve original FIR texts
            textReports:      Array.isArray(intakeMetadata.textReports) ? intakeMetadata.textReports : [],
            csvRecords:       Array.isArray(intakeMetadata.csvRecords) ? intakeMetadata.csvRecords : [],
            retrievalSummary: fastApiResult.retrievalSummary || undefined,
            similarCaseLeads: Array.isArray(fastApiResult.similarCaseLeads)
              ? fastApiResult.similarCaseLeads
              : [],
            timelineEvents: Array.isArray(fastApiResult.timelineEvents)
              ? fastApiResult.timelineEvents
              : [],
            caseHistory:      exactCaseHistory,
            fastApiResponse:  fastApiResponseSnapshot,
            systemStatus:     fastApiResult.systemStatus || undefined,
            sourceUploads:    [newUploadRecord],
            metadata:         newMetadata,
          },
        ],
        sessionOption
      );
      caseDoc = createdCases[0];
    } else {
      caseDoc.status = "completed";
      caseDoc.sourceUploads.push(newUploadRecord);

      // Accumulate original FIR texts (append new ones, don't overwrite existing)
      if (Array.isArray(intakeMetadata.textReports) && intakeMetadata.textReports.length > 0) {
        const existing = new Set(caseDoc.textReports || []);
        for (const report of intakeMetadata.textReports) {
          if (!existing.has(report)) caseDoc.textReports.push(report);
        }
      }
      if (Array.isArray(intakeMetadata.csvRecords) && intakeMetadata.csvRecords.length > 0) {
        const existingRows = new Set((caseDoc.csvRecords || []).map((row) => JSON.stringify(row)));
        for (const row of intakeMetadata.csvRecords) {
          const key = JSON.stringify(row);
          if (!existingRows.has(key)) {
            caseDoc.csvRecords.push(row);
            existingRows.add(key);
          }
        }
      }

      // Update AI summary fields (non-destructive)
      if (fastApiResult.retrievalSummary) {
        caseDoc.retrievalSummary = fastApiResult.retrievalSummary;
      }
      if (Array.isArray(fastApiResult.similarCaseLeads)) {
        caseDoc.similarCaseLeads = mergeSemanticLeads(fastApiResult.similarCaseLeads, caseDoc.similarCaseLeads);
      }
      if (Array.isArray(fastApiResult.timelineEvents)) {
        caseDoc.timelineEvents = fastApiResult.timelineEvents;
      }
      caseDoc.caseHistory = exactCaseHistory;
      caseDoc.fastApiResponse = fastApiResponseSnapshot;
      caseDoc.markModified("fastApiResponse");
      if (fastApiResult.priority) {
        if (!caseDoc.metadata) caseDoc.metadata = {};
        caseDoc.metadata.priority = fastApiResult.priority;
        caseDoc.markModified("metadata");
      }
      await caseDoc.save(sessionOption);
    }

    // ── 3. Persist / Merge Entities (Identity: canonicalId) ─────────────────
    const entities     = Array.isArray(fastApiResult.entities) ? fastApiResult.entities : [];
    const savedEntities = [];

    for (const rawEntity of entities) {
      const canonicalId = rawEntity.canonicalId?.trim();
      const type        = rawEntity.type?.trim();
      if (!canonicalId || !type) continue;

      const newAliases = Array.isArray(rawEntity.aliases)
        ? rawEntity.aliases.filter((a) => typeof a === "string" && a.trim()).map((a) => a.trim())
        : [];
      const newAttributes = rawEntity.attributes && typeof rawEntity.attributes === "object"
        ? rawEntity.attributes
        : {};
      const newConfidence = typeof rawEntity.confidence === "number" ? rawEntity.confidence : 1.0;

      // Build normalized identifier arrays from this entity's data
      const normalizedIds = buildEntityNormalizedIdentifiers(rawEntity);

      let existingEntity = await Entity.findOne({ canonicalId }, null, sessionOption);

      if (!existingEntity) {
        const created = await Entity.create(
          [
            {
              associatedCases:    [caseId],
              canonicalId,
              type,
              aliases:            newAliases,
              attributes:         newAttributes,
              confidence:         newConfidence,
              ...normalizedIds,   // normalizedPhones, normalizedVehicles, etc.
            },
          ],
          sessionOption
        );
        savedEntities.push(created[0]);
      } else {
        // Deterministic merge — preserve existing, union new data
        existingEntity.associatedCases = Array.from(
          new Set([...(existingEntity.associatedCases || []), caseId])
        );
        existingEntity.aliases = Array.from(new Set([...existingEntity.aliases, ...newAliases]));
        existingEntity.attributes = Object.assign({}, existingEntity.attributes || {}, newAttributes);
        existingEntity.markModified("attributes");
        existingEntity.confidence = Math.max(existingEntity.confidence || 0, newConfidence);

        // Merge normalized identifier arrays (union, no duplicates)
        for (const field of [
          "normalizedPhones", "normalizedVehicles", "normalizedEmails",
          "normalizedAccounts", "normalizedAddresses",
        ]) {
          existingEntity[field] = Array.from(
            new Set([...(existingEntity[field] || []), ...(normalizedIds[field] || [])])
          );
        }

        await existingEntity.save(sessionOption);
        savedEntities.push(existingEntity);
      }
    }

    // ── 3b. Update Case normalizedIdentifiers from all saved entities ────────
    if (savedEntities.length > 0) {
      const caseNormIds = aggregateCaseIdentifiers(savedEntities);
      const intakeNormIds = intakeMetadata.normalizedIdentifiers || {};
      for (const plural of ["phones", "vehicles", "emails", "accounts", "addresses"]) {
        caseNormIds[plural] = Array.from(new Set([...(caseNormIds[plural] || []), ...(intakeNormIds[plural] || [])]));
      }
      await Case.updateOne(
        { caseId },
        {
          $set: {
            "normalizedIdentifiers.phones":    caseNormIds.phones,
            "normalizedIdentifiers.vehicles":  caseNormIds.vehicles,
            "normalizedIdentifiers.emails":    caseNormIds.emails,
            "normalizedIdentifiers.accounts":  caseNormIds.accounts,
            "normalizedIdentifiers.addresses": caseNormIds.addresses,
          },
        },
        sessionOption
      );
    }

    // ── 4. Persist / Accumulate Edges with Mandatory Evidence ───────────────
    const rawRelationships = fastApiResult.relationships || fastApiResult.edges || [];
    const savedEdges = [];

    for (const rel of rawRelationships) {
      const source   = (rel.source   || rel.sourceEntityId)?.trim();
      const target   = (rel.target   || rel.targetEntityId)?.trim();
      const edgeType = rel.edgeType?.trim();
      if (!source || !target || !edgeType) continue;

      const confidence = typeof rel.confidence === "number" ? rel.confidence : 1.0;
      const timestamp  = rel.timestamp ? new Date(rel.timestamp) : undefined;
      const stableEdgeId = typeof rel.edgeId === "string" && rel.edgeId.trim() ? rel.edgeId.trim() : undefined;

      // Look up guardrail for THIS specific edge (by edgeId)
      const edgeGuardrail    = rel.edgeId ? guardrailMap.get(rel.edgeId.trim()) : undefined;
      const guardrailStatus  = edgeGuardrail?.status  || rel.guardrailStatus  || undefined;
      const guardrailRationale = edgeGuardrail?.rationale || rel.guardrailRationale || undefined;

      const incomingEvidence = Array.isArray(rel.evidence) ? rel.evidence : [];

      // ── New timeline / event fields ──────────────────────────────────────
      const timelineEvent = stableEdgeId ? timelineMap.get(stableEdgeId) : undefined;
      const eventDate      = typeof (timelineEvent?.eventDate ?? rel.eventDate) === "string" ? (timelineEvent?.eventDate ?? rel.eventDate).trim() : undefined;
      const eventTime      = typeof (timelineEvent?.eventTime ?? rel.eventTime) === "string" ? (timelineEvent?.eventTime ?? rel.eventTime).trim() : undefined;
      const eventType      = typeof (timelineEvent?.eventType ?? rel.eventType) === "string" ? (timelineEvent?.eventType ?? rel.eventType).trim() : undefined;
      const relationReason = typeof (timelineEvent?.relationReason ?? rel.relationReason) === "string" ? (timelineEvent?.relationReason ?? rel.relationReason).trim() : undefined;
      const evidenceIds    = Array.isArray(timelineEvent?.evidenceIds ?? rel.evidenceIds) ? (timelineEvent?.evidenceIds ?? rel.evidenceIds) : [];
      const rawDateConfidence = timelineEvent?.dateConfidence ?? rel.dateConfidence;
      const dateConfidence = ["explicit", "inferred", "none"].includes(rawDateConfidence)
        ? rawDateConfidence
        : "none";

      const edgeQuery    = { source, target, edgeType };
      let existingEdge   = await Edge.findOne(edgeQuery, null, sessionOption);

      if (!existingEdge) {
        const created = await Edge.create(
          [
            {
              associatedCases: [caseId],
              edgeId: stableEdgeId,
              source,
              target,
              edgeType,
              confidence,
              timestamp,
              guardrailStatus,
              guardrailRationale,
              // systemStatus mirrors guardrailStatus and is immutable after creation
              systemStatus:  guardrailStatus || undefined,
              // Timeline fields
              eventDate,
              eventTime,
              eventType,
              relationReason,
              evidenceIds,
              dateConfidence,
              evidence:   incomingEvidence,
              attributes: rel.attributes || {},
            },
          ],
          sessionOption
        );
        savedEdges.push(created[0]);
      } else {
        existingEdge.associatedCases = Array.from(
          new Set([...(existingEdge.associatedCases || []), caseId])
        );

        // Deduplicate and accumulate evidence
        const existingEvidenceKeys = new Set(existingEdge.evidence.map(serializeEvidenceItem));
        const nonDuplicateIncoming = incomingEvidence.filter((item) => {
          const key = serializeEvidenceItem(item);
          return key && !existingEvidenceKeys.has(key);
        });
        if (nonDuplicateIncoming.length > 0) {
          existingEdge.evidence.push(...nonDuplicateIncoming);
        }

        // Update confidence to highest observed
        existingEdge.confidence = Math.max(existingEdge.confidence || 0, confidence);

        // Preserve the original model/guardrail result. Investigator decisions
        // remain independent in reviewStatus and reviewAudit.
        if (timestamp && !existingEdge.timestamp) existingEdge.timestamp = timestamp;

        // Update timeline fields if newly available (do not overwrite existing non-null values)
        if (eventDate      && !existingEdge.eventDate)      existingEdge.eventDate      = eventDate;
        if (eventTime      && !existingEdge.eventTime)      existingEdge.eventTime      = eventTime;
        if (eventType      && !existingEdge.eventType)      existingEdge.eventType      = eventType;
        if (relationReason && !existingEdge.relationReason) existingEdge.relationReason = relationReason;
        if (evidenceIds.length > 0) {
          existingEdge.evidenceIds = Array.from(new Set([...existingEdge.evidenceIds, ...evidenceIds]));
        }
        if (dateConfidence !== "none" && existingEdge.dateConfidence === "none") {
          existingEdge.dateConfidence = dateConfidence;
        }

        // CRITICAL: Never overwrite reviewStatus set by an investigator
        // systemStatus is also immutable after first creation
        if (!existingEdge.systemStatus && guardrailStatus) {
          existingEdge.systemStatus = guardrailStatus;
        }
        if (!existingEdge.edgeId && stableEdgeId) existingEdge.edgeId = stableEdgeId;

        await existingEdge.save(sessionOption);
        savedEdges.push(existingEdge);
      }
    }

    // ── 5. Persist / Deduplicate Patterns ───────────────────────────────────
    const rawPatterns  = Array.isArray(fastApiResult.patterns) ? fastApiResult.patterns : [];
    const savedPatterns = [];

    for (const pat of rawPatterns) {
      const patternType = pat.patternType?.trim();
      if (!patternType) continue;

      const relatedEntityIds = Array.isArray(pat.relatedEntityIds) ? pat.relatedEntityIds : [];
      const relatedEdgeIds   = Array.isArray(pat.relatedEdgeIds)   ? pat.relatedEdgeIds   : [];
      const confidence       = typeof pat.confidence === "number" ? pat.confidence : 1.0;
      const description      = pat.description?.trim() || "";
      const severity         = pat.severity || "medium";
      const metadata         = pat.metadata || {};

      let existingPattern = await Pattern.findOne(
        { caseId, patternType, description },
        null,
        sessionOption
      );

      if (!existingPattern) {
        const created = await Pattern.create(
          [{ caseId, patternType, relatedEntityIds, relatedEdgeIds, confidence, description, severity, metadata }],
          sessionOption
        );
        savedPatterns.push(created[0]);
      } else {
        existingPattern.relatedEntityIds = Array.from(
          new Set([...existingPattern.relatedEntityIds, ...relatedEntityIds])
        );
        existingPattern.relatedEdgeIds = Array.from(
          new Set([...existingPattern.relatedEdgeIds, ...relatedEdgeIds])
        );
        existingPattern.confidence = Math.max(existingPattern.confidence || 0, confidence);
        await existingPattern.save(sessionOption);
        savedPatterns.push(existingPattern);
      }
    }

    // ── Commit transaction ───────────────────────────────────────────────────
    if (useTransaction && session) {
      await session.commitTransaction();
    }

    return {
      caseId,
      status: caseDoc.status,
      summary: {
        entitiesCount: savedEntities.length,
        edgesCount:    savedEdges.length,
        patternsCount: savedPatterns.length,
      },
      createdAt: caseDoc.createdAt,
      updatedAt: caseDoc.updatedAt,
    };
  } catch (error) {
    if (useTransaction && session) {
      try { await session.abortTransaction(); } catch { /* ignore */ }
    }
    try { await Case.updateOne({ caseId }, { $set: { status: "failed" } }); } catch { /* ignore */ }

    if (error instanceof PersistenceError) throw error;

    throw new PersistenceError(
      `Database persistence failed: ${error.message}`,
      "PERSISTENCE_DATABASE_ERROR",
      500,
      error.message
    );
  } finally {
    if (session) {
      try { await session.endSession(); } catch { /* ignore */ }
    }
  }
};

module.exports = {
  PersistenceError,
  persistCaseResults,
  validateFastApiResult,
  serializeEvidenceItem,
};
