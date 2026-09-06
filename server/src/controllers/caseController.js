const { processCaseIntake } = require("../services/caseIntakeService");
const { processCaseThroughFastApi } = require("../services/caseProcessingService");
const mongoose = require("mongoose");
const { randomUUID } = require("crypto");
const {
  getCaseGraph,
  getEntityDetail,
  getCaseTimeline,
  getGuardrailDetail,
  getCasesList,
} = require("../services/caseGraphService");

/**
 * Handle case intake, orchestrate FastAPI reasoning, and persist results to MongoDB (T01 - T06)
 *
 * @route POST /api/cases
 * @access Private (Investigator JWT required)
 */
const createCaseIntake = async (req, res, next) => {
  try {
    const body = req.body || {};

    // 1. Gather text inputs
    let textInput = body.textReports || body.text || body.report || body.reports;

    // 2. Gather CSV inputs from multipart files or body string
    let csvBuffer = null;
    let csvString = null;

    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      csvBuffer = Buffer.concat(req.files.map((f) => f.buffer));
    } else if (req.file) {
      csvBuffer = req.file.buffer;
    } else if (body.csvData || body.csv) {
      csvString = body.csvData || body.csv;
    }

    // 3. Process and normalize via intake service (Module 1)
    const normalizedData = processCaseIntake({
      textInput,
      csvBuffer,
      csvString,
      title: body.caseName,
      category: body.category,
    });

    // 4. Orchestrate call to FastAPI reasoning service & persist into MongoDB (Modules 2 & 4)
    const persistenceResult = await processCaseThroughFastApi(normalizedData);

    // 5. Return HTTP 201 Created with standard persistence success envelope
    return res.status(201).json({
      success: true,
      data: {
        caseId: persistenceResult.caseId,
        status: persistenceResult.status,
        summary: persistenceResult.summary,
        createdAt: persistenceResult.createdAt,
        updatedAt: persistenceResult.updatedAt,
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Retrieve full graph (nodes + edges) for a given case
 *
 * @route GET /api/cases/:caseId/graph
 * @access Private (Investigator JWT required)
 */
const fetchCaseGraph = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const graphData = await getCaseGraph(caseId);
    return res.status(200).json({
      success: true,
      data: graphData,
      error: null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Retrieve entity detail and related edges
 *
 * @route GET /api/cases/:caseId/entities/:entityId
 * @access Private (Investigator JWT required)
 */
const fetchEntityDetail = async (req, res, next) => {
  try {
    const { caseId, entityId } = req.params;
    const entityData = await getEntityDetail(caseId, entityId);
    return res.status(200).json({
      success: true,
      data: entityData,
      error: null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Retrieve chronologically ordered interaction timeline
 *
 * @route GET /api/cases/:caseId/timeline
 * @access Private (Investigator JWT required)
 */
const fetchCaseTimeline = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const timelineData = await getCaseTimeline(caseId);
    return res.status(200).json({
      success: true,
      data: timelineData,
      error: null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Retrieve guardrail details and evidence for a specific edge
 *
 * @route GET /api/cases/:caseId/guardrail/:edgeId
 * @access Private (Investigator JWT required)
 */
const fetchGuardrailDetail = async (req, res, next) => {
  try {
    const { caseId, edgeId } = req.params;
    const guardrailData = await getGuardrailDetail(caseId, edgeId);
    return res.status(200).json({
      success: true,
      data: guardrailData,
      error: null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * List all investigation cases (newest first) with summary counts for the dashboard
 *
 * @route GET /api/cases
 * @access Private (Investigator JWT required)
 */
const listCases = async (req, res, next) => {
  try {
    const listData = await getCasesList();
    return res.status(200).json({
      success: true,
      data: listData,
      error: null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update case status
 *
 * @route PATCH /api/cases/:caseId/status
 * @access Private
 */
const updateCaseStatus = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { status } = req.body;
    
    if (!status || !['open', 'closed'].includes(status)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid status' } });
    }

    const { Case } = require('../models');
    const caseDoc = await Case.findOneAndUpdate(
      { caseId: caseId.trim() },
      { status },
      { new: true }
    );

    if (!caseDoc) {
      return res.status(404).json({ success: false, error: { message: 'Case not found' } });
    }

    return res.status(200).json({
      success: true,
      data: { caseId: caseDoc.caseId, status: caseDoc.status },
      error: null,
    });
  } catch (error) {
    next(error);
  }
};


/**
 * Update the investigator review status for a specific relationship edge.
 *
 * @route PATCH /api/cases/:caseId/relationships/:edgeId/status
 * @access Private
 */
const updateRelationshipStatus = async (req, res, next) => {
  try {
    const { caseId, edgeId } = req.params;
    // The request body should pass "status" and "reason" as per requirements
    const { status, reason } = req.body;
    
    // Assuming auth middleware sets req.user
    const investigatorId = req.user?.username || req.user?.id || 'unknown_investigator';

    const validStatuses = ['verified', 'possible_connection', 'unverified', 'cross_connection', 'unknown'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid review status' } });
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ success: false, error: { code: 'REASON_REQUIRED', message: 'An investigator note is required' } });
    }

    const { Edge } = require('../models');
    
    const edgeIdentity = [{ edgeId: edgeId.trim() }];
    if (mongoose.Types.ObjectId.isValid(edgeId.trim())) edgeIdentity.push({ _id: edgeId.trim() });
    const edge = await Edge.findOne({ associatedCases: caseId.trim(), $or: edgeIdentity });

    if (!edge) {
      return res.status(404).json({ success: false, error: { message: 'Edge not found in this case' } });
    }

    const previousStatus = edge.reviewStatus || edge.systemStatus || edge.guardrailStatus || 'unknown';
    
    edge.reviewStatus = status;
    edge.reviewReason = typeof reason === 'string' ? reason.trim() : '';
    edge.reviewUpdatedBy = investigatorId;
    edge.reviewUpdatedAt = new Date();
    if (!Array.isArray(edge.reviewAudit)) {
      edge.reviewAudit = [];
    }
    
    edge.reviewAudit.push({
      reviewedBy: investigatorId,
      reviewedAt: new Date(),
      previousStatus,
      newStatus: status,
      note: edge.reviewReason
    });

    await edge.save();

    return res.status(200).json({
      success: true,
      data: {
        id: edge.edgeId || edge._id,
        reviewStatus: edge.reviewStatus,
        reviewAudit: edge.reviewAudit,
        systemStatus: edge.systemStatus || edge.guardrailStatus || null,
        effectiveStatus: edge.reviewStatus || edge.systemStatus || edge.guardrailStatus || 'unknown',
        latestNote: edge.reviewReason,
        updatedBy: edge.reviewUpdatedBy,
        updatedAt: edge.reviewUpdatedAt,
      },
      error: null,
    });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ success: false, error: { message: 'Invalid edge ID format' } });
    }
    next(error);
  }
};

/**
 * Update the investigator status for a semantic similar case lead.
 *
 * @route PATCH /api/cases/:caseId/similar-leads/:matchedCaseId/status
 * @access Private
 */
const updateSemanticLeadStatus = async (req, res, next) => {
  try {
    const { caseId, matchedCaseId } = req.params;
    const { status, reason } = req.body;
    
    const validStatuses = ['verified', 'possible_connection', 'cross_connection', 'unverified', 'unknown'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid semantic lead status' } });
    }

    const { Case } = require('../models');
    
    const caseDoc = await Case.findOne({ caseId: caseId.trim() });
    if (!caseDoc) {
      return res.status(404).json({ success: false, error: { message: 'Case not found' } });
    }
    
    const leadIndex = caseDoc.similarCaseLeads.findIndex(l => l.matchedCaseId === matchedCaseId);
    if (leadIndex === -1) {
      return res.status(404).json({ success: false, error: { message: 'Semantic lead not found in this case' } });
    }
    
    const lead = caseDoc.similarCaseLeads[leadIndex];
    if ((lead.similarityScore || 0) < 0.9) {
      return res.status(409).json({ success: false, error: { code: 'LEAD_REVIEW_ONLY', message: 'Lower-confidence semantic leads cannot be classified.' } });
    }
    if (['verified', 'cross_connection'].includes(status) && !lead.referencedCaseReviewedAt) {
      return res.status(409).json({ success: false, error: { code: 'CASE_REVIEW_REQUIRED', message: 'Open and review the referenced case before applying this status.' } });
    }
    const investigatorId = req.user?.username || req.user?.userId || 'unknown_investigator';
    const previousStatus = lead.investigatorStatus || lead.status || 'unknown';
    const updatedAt = new Date();
    lead.investigatorStatus = status;
    lead.investigatorReason = typeof reason === 'string' ? reason.trim() : '';
    lead.investigatorUpdatedBy = investigatorId;
    lead.investigatorUpdatedAt = updatedAt;
    if (!Array.isArray(lead.reviewAudit)) lead.reviewAudit = [];
    lead.reviewAudit.push({ updatedBy: investigatorId, updatedAt, previousStatus, status, reason: lead.investigatorReason });
    
    // We mark the array modified to ensure it saves
    caseDoc.markModified('similarCaseLeads');
    await caseDoc.save();

    return res.status(200).json({
      success: true,
      data: {
        matchedCaseId,
        investigatorStatus: lead.investigatorStatus,
        investigatorReason: lead.investigatorReason,
        reviewAudit: lead.reviewAudit,
      },
      error: null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Persist a relationship discovered manually by an investigator between two
 * entities already visible in this case graph. This never invokes FastAPI and
 * never changes either entity document.
 *
 * @route POST /api/cases/:caseId/relationships
 * @access Private (investigator only)
 */
const createManualRelationship = async (req, res, next) => {
  try {
    const normalizedCaseId = String(req.params.caseId || '').trim();
    const source = String(req.body?.source || '').trim();
    const target = String(req.body?.target || '').trim();
    const rawEdgeType = String(req.body?.edgeType || '').trim();
    const status = String(req.body?.status || '').trim();
    const reason = String(req.body?.reason || '').trim();
    const eventDate = String(req.body?.eventDate || '').trim();
    const eventTime = String(req.body?.eventTime || '').trim();
    const investigatorId = req.user?.username || req.user?.userId || req.user?.id || 'unknown_investigator';
    const validStatuses = ['verified', 'possible_connection', 'cross_connection', 'unverified', 'unknown'];

    if (!source || !target) {
      return res.status(400).json({ success: false, error: { code: 'ENTITIES_REQUIRED', message: 'Select both a source and target entity' } });
    }
    if (source === target) {
      return res.status(400).json({ success: false, error: { code: 'SELF_RELATIONSHIP', message: 'A relationship must connect two different entities' } });
    }
    if (!rawEdgeType || rawEdgeType.length > 80 || !/^[a-zA-Z0-9 _-]+$/.test(rawEdgeType)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_RELATIONSHIP_TYPE', message: 'Enter a valid relationship type using letters, numbers, spaces, hyphens, or underscores' } });
    }
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_REVIEW_STATUS', message: 'Select a valid relationship status' } });
    }
    if (!reason) {
      return res.status(400).json({ success: false, error: { code: 'REASON_REQUIRED', message: 'An investigator rationale is required' } });
    }
    const parsedEventDate = eventDate ? new Date(`${eventDate}T00:00:00Z`) : null;
    if (eventDate && (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(parsedEventDate.getTime()) || parsedEventDate.toISOString().slice(0, 10) !== eventDate)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_EVENT_DATE', message: 'Event date must be a real date in YYYY-MM-DD format' } });
    }
    if (eventTime && !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(eventTime)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_EVENT_TIME', message: 'Event time must use HH:MM or HH:MM:SS' } });
    }

    const { Case, Entity, Edge } = require('../models');
    const caseExists = await Case.exists({ caseId: normalizedCaseId });
    if (!caseExists) {
      return res.status(404).json({ success: false, error: { code: 'CASE_NOT_FOUND', message: 'Case not found' } });
    }

    // A graph can include a historical endpoint without adding that entity to
    // this case. Include those existing edge endpoints in the allowed scope.
    const currentEdges = await Edge.find({ associatedCases: normalizedCaseId }).select('source target').lean();
    const graphEntityIds = new Set(currentEdges.flatMap((edge) => [edge.source, edge.target]).filter(Boolean));
    const selectedEntities = await Entity.find({
      canonicalId: { $in: [source, target] },
      $or: [
        { associatedCases: normalizedCaseId },
        { canonicalId: { $in: [...graphEntityIds] } },
      ],
    }).select('canonicalId').lean();
    const selectedIds = new Set(selectedEntities.map((entity) => entity.canonicalId));
    if (!selectedIds.has(source) || !selectedIds.has(target)) {
      return res.status(404).json({ success: false, error: { code: 'ENTITY_NOT_IN_CASE_GRAPH', message: 'One or both selected entities are not available in this case graph' } });
    }

    const edgeType = rawEdgeType.toLowerCase().replace(/\s+/g, '_');
    const duplicate = await Edge.findOne({
      edgeType,
      $or: [
        { source, target },
        { source: target, target: source },
      ],
    });
    const now = new Date();

    if (duplicate) {
      if ((duplicate.associatedCases || []).includes(normalizedCaseId)) {
        return res.status(409).json({ success: false, error: { code: 'RELATIONSHIP_EXISTS', message: 'This relationship already exists; open it to update its status or note' } });
      }

      const previousStatus = duplicate.reviewStatus || duplicate.systemStatus || duplicate.guardrailStatus || 'unknown';
      duplicate.associatedCases = Array.from(new Set([...(duplicate.associatedCases || []), normalizedCaseId]));
      duplicate.reviewStatus = status;
      duplicate.reviewReason = reason;
      duplicate.reviewUpdatedBy = investigatorId;
      duplicate.reviewUpdatedAt = now;
      duplicate.reviewAudit = Array.isArray(duplicate.reviewAudit) ? duplicate.reviewAudit : [];
      duplicate.reviewAudit.push({
        reviewedBy: investigatorId,
        reviewedAt: now,
        previousStatus,
        newStatus: status,
        note: reason,
      });
      duplicate.evidence = Array.isArray(duplicate.evidence) ? duplicate.evidence : [];
      duplicate.evidence.push({
        sourceReportId: 'investigator_manual',
        matchedField: 'manual_relationship',
        record: { summary: reason },
        metadata: {
          createdBy: investigatorId,
          createdAt: now,
          caseId: normalizedCaseId,
          ...(eventDate ? { eventDate } : {}),
          ...(eventTime ? { eventTime } : {}),
        },
      });
      if (!duplicate.eventDate && eventDate) duplicate.eventDate = eventDate;
      if (!duplicate.eventTime && eventTime) duplicate.eventTime = eventTime;
      if (!duplicate.eventType) duplicate.eventType = edgeType;
      if (!duplicate.relationReason) duplicate.relationReason = reason;
      if (eventDate && (!duplicate.dateConfidence || duplicate.dateConfidence === 'none')) {
        duplicate.dateConfidence = 'explicit';
      }
      duplicate.attributes = { ...(duplicate.attributes || {}), manuallyCorroborated: true };
      await duplicate.save();

      return res.status(200).json({
        success: true,
        data: {
          id: duplicate.edgeId || duplicate._id.toString(),
          edgeId: duplicate.edgeId || duplicate._id.toString(),
          source: duplicate.source,
          target: duplicate.target,
          edgeType: duplicate.edgeType,
          confidence: duplicate.confidence,
          eventDate: duplicate.eventDate || null,
          eventTime: duplicate.eventTime || null,
          eventType: duplicate.eventType || null,
          relationReason: duplicate.relationReason || null,
          dateConfidence: duplicate.dateConfidence || 'none',
          originalStatus: duplicate.systemStatus || duplicate.guardrailStatus || 'unknown',
          systemStatus: duplicate.systemStatus || duplicate.guardrailStatus || null,
          reviewStatus: duplicate.reviewStatus,
          effectiveStatus: duplicate.reviewStatus,
          latestNote: duplicate.reviewReason,
          reviewUpdatedBy: duplicate.reviewUpdatedBy,
          reviewUpdatedAt: duplicate.reviewUpdatedAt,
          reviewAudit: duplicate.reviewAudit,
          evidence: duplicate.evidence,
          attributes: duplicate.attributes,
          associatedCases: duplicate.associatedCases,
          reusedExisting: true,
        },
        error: null,
      });
    }

    const edgeId = `manual-${randomUUID()}`;
    const edge = await Edge.create({
      associatedCases: [normalizedCaseId],
      edgeId,
      source,
      target,
      edgeType,
      confidence: 1,
      eventDate: eventDate || undefined,
      eventTime: eventTime || undefined,
      eventType: edgeType,
      relationReason: reason,
      dateConfidence: eventDate ? 'explicit' : 'none',
      reviewStatus: status,
      reviewReason: reason,
      reviewUpdatedBy: investigatorId,
      reviewUpdatedAt: now,
      reviewAudit: [{ reviewedBy: investigatorId, reviewedAt: now, previousStatus: 'unknown', newStatus: status, note: reason }],
      attributes: { createdManually: true },
      evidence: [{
        sourceReportId: 'investigator_manual',
        matchedField: 'manual_relationship',
        record: { summary: reason },
        metadata: { createdBy: investigatorId, createdAt: now },
      }],
    });

    return res.status(201).json({
      success: true,
      data: {
        id: edge.edgeId,
        edgeId: edge.edgeId,
        source: edge.source,
        target: edge.target,
        edgeType: edge.edgeType,
        confidence: edge.confidence,
        eventDate: edge.eventDate || null,
        eventTime: edge.eventTime || null,
        eventType: edge.eventType,
        relationReason: edge.relationReason,
        dateConfidence: edge.dateConfidence,
        originalStatus: 'unknown',
        systemStatus: null,
        reviewStatus: edge.reviewStatus,
        effectiveStatus: edge.reviewStatus,
        latestNote: edge.reviewReason,
        reviewUpdatedBy: edge.reviewUpdatedBy,
        reviewUpdatedAt: edge.reviewUpdatedAt,
        reviewAudit: edge.reviewAudit,
        evidence: edge.evidence,
        attributes: edge.attributes,
        associatedCases: edge.associatedCases,
      },
      error: null,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, error: { code: 'RELATIONSHIP_EXISTS', message: 'This relationship already exists; open it to update its status or note' } });
    }
    next(error);
  }
};

const markSemanticLeadReviewed = async (req, res, next) => {
  try {
    const { caseId, matchedCaseId } = req.params;
    const { Case } = require('../models');
    const caseDoc = await Case.findOne({ caseId: caseId.trim() });
    if (!caseDoc) return res.status(404).json({ success: false, error: { code: 'CASE_NOT_FOUND', message: 'Case not found' } });
    const lead = caseDoc.similarCaseLeads.find((item) => item.matchedCaseId === matchedCaseId);
    if (!lead) return res.status(404).json({ success: false, error: { code: 'LEAD_NOT_FOUND', message: 'Semantic lead not found in this case' } });
    const referencedCase = await Case.exists({ caseId: matchedCaseId });
    if (!referencedCase) return res.status(404).json({ success: false, error: { code: 'REFERENCED_CASE_UNAVAILABLE', message: 'The referenced case is unavailable' } });
    lead.referencedCaseReviewedAt = new Date();
    caseDoc.markModified('similarCaseLeads');
    await caseDoc.save();
    return res.status(200).json({ success: true, data: { matchedCaseId, referencedCaseReviewedAt: lead.referencedCaseReviewedAt }, error: null });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createCaseIntake,
  listCases,
  fetchCaseGraph,
  fetchEntityDetail,
  fetchCaseTimeline,
  fetchGuardrailDetail,
  updateCaseStatus,
  updateRelationshipStatus,
  createManualRelationship,
  updateSemanticLeadStatus,
  markSemanticLeadReviewed,
};
