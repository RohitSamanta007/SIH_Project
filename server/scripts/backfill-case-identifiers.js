"use strict";

const { connectDB, disconnectDB } = require("../config/db");
const { Case, Entity, Edge } = require("../src/models");
const { buildEntityNormalizedIdentifiers } = require("../src/services/identifierNormalizationService");

async function run() {
  await connectDB();
  const perCase = new Map();
  const empty = () => ({ phones: new Set(), vehicles: new Set(), emails: new Set(), accounts: new Set(), addresses: new Set() });

  for await (const entity of Entity.find({}).cursor()) {
    const normalized = buildEntityNormalizedIdentifiers(entity.toObject());
    await Entity.updateOne({ _id: entity._id }, { $set: normalized });
    for (const caseId of entity.associatedCases || []) {
      if (!perCase.has(caseId)) perCase.set(caseId, empty());
      const target = perCase.get(caseId);
      for (const [entityField, plural] of [
        ["normalizedPhones", "phones"], ["normalizedVehicles", "vehicles"],
        ["normalizedEmails", "emails"], ["normalizedAccounts", "accounts"],
        ["normalizedAddresses", "addresses"],
      ]) for (const value of normalized[entityField] || []) target[plural].add(value);
    }
  }

  for (const [caseId, identifiers] of perCase) {
    await Case.updateOne({ caseId }, { $set: {
      "normalizedIdentifiers.phones": [...identifiers.phones],
      "normalizedIdentifiers.vehicles": [...identifiers.vehicles],
      "normalizedIdentifiers.emails": [...identifiers.emails],
      "normalizedIdentifiers.accounts": [...identifiers.accounts],
      "normalizedIdentifiers.addresses": [...identifiers.addresses],
    } });
  }
  await Edge.updateMany(
    { systemStatus: { $exists: false }, guardrailStatus: { $exists: true, $ne: null } },
    [{ $set: { systemStatus: "$guardrailStatus" } }]
  );
  const clearedLegacyDefaults = await Edge.updateMany(
    {
      reviewStatus: { $exists: true },
      reviewAudit: { $size: 0 },
      reviewUpdatedBy: { $exists: false },
      reviewReason: { $exists: false },
    },
    { $unset: { reviewStatus: "" } }
  );
  // Create declared indexes without dropping existing indexes or case data.
  await Case.createIndexes();
  await Entity.createIndexes();
  console.log(`Backfilled normalized identifiers for ${perCase.size} logical cases.`);
  console.log("Verified logical caseId and normalized identifier indexes.");
  console.log(`Cleared ${clearedLegacyDefaults.modifiedCount || 0} legacy model-derived review statuses.`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(disconnectDB);
