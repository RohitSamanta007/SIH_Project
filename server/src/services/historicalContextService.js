"use strict";

const { Entity, Case, Edge } = require("../models");
const {
  normalizePhone, normalizeVehicle, normalizeEmail, normalizeAccount,
  normalizeAddress, extractIdentifiersFromText,
} = require("./identifierNormalizationService");

const MAX_HISTORICAL_CASES = 3;
const MAX_EXCERPT_CHARS = 500;
const MAX_SUMMARY_CHARS = 1200;
const IDENTIFIER_TYPES = [
  { type: "phone", historyType: "phone", plural: "phones", entityField: "normalizedPhones", normalize: normalizePhone },
  { type: "vehicle", historyType: "vehicle", plural: "vehicles", entityField: "normalizedVehicles", normalize: normalizeVehicle },
  { type: "email", historyType: "person", plural: "emails", entityField: "normalizedEmails", normalize: normalizeEmail },
  { type: "account", historyType: "person", plural: "accounts", entityField: "normalizedAccounts", normalize: normalizeAccount },
  { type: "address", historyType: "location", plural: "addresses", entityField: "normalizedAddresses", normalize: normalizeAddress },
];

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value))];
}

function normalizeIdentifierInput(value = {}) {
  return Object.fromEntries(IDENTIFIER_TYPES.map(({ plural, normalize }) => [
    plural,
    uniqueStrings((Array.isArray(value[plural]) ? value[plural] : [])
      .map((item) => normalize(String(item)))
      .filter(Boolean)),
  ]));
}

function buildCaseExactQuery(currentCaseId, identifiers) {
  const conditions = IDENTIFIER_TYPES
    .filter(({ plural }) => identifiers[plural].length)
    .map(({ plural }) => ({ [`normalizedIdentifiers.${plural}`]: { $in: identifiers[plural] } }));
  return conditions.length ? { caseId: { $ne: currentCaseId }, $or: conditions } : null;
}

function matchedByType(caseDoc, identifiers) {
  const stored = caseDoc.normalizedIdentifiers || {};
  const result = new Map();
  for (const { type, plural } of IDENTIFIER_TYPES) {
    const historical = new Set(stored[plural] || []);
    const matched = identifiers[plural].filter((value) => historical.has(value));
    if (matched.length) result.set(type, uniqueStrings(matched));
  }
  return result;
}

