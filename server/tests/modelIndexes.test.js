"use strict";

const Case = require("../src/models/Case");

describe("Case persistence schema", () => {
  test("logical caseId is unique and normalized identifier indexes exist", () => {
    expect(Case.schema.path("caseId").options.unique).toBe(true);
    const indexKeys = Case.schema.indexes().map(([keys]) => Object.keys(keys).join(","));
    for (const field of ["phones", "vehicles", "emails", "accounts", "addresses"]) {
      expect(indexKeys).toContain(`normalizedIdentifiers.${field}`);
    }
  });

  test("stores retrieval summary and original CSV records", () => {
    expect(Case.schema.path("retrievalSummary")).toBeDefined();
    expect(Case.schema.path("csvRecords")).toBeDefined();
    expect(Case.schema.path("caseHistory")).toBeDefined();
    expect(Case.schema.path("fastApiResponse")).toBeDefined();
  });
});
