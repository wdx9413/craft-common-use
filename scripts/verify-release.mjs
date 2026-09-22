import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(readFileSync(resolve(root, "release.json"), "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const EXTERNAL_PRODUCTS = ["craft-experience", "craft-knowledge", "craft-memory"];
if (JSON.stringify([...release.skills].sort()) !== JSON.stringify(EXTERNAL_PRODUCTS)) throw new Error("release must contain exactly the three external products");
for (const name of release.skills) {
  const skill = resolve(root, "skills", name, "SKILL.md");
  if (!existsSync(skill)) throw new Error(`missing Skill ${name}`);
  if (!release.skill_sha256 || release.skill_sha256[name] !== sha256(skill)) throw new Error(`Skill ${name} digest differs from release.json`);
}
for (const [file, expected] of [["craft-mcp.cjs", release.bundle.craft_mcp_sha256], ["craft-parser-worker.js", release.bundle.parser_worker_sha256]]) {
  const actual = sha256(resolve(root, "bundle", file));
  if (actual !== expected) throw new Error(`${file} digest differs from release.json`);
}
process.stdout.write(`craft-common-use ${release.craft_version}: three products and artifacts verified.\n`);
