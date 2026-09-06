"use strict";

const { callFastAPI, FastApiError } = require("./fastApiClient");
const { persistCaseResults, PersistenceError } = require("./resultPersistenceService");
const { Case } = require("../models");
const { extractIdentifiersFromCase } = require("./identifierNormalizationService");
const { buildExactCaseHistory, buildRetrievalContext } = require("./historicalContextService");

function enrichRecurrencePatterns(fastApiResult, caseHistory) {
  if (!fastApiResult || !Array.isArray(fastApiResult.patterns)) return fastApiResult;

  const grouped = new Map();
  for (const entry of Array.isArray(caseHistory) ? caseHistory : []) {
    if (!entry?.canonicalId || !entry?.lastSeenCaseId) continue;
    const key = `${entry.type}:${entry.canonicalId}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        canonicalId: entry.canonicalId,
        type: entry.type,
        historicalCaseIds: [],
      });
    }
    const match = grouped.get(key);
    if (!match.historicalCaseIds.includes(entry.lastSeenCaseId)) {
      match.historicalCaseIds.push(entry.lastSeenCaseId);
    }
  }
  const exactMatches = [...grouped.values()];

  return {
    ...fastApiResult,
    patterns: fastApiResult.patterns.map((pattern) => {
      if (pattern?.patternType !== "cross_case_recurrence") return pattern;
      const related = new Set(Array.isArray(pattern.relatedEntityIds) ? pattern.relatedEntityIds : []);
      const relatedMatches = exactMatches.filter((match) => related.has(match.canonicalId));
      return {
        ...pattern,
        metadata: {
          ...(pattern.metadata && typeof pattern.metadata === "object" ? pattern.metadata : {}),
          exactMatches: relatedMatches.length ? relatedMatches : exactMatches,
        },
      };
    }),
  };
}

/**
 * Case Processing Service (Orchestration Layer)
 *
 * Coordinates normalized case intake → historical context injection →
 * FastAPI reasoning call → MongoDB persistence.
 *
 * Pipeline:
 *  1. Extract normalized identifiers from current FIR + CSV
 *  2. Build exact historical context before writing the current case
 *  3. Create/upsert the current Case document with status "processing"
 *  4. Call FastAPI reasoning service with the enriched payload
 *  5. Persist the complete AI result into existing MongoDB collections
 *
 * @param {Object} normalizedCase — from caseIntakeService.processCaseIntake()
 * @param {Object} [options]      — transport overrides used in tests
 * @returns {Promise<Object>}      Persistence summary and Case status
 */
const processCaseThroughFastApi = async (normalizedCase, options = {}) => {
  if (!normalizedCase || !normalizedCase.caseId) {
    throw new Error("Invalid case payload passed to caseProcessingService");
  }

  const caseId = normalizedCase.caseId;

  // ── 1. Extract normalized identifiers from the current FIR and CSV data ──
  //    This is used to build the exact-match caseHistory and retrievalContext.
  let normalizedIdentifiers = { phones: [], vehicles: [], emails: [], accounts: [], addresses: [] };
  try {
    normalizedIdentifiers = extractIdentifiersFromCase(
      normalizedCase.textReports || [],
      normalizedCase.csvRecords  || []
    );
    console.log(
      `[caseProcessingService] Extracted identifiers for ${caseId}:`,
      `phones=${normalizedIdentifiers.phones.length}`,
      `vehicles=${normalizedIdentifiers.vehicles.length}`,
      `emails=${normalizedIdentifiers.emails.length}`,
      `accounts=${normalizedIdentifiers.accounts.length}`,
      `addresses=${normalizedIdentifiers.addresses.length}`
    );
  } catch (err) {
    console.warn("[caseProcessingService] Identifier extraction failed:", err.message);
  }

  // ── 2. Build caseHistory from exact identifier matches ───────────────────
  //    Non-fatal: if lookup fails, proceed with empty history so FastAPI still runs.
  let caseHistory = [];
  try {
    caseHistory = await buildExactCaseHistory(caseId, normalizedIdentifiers);
    console.log(`[caseProcessingService] caseHistory entries: ${caseHistory.length}`);
  } catch (err) {
    console.error("[caseProcessingService] buildExactCaseHistory failed — empty history:", err.message);
  }

  // Build retrievalContext from the same exact hits only. Passing caseHistory
  // avoids a second, potentially divergent historical search.
  //    Non-fatal: if context building fails, send empty array.
  let retrievalContext = [];
  try {
    retrievalContext = await buildRetrievalContext(
      caseId,
      normalizedIdentifiers,
      caseHistory
    );
    console.log(`[caseProcessingService] retrievalContext entries: ${retrievalContext.length}`);
  } catch (err) {
    console.error("[caseProcessingService] buildRetrievalContext failed — empty context:", err.message);
  }

  // ── 3. Only now write the current case. This guarantees it cannot become
  // part of its own historical lookup, even transiently.
  try {
    await Case.findOneAndUpdate(
      { caseId },
      {
        $setOnInsert: { caseId },
        $set: {
          status: "processing",
          ...(normalizedCase.title ? { title: normalizedCase.title } : {}),
          ...(normalizedCase.category ? { "metadata.category": normalizedCase.category } : {}),
          "normalizedIdentifiers.phones": normalizedIdentifiers.phones,
          "normalizedIdentifiers.vehicles": normalizedIdentifiers.vehicles,
          "normalizedIdentifiers.emails": normalizedIdentifiers.emails,
          "normalizedIdentifiers.accounts": normalizedIdentifiers.accounts,
          "normalizedIdentifiers.addresses": normalizedIdentifiers.addresses,
        },
        $addToSet: {
          textReports: { $each: normalizedCase.textReports || [] },
          csvRecords: { $each: normalizedCase.csvRecords || [] },
        },
      },
      { upsert: true, returnDocument: "before" }
    );
  } catch (err) {
    console.warn("[caseProcessingService] Could not pre-create Case document:", err.message);
  }

  // ── 4. Build enriched payload and call FastAPI ───────────────────────────
  const enrichedCase = {
    ...normalizedCase,
    caseHistory,
    retrievalContext,
    // caseName and caseCategory are passed through for FastAPI context
    caseName:     normalizedCase.title    || "",
    caseCategory: normalizedCase.category || "",
  };

  let fastApiResult;
  try {
    fastApiResult = await callFastAPI(enrichedCase, options);
    fastApiResult = enrichRecurrencePatterns(fastApiResult, caseHistory);
  } catch (err) {
    // Mark case as 'failed' — never leave it stuck on 'processing'
    try {
      await Case.updateOne(
        { caseId },
        {
          $set: {
            status: "failed",
            "metadata.failureReason": err.message || "FastAPI call failed",
            "metadata.failureCode":   err.code || "FASTAPI_ERROR",
            "metadata.failedAt":      new Date().toISOString(),
          },
        }
      );
    } catch (updateErr) {
      console.error("[caseProcessingService] Failed to mark case as failed:", updateErr.message);
    }
    throw err;
  }

  // ── 5. Persist AI reasoning results into MongoDB ─────────────────────────
  console.log(`[caseProcessingService] Calling persistCaseResults for ${caseId}...`);
  const persistenceResult = await persistCaseResults(fastApiResult, {
    ...normalizedCase,
    normalizedIdentifiers,
    caseHistory,
  });
  console.log(`[caseProcessingService] persistCaseResults finished for ${caseId}.`);

  return persistenceResult;
};

module.exports = {
  processCaseThroughFastApi,
  enrichRecurrencePatterns,
  FastApiError,
  PersistenceError,
};
