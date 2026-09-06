"use strict";

jest.mock("../src/models", () => ({
  Case: { find: jest.fn() }, Entity: { find: jest.fn() }, Edge: { find: jest.fn() },
}));

const { Case, Entity, Edge } = require("../src/models");
const { buildExactCaseHistory, buildRetrievalContext } = require("../src/services/historicalContextService");

const leanQuery = (value) => ({ lean: jest.fn().mockResolvedValue(value) });
const limitedQuery = (value) => ({ limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(value) });

describe("historical exact evidence", () => {
  beforeEach(() => jest.clearAllMocks());

  test("deduplicates by type, normalized value, and logical case ID", async () => {
    Case.find.mockReturnValue(leanQuery([
      { caseId: "OLD-1", normalizedIdentifiers: { phones: ["9012345678", "9012345678"] } },
      { caseId: "OLD-2", normalizedIdentifiers: { phones: ["9012345678"] } },
    ]));
    Entity.find.mockReturnValue(leanQuery([
      { associatedCases: ["OLD-1"], normalizedPhones: ["9012345678", "9012345678"] },
    ]));
    const history = await buildExactCaseHistory("NEW-1", { phones: ["9012345678"], vehicles: [], emails: [], accounts: [], addresses: [] });
    expect(history).toEqual([
      { canonicalId: "phone:9012345678", type: "phone", lastSeenCaseId: "OLD-1" },
      { canonicalId: "phone:9012345678", type: "phone", lastSeenCaseId: "OLD-2" },
    ]);
  });

  test("generic FIR wording produces no historical lookup entries", async () => {
    const history = await buildExactCaseHistory("NEW-1", {
      phones: [], vehicles: [], emails: [], accounts: [], addresses: [],
    });
    expect(history).toEqual([]);
    expect(Case.find).not.toHaveBeenCalled();
    expect(Entity.find).not.toHaveBeenCalled();
  });

  test("builds bounded exact packets and never sends an unrelated full FIR", async () => {
    const fullFir = `Unrelated opening. Exact phone +91 90123 45678 appeared in a call.${" private narrative".repeat(200)}`;
    Case.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ caseId: "OLD-1", retrievalSummary: "Bounded summary", textReports: [fullFir], normalizedIdentifiers: { phones: ["9012345678"] } }]),
    });
    Entity.find.mockReturnValue(limitedQuery([{ canonicalId: "PHONE-1", type: "phone", aliases: ["+91 90123 45678"] }]));
    Edge.find.mockReturnValue(limitedQuery([{
      source: "PERSON-1", target: "PHONE-1", edgeType: "telecom_link", relationReason: "CDR call",
      eventDate: "2025-01-02", eventTime: "10:30", eventType: "call", dateConfidence: "explicit", confidence: 0.98,
      evidence: [{ record: { excerpt: "9012345678 called the suspect" } }],
    }]));
    const packets = await buildRetrievalContext(
      "NEW-1",
      { phones: ["9012345678"] },
      [{ canonicalId: "phone:9012345678", type: "phone", lastSeenCaseId: "OLD-1" }]
    );
    expect(packets).toHaveLength(1);
    expect(packets[0].matchType).toBe("exact");
    expect(packets[0].matchedFields).toEqual(["phone:9012345678"]);
    expect(packets[0].caseSummary).toContain("CDR call");
    expect(packets[0].caseSummary).toContain("2025-01-02 10:30 call explicit");
    expect(packets[0].reportExcerpt).toContain("90123 45678");
    expect(packets[0].reportExcerpt.length).toBeLessThanOrEqual(500);
    expect(packets[0].caseSummary.length).toBeLessThanOrEqual(1200);
    expect(packets[0].reportExcerpt).not.toBe(fullFir);
  });

  test("builds acceptance history from exact normalized fields using logical case IDs", async () => {
    Case.find.mockReturnValue(leanQuery([
      { _id: "mongo-1", caseId: "ALPHA-01", normalizedIdentifiers: { phones: ["9050011122"], vehicles: ["WB24K5521"] } },
      { _id: "mongo-2", caseId: "ALPHA-02", normalizedIdentifiers: { phones: ["9050011122"] } },
      { _id: "mongo-3", caseId: "ALPHA-03", normalizedIdentifiers: { vehicles: ["WB19R8842"], addresses: ["44 ganges road howrah"] } },
      { _id: "mongo-current", caseId: "ALPHA-NEW", normalizedIdentifiers: { phones: ["9050011122"] } },
    ]));
    Entity.find.mockReturnValue(leanQuery([
      { associatedCases: ["ALPHA-01", "ALPHA-01"], normalizedPhones: ["9050011122"] },
      { associatedCases: ["ALPHA-03"], normalizedVehicles: ["WB19R8842"], normalizedAddresses: ["44 ganges road howrah"] },
    ]));

    const history = await buildExactCaseHistory("ALPHA-NEW", {
      phones: ["+91 90500 11122"],
      vehicles: ["WB-19-R-8842"],
      emails: [], accounts: [],
      addresses: ["44 Ganges Road,  Howrah"],
    });

    expect(Case.find.mock.calls[0][0]).toEqual(expect.objectContaining({ caseId: { $ne: "ALPHA-NEW" } }));
    expect(history).toEqual(expect.arrayContaining([
      { canonicalId: "phone:9050011122", type: "phone", lastSeenCaseId: "ALPHA-01" },
      { canonicalId: "phone:9050011122", type: "phone", lastSeenCaseId: "ALPHA-02" },
      { canonicalId: "vehicle:WB19R8842", type: "vehicle", lastSeenCaseId: "ALPHA-03" },
      { canonicalId: "address:44 ganges road howrah", type: "location", lastSeenCaseId: "ALPHA-03" },
    ]));
    expect(history.some((entry) => entry.lastSeenCaseId === "mongo-1")).toBe(false);
    expect(history.some((entry) => entry.lastSeenCaseId === "ALPHA-NEW")).toBe(false);
    expect(history.filter((entry) => entry.canonicalId === "phone:9050011122" && entry.lastSeenCaseId === "ALPHA-01")).toHaveLength(1);
  });
});
