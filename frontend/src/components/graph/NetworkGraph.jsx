import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import SpriteText from 'three-spritetext';
import {
  buildRenderableGraphData,
  historicalNodeLabel,
  isDashedConnectionType,
} from './graphPresentation.js';

// 1. NODE COLOR CODING
const NODE_COLORS = { 
  person: "#3b82f6", // Blue
  phone: "#10b981", // Green
  email: "#a855f7", // Purple
  location: "#f97316", // Orange
  organization: "#06b6d4", // Cyan
  org: "#06b6d4", // Cyan
  account: "#ec4899", // Pink
  user: "#ec4899", // Pink
  device: "#ef4444", // Red
  ip: "#ef4444", // Red
  default: "#9ca3af" // Gray
};

// 2. EDGE / RELATIONSHIP COLORS
const EDGE_COLORS = { 
  verified: "#059669", // Emerald (Solid)
  possible_connection: "#d97706", // Dark Amber (Dashed)
  cross_connection: "#3b82f6", // Blue (Cross-case link)
  historical_evidence: "#7c3aed", // Read-only evidence from an earlier case
  unverified: "#dc2626",
  unknown: "#9ca3af",
  default: "#9ca3af" // Grey (Unverified/Unknown)
};

/**
 * Derive the frontend display classification for an edge.
 * Rules:
 *  1. Use reviewStatus if specified (approved/rejected).
 *  2. If reviewStatus is 'flagged', treat as possible_connection.
 *  3. Otherwise, use systemStatus (if present) or fallback to guardrailStatus.
 * A recurrence pattern is entity-level metadata and never changes edge
 * rendering. Only an explicit investigator/model edge status can do that.
 */
