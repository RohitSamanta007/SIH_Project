"use strict";

/**
 * Identifier Normalization Service
 *
 * Provides deterministic normalization functions for common investigation
 * identifiers (phone numbers, vehicle plates, emails, account numbers,
 * addresses, and names).
 *
 * RULES:
 *  - All output values are plain strings — never Numbers.
 *  - Leading zeros are preserved (critical for account numbers).
 *  - Normalization is deterministic: the same raw input always produces the
 *    same normalized output, making it safe for exact MongoDB index lookups.
 *  - These functions never merge entities.  Only identical normalized values
 *    from two different sources may trigger a deterministic history match.
 */

// ── Supported country-code prefixes to strip from phone numbers ──────────────
// Add more prefixes here as needed.  Order matters: longer prefixes first.
/**
 * Normalize a raw phone number to a digits-only string without country code.
 *
 * Steps:
 *  1. Strip spaces, hyphens, parentheses, dots
 *  2. Remove supported country-code prefix
 *  3. Return remaining digit string
 *
 * @param {string} raw
 * @returns {string | null}  Normalized digit string, or null if input is unusable
 */
function normalizePhone(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;

  let s = raw.trim().replace(/\D/g, "");
  if (s.startsWith("0091") && s.length === 14) s = s.slice(4);
  else if (s.startsWith("91") && s.length === 12) s = s.slice(2);
  else if (s.startsWith("0") && s.length === 11) s = s.slice(1);

  // Reject obviously invalid results (e.g. empty or too short)
  if (s.length < 7) return null;

  return s;
}

/**
 * Normalize a vehicle registration plate.
 *
 * Steps:
 *  1. Uppercase
 *  2. Remove spaces, hyphens, dots
 *
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeVehicle(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim().toUpperCase().replace(/[\s\-. ]/g, "");
  return s.length >= 4 ? s : null; // Reject trivially short values
}

/**
 * Normalize an email address.
 *
 * Steps:
 *  1. Trim whitespace
 *  2. Lowercase
 *
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeEmail(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim().toLowerCase();
  // Basic sanity check: must contain @ and a dot after @
  return s.includes("@") && s.split("@")[1]?.includes(".") ? s : null;
}

/**
 * Normalize a bank / UPI account number.
 *
 * Steps:
 *  1. Trim leading/trailing whitespace
 *  2. Remove internal spaces (but preserve all other characters, including
 *     leading zeros which are meaningful in account numbers)
 *
 * CRITICAL: Never coerce to a Number — that silently drops leading zeros.
 *
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeAccount(raw) {
  if (raw === null || raw === undefined) return null;
  // Accept numbers too — convert to string first
  const s = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= 4 ? s : null;
}

/**
 * Normalize a physical address.
 *
 * Steps:
 *  1. Lowercase
 *  2. Collapse multiple whitespace characters to a single space
 *  3. Remove harmless punctuation (commas, full stops, slashes used as
 *     separators) while preserving meaningful hyphens in house numbers
 *
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeAddress(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[,./\\]/g, " ")   // Replace common separators with space
    .replace(/\s+/g, " ")       // Collapse whitespace
    .trim();
  return s.length >= 5 ? s : null;
}

/**
 * Normalize a person or organization name for case-insensitive text matching.
 *
 * NOTE: Name normalization is ONLY used for text-search fallback.
 * Similar or identical names must NEVER automatically merge two entities.
 *
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeName(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Regex patterns for extraction ────────────────────────────────────────────

// Indian phone numbers (10 digits, optional country code)
const PHONE_RE =
  /(?:(?:\+91|0091|91)?[\s\-.]?)([6-9](?:[\s().-]*\d){9})(?!\d)/g;

// Indian vehicle registration plates (e.g. MH12AB1234, WB06AX4471)
const VEHICLE_RE =
  /\b([A-Z]{2}[\s\-]?\d{1,2}[\s\-]?[A-Z]{1,3}[\s\-]?\d{1,4})\b/gi;

// Email addresses
const EMAIL_RE =
  /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;

const ACCOUNT_LABEL_RE =
  /\b(?:account|a\/?c|acct|upi)\s*(?:number|no|id)?\s*[:\-]?\s*([a-z0-9][a-z0-9._\-/]{3,39})/gi;

// Conservative labelled address extraction. Unlabelled FIR vocabulary never
// becomes an automatic identifier.
const ADDRESS_RE =
  /\b(?:address|residing at|resident of|located at)\s*[:\-]?\s*([^.;\r\n]{5,160})/gi;

// Structured street addresses are identifier-shaped even when the FIR does
// not prefix them with "address" or "located at". Requiring a house number
// and a street-kind word avoids promoting generic place prose into history.
const STREET_ADDRESS_RE =
  /\b(\d{1,6}[a-z0-9\/-]*\s+(?:[a-z0-9.'-]+\s+){0,5}(?:road|street|lane|avenue|highway|nagar|colony|boulevard|drive|way)(?:\s*,\s*[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})?)(?=[.;\r\n]|$)/gi;

/**
 * Extract and normalize identifiers from a single text string.
 *
 * @param {string} text  A FIR report or any free-text string
 * @returns {{
 *   phones:    string[],
 *   vehicles:  string[],
 *   emails:    string[],
 *   accounts:  string[],
 * }}
 */
