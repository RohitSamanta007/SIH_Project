"use strict";

jest.mock("../src/models", () => ({
  Case: { findOneAndUpdate: jest.fn(), updateOne: jest.fn() },
}));
jest.mock("../src/services/identifierNormalizationService", () => ({
  extractIdentifiersFromCase: jest.fn(),
}));
jest.mock("../src/services/historicalContextService", () => ({
  buildExactCaseHistory: jest.fn(), buildRetrievalContext: jest.fn(),
}));
jest.mock("../src/services/fastApiClient", () => ({
  callFastAPI: jest.fn(), FastApiError: class FastApiError extends Error {},
}));
jest.mock("../src/services/resultPersistenceService", () => ({
  persistCaseResults: jest.fn(), PersistenceError: class PersistenceError extends Error {},
}));

const { Case } = require("../src/models");
const { extractIdentifiersFromCase } = require("../src/services/identifierNormalizationService");
const { buildExactCaseHistory, buildRetrievalContext } = require("../src/services/historicalContextService");
const { callFastAPI } = require("../src/services/fastApiClient");
const { persistCaseResults } = require("../src/services/resultPersistenceService");
const { processCaseThroughFastApi } = require("../src/services/caseProcessingService");

describe("case processing exact-history orchestration", () => {
  beforeEach(() => jest.clearAllMocks());

  test("looks up history before inserting the current case and forwards it to FastAPI and persistence", async () => {
    const identifiers = {
      phones: ["9050011122"], vehicles: ["WB19R8842"], emails: [], accounts: [],
      addresses: ["44 ganges road howrah"],
    };
    const caseHistory = [
      { canonicalId: "phone:9050011122", type: "phone", lastSeenCaseId: "ALPHA-01" },
      { canonicalId: "vehicle:WB19R8842", type: "vehicle", lastSeenCaseId: "ALPHA-03" },
    ];
    extractIdentifiersFromCase.mockReturnValue(identifiers);
    buildExactCaseHistory.mockResolvedValue(caseHistory);
    buildRetrievalContext.mockResolvedValue([{ caseId: "ALPHA-01", matchType: "exact" }]);
    Case.findOneAndUpdate.mockResolvedValue(null);
    callFastAPI.mockResolvedValue({
      caseId: "ALPHA-NEW", entities: [], relationships: [], guardrail: [], timelineEvents: [],
      similarCaseLeads: [],
      patterns: [{ patternType: "cross_case_recurrence", relatedEntityIds: ["phone:9050011122"] }],
    });
    persistCaseResults.mockResolvedValue({ caseId: "ALPHA-NEW", status: "completed", summary: {} });

    await processCaseThroughFastApi({
      caseId: "ALPHA-NEW", title: "New case", category: "Vehicle theft",
      textReports: ["Phone 9050011122 and WB-19-R-8842"], csvRecords: [],
    });

    expect(buildExactCaseHistory.mock.invocationCallOrder[0]).toBeLessThan(Case.findOneAndUpdate.mock.invocationCallOrder[0]);
    expect(buildRetrievalContext).toHaveBeenCalledWith("ALPHA-NEW", identifiers, caseHistory);
    expect(callFastAPI).toHaveBeenCalledWith(expect.objectContaining({
      caseId: "ALPHA-NEW",
      caseHistory,
      retrievalContext: [{ caseId: "ALPHA-01", matchType: "exact" }],
    }), {});
    expect(persistCaseResults).toHaveBeenCalledWith(expect.objectContaining({
      patterns: [expect.objectContaining({
        patternType: "cross_case_recurrence",
        metadata: expect.objectContaining({
          exactMatches: [expect.objectContaining({
            canonicalId: "phone:9050011122",
            historicalCaseIds: ["ALPHA-01"],
          })],
        }),
      })],
    }), expect.objectContaining({ normalizedIdentifiers: identifiers, caseHistory }));
  });
});
