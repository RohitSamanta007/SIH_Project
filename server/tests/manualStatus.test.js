"use strict";

jest.mock("../src/services/caseIntakeService", () => ({ processCaseIntake: jest.fn() }));
jest.mock("../src/services/caseProcessingService", () => ({ processCaseThroughFastApi: jest.fn() }));
jest.mock("../src/services/caseGraphService", () => ({
  getCaseGraph: jest.fn(), getEntityDetail: jest.fn(), getCaseTimeline: jest.fn(),
  getGuardrailDetail: jest.fn(), getCasesList: jest.fn(),
}));
jest.mock("../src/models", () => ({
  Edge: { findOne: jest.fn(), find: jest.fn(), create: jest.fn() },
  Entity: { find: jest.fn() },
  Case: { findOne: jest.fn(), exists: jest.fn() },
}));

const { Edge, Entity, Case } = require("../src/models");
const controller = require("../src/controllers/caseController");
const { requireInvestigator } = require("../src/middleware/authMiddleware");

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe("investigator decisions", () => {
  beforeEach(() => jest.clearAllMocks());

  test("rejects authenticated non-investigators", () => {
    const res = response();
    const next = jest.fn();
    requireInvestigator({ user: { role: "viewer" } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test("persists a manual override and append-only audit without changing model status", async () => {
    const edge = {
      _id: "507f1f77bcf86cd799439011", edgeId: "edge-1", systemStatus: "possible_connection",
      guardrailStatus: "possible_connection", reviewAudit: [], save: jest.fn(),
    };
    Edge.findOne.mockResolvedValue(edge);
    const req = { params: { caseId: "CASE-1", edgeId: "edge-1" }, body: { status: "verified", reason: "Confirmed from CDR" }, user: { role: "investigator", username: "asha" } };
    const res = response();
    await controller.updateRelationshipStatus(req, res, jest.fn());
    expect(edge.reviewStatus).toBe("verified");
    expect(edge.reviewReason).toBe("Confirmed from CDR");
    expect(edge.reviewAudit).toHaveLength(1);
    expect(edge.reviewAudit[0]).toMatchObject({ previousStatus: "possible_connection", newStatus: "verified", reviewedBy: "asha" });
    expect(edge.systemStatus).toBe("possible_connection");
    expect(edge.save).toHaveBeenCalled();
  });

  test("creates an audited manual relationship between entities in the case graph", async () => {
    Case.exists.mockResolvedValue({ _id: "case-db-id" });
    Edge.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
    Entity.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        { canonicalId: "person:a" }, { canonicalId: "account:b" },
      ]) }),
    });
    Edge.findOne.mockResolvedValue(null);
    Edge.create.mockImplementation(async (payload) => payload);

    const req = {
      params: { caseId: "CASE-1" },
      body: {
        source: "person:a", target: "account:b", edgeType: "Transferred Funds To",
        status: "verified", reason: "Bank statement confirms the transfer",
        eventDate: "2026-08-14", eventTime: "12:30",
      },
      user: { role: "investigator", username: "asha" },
    };
    const res = response();
    await controller.createManualRelationship(req, res, jest.fn());

    expect(Edge.create).toHaveBeenCalledWith(expect.objectContaining({
      associatedCases: ["CASE-1"],
      source: "person:a",
      target: "account:b",
      edgeType: "transferred_funds_to",
      reviewStatus: "verified",
      relationReason: "Bank statement confirms the transfer",
      dateConfidence: "explicit",
    }));
    const created = Edge.create.mock.calls[0][0];
    expect(created.edgeId).toMatch(/^manual-/);
    expect(created.reviewAudit).toEqual([expect.objectContaining({
      reviewedBy: "asha", previousStatus: "unknown", newStatus: "verified",
    })]);
    expect(created.evidence[0].record.summary).toBe("Bank statement confirms the transfer");
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test("links a global relationship into the current case and appends investigator evidence", async () => {
    Case.exists.mockResolvedValue({ _id: "case-db-id" });
    Edge.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
    Entity.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        { canonicalId: "person:rafiq" }, { canonicalId: "vehicle:wb24" },
      ]) }),
    });
    const existing = {
      _id: { toString: () => "edge-db-id" },
      edgeId: "existing-edge",
      source: "person:rafiq",
      target: "vehicle:wb24",
      edgeType: "associated_with",
      associatedCases: ["CASE-OLD"],
      confidence: 0.9,
      systemStatus: "possible_connection",
      reviewStatus: "possible_connection",
      reviewAudit: [],
      evidence: [{ sourceReportId: "CASE-OLD_text_0", matchedField: "associated_with", record: {} }],
      attributes: {},
      dateConfidence: "none",
      save: jest.fn(),
    };
    Edge.findOne.mockResolvedValue(existing);

    const res = response();
    await controller.createManualRelationship({
      params: { caseId: "CASE-NEW" },
      body: {
        source: "person:rafiq", target: "vehicle:wb24", edgeType: "Associated with",
        status: "verified", reason: "The FIR explicitly links the person and vehicle",
        eventDate: "2026-03-05", eventTime: "15:04",
      },
      user: { role: "investigator", username: "asha" },
    }, res, jest.fn());

    expect(Edge.findOne).toHaveBeenCalledWith({
      edgeType: "associated_with",
      $or: [
        { source: "person:rafiq", target: "vehicle:wb24" },
        { source: "vehicle:wb24", target: "person:rafiq" },
      ],
    });
    expect(existing.associatedCases).toEqual(["CASE-OLD", "CASE-NEW"]);
    expect(existing.reviewStatus).toBe("verified");
    expect(existing.reviewAudit).toEqual([expect.objectContaining({
      reviewedBy: "asha", previousStatus: "possible_connection", newStatus: "verified",
    })]);
    expect(existing.evidence).toHaveLength(2);
    expect(existing.evidence[1]).toMatchObject({
      sourceReportId: "investigator_manual",
      metadata: { caseId: "CASE-NEW", eventDate: "2026-03-05", eventTime: "15:04" },
    });
    expect(existing.attributes.manuallyCorroborated).toBe(true);
    expect(existing.save).toHaveBeenCalled();
    expect(Edge.create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ reusedExisting: true, associatedCases: ["CASE-OLD", "CASE-NEW"] }),
    }));
  });

  test("still rejects a relationship that is already linked to the current case", async () => {
    Case.exists.mockResolvedValue({ _id: "case-db-id" });
    Edge.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
    Entity.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
        { canonicalId: "person:a" }, { canonicalId: "vehicle:b" },
      ]) }),
    });
    Edge.findOne.mockResolvedValue({
      source: "person:a", target: "vehicle:b", edgeType: "associated_with",
      associatedCases: ["CASE-1"],
    });

    const res = response();
    await controller.createManualRelationship({
      params: { caseId: "CASE-1" },
      body: { source: "person:a", target: "vehicle:b", edgeType: "associated_with", status: "verified", reason: "Already known" },
      user: { role: "investigator", username: "asha" },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(Edge.create).not.toHaveBeenCalled();
  });

  test("refuses to connect an entity outside the current case graph", async () => {
    Case.exists.mockResolvedValue({ _id: "case-db-id" });
    Edge.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
    Entity.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ canonicalId: "person:a" }]) }),
    });
    const res = response();
    await controller.createManualRelationship({
      params: { caseId: "CASE-1" },
      body: { source: "person:a", target: "person:outside", edgeType: "associated_with", status: "possible_connection", reason: "Field lead" },
      user: { username: "asha" },
    }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(Edge.create).not.toHaveBeenCalled();
  });

  test("semantic model data survives decisions and verified status requires review", async () => {
    const lead = { matchedCaseId: "OLD-1", similarityScore: 0.95, status: "possible_connection", rationale: "model rationale", reviewAudit: [] };
    const caseDoc = { similarCaseLeads: [lead], markModified: jest.fn(), save: jest.fn() };
    Case.findOne.mockResolvedValue(caseDoc);
    let res = response();
    await controller.updateSemanticLeadStatus({ params: { caseId: "NEW-1", matchedCaseId: "OLD-1" }, body: { status: "verified", reason: "reviewed" }, user: { username: "asha" } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);

    lead.referencedCaseReviewedAt = new Date();
    res = response();
    await controller.updateSemanticLeadStatus({ params: { caseId: "NEW-1", matchedCaseId: "OLD-1" }, body: { status: "verified", reason: "reviewed" }, user: { username: "asha" } }, res, jest.fn());
    expect(lead.investigatorStatus).toBe("verified");
    expect(lead.status).toBe("possible_connection");
    expect(lead.rationale).toBe("model rationale");
    expect(lead.reviewAudit).toHaveLength(1);
  });

  test("semantic review resolves the referenced logical caseId", async () => {
    const lead = { matchedCaseId: "OLD-LOGICAL-1" };
    const caseDoc = { similarCaseLeads: [lead], markModified: jest.fn(), save: jest.fn() };
    Case.findOne.mockResolvedValue(caseDoc);
    Case.exists.mockResolvedValue({ _id: "mongo-internal-id" });
    const res = response();
    await controller.markSemanticLeadReviewed({ params: { caseId: "NEW-1", matchedCaseId: "OLD-LOGICAL-1" } }, res, jest.fn());
    expect(Case.exists).toHaveBeenCalledWith({ caseId: "OLD-LOGICAL-1" });
    expect(lead.referencedCaseReviewedAt).toBeInstanceOf(Date);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