async function buildExactCaseHistory(currentCaseId, normalizedIdentifiers) {
  const identifiers = normalizeIdentifierInput(normalizedIdentifiers);
  const caseQuery = buildCaseExactQuery(currentCaseId, identifiers);
  if (!caseQuery) return [];
  const matches = [];
  const seen = new Set();
  const add = (type, value, historicalCaseId) => {
    if (!historicalCaseId || historicalCaseId === currentCaseId) return;
    const key = `${type}:${value}:${historicalCaseId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const historyType = IDENTIFIER_TYPES.find((entry) => entry.type === type)?.historyType || type;
    matches.push({ canonicalId: `${type}:${value}`, type: historyType, lastSeenCaseId: historicalCaseId });
  };

  const historicalCases = await Case.find(caseQuery, { caseId: 1, normalizedIdentifiers: 1 }).lean();
  for (const caseDoc of historicalCases || []) {
    for (const [type, values] of matchedByType(caseDoc, identifiers)) {
      values.forEach((value) => add(type, value, caseDoc.caseId));
    }
  }

  // Exact-only compatibility lookup for documents predating Case-level arrays.
  const conditions = IDENTIFIER_TYPES
    .filter(({ plural }) => identifiers[plural].length)
    .map(({ plural, entityField }) => ({ [entityField]: { $in: identifiers[plural] } }));
  const legacyEntities = conditions.length ? await Entity.find({
    $or: conditions,
  }, {
    associatedCases: 1, normalizedPhones: 1, normalizedVehicles: 1,
    normalizedEmails: 1, normalizedAccounts: 1, normalizedAddresses: 1,
  }).lean() : [];
  for (const entity of legacyEntities || []) {
    for (const { type, plural, entityField } of IDENTIFIER_TYPES) {
      const current = new Set(identifiers[plural]);
      for (const value of entity[entityField] || []) {
        if (!current.has(value)) continue;
        for (const historicalCaseId of entity.associatedCases || []) add(type, value, historicalCaseId);
      }
    }
  }
  return matches;
}

function sentenceContainsIdentifier(sentence, type, value) {
  if (type === "address") return (normalizeAddress(sentence) || "").includes(value);
  const extracted = extractIdentifiersFromText(sentence);
  const config = IDENTIFIER_TYPES.find((entry) => entry.type === type);
  if ((extracted[config.plural] || []).includes(value)) return true;
  return config.normalize(sentence) === value;
}

function exactReportExcerpt(textReports, type, values) {
  const excerpts = [];
  for (const report of Array.isArray(textReports) ? textReports : []) {
    if (typeof report !== "string") continue;
    for (const sentence of report.split(/(?<=[.!?])\s+|\r?\n/)) {
      const trimmed = sentence.trim();
      if (!trimmed || !values.some((value) => sentenceContainsIdentifier(trimmed, type, value))) continue;
      if (!excerpts.includes(trimmed)) excerpts.push(trimmed);
      if (excerpts.length === 3) break;
    }
    if (excerpts.length === 3) break;
  }
  return excerpts.join(" ").slice(0, MAX_EXCERPT_CHARS);
}

function exactReportExcerptForMatches(textReports, matches) {
  const excerpts = [];
  for (const report of Array.isArray(textReports) ? textReports : []) {
    if (typeof report !== "string") continue;
    for (const sentence of report.split(/(?<=[.!?])\s+|\r?\n/)) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      const containsMatch = [...matches.entries()].some(([type, values]) =>
        values.some((value) => sentenceContainsIdentifier(trimmed, type, value))
      );
      if (containsMatch && !excerpts.includes(trimmed)) excerpts.push(trimmed);
      if (excerpts.length === 3) break;
    }
    if (excerpts.length === 3) break;
  }
  return excerpts.join(" ").slice(0, MAX_EXCERPT_CHARS);
}

function evidenceExcerpt(evidence) {
  const parts = [];
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const values = item?.record && typeof item.record === "object"
      ? Object.values(item.record).filter((value) => ["string", "number", "boolean"].includes(typeof value)).slice(0, 4)
      : [item?.record];
    const summary = values.filter((value) => value !== undefined && value !== null).join(" · ");
    if (summary) parts.push(summary.slice(0, 180));
    if (parts.length === 2) break;
  }
  return parts.join("; ");
}

async function buildEvidencePacket(caseDoc, matches) {
  const entityConditions = [...matches.entries()].map(([type, values]) => {
    const config = IDENTIFIER_TYPES.find((entry) => entry.type === type);
    return { [config.entityField]: { $in: values } };
  });
  const entities = await Entity.find({
    associatedCases: caseDoc.caseId,
    $or: entityConditions,
  }, { canonicalId: 1, type: 1, aliases: 1 }).limit(12).lean();
  const entityIds = uniqueStrings((entities || []).map((entity) => entity.canonicalId));
  const edges = entityIds.length ? await Edge.find({
    associatedCases: caseDoc.caseId,
    $or: [{ source: { $in: entityIds } }, { target: { $in: entityIds } }],
  }, {
    source: 1, target: 1, edgeType: 1, relationReason: 1, eventDate: 1,
    eventTime: 1, eventType: 1, dateConfidence: 1, confidence: 1, evidence: 1,
  }).limit(12).lean() : [];

  const facts = [];
  for (const entity of entities || []) {
    facts.push(`Entity ${entity.canonicalId} (${entity.type})${entity.aliases?.length ? `: ${entity.aliases.slice(0, 2).join(", ")}` : ""}`);
  }
  for (const edge of edges || []) {
    const event = [edge.eventDate, edge.eventTime, edge.eventType, edge.dateConfidence].filter(Boolean).join(" ");
    const detail = [edge.relationReason, event, typeof edge.confidence === "number" ? `confidence ${edge.confidence}` : "", evidenceExcerpt(edge.evidence)].filter(Boolean).join("; ");
    facts.push(`${edge.source} ${edge.edgeType} ${edge.target}${detail ? ` — ${detail}` : ""}`);
  }
  const matchedFields = [...matches.entries()].flatMap(([type, values]) =>
    values.map((value) => `${type}:${value}`)
  );
  return {
    caseId: caseDoc.caseId,
    caseSummary: [`Exact identifier matches: ${matchedFields.join(", ")}`, ...facts]
      .filter(Boolean).join("\n").slice(0, MAX_SUMMARY_CHARS),
    reportExcerpt: exactReportExcerptForMatches(caseDoc.textReports, matches),
    matchType: "exact",
    matchedFields,
  };
}

async function buildRetrievalContext(currentCaseId, normalizedIdentifiers, knownCaseHistory = null) {
  const caseHistory = Array.isArray(knownCaseHistory)
    ? knownCaseHistory
    : await buildExactCaseHistory(currentCaseId, normalizedIdentifiers);
  const historicalCaseIds = uniqueStrings(caseHistory
    .map((entry) => entry?.lastSeenCaseId)
    .filter((caseId) => caseId && caseId !== currentCaseId));
  if (!historicalCaseIds.length) return [];

  const historicalCases = await Case.find({
    caseId: { $in: historicalCaseIds, $ne: currentCaseId },
  }, {
    caseId: 1, textReports: 1, updatedAt: 1,
  }).sort({ updatedAt: -1 }).limit(MAX_HISTORICAL_CASES).lean();
  const packets = [];
  for (const caseDoc of historicalCases || []) {
    const matches = new Map();
    for (const entry of caseHistory) {
      if (entry?.lastSeenCaseId !== caseDoc.caseId || typeof entry.canonicalId !== "string") continue;
      const separator = entry.canonicalId.indexOf(":");
      if (separator <= 0) continue;
      const type = entry.canonicalId.slice(0, separator);
      const value = entry.canonicalId.slice(separator + 1);
      if (!IDENTIFIER_TYPES.some((config) => config.type === type) || !value) continue;
      if (!matches.has(type)) matches.set(type, []);
      matches.get(type).push(value);
    }
    for (const [type, values] of matches) matches.set(type, uniqueStrings(values));
    if (matches.size) packets.push(await buildEvidencePacket(caseDoc, matches));
  }
  return packets;
}

module.exports = { buildExactCaseHistory, buildRetrievalContext, exactReportExcerpt };
