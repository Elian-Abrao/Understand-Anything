#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error("Usage: normalize-sqlcmd-json.mjs <input> <output>");
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf8").trim();
const withoutControlChars = Array.from(raw)
  .filter((char) => char.charCodeAt(0) >= 32)
  .join("");
const jsonStart = withoutControlChars.indexOf("{");
const jsonEnd = withoutControlChars.lastIndexOf("}");

if (jsonStart < 0 || jsonEnd < jsonStart) {
  throw new Error(`No JSON object found in ${inputPath}`);
}

const jsonText = withoutControlChars.slice(jsonStart, jsonEnd + 1);
const parsed = JSON.parse(jsonText);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  outputPath,
  tables: parsed.tables?.length ?? 0,
  foreignKeys: parsed.foreignKeys?.length ?? 0,
  procedures: parsed.procedures?.length ?? 0,
  views: parsed.views?.length ?? 0,
  triggers: parsed.triggers?.length ?? 0,
}, null, 2));
