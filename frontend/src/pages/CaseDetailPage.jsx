import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import apiClient from '../api/apiClient.js';
import { useAuth } from '../state/authContext.jsx';
import NetworkGraph from '../components/graph/NetworkGraph.jsx';
import { shouldShowCrossCaseEvidenceByDefault } from '../components/graph/graphPresentation.js';
import { useEntityLookup } from '../hooks/useEntityLookup.js';
import { caseDetailPath } from '../utils/caseNavigation.js';

const CARD_SHADOW =
  '0 0 0 1px rgba(0,0,0,0.08), 0px 2px 2px rgba(0,0,0,0.04), 0px 8px 16px -4px rgba(0,0,0,0.04)';

const STATUS_BADGE_CLASSES = {
  completed: 'bg-[#d3e5ff] text-[#0761d1]',
  failed: 'bg-[#f7d4d6] text-[#c50000]',
  pending: 'bg-[#ffefcf] text-[#ab570a]',
  processing: 'bg-[#ffefcf] text-[#ab570a]',
  verified: 'bg-[#d1fae5] text-[#065f46]',
  approved: 'bg-[#d1fae5] text-[#065f46]',
  possible_connection: 'bg-[#ffefcf] text-[#ab570a]',
  cross_connection: 'bg-[#ede9fe] text-[#6d28d9]',
  unknown_connection: 'bg-[#f3f4f6] text-[#374151]',
  rejected: 'bg-[#fee2e2] text-[#991b1b]',
  flagged: 'bg-[#ffefcf] text-[#ab570a]',
  unspecified: 'bg-[#f3f4f6] text-[#374151]',
  unverified: 'bg-[#fee2e2] text-[#991b1b]',
  unknown: 'bg-[#f3f4f6] text-[#374151]',
  similar_case_lead: 'bg-[#ffefcf] text-[#ab570a]',
  open: 'bg-[#d1fae5] text-[#065f46]',
  closed: 'bg-[#fee2e2] text-[#991b1b]',
};

const GRAPH_LAYOUT_COLUMNS = 4;
const GRAPH_COLUMN_GAP = 240;
const GRAPH_ROW_GAP = 140;

function formatTimelineTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusBadge({ status }) {
  const classes = STATUS_BADGE_CLASSES[status] || STATUS_BADGE_CLASSES.pending;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-xs uppercase tracking-wide ${classes}`}
    >
      {status}
    </span>
  );
}

// Custom node types registry removed as NetworkGraph handles it internally

function buildGraphPayload(graphData) {
  const rawNodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];
  const rawEdges = Array.isArray(graphData?.edges) ? graphData.edges : [];

  const unmappedNodes = [];
  const nodeIds = new Set();

  rawNodes.forEach((node, index) => {
    const canonicalId = typeof node?.canonicalId === 'string' ? node.canonicalId.trim() : '';
    if (!canonicalId) {
      unmappedNodes.push(`node[${index}] has no canonicalId`);
      return;
    }
    nodeIds.add(canonicalId);
  });

  const flowNodes = rawNodes
    .filter((node) => typeof node?.canonicalId === 'string' && node.canonicalId.trim())
    .map((node, index) => ({
      id: node.canonicalId.trim(),
      type: 'entity',
      position: {
        x: (index % GRAPH_LAYOUT_COLUMNS) * GRAPH_COLUMN_GAP,
        y: Math.floor(index / GRAPH_LAYOUT_COLUMNS) * GRAPH_ROW_GAP,
      },
      data: {
        canonicalId: node.canonicalId.trim(),
        type: typeof node.type === 'string' && node.type.trim() ? node.type.trim() : null,
        aliases: Array.isArray(node.aliases)
          ? node.aliases
              .filter((alias) => typeof alias === 'string' && alias.trim())
              .map((alias) => alias.trim())
          : [],
        confidence: typeof node.confidence === 'number' ? node.confidence : null,
      },
    }));

  const unmappedEdges = [];

  const flowEdges = rawEdges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge, index }) => {
      const source = typeof edge?.source === 'string' ? edge.source : '';
      const target = typeof edge?.target === 'string' ? edge.target : '';
      if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
        const endpoint =
          !source || !nodeIds.has(source)
            ? `source '${source || 'missing'}'`
            : `target '${target || 'missing'}'`;
        unmappedEdges.push(`edge[${index}] (id ${edge?.id ?? 'unknown'}) references unknown ${endpoint}`);
        return false;
      }
      return true;
    })
    .map(({ edge }) => ({
      id: String(edge.id),
      source: edge.source,
      target: edge.target,
      label: typeof edge.edgeType === 'string' && edge.edgeType.trim() ? edge.edgeType.trim() : undefined,
      labelStyle: { fill: '#4d4d4d', fontSize: 10 },
      labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
      style: { stroke: '#a1a1a1' },
    }));

  return { flowNodes, flowEdges, unmappedNodes, unmappedEdges };
}

const DCT_LABELS = {
  verified: 'Verified',
  possible_connection: 'Possible Connection',
  cross_connection: 'Cross-Case Connection',
  unknown_connection: 'Unknown Connection',
};

export function TimelineEventRow({ event, index, getEntityName, onClick, caseId, onStatusChange }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const eventDate = typeof event?.eventDate === 'string' ? event.eventDate : null;
  const eventTime = typeof event?.eventTime === 'string' ? event.eventTime : null;
  const eventTypeLabel = typeof event?.eventTypeLabel === 'string'
    ? event.eventTypeLabel
    : (event?.eventType ? friendlyLabel(event.eventType) : '');
  const relationReason = typeof event?.relationReason === 'string' ? event.relationReason : '';
  const dateConfidence = typeof event?.dateConfidence === 'string' ? event.dateConfidence : '';
  
  const displayDate = eventDate ? `${eventDate}${eventTime ? ` ${eventTime}` : ''}` : null;
  
  const source = typeof event?.source === 'string' ? event.source.trim() : '';
  const target = typeof event?.target === 'string' ? event.target.trim() : '';
  const edgeType = typeof event?.edgeType === 'string' ? event.edgeType.trim() : '';
  const sourceName = getEntityName(source);
  const targetName = getEntityName(target);
  const dct = event?.displayConnectionType || event?.effectiveStatus || 'unknown';
  const rationale = event?.guardrailRationale || null;
  const relatedPatterns = Array.isArray(event?.relatedPatterns) ? event.relatedPatterns : [];
  const key = typeof event?.id === 'string' && event.id.trim() ? event.id.trim() : `timeline-${index}`;
  const edgeId = typeof event?.edgeId === 'string' && event.edgeId.trim()
    ? event.edgeId.trim()
    : (typeof event?.id === 'string' ? event.id.trim() : '');

  return (
    <li key={key} className="flex flex-col border-b border-[#ebebeb] last:border-0 bg-white">
      {/* Header row — always visible */}
      <button
        type="button"
        onClick={() => { setIsExpanded(prev => !prev); onClick?.(); }}
        className="flex w-full items-start gap-4 px-6 py-4 text-left transition-colors hover:bg-[#fafafa]"
      >
        <div className="w-44 shrink-0 pt-0.5 flex flex-col">
          <p className="font-mono text-xs leading-5 text-[#888888]">
            {displayDate
              ? event?.isAnalysisTimestamp
                ? <><span>{displayDate}</span><span className="ml-1 text-[#a1a1a1]">(analysis)</span></>
                : displayDate
              : 'Undated'}
          </p>
          {dateConfidence && (
            <p className="font-mono text-[10px] text-[#a1a1a1]">Confidence: {dateConfidence}</p>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm text-[#171717] font-medium" title={`${sourceName} ↔ ${targetName}`}>
            {sourceName} <span className="text-[#a1a1a1] mx-1">↔</span> {targetName}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {(edgeType || eventTypeLabel) && (
              <span className="font-mono text-xs uppercase tracking-wide text-[#888888]">{eventTypeLabel || edgeType}</span>
            )}
            <StatusBadge status={dct} />
          </div>
        </div>
        <svg
          className={`h-4 w-4 shrink-0 text-[#888888] transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expandable detail panel */}
      {isExpanded && (
        <div className="border-t border-[#ebebeb] bg-[#fafafa] px-6 py-5 space-y-4">

          {/* Entities */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Source Entity</p>
              <p className="mt-1 font-mono text-sm text-[#171717] break-all">{sourceName}</p>
              <p className="font-mono text-xs text-[#a1a1a1] break-all">{source}</p>
            </div>
            <div>
              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Target Entity</p>
              <p className="mt-1 font-mono text-sm text-[#171717] break-all">{targetName}</p>
              <p className="font-mono text-xs text-[#a1a1a1] break-all">{target}</p>
            </div>
          </div>

          {/* Relationship & guardrail */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Relationship Type</p>
              <p className="mt-1 text-sm text-[#171717]">{eventTypeLabel || edgeType || '—'}</p>
              {relationReason && <p className="mt-1 text-sm text-[#4d4d4d]">{relationReason}</p>}
            </div>
            <div>
              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Guardrail Status</p>
              <div className="mt-1">
                <StatusBadge status={event?.guardrailStatus || 'unknown_connection'} />
              </div>
            </div>
          </div>

          {/* Display connection type */}
          <div>
            <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Connection Classification</p>
            <div className="mt-1"><StatusBadge status={dct} /></div>
            <p className="mt-0.5 font-mono text-xs text-[#888888]">{DCT_LABELS[dct] || dct}</p>
          </div>

          {caseId && edgeId && onStatusChange && (
            <div className="rounded-md border border-[#ebebeb] bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Investigator relationship status</p>
              <p className="mt-1 text-sm text-[#4d4d4d]">
                Add a note, then choose the status that should be shown for this connection.
              </p>
              <div className="mt-3 max-w-sm">
                <EdgeReviewDropdown
                  caseId={caseId}
                  edgeId={edgeId}
                  currentStatus={event?.reviewStatus || event?.effectiveStatus || event?.guardrailStatus || 'unknown'}
                  currentReason={event?.latestNote}
                  auditHistory={event?.reviewAudit}
                  onStatusChange={(newStatus, saved) => onStatusChange(edgeId, newStatus, saved)}
                />
              </div>
            </div>
          )}

          {/* Guardrail rationale */}
          <div>
            <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Analytical Rationale</p>
            <p className="mt-1 text-sm leading-5 text-[#4d4d4d]">
              {rationale && rationale.trim()
                ? rationale
                : 'No analytical rationale was returned for this relationship. Review the supporting evidence before drawing a conclusion.'}
            </p>
          </div>

          {/* Patterns */}
          {relatedPatterns.length > 0 && (
            <div>
              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Detected Patterns</p>
              <ul className="mt-2 space-y-2">
                {relatedPatterns.map((p, i) => (
                  <li key={i} className="rounded-md border border-[#ebebeb] bg-white px-3 py-2">
                    <p className="font-mono text-xs font-semibold text-[#6d28d9]">{p.patternType}</p>
                    {p.description && <p className="mt-1 text-xs text-[#4d4d4d]">{p.description}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

        </div>
      )}
    </li>
  );
}


export function EdgeReviewDropdown({ caseId, edgeId, currentStatus, currentReason, auditHistory, onStatusChange }) {
  const [updating, setUpdating] = useState(false);
  const [reason, setReason] = useState('');
  const [validationMessage, setValidationMessage] = useState('');

  const handleChange = async (e) => {
    const newStatus = e.target.value;
    if (!newStatus || newStatus === currentStatus) return;
    if (!reason.trim()) {
      setValidationMessage('Enter an investigator note before saving a new status.');
      return;
    }
    setValidationMessage('');
    const previousStatus = currentStatus;
    onStatusChange(newStatus);
    setUpdating(true);
    try {
      const res = await apiClient.patch(`/cases/${encodeURIComponent(caseId)}/relationships/${encodeURIComponent(edgeId)}/status`, {
        status: newStatus,
        reason
      });
      if (res.data?.success) {
        onStatusChange(newStatus, res.data.data);
        setReason('');
      }
    } catch (err) {
      onStatusChange(previousStatus || null);
      console.error('Failed to update status', err);
      alert(err.response?.data?.error?.message || 'Failed to update status.');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="space-y-2">
      <label className="block text-xs text-[#4d4d4d]" htmlFor={`edge-note-${edgeId}`}>Investigator note</label>
      <input
        id={`edge-note-${edgeId}`}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          if (event.target.value.trim()) setValidationMessage('');
        }}
        placeholder="Reason for this decision"
        className="h-9 w-full rounded-md border border-[#ebebeb] bg-white px-3 text-sm text-[#171717]"
      />
      <select
        aria-label="Relationship status"
        value={currentStatus || 'unknown'}
        onChange={handleChange}
        disabled={updating}
        className="block w-full rounded-md border border-[#ebebeb] bg-white px-3 py-1.5 text-sm text-[#171717] shadow-sm focus:border-[#171717] focus:outline-none focus:ring-1 focus:ring-[#171717] disabled:opacity-50"
      >
        <option value="verified">Verified</option>
        <option value="possible_connection">Possible connection</option>
        <option value="cross_connection">Cross-case connection</option>
        <option value="unverified">Unverified</option>
        <option value="unknown">Unknown</option>
      </select>
      {validationMessage && <p role="alert" className="text-xs text-[#c50000]">{validationMessage}</p>}
      {updating && <span className="text-xs text-[#888888]">Saving...</span>}
      {currentReason && (
        <div className="rounded-md bg-[#fafafa] px-3 py-2">
          <p className="font-mono text-[10px] uppercase tracking-wide text-[#888888]">Latest saved reason</p>
          <p className="mt-1 text-sm text-[#4d4d4d]">{currentReason}</p>
        </div>
      )}
      {Array.isArray(auditHistory) && auditHistory.length > 0 && (
        <details className="rounded-md border border-[#ebebeb] bg-[#fafafa] px-3 py-2">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-[#888888]">
            Status history · {auditHistory.length}
          </summary>
          <ol className="mt-2 space-y-2">
            {auditHistory.slice().reverse().map((entry, index) => (
              <li key={`${entry.reviewedAt || entry.updatedAt || index}-${index}`} className="text-xs text-[#4d4d4d]">
                <span className="font-medium text-[#171717]">
                  {friendlyLabel(entry.previousStatus || 'unknown')} → {friendlyLabel(entry.newStatus || entry.status || 'unknown')}
                </span>
                {(entry.note || entry.reason) && <span> — {entry.note || entry.reason}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

const RELATIONSHIP_TYPE_OPTIONS = [
  ['owns', 'Owns'],
  ['associated_with', 'Associated with'],
  ['shared_phone', 'Shared phone'],
  ['shared_address', 'Shared address'],
  ['telecom_link', 'Telecom link'],
  ['co-mention', 'Co-mention'],
];

export function CrossCaseRecurrenceAlert({ patterns, nodes, navigate, currentCaseId, onHighlightMatch }) {
  const recurrences = (Array.isArray(patterns) ? patterns : [])
    .filter((pattern) => pattern?.patternType === 'cross_case_recurrence');
  if (!recurrences.length) return null;

  const nodeNames = new Map((Array.isArray(nodes) ? nodes : []).map((node) => {
    const alias = Array.isArray(node?.aliases)
      ? node.aliases.find((value) => typeof value === 'string' && value.trim())
      : null;
    return [node?.canonicalId, alias || node?.canonicalId];
  }));
  const matches = [];
  const seen = new Set();
  for (const pattern of recurrences) {
    const exactMatches = Array.isArray(pattern.metadata?.exactMatches) ? pattern.metadata.exactMatches : [];
    for (const match of exactMatches) {
      if (!match?.canonicalId) continue;
      const historicalCases = Array.isArray(match.historicalCases)
        ? match.historicalCases
        : (Array.isArray(match.historicalCaseIds)
          ? match.historicalCaseIds.map((caseId) => ({ caseId, available: true }))
          : []);
      const filteredCases = historicalCases.filter((item) =>
        typeof item?.caseId === 'string' && item.caseId && item.caseId !== currentCaseId
      );
      const key = `${match.canonicalId}:${filteredCases.map((item) => item.caseId).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ ...match, historicalCases: filteredCases });
    }
  }

  return (
    <section
      role="alert"
      aria-label="Cross-case recurrence"
      className="mt-8 rounded-xl border border-[#d8ccf1] bg-[#f8f5ff] px-6 py-5"
      style={{ boxShadow: CARD_SHADOW }}
    >
      <p className="font-mono text-xs uppercase tracking-wide text-[#6d28d9]">Cross-case recurrence</p>
      <h2 className="mt-2 text-lg font-semibold tracking-[-0.4px] text-[#171717]">
        Exact identifiers appeared in earlier cases
      </h2>
      <p className="mt-1 text-sm leading-5 text-[#4d4d4d]">
        This is an entity-level alert. It does not create or verify a graph connection automatically.
      </p>

      {matches.length ? (
        <ul className="mt-4 divide-y divide-[#d8ccf1] overflow-hidden rounded-lg border border-[#d8ccf1] bg-white">
          {matches.map((match) => (
            <li key={`${match.type}-${match.canonicalId}`} className="px-4 py-3">
              {onHighlightMatch ? (
                <button
                  type="button"
                  onClick={() => onHighlightMatch(match.canonicalId)}
                  className="text-left text-sm font-medium text-[#0761d1] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0761d1]"
                  aria-label={`Show historical graph evidence for ${match.canonicalId}`}
                >
                  {nodeNames.get(match.canonicalId) || match.canonicalId}
                </button>
              ) : (
                <p className="text-sm font-medium text-[#171717]">
                  {nodeNames.get(match.canonicalId) || match.canonicalId}
                </p>
              )}
              <p className="mt-0.5 break-all font-mono text-xs text-[#888888]">{match.canonicalId}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {match.historicalCases.length ? match.historicalCases.map((reference) => (
                  reference.available ? (
                    <button
                      key={reference.caseId}
                      type="button"
                      onClick={() => navigate(caseDetailPath(reference.caseId))}
                      className="h-8 rounded-md border border-[#ebebeb] bg-white px-3 text-sm font-medium text-[#0761d1] transition-colors hover:bg-[#f5f5f5]"
                    >
                      Open case {reference.caseId}
                    </button>
                  ) : (
                    <span key={reference.caseId} className="rounded-md bg-[#f5f5f5] px-3 py-1.5 text-sm text-[#888888]">
                      {reference.caseId}: Referenced case unavailable
                    </span>
                  )
                )) : (
                  <span className="text-sm text-[#888888]">Referenced case unavailable</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-[#888888]">
          Exact recurrence was detected, but historical case references were not returned.
        </p>
      )}
    </section>
  );
}

export function CrossCaseEvidenceDetail({ evidence, unavailable, onOpenCase, onClose }) {
  if (!evidence) return null;
  const relationship = evidence.historicalRelationship || {};
  const confidence = typeof relationship.confidence === 'number'
    ? `${Math.round(relationship.confidence * 100)}%`
    : 'Unknown';
  const evidenceItems = Array.isArray(relationship.evidence) ? relationship.evidence : [];
  return (
    <aside className="border-t border-[#ebebeb] bg-[#fafafa] px-6 py-5" aria-label="Historical cross-case evidence details">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-wide text-[#6d28d9]">Historical cross-case evidence</p>
          <h3 className="mt-1 text-base font-semibold text-[#171717]">{evidence.historicalEntity?.name || 'Historical entity'}</h3>
        </div>
        <button type="button" onClick={onClose} className="rounded-md border border-[#ebebeb] bg-white px-3 py-1.5 text-sm text-[#4d4d4d] hover:bg-[#f5f5f5]">Close</button>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="font-mono text-xs text-[#888888]">Historical case</dt><dd className="mt-1 text-[#171717]">{evidence.historicalCaseId || 'Unavailable'}</dd></div>
        <div><dt className="font-mono text-xs text-[#888888]">Matched identifier</dt><dd className="mt-1 break-all text-[#171717]">{evidence.matchedIdentifier || 'Unknown'}</dd></div>
        <div><dt className="font-mono text-xs text-[#888888]">Original relationship</dt><dd className="mt-1 text-[#171717]">{friendlyLabel(relationship.edgeType || 'unknown')}</dd></div>
        <div><dt className="font-mono text-xs text-[#888888]">Original model status</dt><dd className="mt-1 text-[#171717]">{friendlyLabel(relationship.modelStatus || 'unknown')}</dd></div>
        <div><dt className="font-mono text-xs text-[#888888]">Confidence</dt><dd className="mt-1 text-[#171717]">{confidence}</dd></div>
        <div><dt className="font-mono text-xs text-[#888888]">Event date</dt><dd className="mt-1 text-[#171717]">{[relationship.eventDate, relationship.eventTime].filter(Boolean).join(' ') || 'Undated'}</dd></div>
      </dl>
      {relationship.relationReason && <p className="mt-4 text-sm leading-6 text-[#4d4d4d]">{relationship.relationReason}</p>}
      {evidenceItems.length > 0 && (
        <div className="mt-4 rounded-md border border-[#ebebeb] bg-white px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Original relationship evidence</p>
          <ul className="mt-2 space-y-2 text-sm text-[#4d4d4d]">
            {evidenceItems.map((item, index) => (
              <li key={`${item?.sourceReportId || 'evidence'}-${index}`}>
                {[item?.sourceReportId, item?.matchedField, friendlyValue(item?.record)].filter(Boolean).join(' · ')}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={!evidence.historicalCaseId}
          onClick={() => onOpenCase(evidence.historicalCaseId)}
          className="h-9 rounded-md bg-[#171717] px-4 text-sm font-medium text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
        >
          Open historical case
        </button>
        {unavailable && <p role="alert" className="text-sm text-[#c50000]">Referenced case unavailable</p>}
      </div>
      <p className="mt-3 text-xs text-[#888888]">Read-only historical evidence. This does not change any relationship status.</p>
    </aside>
  );
}

export function GraphEvidenceToggle({ available, shown, onChange }) {
  return (
    <div className="flex rounded-md border border-[#ebebeb] bg-[#fafafa] p-0.5" role="group" aria-label="Graph evidence view">
      <button
        type="button"
        aria-pressed={!shown}
        onClick={() => onChange(false)}
        className={`rounded px-3 py-1.5 text-xs font-medium ${!shown ? 'bg-white text-[#171717] shadow-sm' : 'text-[#666666]'}`}
      >
        Current case
      </button>
      <button
        type="button"
        aria-pressed={shown}
        disabled={!available}
        onClick={() => onChange(true)}
        className={`rounded px-3 py-1.5 text-xs font-medium ${shown ? 'bg-white text-[#6d28d9] shadow-sm' : 'text-[#666666]'} disabled:cursor-not-allowed disabled:opacity-40`}
      >
        Show cross-case evidence
      </button>
    </div>
  );
}

export function ManualRelationshipForm({ caseId, nodes, onCreated }) {
  const availableNodes = Array.isArray(nodes)
    ? nodes.filter((node) => typeof node?.canonicalId === 'string' && node.canonicalId.trim())
    : [];
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [relationshipType, setRelationshipType] = useState('associated_with');
  const [customType, setCustomType] = useState('');
  const [status, setStatus] = useState('possible_connection');
  const [reason, setReason] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [eventTime, setEventTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const nodeLabel = (node) => {
    const alias = Array.isArray(node.aliases) && node.aliases.find((value) => typeof value === 'string' && value.trim());
    return alias ? `${alias} (${node.canonicalId})` : node.canonicalId;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setMessage('');
    setError('');
    const edgeType = relationshipType === 'custom' ? customType.trim() : relationshipType;
    if (!source || !target) {
      setError('Select both nodes to create a connection.');
      return;
    }
    if (source === target) {
      setError('Choose two different nodes.');
      return;
    }
    if (!edgeType) {
      setError('Enter a custom relationship type.');
      return;
    }
    if (!reason.trim()) {
      setError('Add the evidence or rationale for this connection.');
      return;
    }

    setSaving(true);
    try {
      const response = await apiClient.post(`/cases/${encodeURIComponent(caseId)}/relationships`, {
        source,
        target,
        edgeType,
        status,
        reason: reason.trim(),
        eventDate: eventDate || undefined,
        eventTime: eventTime || undefined,
      });
      const savedEdge = response.data?.data;
      if (!response.data?.success || !savedEdge) throw new Error('The server did not return the saved relationship.');
      setSource('');
      setTarget('');
      setRelationshipType('associated_with');
      setCustomType('');
      setStatus('possible_connection');
      setReason('');
      setEventDate('');
      setEventTime('');
      setMessage('Connection saved. It is now visible in the graph and timeline.');
      onCreated?.(savedEdge);
    } catch (requestError) {
      setError(requestError.response?.data?.error?.message || requestError.message || 'Could not save this connection.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-8 rounded-xl bg-white" style={{ boxShadow: CARD_SHADOW }} aria-labelledby="manual-connection-title">
      <details>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 marker:hidden">
          <div>
            <h2 id="manual-connection-title" className="text-sm font-semibold text-[#171717]">Add investigator connection</h2>
            <p className="mt-1 text-sm text-[#4d4d4d]">Link two currently unconnected nodes when new evidence establishes a relationship.</p>
          </div>
          <span className="shrink-0 rounded-md bg-[#171717] px-3 py-1.5 text-sm font-medium text-white">Add connection</span>
        </summary>
        <form onSubmit={handleSubmit} className="border-t border-[#ebebeb] px-6 py-5">
          {availableNodes.length < 2 ? (
            <p className="text-sm text-[#4d4d4d]">At least two case entities are required before a connection can be added.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm text-[#4d4d4d]">
                Source node
                <select aria-label="Source node" required value={source} onChange={(event) => setSource(event.target.value)} className="mt-1 block h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 text-sm text-[#171717]">
                  <option value="">Select source</option>
                  {availableNodes.map((node) => <option key={node.canonicalId} value={node.canonicalId} disabled={node.canonicalId === target}>{nodeLabel(node)}</option>)}
                </select>
              </label>
              <label className="text-sm text-[#4d4d4d]">
                Target node
                <select aria-label="Target node" required value={target} onChange={(event) => setTarget(event.target.value)} className="mt-1 block h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 text-sm text-[#171717]">
                  <option value="">Select target</option>
                  {availableNodes.map((node) => <option key={node.canonicalId} value={node.canonicalId} disabled={node.canonicalId === source}>{nodeLabel(node)}</option>)}
                </select>
              </label>
              <label className="text-sm text-[#4d4d4d]">
                Relationship type
                <select aria-label="Relationship type" value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} className="mt-1 block h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 text-sm text-[#171717]">
                  {RELATIONSHIP_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  <option value="custom">Custom relationship…</option>
                </select>
              </label>
              <label className="text-sm text-[#4d4d4d]">
                Initial status
                <select aria-label="Initial relationship status" value={status} onChange={(event) => setStatus(event.target.value)} className="mt-1 block h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 text-sm text-[#171717]">
                  <option value="verified">Verified</option>
                  <option value="possible_connection">Possible connection</option>
                  <option value="cross_connection">Cross-case connection</option>
                  <option value="unverified">Unverified</option>
                  <option value="unknown">Unknown</option>
                </select>
              </label>
              {relationshipType === 'custom' && (
                <label className="text-sm text-[#4d4d4d] md:col-span-2">
                  Custom relationship type
                  <input aria-label="Custom relationship type" maxLength={80} required value={customType} onChange={(event) => setCustomType(event.target.value)} placeholder="e.g. transferred_funds_to" className="mt-1 block h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 text-sm text-[#171717]" />
                </label>
              )}
              <label className="text-sm text-[#4d4d4d] md:col-span-2">
                Evidence / investigator rationale
                <textarea aria-label="Connection rationale" required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Describe the evidence that supports this new connection" className="mt-1 block w-full rounded-md border border-[#d4d4d4] bg-white px-3 py-2 text-sm text-[#171717]" />
              </label>
              <label className="text-sm text-[#4d4d4d]">
                Event date <span className="text-[#888888]">(optional)</span>
                <input aria-label="Connection event date" type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} className="mt-1 block h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 text-sm text-[#171717]" />
              </label>
              <label className="text-sm text-[#4d4d4d]">
                Event time <span className="text-[#888888]">(optional)</span>
                <input aria-label="Connection event time" type="time" value={eventTime} onChange={(event) => setEventTime(event.target.value)} className="mt-1 block h-10 w-full rounded-md border border-[#d4d4d4] bg-white px-3 text-sm text-[#171717]" />
              </label>
            </div>
          )}
          {error && <p role="alert" className="mt-4 rounded-md bg-[#f7d4d6] px-3 py-2 text-sm text-[#c50000]">{error}</p>}
          {message && <p role="status" className="mt-4 rounded-md bg-[#d1fae5] px-3 py-2 text-sm text-[#065f46]">{message}</p>}
          {availableNodes.length >= 2 && (
            <div className="mt-5 flex justify-end">
              <button type="submit" disabled={saving} className="h-9 rounded-md bg-[#171717] px-4 text-sm font-medium text-white transition-opacity hover:opacity-85 disabled:cursor-wait disabled:opacity-50">
                {saving ? 'Saving connection…' : 'Save connection'}
              </button>
            </div>
          )}
        </form>
      </details>
    </section>
  );
}

// Timeline range scrubber — rendered below the graph
export function TimelineScrubber({ bounds, activeRange, onChange }) {
  const timestamps = bounds.timestamps || [];
  const trackRef = useRef(null);
  const draggingRef = useRef(false);
  const currentEnd = activeRange ? new Date(activeRange.end).getTime() : bounds.max;
  const matchedIndex = timestamps.findIndex((timestamp) => timestamp >= currentEnd);
  const currentIndex = matchedIndex === -1 ? Math.max(0, timestamps.length - 1) : matchedIndex;
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const selectIndex = (index) => {
    if (!timestamps.length) return;
    const bounded = Math.max(0, Math.min(timestamps.length - 1, index));
    onChange({ start: new Date(bounds.min).toISOString(), end: new Date(timestamps[bounded]).toISOString() });
  };
  const selectPointer = (clientX) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const nearestIndex = Math.round(ratio * (timestamps.length - 1));
    selectIndex(nearestIndex);
  };

  if (timestamps.length === 0) {
    return (
      <div className="px-6 py-4 border-t border-[#ebebeb] bg-[#fafafa]">
        <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Timeline filter</p>
        <p className="mt-2 text-sm text-[#4d4d4d]">No dated investigation events</p>
      </div>
    );
  }
  const displayEnd = fmtDate(timestamps[currentIndex]);
  const progress = timestamps.length <= 1 ? 0 : (currentIndex / (timestamps.length - 1)) * 100;

  return (
    <div className="px-6 py-4 border-t border-[#ebebeb] bg-[#fafafa]">
      <div className="flex items-center justify-between mb-2">
        <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">
          Investigation date (cumulative)
        </p>
        {timestamps.length > 1 && activeRange && currentEnd < bounds.max && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="font-mono text-xs text-[#888888] hover:text-[#171717] transition-colors underline underline-offset-2"
          >
            Reset
          </button>
        )}
      </div>

      <p className="mb-2 text-sm text-[#171717]">Selected date: <span className="font-mono">{displayEnd}</span></p>
      <div className="flex justify-between mb-1">
        <span className="font-mono text-xs text-[#888888]">{fmtDate(bounds.min)}</span>
        <span className="font-mono text-xs text-[#0761d1] font-medium text-right flex-1">{displayEnd}</span>
        <span className="font-mono text-xs text-[#888888] text-right" style={{minWidth: '70px'}}>{fmtDate(bounds.max)}</span>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={timestamps.length > 1 ? 0 : -1}
        aria-label="Select investigation date"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, timestamps.length - 1)}
        aria-valuenow={currentIndex}
        aria-valuetext={displayEnd}
        aria-disabled={timestamps.length === 1}
        className={`relative flex h-8 touch-none items-center ${timestamps.length > 1 ? 'cursor-pointer' : 'cursor-default'}`}
        onClick={(event) => timestamps.length > 1 && selectPointer(event.clientX)}
        onPointerDown={(event) => {
          if (timestamps.length <= 1) return;
          draggingRef.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          selectPointer(event.clientX);
        }}
        onPointerMove={(event) => draggingRef.current && selectPointer(event.clientX)}
        onPointerUp={(event) => {
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => { draggingRef.current = false; }}
        onKeyDown={(event) => {
          if (timestamps.length <= 1) return;
          if (event.key === 'ArrowLeft') { event.preventDefault(); selectIndex(currentIndex - 1); }
          if (event.key === 'ArrowRight') { event.preventDefault(); selectIndex(currentIndex + 1); }
          if (event.key === 'Home') { event.preventDefault(); selectIndex(0); }
          if (event.key === 'End') { event.preventDefault(); selectIndex(timestamps.length - 1); }
        }}
      >
        <div className="absolute w-full h-1.5 rounded-full bg-[#ebebeb]" />
        <div className="absolute h-1.5 rounded-full bg-[#0761d1]" style={{ left: 0, width: `${progress}%` }} />
        {timestamps.map((ts, idx) => {
          const pct = timestamps.length <= 1 ? 0 : (idx / (timestamps.length - 1)) * 100;
          return (
            <div 
              key={`tick-${idx}`}
              className="absolute h-2.5 w-[2px] bg-[#a1a1a1] -translate-x-1/2 pointer-events-none rounded-sm"
              style={{ left: `${pct}%`, top: '50%', transform: 'translate(-50%, -50%)' }}
              title={new Date(ts).toLocaleString()}
            />
          );
        })}
        <div
          className="absolute w-4 h-4 rounded-full bg-white border-2 border-[#0761d1] shadow-sm -translate-x-1/2 pointer-events-none"
          style={{ left: `${progress}%` }}
        />
      </div>
      {timestamps.length === 1 && <p className="mt-1 text-xs text-[#888888]">Only one dated event is available.</p>}
    </div>
  );
}

function friendlyLabel(value) {
  return String(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function friendlyValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map(friendlyValue).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => `${friendlyLabel(key)}: ${friendlyValue(item)}`).join(' · ');
  }
  return String(value);
}

function FriendlyFields({ values }) {
  return (
    <dl className="mt-2 divide-y divide-[#ebebeb] rounded-md border border-[#ebebeb] bg-[#fafafa]">
      {Object.entries(values || {}).map(([key, value]) => (
        <div key={key} className="grid grid-cols-[minmax(110px,0.4fr)_1fr] gap-3 px-3 py-2 text-sm">
          <dt className="font-mono text-xs text-[#4d4d4d]">{friendlyLabel(key)}</dt>
          <dd className="break-words text-[#171717]">{friendlyValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SimilarCasesPanel({ leads, navigate, currentCaseId, onUpdateLeadStatus }) {
  const [updatingId, setUpdatingId] = useState(null);
  const [reasons, setReasons] = useState({});
  const [unavailableId, setUnavailableId] = useState(null);

  if (!leads || leads.length === 0) return null;

  const handleStatusChange = async (matchedCaseId, newStatus) => {
    if (!newStatus) return;
    setUpdatingId(matchedCaseId);
    try {
      const res = await apiClient.patch(`/cases/${encodeURIComponent(currentCaseId)}/similar-leads/${encodeURIComponent(matchedCaseId)}/status`, {
        status: newStatus,
        reason: reasons[matchedCaseId] || ''
      });
      if (res.data?.success) {
        if (onUpdateLeadStatus) onUpdateLeadStatus(matchedCaseId, newStatus);
      }
    } catch (err) {
      console.error('Failed to update semantic lead status', err);
      alert(err.response?.data?.error?.message || 'Failed to update semantic lead status.');
    } finally {
      setUpdatingId(null);
    }
  };

  const openCase = async (matchedCaseId) => {
    if (!matchedCaseId) {
      setUnavailableId('__missing__');
      return;
    }
    setUnavailableId(null);
    try {
      const response = await apiClient.post(`/cases/${encodeURIComponent(currentCaseId)}/similar-leads/${encodeURIComponent(matchedCaseId)}/reviewed`);
      if (response.data?.success) navigate(`/cases/${encodeURIComponent(matchedCaseId)}`);
    } catch (error) {
      if (error.response?.status === 404) setUnavailableId(matchedCaseId);
      else alert(error.response?.data?.error?.message || 'Could not open the referenced case.');
    }
  };

  return (
    <section
      className="mt-8 overflow-hidden rounded-xl bg-white"
      style={{ boxShadow: '0 0 0 1px rgba(0,0,0,0.08), 0px 2px 2px rgba(0,0,0,0.04), 0px 8px 16px -4px rgba(0,0,0,0.04)' }}
      aria-label="Similar Cases"
    >
      <div className="flex items-center justify-between border-b border-[#ebebeb] px-6 py-3">
        <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Similar cases detected</p>
      </div>
      <div className="divide-y divide-[#ebebeb]">
        {leads.map((lead, idx) => {
          const matchedId = lead.matchedCaseId;
          const score = typeof lead.similarityScore === 'number' ? lead.similarityScore : 0;
          const isHighMatch = score >= 0.90;

          return (
            <div key={idx} className="flex flex-col sm:flex-row sm:items-start justify-between p-6 gap-4 hover:bg-[#fafafa] transition-colors">
              <div className="flex-1 space-y-3">
                <div className="flex items-center gap-3">
                  <h4 className="font-mono text-sm font-semibold text-[#171717]">
                    {matchedId || 'Referenced case unavailable'}
                  </h4>
                  <StatusBadge status={isHighMatch ? (lead.investigatorStatus || 'possible_connection') : 'similar_case_lead'} />
                  {typeof lead.similarityScore === 'number' && (
                    <span className="font-mono text-xs text-[#065f46] bg-[#d1fae5] px-2 py-0.5 rounded-full">
                      {Math.round(score * 100)}% Match
                    </span>
                  )}
                </div>
                {lead.rationale && (
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Rationale</p>
                    <p className="mt-1 text-sm text-[#4d4d4d] leading-5">{lead.rationale}</p>
                  </div>
                )}
                <div>
                  <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Model status</p>
                  <p className="mt-1 text-sm text-[#4d4d4d]">{lead.status || 'Unknown'}</p>
                </div>
                {lead.matchingFacts && lead.matchingFacts.length > 0 && (
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Matching Facts</p>
                    <ul className="mt-1 list-disc list-inside text-sm text-[#4d4d4d] space-y-1">
                      {lead.matchingFacts.map((fact, i) => <li key={i}>{fact}</li>)}
                    </ul>
                  </div>
                )}
                {lead.sharedConcepts && lead.sharedConcepts.length > 0 && (
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Shared Concepts</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {lead.sharedConcepts.map((concept, i) => (
                        <span key={i} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#f3f4f6] text-[#374151]">
                          {concept}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {lead.exactIdentifierOverlap && lead.exactIdentifierOverlap.length > 0 && (
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Exact Identifier Overlap</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {lead.exactIdentifierOverlap.map((id, i) => (
                        <span key={i} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#fee2e2] text-[#991b1b] border border-[#fca5a5]">
                          {id}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                
                {!isHighMatch && (
                  <div className="mt-3 text-xs text-[#ab570a] bg-[#ffefcf] p-2 rounded border border-[#ffd380]">
                    <span className="font-bold">Review Warning:</span> This case was flagged as a potential semantic lead, but falls below the confidence threshold for automated relationship proposals.
                  </div>
                )}
              </div>
              <div className="shrink-0 flex flex-col gap-3 min-w-[200px]">
                <button
                  type="button"
                  onClick={() => openCase(matchedId)}
                  className="h-8 w-full rounded-md bg-[#171717] px-3 text-sm font-medium text-white transition-colors hover:bg-black"
                >
                  Open case
                </button>
                {(unavailableId === matchedId || (!matchedId && unavailableId === '__missing__')) && (
                  <p role="alert" className="text-sm text-[#c50000]">The referenced case is unavailable</p>
                )}
                
                {isHighMatch && (
                  <div className="mt-2">
                    <label className="block font-mono text-xs uppercase tracking-wide text-[#888888] mb-1">
                      Investigator Status
                    </label>
                    <select
                      value={lead.investigatorStatus || 'unspecified'}
                      onChange={(e) => handleStatusChange(matchedId, e.target.value)}
                      disabled={updatingId === matchedId}
                      className="block w-full rounded-md border border-[#ebebeb] bg-white px-3 py-1.5 text-sm text-[#171717] shadow-sm focus:border-[#171717] focus:outline-none focus:ring-1 focus:ring-[#171717] disabled:opacity-50"
                    >
                      <option value="unspecified">Unspecified (System default)</option>
                      <option value="verified" disabled={!lead.referencedCaseReviewedAt}>Verified</option>
                      <option value="possible_connection">Possible connection</option>
                      <option value="cross_connection" disabled={!lead.referencedCaseReviewedAt}>Cross-case connection</option>
                      <option value="unverified">Unverified</option>
                      <option value="unknown">Unknown</option>
                    </select>
                    {!lead.referencedCaseReviewedAt && (
                      <p className="mt-1 text-xs text-[#888888]">Open and review the referenced case before verifying or marking a cross-case connection.</p>
                    )}
                    <label className="mt-3 block font-mono text-xs uppercase tracking-wide text-[#888888]" htmlFor={`semantic-note-${idx}`}>Investigator note</label>
                    <input
                      id={`semantic-note-${idx}`}
                      value={reasons[matchedId] || ''}
                      onChange={(event) => setReasons((current) => ({ ...current, [matchedId]: event.target.value }))}
                      className="mt-1 h-9 w-full rounded-md border border-[#ebebeb] bg-white px-3 text-sm text-[#171717]"
                      placeholder="Reason for this decision"
                    />
                    {updatingId === matchedId && <span className="text-xs text-[#888888] mt-1 block">Saving...</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function CaseDetailPage() {
  const { caseId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [fetchStatus, setFetchStatus] = useState('loading');
  const [graphData, setGraphData] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [notFound, setNotFound] = useState(false);

  const [timelineStatus, setTimelineStatus] = useState('loading');
  const [timelineEvents, setTimelineEvents] = useState([]);
  const [timelineTotal, setTimelineTotal] = useState(0);
  const [timelineError, setTimelineError] = useState('');
  const [timelineNotFound, setTimelineNotFound] = useState(false);

  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [entityStatus, setEntityStatus] = useState('idle');
  const [entityData, setEntityData] = useState(null);
  const [entityError, setEntityError] = useState('');

  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [guardrailFetchStatus, setGuardrailFetchStatus] = useState('idle');
  const [guardrailData, setGuardrailData] = useState(null);
  const [guardrailError, setGuardrailError] = useState('');
  const [showCrossCaseEvidence, setShowCrossCaseEvidence] = useState(false);
  const [focusedGraphNodeId, setFocusedGraphNodeId] = useState(null);
  const [selectedCrossCaseEvidence, setSelectedCrossCaseEvidence] = useState(null);
  const [historicalCaseUnavailable, setHistoricalCaseUnavailable] = useState(false);

  // Timeline scrubber state
  const [activeTimeRange, setActiveTimeRange] = useState(null);
  
  const [statusUpdating, setStatusUpdating] = useState(false);

  const toggleCaseStatus = async () => {
    if (!graphData) return;
    setStatusUpdating(true);
    const newStatus = graphData.status === 'closed' ? 'open' : 'closed';
    try {
      const res = await apiClient.patch(`/cases/${encodeURIComponent(caseId)}/status`, { status: newStatus });
      if (res.data?.success) {
        setGraphData(prev => ({ ...prev, status: newStatus }));
      }
    } catch (err) {
      console.error('Failed to update status', err);
      alert('Failed to update case status.');
    } finally {
      setStatusUpdating(false);
    }
  };

  const fetchGraph = useCallback(async () => {
    setFetchStatus('loading');
    setErrorMessage('');
    setNotFound(false);
    setShowCrossCaseEvidence(false);
    setFocusedGraphNodeId(null);
    setSelectedCrossCaseEvidence(null);
    setHistoricalCaseUnavailable(false);
    try {
      const res = await apiClient.get(`/cases/${encodeURIComponent(caseId)}/graph`);
      const payload = res.data?.data ?? null;
      setGraphData(payload);
      setShowCrossCaseEvidence(shouldShowCrossCaseEvidenceByDefault(payload));
      setFetchStatus('ready');
    } catch (err) {
      const errorCode = err.response?.data?.error?.code;
      if (errorCode === 'CASE_NOT_FOUND' || err.response?.status === 404) {
        setNotFound(true);
        setErrorMessage(
          err.response?.data?.error?.message ||
            `Case '${caseId}' was not found. It may not exist yet.`
        );
      } else if (
        err.response?.status === 401 ||
        errorCode === 'UNAUTHORIZED' ||
        errorCode === 'INVALID_TOKEN' ||
        errorCode === 'TOKEN_EXPIRED'
      ) {
        setErrorMessage('Your session has expired. Please sign in again.');
      } else if (err.response) {
        setErrorMessage(err.response.data?.error?.message || 'Could not load this case.');
      } else if (err.request) {
        setErrorMessage(
          'Cannot reach the server. Please check that the backend is running and try again.'
        );
      } else {
        setErrorMessage(err.message || 'Could not load this case.');
      }
      setFetchStatus('error');
    }
  }, [caseId]);

  const fetchTimeline = useCallback(async () => {
    setTimelineStatus('loading');
    setTimelineError('');
    setTimelineNotFound(false);
    try {
      const res = await apiClient.get(`/cases/${encodeURIComponent(caseId)}/timeline`);
      const payload = res.data?.data ?? null;
      const events = Array.isArray(payload?.timeline) ? payload.timeline : [];
      setTimelineEvents(events);
      setActiveTimeRange(null);
      setTimelineTotal(typeof payload?.totalEvents === 'number' ? payload.totalEvents : events.length);
      setTimelineStatus(events.length === 0 ? 'empty' : 'ready');
    } catch (err) {
      const errorCode = err.response?.data?.error?.code;
      if (errorCode === 'CASE_NOT_FOUND' || err.response?.status === 404) {
        setTimelineNotFound(true);
        setTimelineError(
          err.response?.data?.error?.message || `Case '${caseId}' was not found. It may not exist yet.`
        );
      } else if (
        err.response?.status === 401 ||
        errorCode === 'UNAUTHORIZED' ||
        errorCode === 'INVALID_TOKEN' ||
        errorCode === 'TOKEN_EXPIRED'
      ) {
        setTimelineError('Your session has expired. Please sign in again.');
      } else if (err.response) {
        setTimelineError(err.response.data?.error?.message || 'Could not load the investigation timeline.');
      } else if (err.request) {
        setTimelineError(
          'Cannot reach the server. Please check that the backend is running and try again.'
        );
      } else {
        setTimelineError(err.message || 'Could not load the investigation timeline.');
      }
      setTimelineStatus('error');
    }
  }, [caseId]);

  const fetchEntity = useCallback(
    async (entityId) => {
      if (!entityId || typeof entityId !== 'string' || !entityId.trim()) return;
      setEntityStatus('loading');
      setEntityError('');
      setEntityData(null);
      try {
        const res = await apiClient.get(
          `/cases/${encodeURIComponent(caseId)}/entities/${encodeURIComponent(entityId.trim())}`
        );
        const payload = res.data?.data ?? null;
        if (!payload?.entity) {
          setEntityStatus('empty');
          return;
        }
        setEntityData(payload);
        setEntityStatus('ready');
      } catch (err) {
        const errorCode = err.response?.data?.error?.code;
        if (err.response?.status === 401 || errorCode === 'UNAUTHORIZED' || errorCode === 'INVALID_TOKEN' || errorCode === 'TOKEN_EXPIRED') {
          setEntityError('Your session has expired. Please sign in again.');
        } else if (err.response) {
          setEntityError(err.response.data?.error?.message || 'Could not load entity details.');
        } else if (err.request) {
          setEntityError('Cannot reach the server. Please check that the backend is running and try again.');
        } else {
          setEntityError(err.message || 'Could not load entity details.');
        }
        setEntityStatus('error');
      }
    },
    [caseId]
  );

  const fetchGuardrail = useCallback(
    async (edgeId) => {
      if (!edgeId || typeof edgeId !== 'string' || !edgeId.trim()) return;
      setGuardrailFetchStatus('loading');
      setGuardrailError('');
      setGuardrailData(null);
      try {
        const res = await apiClient.get(
          `/cases/${encodeURIComponent(caseId)}/guardrail/${encodeURIComponent(edgeId.trim())}`
        );
        const payload = res.data?.data ?? null;
        if (!payload?.edge) {
          setGuardrailFetchStatus('empty');
          return;
        }
        setGuardrailData(payload);
        setGuardrailFetchStatus('ready');
      } catch (err) {
        const errorCode = err.response?.data?.error?.code;
        if (err.response?.status === 401 || errorCode === 'UNAUTHORIZED' || errorCode === 'INVALID_TOKEN' || errorCode === 'TOKEN_EXPIRED') {
          setGuardrailError('Your session has expired. Please sign in again.');
        } else if (err.response) {
          setGuardrailError(err.response.data?.error?.message || 'Could not load guardrail details.');
        } else if (err.request) {
          setGuardrailError('Cannot reach the server. Please check that the backend is running and try again.');
        } else {
          setGuardrailError(err.message || 'Could not load guardrail details.');
        }
        setGuardrailFetchStatus('error');
      }
    },
    [caseId]
  );

  const closeEntityPanel = useCallback(() => {
    setSelectedEntityId(null);
    setEntityData(null);
    setEntityError('');
    setEntityStatus('idle');
  }, []);

  const closeGuardrailPanel = useCallback(() => {
    setSelectedEdgeId(null);
    setGuardrailData(null);
    setGuardrailError('');
    setGuardrailFetchStatus('idle');
  }, []);

  const handleBackgroundClick = useCallback(() => {
    closeEntityPanel();
    closeGuardrailPanel();
    setSelectedCrossCaseEvidence(null);
    setFocusedGraphNodeId(null);
  }, [closeEntityPanel, closeGuardrailPanel]);

  const handleNodeClick = useCallback(
    (_event, node) => {
      if (node?.isHistoricalEvidence && node?.crossCaseEvidence) {
        closeEntityPanel();
        closeGuardrailPanel();
        setHistoricalCaseUnavailable(false);
        setSelectedCrossCaseEvidence(node.crossCaseEvidence);
        return;
      }
      setSelectedCrossCaseEvidence(null);
      const entityId = node?.canonicalId || node?.id;
      if (!entityId || typeof entityId !== 'string') return;
      
      // If clicking the already selected node, deselect it
      if (selectedEntityId === entityId) {
        closeEntityPanel();
        return;
      }

      closeGuardrailPanel();
      
      setSelectedEntityId(entityId);
      fetchEntity(entityId);
    },
    [fetchEntity, selectedEntityId, closeEntityPanel, closeGuardrailPanel]
  );

  const handleEdgeClick = useCallback(
    (_event, edge) => {
      if (edge?.isCrossCaseEvidence && edge?.crossCaseEvidence) {
        closeEntityPanel();
        closeGuardrailPanel();
        setHistoricalCaseUnavailable(false);
        setSelectedCrossCaseEvidence(edge.crossCaseEvidence);
        return;
      }
      setSelectedCrossCaseEvidence(null);
      const edgeId = edge?.id;
      if (!edgeId || typeof edgeId !== 'string') return;
      
      // If clicking the already selected edge, deselect it
      if (selectedEdgeId === edgeId) {
        closeGuardrailPanel();
        return;
      }

      closeEntityPanel();
      
      setSelectedEdgeId(edgeId);
      fetchGuardrail(edgeId);
    },
    [fetchGuardrail, selectedEdgeId, closeGuardrailPanel, closeEntityPanel]
  );

  const openHistoricalCase = useCallback(async (historicalCaseId) => {
    const path = caseDetailPath(historicalCaseId);
    if (!path) {
      setHistoricalCaseUnavailable(true);
      return;
    }
    setHistoricalCaseUnavailable(false);
    try {
      await apiClient.get(`${path}/graph`);
      navigate(path);
    } catch (error) {
      if (error.response?.status === 404) setHistoricalCaseUnavailable(true);
      else alert(error.response?.data?.error?.message || 'Could not open the referenced case.');
    }
  }, [navigate]);

  const handleTimelineStatusChange = useCallback((edgeId, newStatus, saved) => {
    const updateEdge = (edge) => {
      if (edge?.id !== edgeId && edge?.edgeId !== edgeId) return edge;
      return {
        ...edge,
        reviewStatus: newStatus,
        effectiveStatus: newStatus || edge.systemStatus || edge.guardrailStatus || 'unknown',
        latestNote: saved?.latestNote ?? edge.latestNote,
        reviewAudit: saved?.reviewAudit ?? edge.reviewAudit,
      };
    };
    setTimelineEvents((events) => events.map(updateEdge));
    setGraphData((current) => current ? { ...current, edges: (current.edges || []).map(updateEdge) } : current);
    setGuardrailData((current) => {
      if (!current?.edge || (current.edgeId !== edgeId && current.edge.id !== edgeId && current.edge.edgeId !== edgeId)) return current;
      return { ...current, edge: updateEdge(current.edge) };
    });

    if (saved) {
      fetchGraph();
      fetchTimeline();
      if (selectedEdgeId === edgeId) fetchGuardrail(edgeId);
    }
  }, [fetchGraph, fetchTimeline, fetchGuardrail, selectedEdgeId]);

  useEffect(() => {
    if (caseId) {
      fetchGraph();
      fetchTimeline();
    }
  }, [caseId, fetchGraph, fetchTimeline]);

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  const { getEntityName } = useEntityLookup(graphData?.nodes || []);
  const graph = useMemo(() => buildGraphPayload(graphData), [graphData]);
  const isEmptyGraph =
    fetchStatus === 'ready' && graph.flowNodes.length === 0 && graph.flowEdges.length === 0;

  // Derive min/max timestamps from events for the scrubber
  const edgeTimeBounds = useMemo(() => {
    const events = timelineEvents || [];
    const timestamps = Array.from(new Set(events
      .map(e => e.eventDate ? new Date(e.eventDate).getTime() : null)
      .filter(t => t !== null && !isNaN(t)))).sort((a, b) => a - b);
      
    if (timestamps.length === 0) return { min: null, max: null, timestamps: [] };
    if (timestamps.length === 1) return { min: timestamps[0], max: timestamps[0], timestamps };
    return { min: timestamps[0], max: timestamps[timestamps.length - 1], timestamps };
  }, [timelineEvents]);

  return (
    <div className="min-h-screen bg-[#fafafa]">
      {/* Nav bar */}
      <header className="h-16 bg-white border-b border-[#ebebeb] flex items-center justify-between px-6">
        <Link to="/cases" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <svg className="h-6 w-6 text-[#171717]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <span className="font-sans text-lg font-bold tracking-tight text-[#171717]">
            Trace-X
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-sm text-[#4d4d4d]">
            {user?.username ? `Signed in as ${user.username}` : ''}
          </span>
          <button
            onClick={handleLogout}
            className="h-7 rounded-md border border-[#ebebeb] bg-white px-2 text-sm font-medium text-[#171717] hover:bg-[#f5f5f5]"
          >
            Log out
          </button>
        </div>
      </header>

      <main
        className="mx-auto w-full max-w-6xl px-4 py-10"
        style={{ minHeight: 'calc(100vh - 64px)' }}
      >
        <button
          onClick={() => navigate('/cases')}
          className="h-7 rounded-md border border-[#ebebeb] bg-white px-2 text-sm font-medium text-[#171717] transition-colors hover:bg-[#f5f5f5]"
        >
          ← Back to cases
        </button>

        <h2 className="mt-6 text-2xl font-bold tracking-tight text-[#171717]">
          Investigation Workspace
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold leading-7 tracking-[-0.6px] text-[#171717]">
            {graphData?.title ? graphData.title : <span className="font-mono">{caseId}</span>}
          </h1>
          {graphData?.title && (
            <span className="font-mono text-sm text-[#888888]">({caseId})</span>
          )}
          {graphData?.metadata?.category && (
            <span className="inline-flex items-center rounded-full bg-[#f3f4f6] px-2.5 py-0.5 text-xs font-medium text-[#374151]">
              {graphData.metadata.category}
            </span>
          )}
          {fetchStatus === 'ready' && !isEmptyGraph && (
            <StatusBadge status={graphData?.status === 'closed' ? 'closed' : 'open'} />
          )}
          {fetchStatus === 'ready' && !isEmptyGraph && (
            <button
              onClick={toggleCaseStatus}
              disabled={statusUpdating}
              className="ml-auto h-8 rounded-md bg-[#171717] px-3 text-sm font-medium text-white transition-colors hover:bg-black disabled:opacity-60"
            >
              {graphData?.status === 'closed' ? 'Reopen case' : 'Close case'}
            </button>
          )}
        </div>
        <p className="mt-1 text-sm leading-5 tracking-[-0.28px] text-[#4d4d4d]">
          Entity relationship graph reconstructed from ingested evidence.
        </p>

        {(fetchStatus === 'loading') && (
          <section
            aria-label="Loading case graph"
            className="mt-8 rounded-xl bg-white px-6 py-8"
            style={{ boxShadow: CARD_SHADOW }}
          >
            <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">
              Loading graph…
            </p>
            <div className="mt-5 flex flex-wrap gap-4">
              {[0, 1, 2, 3].map((item) => (
                <div key={item} className="h-16 w-40 animate-pulse rounded-md bg-[#f5f5f5]" />
              ))}
            </div>
          </section>
        )}

        {fetchStatus === 'error' && (
          <section className="mt-8 rounded-xl bg-white px-6 py-8" style={{ boxShadow: CARD_SHADOW }}>
            <div className="rounded-md bg-[#f7d4d6] px-3 py-2 text-sm text-[#c50000]" role="alert">
              {errorMessage}
            </div>
            <div className="mt-4 flex items-center gap-3">
              {!notFound && (
                <button
                  onClick={fetchGraph}
                  className="h-8 rounded-md bg-[#171717] px-3 text-sm font-medium text-white transition-colors hover:bg-black"
                >
                  Retry
                </button>
              )}
              <button
                onClick={() => navigate('/cases')}
                className="h-8 rounded-md border border-[#ebebeb] bg-white px-3 text-sm font-medium text-[#171717] transition-colors hover:bg-[#f5f5f5]"
              >
                Back to cases
              </button>
            </div>
          </section>
        )}

        {fetchStatus === 'ready' && graphData?.textReports?.length > 0 && (
          <section className="mt-8 rounded-xl bg-white px-6 py-5" style={{ boxShadow: CARD_SHADOW }} aria-label="Case source material">
            {Array.isArray(graphData.textReports) && graphData.textReports.length > 0 && (
              <details>
                <summary className="cursor-pointer font-mono text-xs uppercase tracking-wide text-[#888888]">Original FIR / reports · {graphData.textReports.length}</summary>
                <div className="mt-3 space-y-3">{graphData.textReports.map((report, index) => (
                  <p key={index} className="whitespace-pre-wrap rounded-md bg-[#fafafa] px-4 py-3 text-sm leading-6 text-[#4d4d4d]">{report}</p>
                ))}</div>
              </details>
            )}
          </section>
        )}

        {isEmptyGraph && (
          <section
            className="mt-8 rounded-xl bg-[#fafafa] px-8 py-16 text-center"
            style={{ boxShadow: CARD_SHADOW }}
          >
            <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">
              No graph yet
            </p>
            <h2 className="mt-3 text-lg font-semibold tracking-[-0.4px] text-[#171717]">
              This case has no entities or relationships yet.
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-[#4d4d4d]">
              Once evidence is processed for this case, its investigation graph will appear here.
            </p>
          </section>
        )}

        {fetchStatus === 'ready' && !isEmptyGraph && (
          <>
            {graph.unmappedNodes.length > 0 && (
              <div
                className="mt-8 rounded-md bg-[#ffefcf] px-3 py-2 text-sm text-[#ab570a]"
                role="status"
              >
                Graph data could not be fully mapped: {graph.unmappedNodes.join('; ')}
              </div>
            )}
            {graph.unmappedEdges.length > 0 && (
              <div
                className="mt-8 rounded-md bg-[#ffefcf] px-3 py-2 text-sm text-[#ab570a]"
                role="status"
              >
                Some relationships were excluded because they reference entities outside this
                graph: {graph.unmappedEdges.join('; ')}
              </div>
            )}

            <CrossCaseRecurrenceAlert
              patterns={graphData?.patterns || []}
              nodes={graphData?.nodes || []}
              navigate={navigate}
              currentCaseId={caseId}
              onHighlightMatch={(canonicalId) => {
                setShowCrossCaseEvidence(true);
                setFocusedGraphNodeId(canonicalId);
              }}
            />

            <ManualRelationshipForm
              caseId={caseId}
              nodes={graphData?.nodes || []}
              onCreated={(savedEdge) => {
                setGraphData((current) => current ? { ...current, edges: [...(current.edges || []), savedEdge] } : current);
                setTimelineEvents((current) => [...current, savedEdge]);
                fetchGraph();
                fetchTimeline();
              }}
            />

            <section
              className="mt-8 overflow-hidden rounded-xl bg-white"
              style={{ boxShadow: CARD_SHADOW }}
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ebebeb] px-6 py-3">
                <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">
                  GET /api/cases/:caseId/graph
                </p>
                <div className="flex flex-wrap items-center gap-4">
                  <GraphEvidenceToggle
                    available={Boolean(graphData?.crossCaseEvidence?.length)}
                    shown={showCrossCaseEvidence}
                    onChange={(shown) => {
                      setShowCrossCaseEvidence(shown);
                      if (!shown) {
                        setFocusedGraphNodeId(null);
                        setSelectedCrossCaseEvidence(null);
                      }
                    }}
                  />
                  <p className="hidden font-mono text-xs text-[#888888] sm:block">
                    {graph.flowNodes.length} entities · {graph.flowEdges.length} relationships
                  </p>
                </div>
              </div>
              <div className="h-[560px] w-full">
                <NetworkGraph 
                  graphData={{ nodes: graphData?.nodes || [], edges: graphData?.edges || [], crossCaseEvidence: graphData?.crossCaseEvidence || [] }}
                  onNodeClick={(id, node) => handleNodeClick(null, node || { id })}
                  onEdgeClick={(id, edge) => handleEdgeClick(null, edge || { id })}
                  onBackgroundClick={handleBackgroundClick}
                  activeTimeRange={activeTimeRange}
                  currentCaseId={caseId}
                  selectedEdgeId={selectedEdgeId}
                  showCrossCaseEvidence={showCrossCaseEvidence}
                  focusedNodeId={focusedGraphNodeId}
                />
              </div>
              <CrossCaseEvidenceDetail
                evidence={selectedCrossCaseEvidence}
                unavailable={historicalCaseUnavailable}
                onOpenCase={openHistoricalCase}
                onClose={() => setSelectedCrossCaseEvidence(null)}
              />
              {edgeTimeBounds && (
                <TimelineScrubber
                  bounds={edgeTimeBounds}
                  activeRange={activeTimeRange}
                  onChange={setActiveTimeRange}
                />
              )}
            </section>
          </>
        )}

        {fetchStatus === 'ready' && (
          <section className="mt-8 overflow-hidden rounded-xl bg-white" style={{ boxShadow: CARD_SHADOW }}>
            <div className="flex items-center justify-between border-b border-[#ebebeb] px-6 py-3">
              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">
                Investigation timeline
              </p>
              {timelineStatus === 'ready' ? (
                <p className="hidden font-mono text-xs text-[#888888] sm:block">{timelineTotal} events</p>
              ) : (
                <p className="hidden font-mono text-xs text-[#888888] sm:block">
                  GET /api/cases/:caseId/timeline
                </p>
              )}
            </div>

            {timelineStatus === 'loading' && (
              <div className="px-6 py-8">
                <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Loading timeline…</p>
                <div className="mt-5 space-y-3">
                  {[0, 1, 2].map((item) => (
                    <div key={item} className="flex gap-4">
                      <div className="h-12 w-32 animate-pulse rounded-md bg-[#f5f5f5]" />
                      <div className="h-12 flex-1 animate-pulse rounded-md bg-[#f5f5f5]" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {timelineStatus === 'error' && (
              <div className="px-6 py-6">
                <div className="rounded-md bg-[#f7d4d6] px-3 py-2 text-sm text-[#c50000]" role="alert">
                  {timelineError}
                </div>
                <div className="mt-4 flex items-center gap-3">
                  {!timelineNotFound && (
                    <button
                      onClick={fetchTimeline}
                      className="h-8 rounded-md bg-[#171717] px-3 text-sm font-medium text-white transition-colors hover:bg-black"
                    >
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => navigate('/cases')}
                    className="h-8 rounded-md border border-[#ebebeb] bg-white px-3 text-sm font-medium text-[#171717] transition-colors hover:bg-[#f5f5f5]"
                  >
                    Back to cases
                  </button>
                </div>
              </div>
            )}

            {timelineStatus === 'empty' && (
              <div className="px-8 py-12 text-center">
                <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">No dated investigation events</p>
                <h3 className="mt-3 text-base font-semibold tracking-[-0.28px] text-[#171717]">
                  No dated interactions recorded.
                </h3>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-[#4d4d4d]">
                  Interactions will appear here once evidence is processed for this case.
                </p>
              </div>
            )}

            {timelineStatus === 'ready' && (
              <>
                <ol className="divide-y divide-[#ebebeb] bg-[#fafafa]">
                  {timelineEvents.filter(e => e.eventDate).map((event, index) => (
                    <TimelineEventRow 
                      key={event.id || index} 
                      event={event} 
                      index={index} 
                      getEntityName={getEntityName} 
                      caseId={caseId}
                      onStatusChange={handleTimelineStatusChange}
                      onClick={() => {
                        if (event.id || event.edgeId) {
                          handleEdgeClick(null, { id: event.id || event.edgeId });
                        }
                      }}
                    />
                  ))}
                </ol>
                {timelineEvents.filter(e => !e.eventDate).length > 0 && (
                  <details open className="mt-8 border-t border-[#ebebeb]">
                    <summary className="cursor-pointer bg-white px-6 py-4 font-mono text-xs uppercase tracking-wide text-[#888888]">
                      Undated evidence · {timelineEvents.filter(e => !e.eventDate).length}
                    </summary>
                    <ol className="divide-y divide-[#ebebeb] bg-[#fafafa]">
                      {timelineEvents.filter(e => !e.eventDate).map((event, index) => (
                        <TimelineEventRow 
                          key={`undated-${event.id || index}`} 
                          event={event} 
                          index={index} 
                          getEntityName={getEntityName} 
                          caseId={caseId}
                          onStatusChange={handleTimelineStatusChange}
                          onClick={() => {
                            if (event.id || event.edgeId) {
                              handleEdgeClick(null, { id: event.id || event.edgeId });
                            }
                          }}
                        />
                      ))}
                    </ol>
                  </details>
                )}
              </>
            )}
          </section>
        )}
        {selectedEntityId && (
          <section
            className="mt-8 overflow-hidden rounded-xl bg-white"
            style={{ boxShadow: CARD_SHADOW }}
            aria-label="Entity detail"
          >
            <div className="flex items-center justify-between border-b border-[#ebebeb] px-6 py-3">
              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Entity detail</p>
              <button
                onClick={closeEntityPanel}
                className="h-7 rounded-md border border-[#ebebeb] bg-white px-2 text-sm font-medium text-[#171717] transition-colors hover:bg-[#f5f5f5]"
              >
                Close
              </button>
            </div>

            {entityStatus === 'loading' && (
              <div className="px-6 py-8">
                <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Loading entity…</p>
                <div className="mt-5 space-y-3">
                  <div className="h-4 w-32 animate-pulse rounded-md bg-[#f5f5f5]" />
                  <div className="h-4 w-full animate-pulse rounded-md bg-[#f5f5f5]" />
                  <div className="h-4 w-3/4 animate-pulse rounded-md bg-[#f5f5f5]" />
                </div>
              </div>
            )}

            {entityStatus === 'error' && (
              <div className="px-6 py-6">
                {(() => {
                  const fallbackEntity = (graphData?.nodes || []).find(n => n.canonicalId === selectedEntityId || n.id === selectedEntityId);
                  if (fallbackEntity) {
                    return (
                      <div className="rounded-md border border-[#ebebeb] bg-[#fafafa] p-4">
                        <div className="mb-4 flex items-center justify-between border-b border-[#ebebeb] pb-3">
                          <div>
                            <span className="inline-flex items-center rounded-full bg-[#fef08a] px-2 py-0.5 font-mono text-xs font-semibold text-[#854d0e]">
                              Partial Data
                            </span>
                            <p className="mt-1 font-mono text-xs uppercase tracking-wide text-[#888888]">Cross-case API Fetch Failed</p>
                          </div>
                        </div>
                        <div className="space-y-4">
                          <div>
                            <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Type</p>
                            <p className="mt-1 text-sm text-[#171717]">{fallbackEntity.type || 'Unknown'}</p>
                          </div>
                          {Array.isArray(fallbackEntity.aliases) && fallbackEntity.aliases.length > 0 && (
                            <div>
                              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Aliases</p>
                              <ul className="mt-1 space-y-1">
                                {fallbackEntity.aliases.map((alias, idx) => (
                                  <li key={idx} className="font-mono text-sm text-[#4d4d4d]">{alias}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <div className="mt-4 pt-4 border-t border-[#ebebeb] flex items-center gap-3">
                            <button onClick={() => fetchEntity(selectedEntityId)} className="h-8 rounded-md bg-[#171717] px-3 text-sm font-medium text-white transition-colors hover:bg-black">
                              Retry Full Fetch
                            </button>
                            <button onClick={closeEntityPanel} className="h-8 rounded-md border border-[#ebebeb] bg-white px-3 text-sm font-medium text-[#171717] transition-colors hover:bg-[#f5f5f5]">
                              Close
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  
                  return (
                    <>
                      <div className="rounded-md bg-[#f7d4d6] px-3 py-2 text-sm text-[#c50000]" role="alert">
                        {entityError}
                      </div>
                      <div className="mt-4 flex items-center gap-3">
                        <button
                          onClick={() => fetchEntity(selectedEntityId)}
                          className="h-8 rounded-md bg-[#171717] px-3 text-sm font-medium text-white transition-colors hover:bg-black"
                        >
                          Retry
                        </button>
                        <button
                          onClick={closeEntityPanel}
                          className="h-8 rounded-md border border-[#ebebeb] bg-white px-3 text-sm font-medium text-[#171717] transition-colors hover:bg-[#f5f5f5]"
                        >
                          Close
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {entityStatus === 'empty' && (
              <div className="px-8 py-12 text-center">
                <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">No entity data</p>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-[#4d4d4d]">
                  No details were returned for this entity.
                </p>
              </div>
            )}

            {entityStatus === 'ready' && entityData?.entity && (
              <div className="px-6 py-6">
                <div className="space-y-5">
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Canonical ID</p>
                    <p className="mt-1 break-all font-mono text-sm font-medium text-[#171717]">
                      {entityData.entity.canonicalId}
                    </p>
                  </div>
                  {typeof entityData.entity.type === 'string' && entityData.entity.type.trim() && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Type</p>
                      <p className="mt-1 text-sm text-[#171717]">{entityData.entity.type}</p>
                    </div>
                  )}
                  {typeof entityData.entity.confidence === 'number' && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Confidence</p>
                      <p className="mt-1 font-mono text-sm text-[#171717]">{entityData.entity.confidence}</p>
                    </div>
                  )}
                  {Array.isArray(entityData.entity.aliases) && entityData.entity.aliases.length > 0 && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Aliases</p>
                      <ul className="mt-1 space-y-1">
                        {entityData.entity.aliases.map((alias, idx) => (
                          <li key={`${alias}-${idx}`} className="font-mono text-sm text-[#4d4d4d]">
                            {alias}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {entityData.entity.attributes &&
                    typeof entityData.entity.attributes === 'object' &&
                    Object.keys(entityData.entity.attributes).length > 0 && (
                      <div>
                        <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Attributes</p>
                        <FriendlyFields values={entityData.entity.attributes} />
                      </div>
                    )}
                  {entityData.entity.createdAt && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Created</p>
                      <p className="mt-1 font-mono text-xs text-[#4d4d4d]">
                        {formatTimelineTimestamp(entityData.entity.createdAt) ?? String(entityData.entity.createdAt)}
                      </p>
                    </div>
                  )}
                  {entityData.entity.updatedAt && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Updated</p>
                      <p className="mt-1 font-mono text-xs text-[#4d4d4d]">
                        {formatTimelineTimestamp(entityData.entity.updatedAt) ?? String(entityData.entity.updatedAt)}
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">
                      Related edges ·{' '}
                      {Array.isArray(entityData.relatedEdges) ? entityData.relatedEdges.length : 0}
                    </p>
                    {Array.isArray(entityData.relatedEdges) && entityData.relatedEdges.length === 0 ? (
                      <p className="mt-2 text-sm text-[#4d4d4d]">No related relationships.</p>
                    ) : (
                      <ol className="mt-3 divide-y divide-[#ebebeb] overflow-hidden rounded-md border border-[#ebebeb]">
                        {entityData.relatedEdges.map((edge) => {
                          const edgeKey = typeof edge?.id === 'string' ? edge.id : `${edge?.source}-${edge?.target}`;
                          const edgeSource = typeof edge?.source === 'string' ? edge.source : '';
                          const edgeTarget = typeof edge?.target === 'string' ? edge.target : '';
                          const edgeType = typeof edge?.edgeType === 'string' ? edge.edgeType : '';
                          const edgeTs = formatTimelineTimestamp(edge?.timestamp);
                          return (
                            <li key={edgeKey} className="bg-white px-3 py-2">
                              <p className="truncate font-mono text-xs text-[#171717]" title={`${edgeSource} → ${edgeTarget}`}>
                                {edgeSource && edgeTarget ? (
                                  <>
                                    {edgeSource} <span className="text-[#a1a1a1]">→</span> {edgeTarget}
                                  </>
                                ) : (
                                  edgeSource || edgeTarget || '—'
                                )}
                              </p>
                              {(edgeType || edgeTs) && (
                                <p className="mt-0.5 font-mono text-xs uppercase tracking-wide text-[#888888]">
                                  {edgeType && <span>{edgeType}</span>}
                                  {edgeType && edgeTs && <span className="mx-1 text-[#ebebeb]">·</span>}
                                  {edgeTs && <span>{edgeTs}</span>}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}
        {selectedEdgeId && (
          <section
            className="mt-8 overflow-hidden rounded-xl bg-white"
            style={{ boxShadow: CARD_SHADOW }}
            aria-label="Guardrail detail"
          >
            <div className="flex items-center justify-between border-b border-[#ebebeb] px-6 py-3">
              <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Guardrail &amp; evidence</p>
              <button
                onClick={closeGuardrailPanel}
                className="h-7 rounded-md border border-[#ebebeb] bg-white px-2 text-sm font-medium text-[#171717] transition-colors hover:bg-[#f5f5f5]"
              >
                Close
              </button>
            </div>

            {guardrailFetchStatus === 'loading' && (
              <div className="px-6 py-8">
                <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Loading guardrail…</p>
                <div className="mt-5 space-y-3">
                  <div className="h-4 w-32 animate-pulse rounded-md bg-[#f5f5f5]" />
                  <div className="h-4 w-full animate-pulse rounded-md bg-[#f5f5f5]" />
                  <div className="h-4 w-3/4 animate-pulse rounded-md bg-[#f5f5f5]" />
                </div>
              </div>
            )}

            {guardrailFetchStatus === 'error' && (
              <div className="px-6 py-6">
                <div className="rounded-md bg-[#f7d4d6] px-3 py-2 text-sm text-[#c50000]" role="alert">
                  {guardrailError}
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    onClick={() => fetchGuardrail(selectedEdgeId)}
                    className="h-8 rounded-md bg-[#171717] px-3 text-sm font-medium text-white transition-colors hover:bg-black"
                  >
                    Retry
                  </button>
                  <button
                    onClick={closeGuardrailPanel}
                    className="h-8 rounded-md border border-[#ebebeb] bg-white px-3 text-sm font-medium text-[#171717] transition-colors hover:bg-[#f5f5f5]"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}

            {guardrailFetchStatus === 'empty' && (
              <div className="px-8 py-12 text-center">
                <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">No guardrail data</p>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-[#4d4d4d]">
                  No details were returned for this relationship.
                </p>
              </div>
            )}

            {guardrailFetchStatus === 'ready' && guardrailData?.edge && (
              <div className="px-6 py-6">
                <div className="space-y-5">
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Edge ID</p>
                    <p className="mt-1 break-all font-mono text-sm font-medium text-[#171717]">
                      {guardrailData.edgeId || selectedEdgeId}
                    </p>
                  </div>
                  {(typeof guardrailData.edge.source === 'string' || typeof guardrailData.edge.target === 'string') && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Source → Target</p>
                      <p className="mt-1 truncate font-mono text-sm text-[#171717]" title={`${guardrailData.edge.source ?? ''} → ${guardrailData.edge.target ?? ''}`}>
                        {guardrailData.edge.source && guardrailData.edge.target ? (
                          <>
                            {getEntityName(guardrailData.edge.source)} <span className="text-[#a1a1a1]">→</span> {getEntityName(guardrailData.edge.target)}
                          </>
                        ) : (
                          guardrailData.edge.source || guardrailData.edge.target || '—'
                        )}
                      </p>
                    </div>
                  )}
                  {typeof guardrailData.edge.edgeType === 'string' && guardrailData.edge.edgeType.trim() && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Edge type</p>
                      <p className="mt-1 text-sm text-[#171717]">{guardrailData.edge.edgeType}</p>
                    </div>
                  )}
                  {typeof guardrailData.edge.confidence === 'number' && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Confidence</p>
                      <p className="mt-1 font-mono text-sm text-[#171717]">{guardrailData.edge.confidence}</p>
                    </div>
                  )}
                  {(guardrailData.edge.eventDate || guardrailData.edge.eventTime) && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Event date and time</p>
                      <p className="mt-1 font-mono text-xs text-[#4d4d4d]">
                        {[guardrailData.edge.eventDate, guardrailData.edge.eventTime].filter(Boolean).join(' ')}
                      </p>
                    </div>
                  )}
                  {typeof guardrailData.edge.originalStatus === 'string' && guardrailData.edge.originalStatus.trim() && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Original model status</p>
                      <p className="mt-1 font-mono text-sm text-[#171717]">{guardrailData.edge.originalStatus}</p>
                    </div>
                  )}
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Effective Status</p>
                    <div className="mt-2">
                      <StatusBadge status={guardrailData.edge.effectiveStatus || 'unknown'} />
                    </div>
                  </div>
                  <div>
                    <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Manual Review Status</p>
                    <div className="mt-2 max-w-xs">
                      <EdgeReviewDropdown
                        caseId={caseId}
                        edgeId={guardrailData.edgeId || selectedEdgeId}
                        currentStatus={guardrailData.edge.reviewStatus || guardrailData.edge.effectiveStatus || guardrailData.edge.originalStatus || 'unknown'}
                        onStatusChange={(newStatus, saved) => {
                          setGuardrailData(prev => ({
                            ...prev,
                            edge: { ...prev.edge, reviewStatus: newStatus, effectiveStatus: newStatus, latestNote: saved?.latestNote, reviewAudit: saved?.reviewAudit || prev.edge.reviewAudit }
                          }));
                          // also update graph data if needed
                          setGraphData(prev => {
                            if (!prev) return prev;
                            return {
                              ...prev,
                              edges: prev.edges.map(e => e.id === (guardrailData.edgeId || selectedEdgeId) ? { ...e, reviewStatus: newStatus } : e)
                            };
                          });
                          if (saved) {
                            fetchGraph();
                            fetchGuardrail(guardrailData.edgeId || selectedEdgeId);
                          }
                        }}
                      />
                    </div>
                  </div>
                  {typeof guardrailData.edge.guardrailRationale === 'string' && guardrailData.edge.guardrailRationale.trim() && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Verification</p>
                      <p className="mt-1 text-sm leading-5 text-[#4d4d4d]">{guardrailData.edge.guardrailRationale}</p>
                    </div>
                  )}
                  {guardrailData.edge.relationReason && (
                    <div><p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Relationship reason</p><p className="mt-1 text-sm text-[#4d4d4d]">{guardrailData.edge.relationReason}</p></div>
                  )}
                  {guardrailData.edge.latestNote && (
                    <div><p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Latest investigator note</p><p className="mt-1 text-sm text-[#4d4d4d]">{guardrailData.edge.latestNote}</p></div>
                  )}
                  {Array.isArray(guardrailData.edge.reviewAudit) && guardrailData.edge.reviewAudit.length > 0 && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Audit history</p>
                      <ol className="mt-2 space-y-2">{guardrailData.edge.reviewAudit.map((entry, index) => (
                        <li key={`${entry.reviewedAt}-${index}`} className="rounded-md border border-[#ebebeb] bg-[#fafafa] px-3 py-2 text-sm text-[#4d4d4d]">
                          <span className="font-medium text-[#171717]">{friendlyLabel(entry.previousStatus)} → {friendlyLabel(entry.newStatus)}</span>
                          {entry.note ? ` — ${entry.note}` : ''}
                          <span className="mt-1 block font-mono text-xs text-[#888888]">{entry.reviewedBy || 'Investigator'} · {formatTimelineTimestamp(entry.reviewedAt) || entry.reviewedAt}</span>
                        </li>
                      ))}</ol>
                    </div>
                  )}
                  {guardrailData.edge.attributes && typeof guardrailData.edge.attributes === 'object' && Object.keys(guardrailData.edge.attributes).length > 0 && (
                    <div>
                      <p className="font-mono text-xs uppercase tracking-wide text-[#888888]">Attributes</p>
                      <FriendlyFields values={guardrailData.edge.attributes} />
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        )}
        {fetchStatus === 'ready' && graphData?.similarCaseLeads && graphData.similarCaseLeads.length > 0 && (
          <SimilarCasesPanel 
            leads={graphData.similarCaseLeads} 
            navigate={navigate}
            currentCaseId={caseId}
            onUpdateLeadStatus={(matchedCaseId, status) => {
              setGraphData(prev => {
                if (!prev) return prev;
                return {
                  ...prev,
                  similarCaseLeads: prev.similarCaseLeads.map(l => 
                    l.matchedCaseId === matchedCaseId 
                      ? { ...l, investigatorStatus: status } 
                      : l
                  )
                };
              });
            }}
          />
        )}
      </main>
    </div>
  );
}
