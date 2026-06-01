#!/usr/bin/env node
/**
 * Legaleweb impact graph enricher.
 *
 * This script is intentionally additive: run the normal Understand-Anything
 * analysis first, then run this enhancer to append deterministic ASP.NET MVC,
 * EF6 Database First, raw SQL, and optional SQL Server metadata relationships.
 *
 * Usage:
 *   node understand-anything-plugin/scripts/enrich-legaleweb-impact.mjs \
 *     --project-root /path/to/legaleweb \
 *     --graph /path/to/.understand-anything/knowledge-graph.json \
 *     --out /path/to/.understand-anything/knowledge-graph.legaleweb.json
 *
 * Optional:
 *   --db-metadata /path/to/sqlserver-metadata.json
 *
 * The db metadata file accepts this shape:
 * {
 *   "tables": [{"schema":"dbo","name":"PROCESSO","columns":[...]}],
 *   "foreignKeys": [{"fromTable":"PROCREC","fromColumn":"SEQPROC","toTable":"PROCESSO","toColumn":"SEQPROC"}],
 *   "procedures": [{"schema":"dbo","name":"GEN_ID1","references":[{"table":"GENERATOR","operation":"write"}]}],
 *   "views": [{"schema":"dbo","name":"PROCESSO_VIEW","references":[{"table":"PROCESSO","operation":"read"}]}],
 *   "triggers": [{"schema":"dbo","name":"TR_PROCESSO","table":"PROCESSO","references":[...]}]
 * }
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const READ_SQL = /\b(?:FROM|JOIN|APPLY)\s+(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;
const INSERT_SQL = /\bINSERT\s+(?:INTO\s+)?(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;
const UPDATE_SQL = /\bUPDATE\s+(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;
const DELETE_SQL = /\bDELETE\s+(?:FROM\s+)?(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;
const MERGE_SQL = /\bMERGE\s+(?:INTO\s+)?(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;
const EXEC_SQL = /\bEXEC(?:UTE)?\s+(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;
const CREATE_TABLE_SQL = /\bCREATE\s+TABLE\s+(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;
const CREATE_PROC_SQL = /\bCREATE\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\s+(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;
const CREATE_VIEW_SQL = /\bCREATE\s+(?:OR\s+ALTER\s+)?VIEW\s+(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;
const CREATE_TRIGGER_SQL = /\bCREATE\s+(?:OR\s+ALTER\s+)?TRIGGER\s+(?:\[?dbo\]?\.)?\[?([A-Za-z_][\w$#]*)\]?/gi;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.error("Usage: enrich-legaleweb-impact.mjs --project-root <dir> --graph <knowledge-graph.json> [--out <file>] [--db-metadata <json>]");
  process.exit(message ? 1 : 0);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function listFiles(root) {
  const git = spawnSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) {
    return git.stdout.trim().split(/\r?\n/).filter(Boolean);
  }

  const files = [];
  const ignoredDirs = new Set([".git", "bin", "obj", "packages", "node_modules", ".understand-anything"]);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoredDirs.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  walk(root);
  return files.sort();
}

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}

function lineOf(content, index) {
  return content.slice(0, Math.max(0, index)).split(/\r\n|\n|\r/).length;
}

function normalizeName(name) {
  return String(name || "").replace(/^\[|\]$/g, "").trim();
}

function tableKey(name) {
  return normalizeName(name).toUpperCase();
}

const SQL_NAME_BLOCKLIST = new Set([
  "A", "B", "C", "D", "E", "F", "P", "T", "U", "X", "Y", "Z",
  "AS", "ON", "NOLOCK", "WITH", "SELECT", "WHERE", "ORDER", "GROUP",
  "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "VALUES", "SET",
]);

function isLikelySqlObject(name, knownTables, { allowShort = false } = {}) {
  const key = tableKey(name);
  if (!key) return false;
  if (knownTables?.has(key)) return true;
  if (!allowShort && key.length <= 2) return false;
  if (SQL_NAME_BLOCKLIST.has(key)) return false;
  return /^[A-Z_][A-Z0-9_$#]*$/.test(key);
}

function safeIdPart(value) {
  return String(value).replace(/[^A-Za-z0-9_.:/-]/g, "_");
}

function makeNode(id, type, name, extras = {}) {
  return {
    id,
    type,
    name,
    summary: extras.summary ?? `${name} detected by Legaleweb impact scanner.`,
    tags: extras.tags ?? ["legaleweb-impact"],
    complexity: extras.complexity ?? "simple",
    ...extras,
  };
}

function makeEdge(source, target, type, description, weight = 0.8) {
  return { source, target, type, direction: "forward", description, weight };
}

function addUnique(map, item, key) {
  if (!map.has(key)) map.set(key, item);
}

function findGraphNodeByFile(graph, rel) {
  return graph.nodes.find((node) => node.filePath === rel && node.type === "file")
    ?? graph.nodes.find((node) => node.filePath === rel);
}

function findClassNode(graph, rel, className) {
  return graph.nodes.find((node) => node.type === "class" && node.filePath === rel && node.name === className);
}

function collectMatches(regex, content) {
  const matches = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push({ name: normalizeName(match[1]), index: match.index });
  }
  return matches;
}

function extractEfModels(root, files, graph) {
  const nodes = new Map();
  const edges = new Map();
  const entityToTable = new Map();
  const dbContexts = [];

  for (const rel of files.filter((file) => file.endsWith(".cs"))) {
    const content = readText(root, rel);
    const classMatch = content.match(/\bpublic\s+partial\s+class\s+([A-Za-z_]\w*)\b/) ?? content.match(/\bpublic\s+class\s+([A-Za-z_]\w*)\b/);
    const tableMatch = content.match(/\[Table\("([^"]+)"\)\]/);
    if (classMatch && tableMatch) {
      const entity = classMatch[1];
      const table = tableMatch[1];
      entityToTable.set(entity, table);
      const tableId = `table:${safeIdPart(tableKey(table))}`;
      addUnique(nodes, makeNode(tableId, "table", table, {
        filePath: rel,
        summary: `Tabela ${table} mapeada pela entidade EF6 ${entity}.`,
        tags: ["legaleweb-impact", "ef6", "sql-server", "table"],
        impactMeta: { source: "ef6-table-attribute", confidence: "high", entity, table },
      }), tableId);

      const classNode = findClassNode(graph, rel, entity);
      if (classNode) {
        const edge = makeEdge(classNode.id, tableId, "defines_schema", `EF6 [Table("${table}")] maps entity ${entity} to table ${table}.`, 0.98);
        addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
      }

      const propertyMatches = [...content.matchAll(/\bpublic\s+(?:virtual\s+)?(?:[\w?.<>]+\s+)+([A-Z_][A-Z0-9_]*)\s*\{\s*get;\s*set;\s*\}/g)];
      for (const match of propertyMatches) {
        const column = match[1];
        const columnId = `schema:${safeIdPart(tableKey(table))}.${safeIdPart(column)}`;
        addUnique(nodes, makeNode(columnId, "schema", `${table}.${column}`, {
          filePath: rel,
          lineRange: [lineOf(content, match.index), lineOf(content, match.index)],
          summary: `Coluna/propriedade ${column} da tabela EF6 ${table}.`,
          tags: ["legaleweb-impact", "ef6", "column"],
          impactMeta: { source: "ef6-property", confidence: "high", table, column },
        }), columnId);
        const edge = makeEdge(tableId, columnId, "defines_schema", `EF6 property ${column} belongs to ${table}.`, 0.96);
        addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
      }
    }

    if (/:\s*DbContext\b/.test(content)) {
      const contextName = classMatch?.[1] ?? path.basename(rel, ".cs");
      dbContexts.push({ rel, contextName, content });
      const ctxNode = findClassNode(graph, rel, contextName);
      for (const match of content.matchAll(/\bDbSet<\s*([A-Za-z_]\w*)\s*>\s+([A-Za-z_]\w*)\s*\{\s*get;\s*set;\s*\}/g)) {
        const entity = match[1];
        const dbSetName = match[2];
        const table = entityToTable.get(entity) ?? dbSetName;
        const tableId = `table:${safeIdPart(tableKey(table))}`;
        addUnique(nodes, makeNode(tableId, "table", table, {
          filePath: rel,
          lineRange: [lineOf(content, match.index), lineOf(content, match.index)],
          summary: `Tabela ${table} exposta no DbContext ${contextName} via DbSet<${entity}>.`,
          tags: ["legaleweb-impact", "ef6", "dbset", "table"],
          impactMeta: { source: "ef6-dbset", confidence: "high", contextName, entity, dbSetName, table },
        }), tableId);
        if (ctxNode) {
          const edge = makeEdge(ctxNode.id, tableId, "defines_schema", `DbContext ${contextName} exposes DbSet<${entity}> ${dbSetName}.`, 0.97);
          addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
        }
      }
    }
  }

  return { nodes, edges, entityToTable, dbContexts };
}

function extractMvc(root, files, graph) {
  const nodes = new Map();
  const edges = new Map();
  const viewFiles = new Set(files.filter((file) => /^QJW\.Web\/Views\/.+\.cshtml$/i.test(file)));

  for (const rel of files.filter((file) => /^QJW\.Web\/Controllers\/.+Controller\.cs$/i.test(file))) {
    const content = readText(root, rel);
    const controllerName = path.basename(rel, ".cs").replace(/Controller$/, "");
    const controllerFile = findGraphNodeByFile(graph, rel);
    const controllerNodeId = `endpoint:mvc:${safeIdPart(controllerName)}`;
    addUnique(nodes, makeNode(controllerNodeId, "endpoint", `${controllerName}Controller`, {
      filePath: rel,
      summary: `ASP.NET MVC controller for the ${controllerName} area.`,
      tags: ["legaleweb-impact", "aspnet-mvc", "controller"],
      impactMeta: { source: "mvc-controller", confidence: "high", controllerName },
    }), controllerNodeId);
    if (controllerFile) {
      const edge = makeEdge(controllerFile.id, controllerNodeId, "routes", `Controller file defines ${controllerName} routes/actions.`, 0.9);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
    }

    const actionRegex = /\bpublic\s+(?:async\s+)?(?:ActionResult|JsonResult|PartialViewResult|FileResult|ContentResult|ViewResult|Task<\s*ActionResult\s*>|Task<\s*JsonResult\s*>)\s+([A-Za-z_]\w*)\s*\(/g;
    for (const match of content.matchAll(actionRegex)) {
      const actionName = match[1];
      const actionNodeId = `endpoint:mvc:${safeIdPart(controllerName)}.${safeIdPart(actionName)}`;
      addUnique(nodes, makeNode(actionNodeId, "endpoint", `${controllerName}.${actionName}`, {
        filePath: rel,
        lineRange: [lineOf(content, match.index), lineOf(content, match.index)],
        summary: `ASP.NET MVC action ${controllerName}.${actionName}.`,
        tags: ["legaleweb-impact", "aspnet-mvc", "action"],
        impactMeta: { source: "mvc-action", confidence: "high", controllerName, actionName },
      }), actionNodeId);
      const edge = makeEdge(controllerNodeId, actionNodeId, "routes", `${controllerName}Controller routes action ${actionName}.`, 0.95);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);

      const conventionalView = `QJW.Web/Views/${controllerName}/${actionName}.cshtml`;
      if (viewFiles.has(conventionalView)) {
        const viewNodeId = `file:${safeIdPart(conventionalView)}`;
        const viewEdge = makeEdge(actionNodeId, viewNodeId, "routes", `Conventional MVC view for ${controllerName}.${actionName}.`, 0.86);
        addUnique(edges, viewEdge, `${viewEdge.source}|${viewEdge.type}|${viewEdge.target}`);
      }
    }
  }

  return { nodes, edges };
}

function extractSql(root, files, graph, knownTables) {
  const nodes = new Map();
  const edges = new Map();
  const tableNames = new Set([...knownTables].map(tableKey));

  function ensureTable(name, source, confidence = "medium", filePath) {
    if (!isLikelySqlObject(name, tableNames)) return null;
    const table = tableKey(name);
    tableNames.add(table);
    const tableId = `table:${safeIdPart(table)}`;
    addUnique(nodes, makeNode(tableId, "table", table, {
      ...(filePath ? { filePath } : {}),
      summary: `Tabela ${table} detectada por ${source}.`,
      tags: ["legaleweb-impact", "sql-server", "table"],
      impactMeta: { source, confidence, table },
    }), tableId);
    return tableId;
  }

  function ensureProcedure(name, source, filePath, line) {
    const proc = normalizeName(name);
    const procId = `schema:proc:${safeIdPart(proc)}`;
    addUnique(nodes, makeNode(procId, "schema", proc, {
      filePath,
      lineRange: line ? [line, line] : undefined,
      summary: `Stored procedure ${proc} detected by ${source}.`,
      tags: ["legaleweb-impact", "sql-server", "procedure"],
      impactMeta: { source, confidence: "medium", procedure: proc },
    }), procId);
    return procId;
  }

  function sourceNodeForFile(rel) {
    const fileNode = findGraphNodeByFile(graph, rel);
    if (fileNode) return fileNode.id;
    const id = `file:${safeIdPart(rel)}`;
    addUnique(nodes, makeNode(id, "file", path.basename(rel), {
      filePath: rel,
      summary: `Source file ${rel} detected by Legaleweb impact scanner.`,
      tags: ["legaleweb-impact"],
    }), id);
    return id;
  }

  const candidates = files.filter((file) => /\.(cs|sql)$/i.test(file));
  for (const rel of candidates) {
    const content = readText(root, rel);
    if (!content) continue;
    const sourceNode = sourceNodeForFile(rel);
    const sourceKind = rel.endsWith(".sql") ? "sql-file" : "csharp-sql-literal";

    for (const match of collectMatches(CREATE_TABLE_SQL, content)) {
      const tableId = ensureTable(match.name, "create-table-sql", "high", rel);
      const edge = makeEdge(sourceNode, tableId, "defines_schema", `${rel} defines table ${match.name}.`, 0.93);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
    }
    for (const match of collectMatches(CREATE_PROC_SQL, content)) {
      const procId = ensureProcedure(match.name, "create-procedure-sql", rel, lineOf(content, match.index));
      const edge = makeEdge(sourceNode, procId, "defines_schema", `${rel} defines procedure ${match.name}.`, 0.9);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
    }
    for (const match of collectMatches(CREATE_VIEW_SQL, content)) {
      const viewId = `schema:view:${safeIdPart(match.name)}`;
      addUnique(nodes, makeNode(viewId, "schema", match.name, {
        filePath: rel,
        lineRange: [lineOf(content, match.index), lineOf(content, match.index)],
        summary: `SQL view ${match.name} detected in ${rel}.`,
        tags: ["legaleweb-impact", "sql-server", "view"],
      }), viewId);
      const edge = makeEdge(sourceNode, viewId, "defines_schema", `${rel} defines view ${match.name}.`, 0.9);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
    }
    for (const match of collectMatches(CREATE_TRIGGER_SQL, content)) {
      const triggerId = `schema:trigger:${safeIdPart(match.name)}`;
      addUnique(nodes, makeNode(triggerId, "schema", match.name, {
        filePath: rel,
        lineRange: [lineOf(content, match.index), lineOf(content, match.index)],
        summary: `SQL trigger ${match.name} detected in ${rel}.`,
        tags: ["legaleweb-impact", "sql-server", "trigger"],
      }), triggerId);
      const edge = makeEdge(sourceNode, triggerId, "triggers", `${rel} defines trigger ${match.name}.`, 0.86);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
    }

    for (const match of collectMatches(READ_SQL, content)) {
      const tableId = ensureTable(match.name, sourceKind, tableNames.has(tableKey(match.name)) ? "high" : "medium", rel);
      if (!tableId) continue;
      const edge = makeEdge(sourceNode, tableId, "reads_from", `${rel} reads from ${match.name} near line ${lineOf(content, match.index)}.`, 0.78);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}|${lineOf(content, match.index)}`);
    }
    for (const [regex, op] of [[INSERT_SQL, "insert"], [UPDATE_SQL, "update"], [DELETE_SQL, "delete"], [MERGE_SQL, "merge"]]) {
      for (const match of collectMatches(regex, content)) {
        const tableId = ensureTable(match.name, sourceKind, tableNames.has(tableKey(match.name)) ? "high" : "medium", rel);
        if (!tableId) continue;
        const edge = makeEdge(sourceNode, tableId, "writes_to", `${rel} ${op}s ${match.name} near line ${lineOf(content, match.index)}.`, 0.8);
        addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}|${lineOf(content, match.index)}`);
      }
    }
    for (const match of collectMatches(EXEC_SQL, content)) {
      const procId = ensureProcedure(match.name, sourceKind, rel, lineOf(content, match.index));
      const edge = makeEdge(sourceNode, procId, "calls", `${rel} executes procedure ${match.name} near line ${lineOf(content, match.index)}.`, 0.84);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}|${lineOf(content, match.index)}`);
    }
  }

  return { nodes, edges, tableNames };
}

function applyDbMetadata(dbMetadata, nodes, edges) {
  if (!dbMetadata) return;

  for (const table of dbMetadata.tables ?? []) {
    const tableName = table.name;
    const tableId = `table:${safeIdPart(tableKey(tableName))}`;
    addUnique(nodes, makeNode(tableId, "table", tableName, {
      summary: `SQL Server table ${table.schema ?? "dbo"}.${tableName} imported from database metadata.`,
      tags: ["legaleweb-impact", "sql-server", "db-metadata", "table"],
      impactMeta: { source: "sqlserver-metadata", confidence: "high", schema: table.schema ?? "dbo", table: tableName },
    }), tableId);
    for (const column of table.columns ?? []) {
      const col = typeof column === "string" ? { name: column } : column;
      const columnId = `schema:${safeIdPart(tableKey(tableName))}.${safeIdPart(col.name)}`;
      addUnique(nodes, makeNode(columnId, "schema", `${tableName}.${col.name}`, {
        summary: `SQL Server column ${tableName}.${col.name}${col.type ? ` (${col.type})` : ""}.`,
        tags: ["legaleweb-impact", "sql-server", "db-metadata", "column"],
        impactMeta: { source: "sqlserver-metadata", confidence: "high", table: tableName, column: col.name, type: col.type },
      }), columnId);
      const edge = makeEdge(tableId, columnId, "defines_schema", `SQL Server metadata: ${tableName} has column ${col.name}.`, 1);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
    }
  }

  for (const fk of dbMetadata.foreignKeys ?? []) {
    const source = `table:${safeIdPart(tableKey(fk.fromTable))}`;
    const target = `table:${safeIdPart(tableKey(fk.toTable))}`;
    const edge = makeEdge(source, target, "depends_on", `Foreign key ${fk.fromTable}.${fk.fromColumn ?? "?"} -> ${fk.toTable}.${fk.toColumn ?? "?"}.`, 0.98);
    addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}|fk`);
  }

  for (const proc of dbMetadata.procedures ?? []) {
    const procId = `schema:proc:${safeIdPart(proc.name)}`;
    addUnique(nodes, makeNode(procId, "schema", proc.name, {
      summary: `SQL Server procedure ${proc.schema ?? "dbo"}.${proc.name} imported from database metadata.`,
      tags: ["legaleweb-impact", "sql-server", "db-metadata", "procedure"],
      impactMeta: { source: "sqlserver-metadata", confidence: "high", procedure: proc.name },
    }), procId);
    for (const ref of proc.references ?? []) {
      const tableId = `table:${safeIdPart(tableKey(ref.table))}`;
      const edgeType = ref.operation === "write" ? "writes_to" : "reads_from";
      const edge = makeEdge(procId, tableId, edgeType, `Database metadata: procedure ${proc.name} ${edgeType === "writes_to" ? "writes to" : "reads from"} ${ref.table}.`, 0.96);
      addUnique(edges, edge, `${edge.source}|${edge.type}|${edge.target}`);
    }
  }

  for (const trigger of dbMetadata.triggers ?? []) {
    const triggerId = `schema:trigger:${safeIdPart(trigger.name)}`;
    const tableId = `table:${safeIdPart(tableKey(trigger.table))}`;
    addUnique(nodes, makeNode(triggerId, "schema", trigger.name, {
      summary: `SQL Server trigger ${trigger.name} on ${trigger.table}.`,
      tags: ["legaleweb-impact", "sql-server", "db-metadata", "trigger"],
      impactMeta: { source: "sqlserver-metadata", confidence: "high", trigger: trigger.name, table: trigger.table },
    }), triggerId);
    const triggerEdge = makeEdge(tableId, triggerId, "triggers", `Table ${trigger.table} has trigger ${trigger.name}.`, 0.97);
    addUnique(edges, triggerEdge, `${triggerEdge.source}|${triggerEdge.type}|${triggerEdge.target}`);
  }
}

function mergeIntoGraph(graph, additions) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const node of additions.nodes.values()) {
    if (!nodeIds.has(node.id)) {
      graph.nodes.push(node);
      nodeIds.add(node.id);
    }
  }

  const edgeKeys = new Set(graph.edges.map((edge) => `${edge.source}|${edge.type}|${edge.target}|${edge.description ?? ""}`));
  for (const edge of additions.edges.values()) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const key = `${edge.source}|${edge.type}|${edge.target}|${edge.description ?? ""}`;
    if (!edgeKeys.has(key)) {
      graph.edges.push(edge);
      edgeKeys.add(key);
    }
  }

  const impactNodeIds = [...additions.nodes.values()].map((node) => node.id).filter((id) => nodeIds.has(id));
  const existingLayer = graph.layers.find((layer) => layer.id === "legaleweb-impact");
  if (existingLayer) {
    existingLayer.nodeIds = [...new Set([...existingLayer.nodeIds, ...impactNodeIds])];
  } else {
    graph.layers.push({
      id: "legaleweb-impact",
      name: "Legaleweb Impact Map",
      description: "EF6, ASP.NET MVC, raw SQL, and SQL Server impact relationships generated by the Legaleweb scanner.",
      nodeIds: [...new Set(impactNodeIds)],
    });
  }

  graph.project.frameworks = [...new Set([...(graph.project.frameworks ?? []), "ASP.NET MVC", "Entity Framework 6", "SQL Server"])];
  graph.project.description = `${graph.project.description} Enriched with deterministic Legaleweb EF6/MVC/SQL impact relationships.`;
  graph.legalewebImpact = {
    generatedAt: new Date().toISOString(),
    nodesAdded: additions.nodes.size,
    edgesAdded: additions.edges.size,
    scannerVersion: "0.1.0",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();
  const projectRoot = args["project-root"];
  const graphPath = args.graph;
  if (!projectRoot || !graphPath) usage("--project-root and --graph are required");
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) usage(`project root not found: ${projectRoot}`);
  if (!fs.existsSync(graphPath)) usage(`graph not found: ${graphPath}`);

  const outPath = args.out ?? graphPath.replace(/\.json$/i, ".legaleweb-impact.json");
  const graph = readJson(graphPath);
  const files = listFiles(projectRoot);

  const ef = extractEfModels(projectRoot, files, graph);
  const mvc = extractMvc(projectRoot, files, graph);
  const sql = extractSql(projectRoot, files, graph, new Set(ef.entityToTable.values()));

  const additions = { nodes: new Map(), edges: new Map() };
  for (const source of [ef, mvc, sql]) {
    for (const [key, node] of source.nodes) additions.nodes.set(key, node);
    for (const [key, edge] of source.edges) additions.edges.set(key, edge);
  }

  const dbMetadata = args["db-metadata"] ? readJson(args["db-metadata"]) : null;
  applyDbMetadata(dbMetadata, additions.nodes, additions.edges);
  mergeIntoGraph(graph, additions);
  writeJson(outPath, graph);

  console.log(JSON.stringify({
    projectRoot,
    graph: graphPath,
    out: outPath,
    filesScanned: files.length,
    efEntities: ef.entityToTable.size,
    dbContexts: ef.dbContexts.length,
    nodesAdded: additions.nodes.size,
    edgesAdded: additions.edges.size,
    dbMetadataLoaded: Boolean(dbMetadata),
  }, null, 2));
}

main();
