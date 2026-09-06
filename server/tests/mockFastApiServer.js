const http = require("http");

class MockFastApiServer {
  constructor() {
    this.server = null;
    this.mode = "success"; // "success", "timeout", "error_500", "error_400", "invalid_json", "empty"
    this.delayMs = 0;
    this.lastRequest = null;
    this.port = 0;
    // Tracked sockets so stop() can force-close requests held open by timeout mode
    this.sockets = new Set();
  }

  setMode(mode, delayMs = 0) {
    this.mode = mode;
    this.delayMs = delayMs;
  }

  start(port = 8899) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        let bodyRaw = "";
        req.on("data", (chunk) => (bodyRaw += chunk));
        req.on("end", async () => {
          let parsedBody = null;
          try {
            parsedBody = JSON.parse(bodyRaw);
          } catch {
            parsedBody = bodyRaw;
          }

          this.lastRequest = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: parsedBody,
            rawBody: bodyRaw,
          };

          // TIMEOUT MODE: intentionally never send a response so the caller's
          // timeout/abort logic fires (fastApiClient -> FASTAPI_TIMEOUT 504).
          // Deterministic for any client timeout value; held sockets are destroyed in stop().
          if (this.mode === "timeout") {
            return;
          }

          // Handle delay if configured
          if (this.delayMs > 0) {
            await new Promise((r) => setTimeout(r, this.delayMs));
          }

          // Handle modes
          if (this.mode === "error_500") {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal AI Engine Error" }));
            return;
          }

          if (this.mode === "error_400") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad request payload to AI Engine" }));
            return;
          }

          if (this.mode === "invalid_json") {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body>502 Bad Gateway from upstream proxy</body></html>");
            return;
          }

          if (this.mode === "empty") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("");
            return;
          }

          // Default success response matching draft contract
          const caseId = parsedBody?.caseId || "CASE-MOCK-001";
          const responsePayload = {
            caseId,
            retrievalSummary: "Mock case summary representing the AI-generated synopsis.",
            similarCaseLeads: [
              {
                matchedCaseId: "CASE-MOCK-HISTORICAL",
                similarityScore: 0.95,
                status: "possible_connection",
                rationale: "Similar modus operandi and overlapping entity types.",
                reviewRequired: true,
                reviewMessage: "Investigator verification required."
              }
            ],
            entities: [
              {
                canonicalId: "PERSON-001",
                type: "PERSON",
                aliases: ["Rahul Sharma"],
                attributes: { phone: "+919876543210" },
                confidence: 0.95,
              },
              {
                canonicalId: "BANK_ACCOUNT-001",
                type: "BANK_ACCOUNT",
                aliases: ["HDFC-99128"],
                attributes: { accountNumber: "XXXX1234" },
                confidence: 1.0,
              },
            ],
            relationships: [
              {
                edgeId: "EDGE-001",
                source: "PERSON-001",
                target: "BANK_ACCOUNT-001",
                edgeType: "TRANSACTION_SENT",
                confidence: 0.9,
                timestamp: "2026-08-15T12:00:00Z",
                eventDate: "2026-08-15",
                eventTime: "12:00:00",
                eventType: "financial_transfer",
                relationReason: "Fund transfer from suspect account",
                evidenceIds: ["ev-1"],
                dateConfidence: "explicit",
                evidence: [
                  {
                    sourceReportId: "doc-1",
                    matchedField: "txn_history",
                    record: { txn_id: "TXN-99881", amount: 50000 },
                  },
                ],
              },
            ],
            patterns: [
              {
                patternType: "SUSPICIOUS_MULE_TRANSFER",
                relatedEntityIds: ["PERSON-001", "BANK_ACCOUNT-001"],
                confidence: 0.88,
                severity: "high",
                description: "Immediate fund transfer after victim communication",
              },
            ],
            guardrail: [
              {
                edgeId: "EDGE-001",
                status: "approved",
                rationale: "Evidence directly verified by CDR records",
              },
            ],
            timelineEvents: [
              {
                edgeId: "EDGE-001",
                eventDate: "2026-08-15",
                eventTime: "12:00:00",
                eventType: "financial_transfer",
                relationReason: "Fund transfer from suspect account",
                evidenceIds: ["ev-1"],
                dateConfidence: "explicit",
              },
            ],
          };

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responsePayload));
        });
      });

      // Track raw sockets so stop() can destroy connections held open by timeout mode
      this.server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
      });

      this.server.listen(port, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });

      this.server.on("error", reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      // Destroy any sockets still held open (e.g. by timeout mode) so close() resolves
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();

      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

module.exports = MockFastApiServer;
