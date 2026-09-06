"use strict";

jest.mock("../src/models", () => ({
  Case: { find: jest.fn() }, Entity: {}, Edge: {}, Pattern: {},
}));

const { Case } = require("../src/models");
const { decorateRecurrencePatterns } = require("../src/services/caseGraphService");

describe("recurrence references in graph responses", () => {
  beforeEach(() => jest.clearAllMocks());

  test("marks historical logical case IDs available or unavailable", async () => {
    Case.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([{ caseId: "ALPHA-01" }]) });
    const [pattern] = await decorateRecurrencePatterns([{
      patternType: "cross_case_recurrence",
      metadata: {
        exactMatches: [{
          canonicalId: "phone:9050011122",
          historicalCaseIds: ["ALPHA-01", "ALPHA-DELETED", "ALPHA-NEW"],
        }],
      },
    }], "ALPHA-NEW");

    expect(pattern.metadata.exactMatches[0].historicalCases).toEqual([
      { caseId: "ALPHA-01", available: true },
      { caseId: "ALPHA-DELETED", available: false },
    ]);
    expect(Case.find.mock.calls[0][0]).toEqual({
      caseId: { $in: ["ALPHA-01", "ALPHA-DELETED"] },
    });
  });
});
