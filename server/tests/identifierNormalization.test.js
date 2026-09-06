"use strict";

const {
  normalizePhone, normalizeVehicle, normalizeEmail, normalizeAccount,
  normalizeAddress, extractIdentifiersFromCase,
} = require("../src/services/identifierNormalizationService");

describe("deterministic identifier normalization", () => {
  test("normalizes every supported identifier without losing leading zeroes", () => {
    expect(normalizePhone("+91 (90123) 45678")).toBe("9012345678");
    expect(normalizePhone("919012345678")).toBe("9012345678");
    expect(normalizeVehicle("mh-12 ab 1234")).toBe("MH12AB1234");
    expect(normalizeEmail(" Person@Example.COM ")).toBe("person@example.com");
    expect(normalizeAccount(" ab-00.12/xy ")).toBe("AB0012XY");
    expect(normalizeAddress(" 12, MG  Road / Pune ")).toBe("12 mg road pune");
  });

  test("extracts only identifier-shaped data, never generic FIR vocabulary", () => {
    const identifiers = extractIdentifiersFromCase([
      "Theft suspect and witness discussed a vehicle. Phone +91 90123 45678. Address: 12 MG Road, Pune.",
    ], [{ vehicle_registration: "mh-12-ab-1234", email: "TIP@EXAMPLE.COM", account_no: "00-19-ab" }]);
    expect(identifiers).toEqual({
      phones: ["9012345678"], vehicles: ["MH12AB1234"], emails: ["tip@example.com"],
      accounts: ["0019AB"], addresses: ["12 mg road pune"],
    });
    expect(Object.values(identifiers).flat()).not.toContain("suspect");
  });

  test("extracts acceptance-case phones, vehicles, and structured street addresses", () => {
    const identifiers = extractIdentifiersFromCase([
      "On 17 March 2026, call records linked phone 9050011122 to motorcycle WB-19-R-8842. " +
      "Officers searched workshop 44 Ganges Road, Howrah.",
    ], []);
    expect(identifiers).toEqual({
      phones: ["9050011122"],
      vehicles: ["WB19R8842"],
      emails: [],
      accounts: [],
      addresses: ["44 ganges road howrah"],
    });
  });
});
