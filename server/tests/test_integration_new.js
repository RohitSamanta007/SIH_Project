const mongoose = require("mongoose");
const request = require("supertest");
const { app } = require("../server"); // Express app
const { Case, Entity, Edge, Pattern } = require("../src/models");
const MockFastApiServer = require("./mockFastApiServer");
const { connectDB } = require("../config/db");

// Simple integration tests focusing on the new features added

describe("Integration Tests - FastAPI enhancements", () => {
  let mockServer;
  let mockPort;
  let serverInstance;

  beforeAll(async () => {
    // 1. Start mock FastAPI server
    mockServer = new MockFastApiServer();
    mockPort = await mockServer.start(8000);
    process.env.FASTAPI_BASE_URL = `http://127.0.0.1:${mockPort}`;
    
    // 2. Connect to DB
    await connectDB();
    
    // 3. Clear existing test data
    await Case.deleteMany({ caseId: { $regex: "^CASE-TEST-NEW-" } });
    await Entity.deleteMany({ associatedCases: { $regex: "^CASE-TEST-NEW-" } });
    await Edge.deleteMany({ associatedCases: { $regex: "^CASE-TEST-NEW-" } });
    
    // 4. Start the express app
    serverInstance = app.listen(0);
  });

  afterAll(async () => {
    await Case.deleteMany({ caseId: { $regex: "^CASE-TEST-NEW-" } });
    await Entity.deleteMany({ associatedCases: { $regex: "^CASE-TEST-NEW-" } });
    await Edge.deleteMany({ associatedCases: { $regex: "^CASE-TEST-NEW-" } });
    await Pattern.deleteMany({ caseId: { $regex: "^CASE-TEST-NEW-" } });
    await mockServer.stop();
    await mongoose.connection.close();
    serverInstance.close();
  });

  // Since we don't have a valid JWT generator here easily, we'll bypass the 
  // auth middleware for test routes or just invoke the services directly to verify behavior.
  
  const { processCaseIntake } = require("../src/services/caseIntakeService");
  const { processCaseThroughFastApi } = require("../src/services/caseProcessingService");

  it("should process a case, extract identifiers, save retrievalSummary and eventDate", async () => {
    const rawCaseData = {
      caseName: "Test Fraud Case",
      category: "Fraud",
      textReports: ["The suspect Rahul can be reached at +91 9876543210."],
      csvRecords: []
    };

    const normalizedCase = {
      caseId: "CASE-TEST-NEW-01",
      title: rawCaseData.caseName,
      category: rawCaseData.category,
      textReports: rawCaseData.textReports,
      csvRecords: rawCaseData.csvRecords,
    };

    const result = await processCaseThroughFastApi(normalizedCase, { baseUrl: process.env.FASTAPI_BASE_URL });
    
    expect(result.status).toBe("completed");

    const caseDoc = await Case.findOne({ caseId: "CASE-TEST-NEW-01" }).lean();
    expect(caseDoc).toBeDefined();
    expect(caseDoc.textReports).toContain(rawCaseData.textReports[0]);
    expect(caseDoc.retrievalSummary).toBe("Mock case summary representing the AI-generated synopsis.");
    expect(caseDoc.similarCaseLeads.length).toBe(1);
    expect(caseDoc.similarCaseLeads[0].status).toBe("possible_connection");
    expect(caseDoc.normalizedIdentifiers.phones).toContain("9876543210");
    expect(caseDoc.fastApiResponse.caseId).toBe("CASE-TEST-NEW-01");
    expect(caseDoc.fastApiResponse.entities).toHaveLength(2);
    expect(caseDoc.fastApiResponse.relationships).toHaveLength(1);
    expect(caseDoc.fastApiResponse.patterns).toHaveLength(1);
    expect(caseDoc.fastApiResponse.guardrail).toHaveLength(1);
    expect(caseDoc.fastApiResponse.timelineEvents).toHaveLength(1);
    expect(caseDoc.fastApiResponse.similarCaseLeads).toHaveLength(1);
    expect(caseDoc.fastApiResponse.receivedAt).toBeDefined();
    expect(caseDoc.timelineEvents).toHaveLength(1);

    const edges = await Edge.find({ associatedCases: "CASE-TEST-NEW-01" }).lean();
    expect(edges.length).toBeGreaterThan(0);
    const edge = edges[0];
    expect(edge.eventDate).toBe("2026-08-15");
    expect(edge.eventTime).toBe("12:00:00");
    expect(edge.eventType).toBe("financial_transfer");
    expect(edge.systemStatus).toBe("approved");
    expect(edge.reviewStatus).toBeUndefined();

    const entities = await Entity.find({ associatedCases: "CASE-TEST-NEW-01" }).lean();
    const person = entities.find(e => e.type === "PERSON");
    expect(person).toBeDefined();
    expect(person.normalizedPhones).toContain("9876543210"); 
  }, 30000);

  it("should build accurate caseHistory in subsequent case", async () => {
    const normalizedCase = {
      caseId: "CASE-TEST-NEW-02",
      title: "Another Case",
      category: "Fraud",
      // Include a word that matches the text index ("synopsis" from the first case's mock summary)
      textReports: ["Found number 9876543210 again. Also synopsis matches."],
      csvRecords: []
    };

    mockServer.lastRequest = null;
    await processCaseThroughFastApi(normalizedCase, { baseUrl: process.env.FASTAPI_BASE_URL });

    const payload = mockServer.lastRequest.body;
    
    expect(payload.caseHistory).toBeDefined();
    expect(payload.caseHistory.length).toBeGreaterThan(0);
    expect(payload.caseHistory.some(h =>
      h.canonicalId === "phone:9876543210" && h.lastSeenCaseId === "CASE-TEST-NEW-01"
    )).toBe(true);

    expect(payload.retrievalContext).toBeDefined();
    expect(payload.retrievalContext.some(ctx => ctx.caseId === "CASE-TEST-NEW-01")).toBe(true);
  }, 30000);
});
