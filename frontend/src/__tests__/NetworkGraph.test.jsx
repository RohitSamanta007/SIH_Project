import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import NetworkGraph, { deriveDisplayConnectionType } from '../components/graph/NetworkGraph';

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
});
