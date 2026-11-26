import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Plan 129 SP06 (ENG-9911) - NO MODEL CALL FROM THIS REPOSITORY.
 *
 * Every paid model call goes through the backend's meter (`LlmMeter`), which
 * books it in `llm_token_usage`. A model SDK or a model-call path here would
 * be a call the ledger never sees, so this fails, naming the file, on:
 *  - an import of `@aws-sdk/client-bedrock-runtime`, `@anthropic-ai/sdk` or
 *    `openai` (static, dynamic or `require`);
 *  - any text containing the Anthropic Messages path or the OpenAI chat
 *    completions path.
 * The paths are written split below so this file does not match itself; it
 * is also excluded by name.
 *
 * A SCAN THAT READ NOTHING MUST NOT PASS: the file count is asserted, a known
 * source file must be among those read, and each detector is shown to fire
 * on a planted source first. What it does not cover: a model reached through
 * another SDK or an endpoint with a different path.
 */

const ROOT = process.cwd();
const SELF = "src/__tests__/model-call-boundary.test.ts";
const KNOWN = "src/server.ts";
const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(entry)) out.push(relative(ROOT, full));
  }
  return out;
}

function roots(): string[] {
  const found = ["src", "scripts"].filter((r) => existsSync(join(ROOT, r)));
  if (existsSync(join(ROOT, "packages"))) {
    for (const pkg of readdirSync(join(ROOT, "packages"))) {
      const src = join("packages", pkg, "src");
      if (existsSync(join(ROOT, src))) found.push(src);
    }
  }
  return found;
}

const files = roots()
  .flatMap((r) => walk(join(ROOT, r)))
  .map((f) => f.split("\\").join("/"))
  .filter((f) => f !== SELF);
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

const SDKS = ["@aws-sdk/client-bedrock-runtime", "@anthropic-ai/sdk", "openai"];
const MODEL_PATHS = ["/v1" + "/messages", "/chat" + "/completions"];
const quoted = SDKS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const SDK_IMPORT = new RegExp(
  `(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)["'](?:${quoted.join("|")})(?:/[^"']*)?["']`,
);

function offencesIn(file: string, source: string): string[] {
  const out: string[] = [];
  const sdk = SDK_IMPORT.exec(source);
  if (sdk) out.push(`${file}: imports a model SDK (${sdk[0]})`);
  for (const path of MODEL_PATHS) {
    if (source.includes(path)) out.push(`${file}: names the model path ${path}`);
  }
  return out;
}

describe("no model call from this repository (plan 129 SP06)", () => {
  it("actually read the tree it polices", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(KNOWN);
  });

  it("every detector fires on a planted source (positive control)", () => {
    const planted = [
      `import { BedrockRuntimeClient } from "${SDKS[0]}";`,
      `const Anthropic = await import("${SDKS[1]}");`,
      `const OpenAI = require("${SDKS[2]}/index");`,
      `fetch(base + "${MODEL_PATHS[0]}");`,
      `fetch(base + "${MODEL_PATHS[1]}");`,
    ];
    expect(planted.map((line) => offencesIn("plant.ts", line).length)).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  it("imports no model SDK and names no model-call path", () => {
    expect(files.flatMap((file) => offencesIn(file, read(file)))).toEqual([]);
  });
});
