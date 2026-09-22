import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const marketplace = resolve(process.argv[2] ?? "../craft-marketplace");
const apply = process.argv.includes("--apply");
const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(readFileSync(resolve(marketplace, "release.json"), "utf8"));
const products = [...release.components].map(String).sort();
if (!products.length || new Set(products).size !== products.length) throw new Error("marketplace must expose a non-empty unique Craft product set");
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const product of products) if (!existsSync(resolve(marketplace, "plugins", product, "skills", product, "SKILL.md"))) throw new Error(`missing marketplace Skill ${product}`);
if (!apply) { process.stdout.write("Validated marketplace input; re-run with --apply to synchronize.\n"); process.exit(0); }
for (const product of products) cpSync(resolve(marketplace, "plugins", product, "skills", product), resolve(root, "skills", product), { recursive: true, force: true });
for (const file of ["craft-mcp.cjs", "craft-parser-worker.js"]) cpSync(resolve(marketplace, "plugins", "craft-memory", "dist", "plugin", file), resolve(root, "bundle", file), { force: true });
const local = JSON.parse(readFileSync(resolve(root, "release.json"), "utf8"));
local.craft_version = release.version; local.source_commit = release.source_commit; local.source_state = release.source_state; local.source_note = release.source_note;
local.bundle = { craft_mcp_sha256: digest(resolve(root, "bundle", "craft-mcp.cjs")), parser_worker_sha256: digest(resolve(root, "bundle", "craft-parser-worker.js")) };
local.skills = products;
local.skill_sha256 = Object.fromEntries(products.map((product) => [product, digest(resolve(root, "skills", product, "SKILL.md"))]));
writeFileSync(resolve(root, "release.json"), `${JSON.stringify(local, null, 2)}\n`);
process.stdout.write(`Synchronized craft-common-use from marketplace ${release.version}.\n`);
