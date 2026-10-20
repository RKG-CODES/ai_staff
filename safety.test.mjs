import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// Mirror the safety policy as pure tests so path traversal and protected files are caught.
function safeRelativePath(p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("Empty file path.");
  const normalized = p.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error("Absolute path rejected");
  const parts = normalized.split("/");
  if (parts.some(x => x === ".." || x === "." || x === "")) throw new Error("Unsafe path rejected");
  if (parts.some(x => x.startsWith(".env"))) throw new Error("Environment/secret file rejected");
  return normalized;
}
function needsApproval(file, action = "write") {
  const lower = file.toLowerCase();
  if (action === "delete") return true;
  if (["package.json","package-lock.json","pnpm-lock.yaml","yarn.lock","netlify.toml","vercel.json","dockerfile","docker-compose.yml"].includes(lower)) return true;
  if ([".github/workflows/",".git/","node_modules/","dist/","build/",".env"].some(x => lower.startsWith(x))) return true;
  if (lower.includes("secret") || lower.includes("credential") || lower.includes("token")) return true;
  return false;
}
test("rejects parent traversal", () => assert.throws(() => safeRelativePath("../outside.txt")));
test("rejects absolute paths", () => assert.throws(() => safeRelativePath("/tmp/outside.txt")));
test("rejects env files", () => assert.throws(() => safeRelativePath(".env")));
test("allows a normal relative source path", () => assert.equal(safeRelativePath("src/login.js"), "src/login.js"));
test("protects deployment configuration", () => assert.equal(needsApproval("netlify.toml"), true));
test("deletion always requires approval", () => assert.equal(needsApproval("src/login.js", "delete"), true));
