#!/usr/bin/env node

import fs from "node:fs";

const [graphPath] = process.argv.slice(2);

if (!graphPath) {
  console.error("Usage: graph-stats.mjs <knowledge-graph.json>");
  process.exit(1);
}

const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
const ids = new Set((graph.nodes ?? []).map((node) => node.id));
let danglingEdges = 0;

for (const edge of graph.edges ?? []) {
  if (!ids.has(edge.source) || !ids.has(edge.target)) danglingEdges += 1;
}

const nodeTypes = {};
const edgeTypes = {};

for (const node of graph.nodes ?? []) {
  nodeTypes[node.type] = (nodeTypes[node.type] ?? 0) + 1;
}

for (const edge of graph.edges ?? []) {
  edgeTypes[edge.type] = (edgeTypes[edge.type] ?? 0) + 1;
}

console.log(JSON.stringify({
  graphPath,
  project: graph.project?.name,
  nodes: graph.nodes?.length ?? 0,
  edges: graph.edges?.length ?? 0,
  layers: graph.layers?.length ?? 0,
  danglingEdges,
  nodeTypes,
  edgeTypes,
  impact: graph.legalewebImpact ?? null,
}, null, 2));
