#!/usr/bin/env node
/**
 * Deterministic Legaleweb scanner.
 *
 * Produces an Understand-Anything compatible knowledge graph from a legacy
 * Legaleweb checkout and then applies the Legaleweb impact enrichment pass.
 *
 * This is designed for unattended VM runs where the interactive
 * Understand-Anything agent pipeline is not available.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const scanProjectScript = path.join(pluginRoot, "skills", "understand", "scan-project.mjs");
const importMapScript = path.join(pluginRoot, "skills", "understand", "extract-import-map.mjs");
const extractStructureScript = path.join(pluginRoot, "skills", "understand", "extract-structure.mjs");
const enrichScript = path.join(__dirname, "enrich-legaleweb-impact.mjs");

const DEFAULT_EXTENSIONS = new Set([
  ".asax", ".ascx", ".aspx", ".bat", ".cmd", ".config", ".cs", ".cshtml",
  ".csproj", ".css", ".htm", ".html", ".js", ".json", ".md", ".resx",
  ".sln", ".sql", ".txt", ".xml", ".xsd", ".xslt",
]);

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
  console.error("Usage: scan-legaleweb.mjs --project-root <dir> [--out-dir <dir>] [--db-metadata <json>] [--max-file-bytes <n>]");
  process.exit(message ? 1 : 0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${stderr}`);
  }
  return result.stdout ?? "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function shouldKeepFile(projectRoot, file, maxFileBytes) {
  const ext = path.extname(file).toLowerCase();
  if (!DEFAULT_EXTENSIONS.has(ext)) return false;
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  if (
    normalized.includes("/bin/") ||
    normalized.includes("/obj/") ||
    normalized.includes("/packages/") ||
    normalized.includes("/node_modules/") ||
    normalized.includes("/.git/") ||
    normalized.includes("/.vs/")
  ) {
    return false;
  }
  try {
    return fs.statSync(path.join(projectRoot, file)).size <= maxFileBytes;
  } catch {
    return false;
  }
}

function filterScanResult(projectRoot, scan, maxFileBytes) {
  const files = scan.files.filter((file) => shouldKeepFile(projectRoot, file.path, maxFileBytes));
  const byCategory = {};
  const byLanguage = {};
  for (const file of files) {
    byCategory[file.fileCategory] = (byCategory[file.fileCategory] ?? 0) + 1;
    byLanguage[file.language] = (byLanguage[file.language] ?? 0) + 1;
  }
  return {
    ...scan,
    files,
    totalFiles: files.length,
    stats: {
      ...(scan.stats ?? {}),
      filesScanned: files.length,
      byCategory,
      byLanguage,
    },
  };
}

function complexityFor(lines, metrics = {}) {
  if (lines > 300 || metrics.functionCount > 20 || metrics.classCount > 5) return "complex";
  if (lines > 80 || metrics.functionCount > 4 || metrics.classCount > 1) return "moderate";
  return "simple";
}

function safeIdPart(value) {
  return String(value).replace(/[^A-Za-z0-9_.:/-]/g, "_");
}

function tagsFor(result) {
  const tags = [result.language || "unknown"];
  const filePath = result.path.toLowerCase();
  if (filePath.includes("/controllers/")) tags.push("aspnet-mvc", "controller");
  if (filePath.includes("/views/")) tags.push("razor-view");
  if (filePath.includes("/models/")) tags.push("model");
  if (filePath.includes("/dados/")) tags.push("data-access");
  if (filePath.endsWith(".sql")) tags.push("sql", "database");
  if (result.metrics?.classCount) tags.push("classes");
  if (result.metrics?.functionCount) tags.push("functions");
  return [...new Set(tags)].slice(0, 5);
}

function buildBaseGraph(projectRoot, scan, structure, importMap) {
  const nodes = [];
  const edges = [];
  const layers = new Map();

  function layerIdFor(filePath) {
    if (filePath.startsWith("QJW.Dados/Models/")) return "ef-models";
    if (filePath.startsWith("QJW.Dados/SqlChanges/")) return "sql-changes";
    if (filePath.startsWith("QJW.Dados/")) return "data-layer";
    if (filePath.startsWith("QJW.Web/Controllers/")) return "mvc-controllers";
    if (filePath.startsWith("QJW.Web/Views/")) return "mvc-views";
    if (filePath.startsWith("QJW.Web/Models/")) return "web-models";
    if (filePath.startsWith("QJW.Web/Dados/")) return "web-repositories";
    if (filePath.startsWith("Background")) return "background-jobs";
    if (filePath.startsWith("QJW.Relatorios/")) return "reports";
    return "source";
  }

  function addToLayer(id, filePath) {
    const layerId = layerIdFor(filePath);
    if (!layers.has(layerId)) layers.set(layerId, new Set());
    layers.get(layerId).add(id);
  }

  function fileNodeType(result) {
    if (result.language === "sql") return "table";
    if (["config", "xml", "json", "csproj", "sln"].includes(result.language)) return "config";
    if (["markdown", "txt"].includes(result.language)) return "document";
    return "file";
  }

  const nodeIds = new Set();
  for (const result of structure.results) {
    const fileId = `file:${safeIdPart(result.path)}`;
    if (!nodeIds.has(fileId)) {
      nodes.push({
        id: fileId,
        type: fileNodeType(result),
        name: path.basename(result.path),
        filePath: result.path,
        lineRange: [1, Math.max(1, result.totalLines || 1)],
        summary: `${result.path}: ${result.language} file with ${result.metrics?.classCount ?? 0} classes and ${result.metrics?.functionCount ?? 0} functions detected deterministically.`,
        tags: tagsFor(result),
        complexity: complexityFor(result.nonEmptyLines ?? result.totalLines ?? 0, result.metrics),
      });
      nodeIds.add(fileId);
      addToLayer(fileId, result.path);
    }

    for (const cls of result.classes ?? []) {
      const classId = `class:${safeIdPart(result.path)}:${safeIdPart(cls.name)}`;
      if (nodeIds.has(classId)) continue;
      nodes.push({
        id: classId,
        type: "class",
        name: cls.name,
        filePath: result.path,
        lineRange: [cls.startLine || 1, cls.endLine || cls.startLine || 1],
        summary: `Class ${cls.name} in ${result.path}. Methods: ${(cls.methods ?? []).slice(0, 10).join(", ") || "none"}. Properties: ${(cls.properties ?? []).slice(0, 10).join(", ") || "none"}.`,
        tags: result.path.includes("/Models/") ? ["csharp", "model", "ef6"] : ["csharp", "class"],
        complexity: complexityFor((cls.endLine ?? 0) - (cls.startLine ?? 0), { functionCount: cls.methods?.length ?? 0 }),
      });
      nodeIds.add(classId);
      addToLayer(classId, result.path);
      edges.push({ source: fileId, target: classId, type: "contains", direction: "forward", weight: 1, description: "File contains class." });
    }

    for (const fn of result.functions ?? []) {
      const length = (fn.endLine ?? 0) - (fn.startLine ?? 0) + 1;
      if (length < 10) continue;
      const fnId = `function:${safeIdPart(result.path)}:${safeIdPart(fn.name)}:${fn.startLine ?? 1}`;
      if (nodeIds.has(fnId)) continue;
      nodes.push({
        id: fnId,
        type: "function",
        name: fn.name,
        filePath: result.path,
        lineRange: [fn.startLine || 1, fn.endLine || fn.startLine || 1],
        summary: `Function or method ${fn.name} in ${result.path}.`,
        tags: ["csharp", "method"],
        complexity: complexityFor(length),
      });
      nodeIds.add(fnId);
      addToLayer(fnId, result.path);
      edges.push({ source: fileId, target: fnId, type: "contains", direction: "forward", weight: 1, description: "File contains function or method." });
    }
  }

  const fileIdByPath = new Map(nodes.filter((node) => node.filePath).map((node) => [node.filePath, node.id]));
  for (const [sourcePath, targets] of Object.entries(importMap.importMap ?? {})) {
    const source = fileIdByPath.get(sourcePath);
    if (!source) continue;
    for (const targetPath of targets) {
      const target = fileIdByPath.get(targetPath);
      if (!target) continue;
      edges.push({ source, target, type: "imports", direction: "forward", weight: 0.7, description: `${sourcePath} imports ${targetPath}.` });
    }
  }

  const layerNames = {
    "ef-models": "EF6 Models",
    "sql-changes": "SQL Changes",
    "data-layer": "QJW.Dados",
    "mvc-controllers": "MVC Controllers",
    "mvc-views": "Razor Views",
    "web-models": "Web Models",
    "web-repositories": "Web Repositories",
    "background-jobs": "Background Jobs",
    "reports": "Reports",
    "source": "Source",
  };

  return {
    version: "1.0.0",
    kind: "codebase",
    project: {
      name: "Legaleweb",
      languages: Object.keys(scan.stats.byLanguage ?? {}),
      frameworks: ["ASP.NET MVC", "Entity Framework 6", "SQL Server"],
      description: `Deterministic source graph for ${projectRoot}.`,
      analyzedAt: new Date().toISOString(),
      gitCommitHash: run("git", ["-C", projectRoot, "rev-parse", "HEAD"], { capture: true }).trim() || "unknown",
    },
    nodes,
    edges,
    layers: [...layers.entries()].map(([id, ids]) => ({
      id,
      name: layerNames[id] ?? id,
      description: `${layerNames[id] ?? id} files detected by path.`,
      nodeIds: [...ids],
    })),
    tour: [{
      order: 1,
      title: "Legaleweb impact map",
      description: "Start from MVC controllers, repositories, EF6 models, SQL changes, and database impact edges.",
      nodeIds: nodes.slice(0, 20).map((node) => node.id),
    }],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();
  const projectRoot = args["project-root"];
  if (!projectRoot) usage("--project-root is required");
  const resolvedRoot = path.resolve(projectRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) usage(`project root not found: ${projectRoot}`);

  const outDir = path.resolve(args["out-dir"] ?? path.join(resolvedRoot, ".understand-anything"));
  const intermediateDir = path.join(outDir, "intermediate");
  const tmpDir = path.join(outDir, "tmp");
  const maxFileBytes = Number(args["max-file-bytes"] ?? 1024 * 1024);
  fs.mkdirSync(intermediateDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const rawScanPath = path.join(intermediateDir, "scan-raw.json");
  const scanPath = path.join(intermediateDir, "scan-result.json");
  const importInputPath = path.join(intermediateDir, "import-input.json");
  const importMapPath = path.join(intermediateDir, "import-map.json");
  const structureInputPath = path.join(tmpDir, "structure-input.json");
  const structurePath = path.join(tmpDir, "structure.json");
  const baseGraphPath = path.join(outDir, "knowledge-graph.base.json");
  const impactGraphPath = path.join(outDir, "knowledge-graph.legaleweb-impact.json");
  const finalGraphPath = path.join(outDir, "knowledge-graph.json");

  console.log("[1/5] Scanning project files...");
  run(process.execPath, [scanProjectScript, resolvedRoot, rawScanPath]);
  const scan = filterScanResult(resolvedRoot, readJson(rawScanPath), maxFileBytes);
  writeJson(scanPath, scan);

  console.log("[2/5] Extracting import map...");
  writeJson(importInputPath, { projectRoot: resolvedRoot, files: scan.files });
  run(process.execPath, [importMapScript, importInputPath, importMapPath]);
  const importMap = readJson(importMapPath);

  console.log("[3/5] Extracting source structure...");
  writeJson(structureInputPath, { projectRoot: resolvedRoot, batchFiles: scan.files, batchImportData: importMap.importMap ?? {} });
  run(process.execPath, [extractStructureScript, structureInputPath, structurePath]);
  const structure = readJson(structurePath);

  console.log("[4/5] Building base knowledge graph...");
  const baseGraph = buildBaseGraph(resolvedRoot, scan, structure, importMap);
  writeJson(baseGraphPath, baseGraph);

  console.log("[5/5] Enriching Legaleweb impact graph...");
  const enrichArgs = [
    enrichScript,
    "--project-root", resolvedRoot,
    "--graph", baseGraphPath,
    "--out", impactGraphPath,
  ];
  if (args["db-metadata"]) enrichArgs.push("--db-metadata", path.resolve(args["db-metadata"]));
  run(process.execPath, enrichArgs);
  fs.copyFileSync(impactGraphPath, finalGraphPath);
  writeJson(path.join(outDir, "meta.json"), {
    lastAnalyzedAt: new Date().toISOString(),
    gitCommitHash: baseGraph.project.gitCommitHash,
    version: "1.0.0",
    analyzedFiles: scan.totalFiles,
  });
  writeJson(path.join(outDir, "config.json"), { autoUpdate: false, outputLanguage: "pt-BR" });

  const finalGraph = readJson(finalGraphPath);
  console.log(JSON.stringify({
    projectRoot: resolvedRoot,
    outDir,
    filesScanned: scan.totalFiles,
    nodes: finalGraph.nodes.length,
    edges: finalGraph.edges.length,
    layers: finalGraph.layers.length,
    dbMetadataLoaded: Boolean(args["db-metadata"]),
    graph: finalGraphPath,
  }, null, 2));
}

main();