function extractIdentifiersFromText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { phones: [], vehicles: [], emails: [], accounts: [], addresses: [] };
  }

  const phones   = new Set();
  const vehicles = new Set();
  const emails   = new Set();
  const accounts = new Set();
  const addresses = new Set();

  // Phones
  for (const m of text.matchAll(PHONE_RE)) {
    const n = normalizePhone(m[1] || m[0]);
    if (n) phones.add(n);
  }

  // Emails (extract before vehicles so email @s don't confuse plate regex)
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = normalizeEmail(m[1]);
    if (e) emails.add(e);
  }

  // Vehicles
  for (const m of text.matchAll(VEHICLE_RE)) {
    const v = normalizeVehicle(m[1]);
    if (v) vehicles.add(v);
  }

  // Account identifiers require an explicit account/UPI label in FIR text.
  // Unlabelled long digit sequences may be phones or unrelated identifiers.
  for (const m of text.matchAll(ACCOUNT_LABEL_RE)) {
    const account = normalizeAccount(m[1]);
    if (account) accounts.add(account);
  }

  for (const m of text.matchAll(ADDRESS_RE)) {
    const address = normalizeAddress(m[1]);
    if (address) addresses.add(address);
  }
  for (const m of text.matchAll(STREET_ADDRESS_RE)) {
    const address = normalizeAddress(m[1]);
    if (address) addresses.add(address);
  }

  return {
    phones:   [...phones],
    vehicles: [...vehicles],
    emails:   [...emails],
    accounts: [...accounts],
    addresses: [...addresses],
  };
}

/**
 * Extract and normalize identifiers from an array of parsed CSV/CDR records.
 *
 * Scans all string and numeric column values for known identifier patterns.
 * Numeric values are converted to strings before processing so leading zeros
 * in CSV columns aren't silently lost.
 *
 * @param {Array<Record<string, any>>} records
 * @returns {{
 *   phones:    string[],
 *   vehicles:  string[],
 *   emails:    string[],
 *   accounts:  string[],
 * }}
 */
function extractIdentifiersFromCsvRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    return { phones: [], vehicles: [], emails: [], accounts: [], addresses: [] };
  }

  const phones   = new Set();
  const vehicles = new Set();
  const emails   = new Set();
  const accounts = new Set();
  const addresses = new Set();

  for (const row of records) {
    if (!row || typeof row !== "object") continue;
    for (const [key, rawVal] of Object.entries(row)) {
      const val = String(rawVal ?? "").trim();
      if (!val) continue;

      const colKey = key.toLowerCase();

      // Column-name hints for fast-path extraction
      if (/phone|mobile|cell|msisdn|calling|called|callee|caller/.test(colKey)) {
        const n = normalizePhone(val);
        if (n) phones.add(n);
        continue;
      }
      if (/vehicle|reg|plate|number_plate/.test(colKey)) {
        const v = normalizeVehicle(val);
        if (v) vehicles.add(v);
        continue;
      }
      if (/email|e.mail/.test(colKey)) {
        const e = normalizeEmail(val);
        if (e) emails.add(e);
        continue;
      }
      if (/account|acc_no|acno|upi/.test(colKey)) {
        const a = normalizeAccount(val);
        if (a) accounts.add(a);
        continue;
      }
      if (/address|location|residence/.test(colKey)) {
        const address = normalizeAddress(val);
        if (address) addresses.add(address);
        continue;
      }

      // Generic fallback — try all patterns against the value
      const fromText = extractIdentifiersFromText(val);
      fromText.phones.forEach((p) => phones.add(p));
      fromText.vehicles.forEach((v) => vehicles.add(v));
      fromText.emails.forEach((e) => emails.add(e));
      fromText.addresses.forEach((a) => addresses.add(a));
      // Skip generic account extraction from ambiguous columns to reduce noise
    }
  }

  return {
    phones:   [...phones],
    vehicles: [...vehicles],
    emails:   [...emails],
    accounts: [...accounts],
    addresses: [...addresses],
  };
}

/**
 * Build a combined normalized identifier set from:
 *   - An array of FIR text reports
 *   - An array of parsed CSV/CDR records
 *
 * Used by historicalContextService to query MongoDB for matching historical
 * entities before calling FastAPI.
 *
 * @param {string[]} textReports
 * @param {Array<Record<string, any>>} csvRecords
 * @returns {{
 *   phones:    string[],
 *   vehicles:  string[],
 *   emails:    string[],
 *   accounts:  string[],
 * }}
 */
