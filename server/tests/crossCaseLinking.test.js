"use strict";

jest.mock("../src/models", () => ({
  Entity: { find: jest.fn() },
}));

const { Entity } = require("../src/models");
const { runCrossCaseLinking } = require("../src/services/crossCaseLinkingService");

const leanQuery = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

describe("legacy cross-case scan safety", () => {
  beforeEach(() => jest.clearAllMocks());

  test("reports an exact recurrence without creating an automatic graph edge", async () => {
    Entity.find
      .mockReturnValueOnce(leanQuery([{
        canonicalId: "phone:9050011122",
        associatedCases: ["ALPHA-NEW"],
        normalizedPhones: ["9050011122"],
      }]))
      .mockReturnValueOnce(leanQuery([{
        canonicalId: "historical-phone-node",
        associatedCases: ["ALPHA-01"],
        normalizedPhones: ["9050011122"],
      }]));

    const result = await runCrossCaseLinking("ALPHA-NEW");

    expect(result).toEqual({ linked: 1, edgesCreated: 0, neighborsLinked: 0 });
    expect(Entity.find).toHaveBeenNthCalledWith(2, expect.objectContaining({
      associatedCases: { $nin: ["ALPHA-NEW"] },
      $or: [{ normalizedPhones: { $in: ["9050011122"] } }],
    }));
  });
});
