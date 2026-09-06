import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';
import apiClient from '../api/apiClient';
import { 
  SimilarCasesPanel, 
  TimelineEventRow, 
  TimelineScrubber, 
  EdgeReviewDropdown,
  ManualRelationshipForm,
  CrossCaseRecurrenceAlert,
} from '../pages/CaseDetailPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Mock apiClient to prevent real API calls in EdgeReviewDropdown
vi.mock('../api/apiClient', () => ({
  default: {
    patch: vi.fn().mockResolvedValue({ data: { success: true, data: { reviewAudit: [] } } }),
    post: vi.fn().mockResolvedValue({ data: { success: true } })
  }
}));

describe('CaseDetailPage Components', () => {
  it('renders exact recurrence identifiers and navigates with the real logical caseId', () => {
    const navigate = vi.fn();
    render(<CrossCaseRecurrenceAlert
      currentCaseId="ALPHA-NEW"
      navigate={navigate}
      nodes={[{ canonicalId: 'phone:9050011122', aliases: ['9050011122'] }]}
      patterns={[{
        patternType: 'cross_case_recurrence',
        metadata: {
          exactMatches: [{
            canonicalId: 'phone:9050011122', type: 'phone',
            historicalCases: [{ caseId: 'ALPHA-01', available: true }],
          }],
        },
      }]}
    />);

    expect(screen.getByRole('alert', { name: 'Cross-case recurrence' })).toBeDefined();
    expect(screen.getByText('phone:9050011122')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Open case ALPHA-01' }));
    expect(navigate).toHaveBeenCalledWith('/cases/ALPHA-01');
    expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining('undefined'));
  });

  it('handles an unavailable historical recurrence reference without navigation', () => {
    const navigate = vi.fn();
    render(<CrossCaseRecurrenceAlert
      currentCaseId="ALPHA-NEW"
      navigate={navigate}
      nodes={[]}
      patterns={[{
        patternType: 'cross_case_recurrence',
        metadata: {
          exactMatches: [{
            canonicalId: 'vehicle:WB19R8842', type: 'vehicle',
            historicalCases: [{ caseId: 'ALPHA-03', available: false }],
          }],
        },
      }]}
    />);

    expect(screen.getByText('ALPHA-03: Referenced case unavailable')).toBeDefined();
    expect(screen.queryByRole('button', { name: /ALPHA-03/ })).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates using matchedCaseId and never an undefined fallback', async () => {
    const leads = [
      { matchedCaseId: 'CASE-123', status: 'similar_case_lead', similarityScore: 0.85, rationale: 'Similar patterns' }
    ];
    const navigateMock = vi.fn();
    render(<BrowserRouter><SimilarCasesPanel leads={leads} navigate={navigateMock} currentCaseId="CASE-999" /></BrowserRouter>);
    
    expect(screen.getByText('CASE-123')).toBeDefined();
    expect(screen.getByText('85% Match')).toBeDefined();
    expect(screen.getByText('Similar patterns')).toBeDefined();
    
    const button = screen.getByRole('button', { name: /open case/i });
    fireEvent.click(button);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/cases/CASE-123'));
    
    // NO dropdown for score < 0.90
    expect(screen.queryByLabelText(/Investigator Status/i)).toBeNull();
  });

  it('handles an unavailable matched case safely', async () => {
    apiClient.post.mockRejectedValueOnce({ response: { status: 404 } });
    render(<BrowserRouter><SimilarCasesPanel leads={[{ matchedCaseId: 'MISSING', similarityScore: 0.8 }]} navigate={vi.fn()} currentCaseId="CASE-1" /></BrowserRouter>);
    fireEvent.click(screen.getByRole('button', { name: /open case/i }));
    expect(await screen.findByText('The referenced case is unavailable')).toBeDefined();
  });

  it('renders SimilarCasesPanel with gated dropdown for score >= 0.90', () => {
    const leads = [
      { matchedCaseId: 'CASE-124', status: 'possible_connection', similarityScore: 0.95, rationale: 'High match' }
    ];
    render(<BrowserRouter><SimilarCasesPanel leads={leads} navigate={vi.fn()} currentCaseId="CASE-456" /></BrowserRouter>);
    
    expect(screen.getByText('Investigator Status')).toBeDefined();
    expect(screen.getByRole('option', { name: 'Verified' }).disabled).toBe(true);
  });

  it('renders null when SimilarCasesPanel has no leads', () => {
    const { container } = render(<SimilarCasesPanel leads={[]} navigate={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders TimelineEventRow correctly', () => {
    const event = {
      id: 'e1',
      eventDate: '2023-10-01',
      eventTime: '12:00',
      eventTypeLabel: 'Phone Call',
      relationReason: 'Contacted',
      dateConfidence: 'High',
      source: 'P1',
      target: 'P2',
      displayConnectionType: 'verified'
    };
    const getEntityName = (id) => `Entity ${id}`;
    
    render(<TimelineEventRow event={event} index={0} getEntityName={getEntityName} onClick={vi.fn()} />);
    
    expect(screen.getByText(/2023-10-01/i)).toBeDefined();
    expect(screen.getByText(/12:00/i)).toBeDefined();
    expect(screen.getByText('Confidence: High')).toBeDefined();
    expect(screen.getByText('Phone Call')).toBeDefined();
    expect(screen.getByText(/Entity P1/i)).toBeDefined();
    expect(screen.getByText(/Entity P2/i)).toBeDefined();
  });

  it('offers the persisted manual relationship control inside an expanded timeline row', async () => {
    const onStatusChange = vi.fn();
    const event = {
      id: 'edge-1', edgeId: 'edge-1', source: 'P1', target: 'P2', edgeType: 'shared_address',
      reviewStatus: 'possible_connection', effectiveStatus: 'possible_connection', evidence: [],
    };
    render(
      <TimelineEventRow
        event={event}
        index={0}
        getEntityName={(id) => id}
        caseId="CASE-1"
        onStatusChange={onStatusChange}
      />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Investigator relationship status')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Investigator note'), { target: { value: 'Confirmed from field review' } });
    fireEvent.change(screen.getByLabelText('Relationship status'), { target: { value: 'verified' } });
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith(
      '/cases/CASE-1/relationships/edge-1/status',
      { status: 'verified', reason: 'Confirmed from field review' }
    ));
    expect(onStatusChange).toHaveBeenCalledWith('edge-1', 'verified', expect.anything());
  });

  it('renders TimelineScrubber gracefully for one date', () => {
    const bounds = { min: 1000, max: 1000, timestamps: [1000] };
    render(<TimelineScrubber bounds={bounds} activeRange={null} onChange={vi.fn()} />);
    expect(screen.getByText('Only one dated event is available.')).toBeDefined();
    expect(screen.getByRole('slider').getAttribute('aria-disabled')).toBe('true');
  });

    it('TimelineScrubber supports keyboard and snaps to real dates', () => {
      const bounds = { min: 1000, max: 5000, timestamps: [1000, 3000, 5000] };
      const onChangeMock = vi.fn();
      render(<TimelineScrubber bounds={bounds} activeRange={null} onChange={onChangeMock} />);
      const slider = screen.getByRole('slider');
      fireEvent.keyDown(slider, { key: 'ArrowLeft' });
      expect(onChangeMock).toHaveBeenCalledWith({ start: new Date(1000).toISOString(), end: new Date(3000).toISOString() });
    });

    it('TimelineScrubber supports track click and pointer/touch-style drag', () => {
      const bounds = { min: 1000, max: 5000, timestamps: [1000, 3000, 5000] };
      const onChangeMock = vi.fn();
      render(<TimelineScrubber bounds={bounds} activeRange={null} onChange={onChangeMock} />);
      const slider = screen.getByRole('slider');
      slider.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 20, height: 20 });
      fireEvent.click(slider, { clientX: 50 });
      expect(onChangeMock).toHaveBeenCalledWith({ start: new Date(1000).toISOString(), end: new Date(3000).toISOString() });
      fireEvent(slider, new MouseEvent('pointerdown', { bubbles: true, clientX: 0 }));
      fireEvent(slider, new MouseEvent('pointermove', { bubbles: true, clientX: 100 }));
      fireEvent(slider, new MouseEvent('pointerup', { bubbles: true, clientX: 100 }));
      expect(onChangeMock).toHaveBeenCalledWith({ start: new Date(1000).toISOString(), end: new Date(5000).toISOString() });
    });

    it('TimelineScrubber gives uneven dates evenly spaced slider stops', () => {
      const bounds = { min: 1000, max: 10000, timestamps: [1000, 2000, 3000, 10000] };
      const onChangeMock = vi.fn();
      render(<TimelineScrubber bounds={bounds} activeRange={null} onChange={onChangeMock} />);
      const slider = screen.getByRole('slider');
      slider.getBoundingClientRect = () => ({ left: 0, width: 90, right: 90, top: 0, bottom: 20, height: 20 });

      fireEvent.click(slider, { clientX: 60 });

      expect(onChangeMock).toHaveBeenCalledWith({
        start: new Date(1000).toISOString(),
        end: new Date(3000).toISOString(),
      });
    });

    it('reports no dated events without hiding undated evidence data', () => {
      render(<TimelineScrubber bounds={{ min: null, max: null, timestamps: [] }} activeRange={null} onChange={vi.fn()} />);
      expect(screen.getByText('No dated investigation events')).toBeDefined();
    });

    it('renders EdgeReviewDropdown with correct statuses', () => {
      const onChangeMock = vi.fn();
      render(<EdgeReviewDropdown caseId="C1" edgeId="E1" currentStatus="unverified" onStatusChange={onChangeMock} />);
      
      const select = screen.getByRole('combobox');
      expect(select.disabled).toBe(false);
      const options = Array.from(select.options).map(o => o.value);
      expect(options).toEqual(['verified', 'possible_connection', 'cross_connection', 'unverified', 'unknown']);
      fireEvent.change(select, { target: { value: 'verified' } });
      expect(screen.getByText('Enter an investigator note before saving a new status.')).toBeDefined();
      expect(apiClient.patch).not.toHaveBeenCalled();
    });

    it('creates a custom investigator relationship between two existing nodes', async () => {
      const savedEdge = {
        id: 'manual-1', source: 'person:a', target: 'account:b', edgeType: 'transferred_funds_to',
        reviewStatus: 'verified', effectiveStatus: 'verified',
      };
      apiClient.post.mockResolvedValueOnce({ data: { success: true, data: savedEdge } });
      const onCreated = vi.fn();
      render(<ManualRelationshipForm
        caseId="CASE 1"
        nodes={[
          { canonicalId: 'person:a', aliases: ['Asha'] },
          { canonicalId: 'account:b', aliases: ['Account B'] },
        ]}
        onCreated={onCreated}
      />);

      fireEvent.change(screen.getByLabelText('Source node'), { target: { value: 'person:a' } });
      fireEvent.change(screen.getByLabelText('Target node'), { target: { value: 'account:b' } });
      fireEvent.change(screen.getByLabelText('Relationship type'), { target: { value: 'custom' } });
      fireEvent.change(screen.getByLabelText('Custom relationship type'), { target: { value: 'transferred funds to' } });
      fireEvent.change(screen.getByLabelText('Initial relationship status'), { target: { value: 'verified' } });
      fireEvent.change(screen.getByLabelText('Connection rationale'), { target: { value: 'Bank statement confirms transfer' } });
      fireEvent.change(screen.getByLabelText('Connection event date'), { target: { value: '2026-08-14' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

      await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
        '/cases/CASE%201/relationships',
        expect.objectContaining({
          source: 'person:a', target: 'account:b', edgeType: 'transferred funds to',
          status: 'verified', reason: 'Bank statement confirms transfer', eventDate: '2026-08-14',
        })
      ));
      expect(onCreated).toHaveBeenCalledWith(savedEdge);
      expect(await screen.findByText('Connection saved. It is now visible in the graph and timeline.')).toBeDefined();
    });
});
