import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import NetworkGraph from '../components/graph/NetworkGraph';
import {
  buildRenderableGraphData,
  deriveDisplayConnectionType,
  isDashedConnectionType,
  historicalNodeLabel,
  shouldShowCrossCaseEvidenceByDefault,
  entityNameSimilarity,
  findCandidateIdentityMerge,
} from '../components/graph/graphPresentation.js';

afterEach(() => {
  cleanup();
});

// Mock react-force-graph-3d which uses canvas/threejs and might crash in JSDOM
vi.mock('react-force-graph-3d', () => ({
  default: () => <div data-testid="force-graph-3d-mock" />
}));

describe('NetworkGraph Component', () => {
  it('renders correctly with no data', () => {
    const { getByText } = render(<NetworkGraph graphData={{ nodes: [], edges: [] }} />);
    expect(getByText('No case data available')).toBeDefined();
  });

  it('renders force graph when data is present', () => {
    const graphData = {
      nodes: [
        { id: 'n1', type: 'person' },
        { id: 'n2', type: 'phone' }
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', reviewStatus: 'approved' }
      ]
    };
    
    // ResizeObserver mock
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    const { container } = render(<NetworkGraph graphData={graphData} />);
    
    // We can't test actual WebGL rendering easily, but we can verify it renders the container
    // However, the dimensions start at 0,0 and update via ResizeObserver.
    // The force graph only renders when dimensions > 0.
    // We'll just verify no crash and it renders the wrapper.
    expect(container).toBeDefined();
  });

  it('applies investigator status ahead of the original model status', () => {
    expect(deriveDisplayConnectionType({ reviewStatus: 'unverified', systemStatus: 'verified' })).toBe('unverified');
    expect(deriveDisplayConnectionType({ effectiveStatus: 'cross_connection' })).toBe('cross_connection');
    expect(deriveDisplayConnectionType({ systemStatus: 'possible_connection' })).toBe('possible_connection');
    expect(deriveDisplayConnectionType({ systemStatus: 'unknown' })).toBe('unknown');
  });

  it('keeps a verified edge verified when either endpoint also appears in another case', () => {
    expect(deriveDisplayConnectionType(
      { id: 'verified-edge', source: 'person:rafiq', target: 'phone:9050011122', systemStatus: 'verified' },
      new Set()
    )).toBe('verified');
  });

  it('does not create cross-connection styling from recurrence pattern metadata alone', () => {
    expect(deriveDisplayConnectionType(
      { id: 'recurrence-edge', source: 'person:rafiq', target: 'phone:9050011122' },
      new Set(['recurrence-edge'])
    )).toBe('unknown');
  });

  it('adds namespaced historical nodes and dashed evidence lines without changing current relationships', () => {
    const graphData = {
      nodes: [{ canonicalId: 'phone:9050011122', type: 'phone', aliases: ['9050011122'] }],
      edges: [{ id: 'current-edge', source: 'person:current', target: 'phone:9050011122', systemStatus: 'verified' }],
      crossCaseEvidence: [{
        id: 'cross:ALPHA-04:phone:9050011122:ALPHA-01:old-edge',
        currentEntityId: 'phone:9050011122',
        matchedIdentifier: 'phone:9050011122',
        identifierType: 'phone',
        historicalCaseId: 'ALPHA-01',
        historicalCaseName: 'Salt Lake Recovery',
        historicalEntity: {
          id: 'historical:ALPHA-01:person:rafiq-old',
          name: 'Rafiq Mondal',
          type: 'person',
        },
        historicalRelationship: { edgeId: 'old-edge', edgeType: 'uses_phone', modelStatus: 'verified' },
      }],
    };
    graphData.nodes.push({ canonicalId: 'person:current', type: 'person', aliases: ['Current person'] });

    const currentOnly = buildRenderableGraphData(graphData, false);
    const withEvidence = buildRenderableGraphData(graphData, true);

    expect(currentOnly.nodes.map((node) => node.id)).not.toContain('historical:ALPHA-01:person:rafiq-old');
    expect(currentOnly.links).toHaveLength(1);
    expect(currentOnly.links[0]).toEqual(expect.objectContaining({ id: 'current-edge', displayConnectionType: 'verified' }));
    expect(withEvidence.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'historical:ALPHA-01:person:rafiq-old',
        isHistoricalEvidence: true,
        historicalCaseId: 'ALPHA-01',
      }),
    ]));
    expect(withEvidence.links).toEqual(expect.arrayContaining([
      expect.objectContaining({
        isCrossCaseEvidence: true,
        displayConnectionType: 'historical_evidence',
        source: 'historical:ALPHA-01:person:rafiq-old',
        target: 'phone:9050011122',
      }),
    ]));
    expect(isDashedConnectionType('historical_evidence')).toBe(true);
    expect(deriveDisplayConnectionType(withEvidence.links[1])).toBe('historical_evidence');
    expect(withEvidence.links[0].displayConnectionType).toBe('verified');
    expect(withEvidence.links[1]).not.toHaveProperty('reviewStatus');
    const historicalNode = withEvidence.nodes.find((node) => node.isHistoricalEvidence);
    expect(historicalNodeLabel(historicalNode, 'Rafiq Mondal')).toBe('Rafiq Mondal · Historical Salt Lake Recovery');
    expect(historicalNodeLabel(historicalNode, 'Rafiq Mondal')).not.toContain('ALPHA-01');
  });

  it('renders the complete phone and vehicle historical acceptance overlay by default', () => {
    const makeEvidence = (historicalCaseId, personId, personName, currentEntityId, identifierType) => ({
      id: `cross:ALPHA-04:${currentEntityId}:${historicalCaseId}:old-edge`,
      currentEntityId,
      matchedIdentifier: currentEntityId,
      identifierType,
      historicalCaseId,
      historicalCaseName: `Case name ${historicalCaseId.slice(-2)}`,
      historicalEntity: {
        id: `historical:${historicalCaseId}:${personId}`,
        name: personName,
        type: 'person',
      },
      historicalRelationship: { edgeId: `edge-${historicalCaseId}`, edgeType: `uses_${identifierType}`, modelStatus: 'verified' },
    });
    const graphData = {
      nodes: [
        { canonicalId: 'phone:9050011122', type: 'phone' },
        { canonicalId: 'vehicle:WB19R8842', type: 'vehicle' },
      ],
      edges: [],
      crossCaseEvidence: [
        makeEvidence('ALPHA-01', 'person:rafiq', 'Rafiq Mondal', 'phone:9050011122', 'phone'),
        makeEvidence('ALPHA-02', 'person:rafiq', 'Rafiq Mondal', 'phone:9050011122', 'phone'),
        makeEvidence('ALPHA-03', 'person:imran', 'Imran Sheikh', 'vehicle:WB19R8842', 'vehicle'),
      ],
    };

    expect(shouldShowCrossCaseEvidenceByDefault(graphData)).toBe(true);
    const rendered = buildRenderableGraphData(graphData, shouldShowCrossCaseEvidenceByDefault(graphData));
    expect(rendered.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      'historical:ALPHA-01:person:rafiq',
      'historical:ALPHA-02:person:rafiq',
      'historical:ALPHA-03:person:imran',
    ]));
    expect(rendered.links.filter((link) => link.target === 'phone:9050011122')).toHaveLength(2);
    expect(rendered.links.filter((link) => link.target === 'vehicle:WB19R8842')).toHaveLength(1);
    expect(rendered.links.every((link) => link.displayConnectionType === 'historical_evidence')).toBe(true);
  });

  it('visually merges a historical person into the current person at 90% name similarity plus an exact identifier', () => {
    const evidence = {
      id: 'cross:CURRENT:vehicle:WB19R8842:OLD:edge-1',
      currentEntityId: 'vehicle:WB19R8842',
      matchedIdentifier: 'vehicle:WB19R8842',
      identifierType: 'vehicle',
      historicalCaseId: 'OLD',
      historicalCaseName: 'Older case',
      historicalEntity: {
        id: 'historical:OLD:person:rafiq-old',
        name: 'Rafiq Mondol',
        type: 'person',
      },
      historicalRelationship: { edgeId: 'edge-1', evidence: [{}] },
    };
    const graphData = {
      nodes: [
        { canonicalId: 'person:rafiq-current', type: 'person', aliases: ['Rafiq Mondal'] },
        { canonicalId: 'vehicle:WB19R8842', type: 'vehicle', aliases: ['WB-19-R-8842'] },
      ],
      edges: [],
      crossCaseEvidence: [evidence],
    };

    expect(entityNameSimilarity('Rafiq Mondal', 'Rafiq Mondol')).toBeGreaterThanOrEqual(0.9);
    expect(findCandidateIdentityMerge(
      graphData.nodes.map((node) => ({ ...node, id: node.canonicalId })),
      evidence,
    )?.node.id).toBe('person:rafiq-current');

    const rendered = buildRenderableGraphData(graphData, true);
    expect(rendered.nodes.map((node) => node.id)).not.toContain('historical:OLD:person:rafiq-old');
    expect(rendered.nodes.find((node) => node.id === 'person:rafiq-current').candidateIdentityMerges).toHaveLength(1);
    expect(rendered.links[0]).toEqual(expect.objectContaining({
      source: 'person:rafiq-current',
      target: 'vehicle:WB19R8842',
      candidateIdentityMerge: true,
      displayConnectionType: 'historical_evidence',
    }));
    expect(rendered.links[0]).not.toHaveProperty('reviewStatus');
  });

  it('keeps the historical person separate when the normalized-name similarity is below 90%', () => {
    const evidence = {
      id: 'cross:CURRENT:phone:9050011122:OLD:edge-2',
      currentEntityId: 'phone:9050011122',
      matchedIdentifier: 'phone:9050011122',
      identifierType: 'phone',
      historicalCaseId: 'OLD',
      historicalEntity: { id: 'historical:OLD:person:other', name: 'Another Person', type: 'person' },
      historicalRelationship: { edgeId: 'edge-2', evidence: [{}] },
    };
    const rendered = buildRenderableGraphData({
      nodes: [
        { canonicalId: 'person:rafiq', type: 'person', aliases: ['Rafiq Mondal'] },
        { canonicalId: 'phone:9050011122', type: 'phone' },
      ],
      edges: [],
      crossCaseEvidence: [evidence],
    }, true);

    expect(rendered.nodes.map((node) => node.id)).toContain('historical:OLD:person:other');
    expect(rendered.links[0].source).toBe('historical:OLD:person:other');
    expect(rendered.links[0].candidateIdentityMerge).toBe(false);
  });
});
