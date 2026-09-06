const mongoose = require("mongoose");

/**
 * Sub-schema for recording upload history and ingested evidence sources
 */
const sourceUploadSchema = new mongoose.Schema(
  {
    uploadId: { type: String, trim: true },
    type: {
      type: String,
      enum: ["text", "csv", "json", "other"],
      default: "text",
    },
    filename: { type: String, trim: true },
    recordCount: { type: Number, default: 0, min: 0 },
    uploadedAt: { type: Date, default: Date.now },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const semanticReviewAuditSchema = new mongoose.Schema(
  {
    updatedBy: { type: String, trim: true },
    updatedAt: { type: Date, default: Date.now },
    previousStatus: { type: String, trim: true },
    status: { type: String, trim: true },
    reason: { type: String, trim: true },
  },
  { _id: false }
);

/**
 * Sub-schema for a single semantic similarity lead returned by FastAPI's
 * Chroma retrieval step.  Status is determined by similarityScore:
 *   score < 0.90  → "similar_case_lead"
 *   score >= 0.90 → "possible_connection"
 *
 * Semantic leads are NEVER automatically converted to graph edges.
 * Only an investigator can promote a lead to a cross-connection.
 */
const similarCaseLeadSchema = new mongoose.Schema(
  {
    matchedCaseId:  { type: String, trim: true },
    similarityScore: { type: Number, min: 0, max: 1 },
    status: {
      type: String,
      enum: ["similar_case_lead", "possible_connection"],
      default: "similar_case_lead",
    },
    rationale:      { type: String, trim: true },
    reviewRequired: { type: Boolean, default: true },
    reviewMessage:  { type: String, trim: true },
    matchingFacts: { type: [String], default: [] },
    sharedConcepts: { type: [String], default: [] },
    exactIdentifierOverlap: { type: [String], default: [] },
    investigatorStatus: { type: String, trim: true },
    investigatorReason: { type: String, trim: true },
    investigatorUpdatedBy: { type: String, trim: true },
    investigatorUpdatedAt: { type: Date },
    referencedCaseReviewedAt: { type: Date },
    reviewAudit: { type: [semanticReviewAuditSchema], default: [] },
  },
  { _id: false }
);

/**
 * Audit record written each time an investigator changes the case-level status.
 */
const reviewAuditSchema = new mongoose.Schema(
  {
    reviewedBy:     { type: String, trim: true },
    reviewedAt:     { type: Date, default: Date.now },
    previousStatus: { type: String, trim: true },
    newStatus:      { type: String, trim: true },
    note:           { type: String, trim: true },
  },
  { _id: false }
);

/**
 * Normalized identifier arrays — all stored as strings so leading zeros and
 * full-precision values are never lost.
 *
 * Normalization rules (enforced by identifierNormalizationService):
 *   phones    — digits only, no country-code prefix (+91 / 0 stripped)
 *   vehicles  — uppercase, spaces and hyphens removed
 *   emails    — trimmed lowercase
 *   accounts  — trimmed, internal whitespace removed, leading zeros kept
 *   addresses — lowercase, whitespace collapsed
 *   names     — lowercase trimmed (for case-insensitive text search only;
 *                never used to deterministically merge entities)
 */
const normalizedIdentifiersSchema = new mongoose.Schema(
  {
    phones:    { type: [String], default: [] },
    vehicles:  { type: [String], default: [] },
    emails:    { type: [String], default: [] },
    accounts:  { type: [String], default: [] },
    addresses: { type: [String], default: [] },
    names:     { type: [String], default: [] },
  },
  { _id: false }
);

const exactCaseHistorySchema = new mongoose.Schema(
  {
    canonicalId: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    lastSeenCaseId: { type: String, required: true, trim: true },
  },
  { _id: false }
);

/**
 * Case Schema
 * Represents a single investigation instance.
 *
 * Backward-compatibility guarantee:
 *   Every new field carries a safe default (undefined / [] / null) so that
 *   documents created before this migration load without validation errors.
 */
const caseSchema = new mongoose.Schema(
  {
    caseId: {
      type: String,
      required: [true, "caseId is required"],
      unique: true,
      trim: true,
      index: true,
    },

    // ----- Processing / investigator status -----
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "open", "closed"],
      default: "pending",
      index: true,
    },

    // ----- Case metadata -----
    title: { type: String, trim: true },
    description: { type: String, trim: true },

    // ----- Original FIR / report texts (array so multiple uploads accumulate) -----
    // textReports preserves the exact submitted FIR/report text.
    // FastAPI receives the current submission's textReports directly from intake;
    // this field is the permanent MongoDB copy for audit and search.
    textReports: { type: [String], default: [] },
    csvRecords: { type: [mongoose.Schema.Types.Mixed], default: [] },

    // ----- FastAPI AI result fields -----

    /**
     * Deterministic summary returned by FastAPI's retrieval pipeline.
     * Stored permanently in MongoDB; sent as `caseSummary` in future
     * retrievalContext entries for other cases.
     * Indexed for keyword search.
     */
    retrievalSummary: { type: String, trim: true },

    /**
     * Semantic similarity leads from FastAPI's Chroma retrieval.
     * Status: "similar_case_lead" (score < 0.90) or "possible_connection" (≥ 0.90).
     * Never automatically converted to verified cross-case graph edges.
     */
    similarCaseLeads: { type: [similarCaseLeadSchema], default: [] },

    /**
     * Timeline events generated by the AI to build a chronological sequence.
     */
    timelineEvents: {
      type: [
        new mongoose.Schema(
          {
            eventDate: { type: String, trim: true },
            eventTime: { type: String, trim: true },
            eventType: { type: String, trim: true },
            relationReason: { type: String, trim: true },
            edgeId: { type: String, trim: true },
            evidenceIds: { type: [String], default: [] },
            dateConfidence: { type: String, trim: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // Exact-only history sent to FastAPI for this processing run. Logical
    // case IDs are retained for recurrence alerts and auditability.
    caseHistory: { type: [exactCaseHistorySchema], default: [] },

    // Immutable-shaped snapshot of the successful FastAPI response. Entities,
    // edges and patterns continue to be normalized into their existing
    // collections for graph queries; this preserves the complete wire result.
    fastApiResponse: { type: mongoose.Schema.Types.Mixed },

    // FastAPI system-level guardrail status for the whole case (if returned)
    systemStatus: { type: String, trim: true },

    // ----- Identifier indexes for cross-case exact lookup -----
    normalizedIdentifiers: {
      type: normalizedIdentifiersSchema,
      default: () => ({}),
    },

    // ----- Upload history -----
    sourceUploads: { type: [sourceUploadSchema], default: [] },

    // ----- Investigator manual review -----
    investigatorReview: {
      type: reviewAuditSchema,
      default: undefined,
    },

    // ----- Catch-all metadata (category, priority, etc.) -----
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    collection: "cases",
  }
);

// ----- Indexes -----

// Full-text search remains available for investigator-facing discovery only.
// It is never used to build deterministic caseHistory.
caseSchema.index(
  { title: "text", "metadata.category": "text", retrievalSummary: "text" },
  { name: "case_text_search", background: true }
);

// Sparse indexes for exact normalized-identifier lookup on the Case level
// (mirrors the same arrays that live on each Entity document).
caseSchema.index(
  { "normalizedIdentifiers.phones": 1 },
  { sparse: true, name: "case_norm_phones" }
);
caseSchema.index(
  { "normalizedIdentifiers.vehicles": 1 },
  { sparse: true, name: "case_norm_vehicles" }
);
caseSchema.index(
  { "normalizedIdentifiers.emails": 1 },
  { sparse: true, name: "case_norm_emails" }
);
caseSchema.index(
  { "normalizedIdentifiers.accounts": 1 },
  { sparse: true, name: "case_norm_accounts" }
);
caseSchema.index(
  { "normalizedIdentifiers.addresses": 1 },
  { sparse: true, name: "case_norm_addresses" }
);

const Case = mongoose.model("Case", caseSchema);

module.exports = Case;