const NetworkGraph = ({
  graphData,
  onNodeClick,
  onEdgeClick,
  onBackgroundClick,
  activeTimeRange,
  currentCaseId,
  selectedEdgeId,
  showCrossCaseEvidence = false,
  focusedNodeId = null,
}) => {
  const fgRef = useRef();
  const containerRef = useRef();
  
  const [hoverNode, setHoverNode] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // Handle responsive resizing
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      if (!entries || !entries.length) return;
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Configure layout engine
  useEffect(() => {
    if (fgRef.current) {
      // Improve spacing and reduce overlap (Bring nodes closer for a tighter graph)
      fgRef.current.d3Force('charge').strength(-300).distanceMax(800);
      fgRef.current.d3Force('link').distance(50);
      
      // Auto-fit graph smoothly on load with minimal padding so it appears larger
      setTimeout(() => {
        if (fgRef.current) {
          fgRef.current.zoomToFit(800, 10);
        }
      }, 600);
    }
  }, [dimensions]);

  // Format data and calculate degrees for node sizing.
  // ALL edges are included — no guardrailStatus filtering here.
  // displayConnectionType is derived per edge for visual styling only.
  const formattedData = useMemo(() => {
    return buildRenderableGraphData(graphData, showCrossCaseEvidence);
  }, [graphData, showCrossCaseEvidence]);

  // Determine whether ANY entity/edge in this dataset is actually tagged with
  // currentCaseId. If nothing matches (e.g. associatedCases is missing/empty
  // across the board, or currentCaseId wasn't passed through correctly),
  // fall back to treating everything as "active" so the graph doesn't render
  // as a washed-out ghost by default.
  const hasAnyCaseMatch = useMemo(() => {
    if (!currentCaseId) return true;
    const nodeMatch = formattedData.nodes.some(n => (n.associatedCases || []).includes(currentCaseId));
    const linkMatch = formattedData.links.some(l => (l.associatedCases || []).includes(currentCaseId));
    return nodeMatch || linkMatch;
  }, [formattedData, currentCaseId]);

  const isNodeInActiveContext = useCallback((node) => {
    if (node?.isHistoricalEvidence) return true;
    if (!currentCaseId || !hasAnyCaseMatch) return true;
    return (node.associatedCases || []).includes(currentCaseId);
  }, [currentCaseId, hasAnyCaseMatch]);

  const isLinkInActiveContext = useCallback((link) => {
    if (link?.isCrossCaseEvidence) return true;
    if (!currentCaseId || !hasAnyCaseMatch) return true;
    return (link.associatedCases || []).includes(currentCaseId);
  }, [currentCaseId, hasAnyCaseMatch]);

  // Compute sets for hovering & selection highlight effects
  const { highlightNodes, highlightLinks } = useMemo(() => {
    const nodes = new Set();
    const links = new Set();
    const focusedNode = focusedNodeId
      ? formattedData.nodes.find((node) => node.id === focusedNodeId)
      : null;
    const activeFocusNode = hoverNode || selectedNode || focusedNode;
    
    if (activeFocusNode && formattedData) {
      nodes.add(activeFocusNode.id);
      formattedData.links.forEach(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        if (sourceId === activeFocusNode.id || targetId === activeFocusNode.id) {
          links.add(link.id);
          nodes.add(sourceId === activeFocusNode.id ? targetId : sourceId);
        }
      });
    } else if (selectedEdgeId && formattedData) {
      formattedData.links.forEach(link => {
        if (link.id === selectedEdgeId) {
          links.add(link.id);
          const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
          const targetId = typeof link.target === 'object' ? link.target.id : link.target;
          nodes.add(sourceId);
          nodes.add(targetId);
        }
      });
    }
    return { highlightNodes: nodes, highlightLinks: links };
  }, [hoverNode, selectedNode, selectedEdgeId, focusedNodeId, formattedData]);

  const getNodeColor = useCallback((type) => {
    const t = type?.toLowerCase();
    return NODE_COLORS[t] || NODE_COLORS.default;
  }, []);

  const isEdgeInTimeRange = useCallback((edge, timeRange) => {
    if (!timeRange || !timeRange.start || !timeRange.end || !edge.eventDate) return true;
    const edgeTime = new Date(edge.eventDate).getTime();
    const start = new Date(timeRange.start).getTime();
    const end = new Date(timeRange.end).getTime();
    return edgeTime >= start && edgeTime <= end;
  }, []);

  // Custom Node Renderer
  const nodeThreeObject = useCallback(node => {
    const activeFocus = hoverNode || selectedNode || selectedEdgeId || focusedNodeId;
    const isFocused = (hoverNode && hoverNode.id === node.id) || (selectedNode && selectedNode.id === node.id) || focusedNodeId === node.id;
    const isHighlighted = activeFocus ? highlightNodes.has(node.id) : true;
    const isActiveContext = isNodeInActiveContext(node);
    
    // Smooth fade for unrelated nodes, but active nodes are 100% opaque.
    // Floors raised so nothing drops below a visible minimum.
    let opacity = isHighlighted ? 1.0 : 0.4;
    if (!isActiveContext && !isFocused && !isHighlighted) opacity = Math.max(opacity, 0.55);

    let color = node.isHistoricalEvidence ? '#6b7280' : getNodeColor(node.type);
    if (!isActiveContext && !isHighlighted) color = '#9ca3af';

    // Cross-case nodes (in this case but also others) get a subtle purple emissive glow
    const isCrossCase = node.associatedCases && node.associatedCases.length > 1;

    const group = new THREE.Group();

    // Node Sizing Strategy: Make nodes significantly smaller
    const baseRadius = 4;
    let radius = baseRadius;
    if (node.attributes?.betweenness_centrality) {
      radius = baseRadius + (node.attributes.betweenness_centrality * 10);
    }
    
    // Slight bump if focused
    if (isFocused) {
      radius *= 1.2;
    }

    // Node sphere
    const geometry = new THREE.SphereGeometry(radius, 32, 32);
    const material = new THREE.MeshPhongMaterial({
      color,
      transparent: true,
      opacity,
      shininess: isActiveContext ? 60 : 10,
      emissive: isFocused ? color : (isCrossCase && isActiveContext ? '#6d28d9' : '#000000'),
      emissiveIntensity: isFocused ? 0.3 : (isCrossCase && isActiveContext ? 0.2 : 0)
    });
    const sphere = new THREE.Mesh(geometry, material);
    group.add(sphere);

    if (node.isHistoricalEvidence) {
      const historicalOutline = new THREE.Mesh(
        new THREE.SphereGeometry(radius + 1.1, 16, 16),
        new THREE.MeshBasicMaterial({ color: '#7c3aed', wireframe: true, transparent: true, opacity: 0.65 })
      );
      group.add(historicalOutline);
    }

    // Outline for selected node
    if (selectedNode && selectedNode.id === node.id) {
      const outlineGeo = new THREE.SphereGeometry(radius + 1.5, 32, 32);
      const outlineMat = new THREE.MeshBasicMaterial({ color: '#1f2937', side: THREE.BackSide, transparent: true, opacity: 0.3 }); 
      const outline = new THREE.Mesh(outlineGeo, outlineMat);
      group.add(outline);
    }

    // Label Rendering
    let labelText = 'Unknown';
    if (Array.isArray(node.aliases) && node.aliases.length > 0 && node.aliases[0]) {
      labelText = node.aliases[0];
    } else if (node.type) {
      labelText = node.type;
    }
    
    // Truncate long labels visually
    if (labelText.length > 22) {
      labelText = labelText.substring(0, 19) + '...';
    }

    labelText = historicalNodeLabel(node, labelText);
    const sprite = new SpriteText(labelText);
    // Keep label text dark/readable regardless of active-context state
    sprite.color = isFocused ? '#000000' : '#1f2937';
    sprite.fontWeight = isFocused ? 'bold' : '600';
    
    // Increase base text size significantly
    sprite.textHeight = isFocused ? 7 : (isHighlighted ? 5.5 : 4.5);
    sprite.position.y = radius + (isFocused ? 7 : 5);
    
    // Add pill background to sprite for contrast, with entity color border
    sprite.backgroundColor = isFocused ? 'rgba(255, 255, 255, 1)' : 'rgba(255, 255, 255, 0.9)';
    sprite.borderColor = color;
    sprite.borderWidth = isFocused ? 1 : 0.5;
    sprite.padding = [4, 6]; // [vertical, horizontal]
    sprite.borderRadius = 4;
    
    // Raised floor so labels never fade near-invisible
    sprite.material.opacity = isActiveContext ? 1.0 : Math.max(opacity, 0.85);
    
    // CRITICAL: Disable depth testing so labels render crisp and ON TOP of all edges/nodes
    sprite.material.depthTest = false;
    sprite.material.depthWrite = false;
    sprite.renderOrder = 999; // Ensure it renders last (on top)

    group.add(sprite);

    return group;
  }, [hoverNode, selectedNode, selectedEdgeId, focusedNodeId, highlightNodes, getNodeColor, isNodeInActiveContext]);

  // Custom Edge Creation using Cylinders for thickness
  const linkThreeObject = useCallback(link => {
    const dct = link.displayConnectionType || 'unknown';
    const isVerified = dct === 'verified';
    const isPossible = dct === 'possible_connection';
    const isCrossCase = dct === 'cross_connection';
    const isHistoricalEvidence = dct === 'historical_evidence';
    const isUnverified = dct === 'unverified';
    const isUnknown = dct === 'unknown';

    let color = EDGE_COLORS.default;
    if (isVerified) color = EDGE_COLORS.verified;
    if (isPossible) color = EDGE_COLORS.possible_connection;
    if (isCrossCase) color = EDGE_COLORS.cross_connection;
    if (isHistoricalEvidence) color = EDGE_COLORS.historical_evidence;
    if (isUnverified) color = EDGE_COLORS.unverified;
    // unknown stays as EDGE_COLORS.default (gray)

    // Thicker lines for verified/cross, thinner for possible/unknown
    const radius = isVerified ? 1.0 : isCrossCase ? 1.2 : isPossible ? 0.7 : isHistoricalEvidence ? 0.55 : 0.5;
    const geometry = new THREE.CylinderGeometry(radius, radius, 1, 8);
    geometry.translate(0, 0.5, 0);

    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: isUnknown ? 0.5 : 1.0
    });

    // Dashed texture for possible and cross-case connections
    if (isDashedConnectionType(dct)) {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 4, 32);
      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(1, (isCrossCase || isHistoricalEvidence) ? 15 : 10);
      material.map = texture;
      material.alphaTest = 0.5;
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.linkData = link;
    return mesh;
  }, []);

  // Dynamic Custom Edge Updates
  const linkPositionUpdate = useCallback((mesh, { start, end }) => {
    const link = mesh.linkData;
    if (!link) return false;

    const dir = new THREE.Vector3(end.x - start.x, end.y - start.y, end.z - start.z);
    const length = dir.length();

    mesh.position.copy(start);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    mesh.scale.set(1, length, 1);

    if (mesh.material.map) {
      const dct = link.displayConnectionType || 'unknown';
      mesh.material.map.repeat.set(1, Math.max(1, length / (dct === 'cross_connection' ? 15 : 12)));
    }

    const inTimeRange = isEdgeInTimeRange(link, activeTimeRange);
    const activeFocus = hoverNode || selectedNode || selectedEdgeId || focusedNodeId;
    const isHighlighted = activeFocus ? highlightLinks.has(link.id) : true;
    const isActiveContext = isLinkInActiveContext(link);

    let targetOpacity = link.displayConnectionType === 'unknown' ? 0.5 : 1.0;
    if (!inTimeRange) targetOpacity = 0.2;
    if (activeFocus && !isHighlighted) targetOpacity = Math.min(targetOpacity, 0.15);
    if (isHighlighted && activeFocus) targetOpacity = 1.0;
    if (!isActiveContext && !isHighlighted) targetOpacity = Math.max(targetOpacity, 0.45);

    mesh.material.opacity = targetOpacity;

    const dct = link.displayConnectionType || 'unknown';
    let targetColor = new THREE.Color(EDGE_COLORS.default);

    if (isActiveContext) {
      if (dct === 'verified') targetColor.set(EDGE_COLORS.verified);
      else if (dct === 'possible_connection') targetColor.set(EDGE_COLORS.possible_connection);
      else if (dct === 'cross_connection') targetColor.set(EDGE_COLORS.cross_connection);
      else if (dct === 'historical_evidence') targetColor.set(EDGE_COLORS.historical_evidence);
      else if (dct === 'unverified') targetColor.set(EDGE_COLORS.unverified);
      // unknown stays gray
    } else {
      targetColor.set('#9ca3af');
    }

    if (activeFocus && isHighlighted) {
      targetColor.lerp(new THREE.Color('#000000'), 0.2);
    }

    mesh.material.color = targetColor;
    return true;
  }, [hoverNode, selectedNode, selectedEdgeId, focusedNodeId, highlightLinks, activeTimeRange, isEdgeInTimeRange, isLinkInActiveContext]);


  // Graph Controls
  const handleZoomIn = () => {
    if (!fgRef.current) return;
    const currentCam = fgRef.current.cameraPosition();
    fgRef.current.cameraPosition(
      { x: currentCam.x * 0.7, y: currentCam.y * 0.7, z: currentCam.z * 0.7 }, 
      { x: 0, y: 0, z: 0 }, 
      400
    );
  };
  
  const handleZoomOut = () => {
    if (!fgRef.current) return;
    const currentCam = fgRef.current.cameraPosition();
    fgRef.current.cameraPosition(
      { x: currentCam.x * 1.4, y: currentCam.y * 1.4, z: currentCam.z * 1.4 }, 
      { x: 0, y: 0, z: 0 }, 
      400
    );
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      if (containerRef.current.requestFullscreen) {
        containerRef.current.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  const handleNodeClick = (node) => {
    setSelectedNode(node);
    if (onNodeClick) onNodeClick(node.id, node);
  };

  if (!formattedData.nodes.length) {
    return (
      <div className="flex items-center justify-center w-full h-full min-h-[400px] bg-slate-900 text-slate-400 rounded-lg shadow-inner">
        <div className="flex flex-col items-center">
          <svg className="w-12 h-12 mb-3 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <span className="text-lg font-medium">No case data available</span>
          <span className="text-sm">Graph requires entities and relationships to render</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full min-h-[500px] rounded-lg overflow-hidden relative bg-white" style={{ backgroundColor: document.fullscreenElement ? '#ffffff' : '#FAF8F0' }}>
      
      {/* 7. GRAPH BACKGROUND - Subtle Dot Pattern */}
      <div className="absolute inset-0 pointer-events-none opacity-40" 
        style={{ 
          backgroundImage: 'radial-gradient(#d1d5db 1px, transparent 1px)', 
          backgroundSize: '24px 24px' 
        }}>
      </div>
      
      <div className="absolute inset-0 pointer-events-none opacity-30 bg-gradient-to-br from-white via-transparent to-gray-100"></div>

      {dimensions.width > 0 && dimensions.height > 0 && (
        <ForceGraph3D
          ref={fgRef}
          width={dimensions.width}
          height={dimensions.height}
          graphData={formattedData}
          nodeId="id"
          nodeThreeObject={nodeThreeObject}
          linkThreeObject={linkThreeObject}
          linkPositionUpdate={linkPositionUpdate}
          onNodeClick={handleNodeClick}
          onLinkClick={link => onEdgeClick && onEdgeClick(link.id, link)}
          onNodeHover={node => setHoverNode(node || null)}
          onBackgroundClick={() => {
            setSelectedNode(null);
            if (onBackgroundClick) onBackgroundClick();
          }}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          enableNodeDrag={true}
          nodeLabel={node => {
            const alias = Array.isArray(node.aliases) && node.aliases.length > 0 ? node.aliases[0] : 'Unknown';
            const color = getNodeColor(node.type);
            const crossCaseBadge = node.isHistoricalEvidence
              ? `<div style="margin-top: 6px; padding: 2px 6px; background: #f5f3ff; color: #6d28d9; border: 1px dashed #8b5cf6; font-size: 10px; border-radius: 4px; display: inline-block;">Historical · ${node.historicalCaseName || 'case'}</div>`
              : node.associatedCases && node.associatedCases.length > 1
              ? `<div style="margin-top: 6px; padding: 2px 6px; background: #ede9fe; color: #6d28d9; border: 1px solid #c4b5fd; font-size: 10px; border-radius: 4px; display: inline-block;">Appears in ${node.associatedCases.length} cases</div>`
              : '';

            return `
              <div style="background: rgba(255, 255, 255, 0.95); padding: 12px; border-radius: 8px; border-left: 4px solid ${color}; color: #1f2937; font-family: ui-sans-serif, system-ui, sans-serif; box-shadow: 0 4px 15px -3px rgba(0, 0, 0, 0.1); font-size: 13px; min-width: 180px;">
                <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 4px;">
                  ${node.type || 'Entity'}
                </div>
                <div style="font-weight: 600; font-size: 15px; margin-bottom: 4px;">
                  ${alias}
                </div>
                ${crossCaseBadge}
                <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #e5e7eb; padding-top: 8px; margin-top: 8px;">
                  <span style="color: #4b5563;">Connections</span>
                  <span style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-weight: bold;">${node.degree}</span>
                </div>
              </div>
            `;
          }}
          linkLabel={link => link.isCrossCaseEvidence
            ? `Exact Historical Cross-Case Evidence · Shared ${link.crossCaseEvidence?.identifierType || 'identifier'} · Case ${link.historicalCaseId || 'unavailable'}`
            : (link.edgeType || 'Relationship')}
        />
      )}
      
      {/* 10. LEGEND */}
      <div className="absolute top-4 left-4 p-4 bg-white/90 backdrop-blur border border-gray-200 rounded-lg shadow-md pointer-events-none text-xs text-gray-700 min-w-[180px]">
        <h4 className="font-semibold text-gray-900 mb-3 tracking-wide">ENTITY TYPES</h4>
        <div className="grid grid-cols-2 gap-y-2 gap-x-4 mb-5">
          <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: NODE_COLORS.person}}></div><span>Person</span></div>
          <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: NODE_COLORS.phone}}></div><span>Phone</span></div>
          <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: NODE_COLORS.email}}></div><span>Email</span></div>
          <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: NODE_COLORS.location}}></div><span>Location</span></div>
          <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: NODE_COLORS.org}}></div><span>Org</span></div>
          <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: NODE_COLORS.device}}></div><span>Device</span></div>
        </div>

        <h4 className="font-semibold text-gray-900 mb-3 tracking-wide">RELATIONSHIP TYPE</h4>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-0.5" style={{backgroundColor: EDGE_COLORS.verified}}></div>
          <span>Verified</span>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 border-b-2 border-dashed" style={{borderColor: EDGE_COLORS.possible_connection}}></div>
          <span>Possible Connection</span>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 border-b-2 border-dashed" style={{borderColor: EDGE_COLORS.cross_connection}}></div>
          <span>Cross-Case Connection</span>
        </div>
        {showCrossCaseEvidence && (
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 border-b-2 border-dashed" style={{borderColor: EDGE_COLORS.historical_evidence}}></div>
            <span>Exact Historical Cross-Case Evidence</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <div className="w-8 h-0.5 opacity-50 bg-gray-400"></div>
          <span>Unknown Connection</span>
        </div>
      </div>

      {/* 11. ZOOM / PAN CONTROLS */}
      <div className="absolute bottom-6 right-6 flex flex-col gap-2">
        <button onClick={toggleFullscreen} className="p-2 bg-white/90 hover:bg-gray-50 border border-gray-200 rounded text-gray-700 transition shadow-md group relative" aria-label="Toggle Fullscreen">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"></path></svg>
        </button>
        <button onClick={handleZoomIn} className="p-2 bg-white/90 hover:bg-gray-50 border border-gray-200 rounded text-gray-700 transition shadow-md" aria-label="Zoom In">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"></path></svg>
        </button>
        <button onClick={handleZoomOut} className="p-2 bg-white/90 hover:bg-gray-50 border border-gray-200 rounded text-gray-700 transition shadow-md" aria-label="Zoom Out">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7"></path></svg>
        </button>
      </div>

      {/* Clear Selection Hint */}
      {selectedNode && (
        <div className="absolute top-4 right-4 animate-fade-in">
          <button onClick={() => setSelectedNode(null)} className="px-3 py-1.5 bg-white hover:bg-gray-50 text-gray-800 text-xs font-semibold rounded-md shadow-md border border-gray-200 transition flex items-center gap-2">
            <span>Clear Selection</span>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
        </div>
      )}
    </div>
  );
};

export default NetworkGraph;