function extractIdentifiersFromCase(textReports, csvRecords) {
  const phones   = new Set();
  const vehicles = new Set();
  const emails   = new Set();
  const accounts = new Set();
  const addresses = new Set();

  for (const text of Array.isArray(textReports) ? textReports : []) {
    const r = extractIdentifiersFromText(text);
    r.phones.forEach((v) => phones.add(v));
    r.vehicles.forEach((v) => vehicles.add(v));
    r.emails.forEach((v) => emails.add(v));
    r.accounts.forEach((v) => accounts.add(v));
    r.addresses.forEach((v) => addresses.add(v));
  }

  const csvResult = extractIdentifiersFromCsvRecords(csvRecords);
  csvResult.phones.forEach((v) => phones.add(v));
  csvResult.vehicles.forEach((v) => vehicles.add(v));
  csvResult.emails.forEach((v) => emails.add(v));
  csvResult.accounts.forEach((v) => accounts.add(v));
  csvResult.addresses.forEach((v) => addresses.add(v));

  return {
    phones:   [...phones],
    vehicles: [...vehicles],
    emails:   [...emails],
    accounts: [...accounts],
    addresses: [...addresses],
  };
}

/**
 * Build the normalizedPhones / normalizedVehicles / … arrays for a single
 * FastAPI entity object before saving it to MongoDB.
 *
 * Sources:
 *  1. `entity.attributes` — known attribute keys (phone, email, vehicle_reg, …)
 *  2. `entity.aliases`    — each alias is also scanned for phone / email patterns
 *
 * @param {Object} entity  Raw entity from FastAPI response
 * @returns {{
 *   normalizedPhones:    string[],
 *   normalizedVehicles:  string[],
 *   normalizedEmails:    string[],
 *   normalizedAccounts:  string[],
 *   normalizedAddresses: string[],
 * }}
 */
function buildEntityNormalizedIdentifiers(entity) {
  const phones    = new Set();
  const vehicles  = new Set();
  const emails    = new Set();
  const accounts  = new Set();
  const addresses = new Set();

  const attrs = entity.attributes && typeof entity.attributes === "object"
    ? entity.attributes
    : {};

  // ── Attribute key hints ──────────────────────────────────────────────────
  const attrEntries = [
    // phones
    ["phone",          phones,    normalizePhone],
    ["mobile",         phones,    normalizePhone],
    ["phone_number",   phones,    normalizePhone],
    ["msisdn",         phones,    normalizePhone],
    // vehicles
    ["vehicle_reg",    vehicles,  normalizeVehicle],
    ["vehicle",        vehicles,  normalizeVehicle],
    ["registration",   vehicles,  normalizeVehicle],
    ["plate",          vehicles,  normalizeVehicle],
    // emails
    ["email",          emails,    normalizeEmail],
    ["email_address",  emails,    normalizeEmail],
    // accounts
    ["account_number", accounts,  normalizeAccount],
    ["account_no",     accounts,  normalizeAccount],
    ["acc_no",         accounts,  normalizeAccount],
    ["upi_id",         accounts,  normalizeAccount],
    // addresses
    ["address",        addresses, normalizeAddress],
    ["location",       addresses, normalizeAddress],
  ];

  for (const [key, targetSet, normFn] of attrEntries) {
    if (attrs[key] !== undefined && attrs[key] !== null) {
      const normalized = normFn(String(attrs[key]));
      if (normalized) targetSet.add(normalized);
    }
  }

  // ── Scan aliases for phone and email patterns ────────────────────────────
  for (const alias of Array.isArray(entity.aliases) ? entity.aliases : []) {
    if (typeof alias !== "string") continue;
    const fromAlias = extractIdentifiersFromText(alias);
    fromAlias.phones.forEach((p) => phones.add(p));
    fromAlias.emails.forEach((e) => emails.add(e));
  }

  // ── Entity type-level hints ──────────────────────────────────────────────
  const entityType = typeof entity.type === "string" ? entity.type.toLowerCase() : "";

  if (entityType === "phone") {
    for (const alias of Array.isArray(entity.aliases) ? entity.aliases : []) {
      const n = normalizePhone(alias);
      if (n) phones.add(n);
    }
  }
  if (entityType === "vehicle") {
    for (const alias of Array.isArray(entity.aliases) ? entity.aliases : []) {
      const v = normalizeVehicle(alias);
      if (v) vehicles.add(v);
    }
  }
  if (entityType === "email") {
    for (const alias of Array.isArray(entity.aliases) ? entity.aliases : []) {
      const e = normalizeEmail(alias);
      if (e) emails.add(e);
    }
  }

  return {
    normalizedPhones:    [...phones],
    normalizedVehicles:  [...vehicles],
    normalizedEmails:    [...emails],
    normalizedAccounts:  [...accounts],
    normalizedAddresses: [...addresses],
  };
}

module.exports = {
  normalizePhone,
  normalizeVehicle,
  normalizeEmail,
  normalizeAccount,
  normalizeAddress,
  normalizeName,
  extractIdentifiersFromText,
  extractIdentifiersFromCsvRecords,
  extractIdentifiersFromCase,
  buildEntityNormalizedIdentifiers,
};
