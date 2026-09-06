"use strict";

jest.mock("../src/models", () => ({
  Case: { find: jest.fn() },
  Entity: { find: jest.fn() },
  Edge: { find: jest.fn() },
  Pattern: {},
}));

const { Case, Entity, Edge } = require("../src/models");
const { buildCrossCaseEvidence } = require("../src/services/caseGraphService");

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

const history = [{
  canonicalId: "phone:9050011122",
  type: "phone",
  lastSeenCaseId: "ALPHA-01",
}];

function mockExactHistoricalRelationship() {
  Case.find.mockReturnValue(leanResult([{ caseId: "ALPHA-01", title: "Salt Lake Recovery" }]));
  Entity.find
    .mockReturnValueOnce(leanResult([{ canonicalId: "phone:9050011122" }]))
    .mockReturnValueOnce(leanResult([{ canonicalId: "phone:9050011122" }]))
    .mockReturnValueOnce(leanResult([{
      canonicalId: "person:rafiq-old",
      type: "person",
      aliases: ["Rafiq Mondal"],
      attributes: {},
      confidence: 0.93,
    }]));
  Edge.find.mockReturnValue(leanResult([{
    _id: { toString: () => "mongo-edge-id" },
    edgeId: "historical-edge-1",
    source: "person:rafiq-old",
    target: "phone:9050011122",
    edgeType: "uses_phone",
    confidence: 0.95,
    systemStatus: "verified",
    relationReason: "Witness identified Rafiq using phone 9050011122.",
    eventDate: "2026-03-05",
    eventTime: null,
    evidence: [{ sourceReportId: "OLD_TEXT_0", matchedField: "phone", record: { excerpt: "Rafiq using phone 9050011122" } }],
  }]));
}

describe("cross-case historical graph evidence", () => {
  beforeEach(() => jest.clearAllMocks());

  test("builds an exact, namespaced, one-hop evidence record without changing status", async () => {
    mockExactHistoricalRelationship();

    const result = await buildCrossCaseEvidence("ALPHA-04", history);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      currentEntityId: "phone:9050011122",
      matchedIdentifier: "phone:9050011122",
      identifierType: "phone",
      historicalCaseId: "ALPHA-01",
      historicalCaseName: "Salt Lake Recovery",
      historicalEntity: expect.objectContaining({
        id: "historical:ALPHA-01:person:rafiq-old",
        name: "Rafiq Mondal",
      }),
      historicalRelationship: expect.objectContaining({
        edgeId: "historical-edge-1",
        edgeType: "uses_phone",
        modelStatus: "verified",
        relationReason: "Witness identified Rafiq using phone 9050011122.",
      }),
    }));
    expect(result[0].historicalEntity.id).not.toBe(result[0].currentEntityId);
    expect(result[0].historicalRelationship).not.toHaveProperty("reviewStatus");
    expect(Edge.find.mock.calls[0][0]).toEqual(expect.objectContaining({
      associatedCases: "ALPHA-01",
      $or: [
        { source: { $in: ["phone:9050011122"] } },
        { target: { $in: ["phone:9050011122"] } },
      ],
    }));
  });

  test("deduplicates repeated exact history and repeated historical relationships", async () => {
    mockExactHistoricalRelationship();
    const duplicateHistory = [history[0], { ...history[0] }, { ...history[0], type: "person" }];
    const originalEdge = await Edge.find().lean();
    Edge.find.mockClear();
    Edge.find.mockReturnValue(leanResult([originalEdge[0], { ...originalEdge[0] }]));

    const result = await buildCrossCaseEvidence("ALPHA-04", duplicateHistory);

    expect(result).toHaveLength(1);
    expect(Case.find).toHaveBeenCalledTimes(1);
  });

  test("does not build evidence from generic vocabulary, semantic leads, or unsupported history", async () => {
    const result = await buildCrossCaseEvidence("ALPHA-04", [
      { canonicalId: "person:Rafiq Mondal", type: "person", lastSeenCaseId: "ALPHA-01" },
      { canonicalId: "summary:motorcycle theft witness", type: "person", lastSeenCaseId: "ALPHA-02" },
    ]);

    expect(result).toEqual([]);
    expect(Case.find).not.toHaveBeenCalled();
    expect(Entity.find).not.toHaveBeenCalled();
    expect(Edge.find).not.toHaveBeenCalled();
  });

  test("handles a deleted historical logical case without exposing an overlay", async () => {
    Case.find.mockReturnValue(leanResult([]));

    const result = await buildCrossCaseEvidence("ALPHA-04", history);

    expect(result).toEqual([]);
    expect(Entity.find).not.toHaveBeenCalled();
    expect(Case.find.mock.calls[0][0]).toEqual({
      caseId: { $in: ["ALPHA-01"], $ne: "ALPHA-04" },
    });
  });

  test("requires original relationship evidence", async () => {
    Case.find.mockReturnValue(leanResult([{ caseId: "ALPHA-01" }]));
    Entity.find
      .mockReturnValueOnce(leanResult([{ canonicalId: "phone:9050011122" }]))
      .mockReturnValueOnce(leanResult([{ canonicalId: "phone:9050011122" }]));
    Edge.find.mockReturnValue(leanResult([{
      edgeId: "no-evidence",
      source: "person:rafiq-old",
      target: "phone:9050011122",
      edgeType: "uses_phone",
      evidence: [],
    }]));

    expect(await buildCrossCaseEvidence("ALPHA-04", history)).toEqual([]);
    expect(Entity.find).toHaveBeenCalledTimes(2);
  });
});
