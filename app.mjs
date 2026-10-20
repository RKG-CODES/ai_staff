import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(ROOT, "state");
const LOGS = path.join(ROOT, "logs");
const WORKSPACES = path.join(ROOT, "workspaces");
const BACKUPS = path.join(ROOT, "backups");
const QUEUE_FILE = path.join(STATE, "queue.json");
const CONFIG_FILE = path.join(STATE, "config.json");
const ENV_FILE = path.join(ROOT, ".env");

for (const dir of [STATE, LOGS, WORKSPACES, BACKUPS]) fs.mkdirSync(dir, { recursive: true });

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

function log(event, details = {}) {
  const entry = { time: new Date().toISOString(), event, ...details };
  fs.appendFileSync(path.join(LOGS, "workforce.jsonl"), JSON.stringify(entry) + "\n");
  console.log(`[${entry.time}] ${event}${details.message ? ": " + details.message : ""}`);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "w" });
  fs.renameSync(tmp, file);
}
function loadQueue() { return readJson(QUEUE_FILE, []); }
function saveQueue(q) { writeJsonAtomic(QUEUE_FILE, q); }
function loadConfig() {
  return readJson(CONFIG_FILE, {
    repo: process.env.GITHUB_REPO || "RKG-CODES/worler",
    repoDir: path.join(ROOT, "workspaces", "worler"),
    maxRetries: 3,
    autoApplySafeChanges: true,
    allowedExtensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".css", ".html", ".md", ".txt", ".yml", ".yaml", ".toml", ".sql", ".sh"],
    protectedPrefixes: [".github/workflows/", ".git/", "node_modules/", "dist/", "build/", ".env"],
    protectedFiles: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "netlify.toml", "vercel.json", "Dockerfile", "docker-compose.yml"]
  });
}
let config = loadConfig();
const rl = readline.createInterface({ input, output });

const workers = {
  manager: { name: "Manager", role: "decomposes work into a safe implementation plan", system: "You are an engineering manager. Turn the task into a small, clear implementation plan. Do not claim to execute actions." },
  developer: { name: "CodeMaster", role: "proposes code edits", system: "You are a senior software engineer. Propose the smallest correct changes. Follow the required JSON schema exactly. Never add secrets, backdoors, tracking, or unrelated changes." },
  tester: { name: "BugHunter", role: "reviews proposed changes and risks", system: "You are a skeptical QA and security reviewer. Identify bugs, risky changes, missing tests, and regressions. Do not claim tests were run." },
  researcher: { name: "Scout", role: "technical investigation and options", system: "You are a careful technical researcher. Distinguish facts from assumptions; do not pretend to browse or access files." },
  writer: { name: "WordSmith", role: "docs and writing", system: "You are a clear technical writer. Keep documentation accurate and concise." },
  marketer: { name: "HypeMan", role: "campaigns and content", system: "You are an honest marketing creative. Do not invent product claims, testimonials, or metrics." },
  analyst: { name: "Numbers", role: "trade-offs and decision support", system: "You are a practical analyst. Explain trade-offs and never invent data." }
};

function runCmd(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    const limit = 1_000_000;
    child.stdout.on("data", d => { if (stdout.length < limit) stdout += d.toString(); });
    child.stderr.on("data", d => { if (stderr.length < limit) stderr += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeout || 120000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${(stderr || stdout).slice(0, 1200)}`));
    });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetries(label, fn, max = config.maxRetries) {
  let last;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      log("attempt", { label, attempt });
      return await fn();
    } catch (e) {
      last = e;
      log("attempt_failed", { label, attempt, message: e.message });
      if (attempt < max) await sleep(Math.min(1500 * 2 ** (attempt - 1), 10000));
    }
  }
  throw last;
}

function safeRelativePath(p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("Empty file path.");
  const normalized = p.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error(`Absolute path rejected: ${p}`);
  const parts = normalized.split("/");
  if (parts.some(x => x === ".." || x === "." || x === "")) throw new Error(`Unsafe path rejected: ${p}`);
  if (parts.some(x => x.startsWith(".env"))) throw new Error(`Environment/secret file rejected: ${p}`);
  if (normalized.includes("\0")) throw new Error("NUL in path.");
  return normalized;
}
function needsApproval(file, action = "write") {
  const lower = file.toLowerCase();
  if (action === "delete") return true;
  if (config.protectedFiles.some(x => lower === x.toLowerCase())) return true;
  if (config.protectedPrefixes.some(x => lower.startsWith(x.toLowerCase()))) return true;
  if (lower.includes("secret") || lower.includes("credential") || lower.includes("token")) return true;
  return false;
}
function getRepoDir() { return config.repoDir; }

async function ensureRepo() {
  const repoDir = getRepoDir();
  if (fs.existsSync(path.join(repoDir, ".git"))) {
    await withRetries("git fetch", () => runCmd("git", ["fetch", "--all", "--prune"], { cwd: repoDir }));
    return repoDir;
  }
  const repo = config.repo || process.env.GITHUB_REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || "")) throw new Error("Repo must look like owner/name.");
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  // Prefer GitHub CLI authentication. Never put a token in the clone URL.
  await withRetries("git clone", () => runCmd("gh", ["repo", "clone", repo, repoDir], { cwd: ROOT }));
  return repoDir;
}

async function checkGitAuth() {
  try {
    const { stdout } = await runCmd("gh", ["auth", "status"]);
    log("github_auth", { message: "GitHub CLI authentication detected." });
    console.log(stdout);
  } catch {
    console.log("GitHub CLI auth not detected. Run: gh auth login");
    console.log("Choose GitHub.com, HTTPS, and browser/device login if offered. Never paste a token into this chat.");
  }
}

function parseJsonFromModel(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model did not return a JSON object.");
  return JSON.parse(text.slice(start, end + 1));
}
async function requestModel(system, user, forceCloud = false) {
  const mode = (process.env.AI_MODE || "auto").toLowerCase();
  const localUrl = (process.env.LOCAL_BASE_URL || "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
  const localModel = process.env.LOCAL_MODEL || "local-model";
  const key = process.env.OPENROUTER_API_KEY;
  const cloudModel = process.env.CLOUD_MODEL || "openrouter/free";
  async function call(base, model, apiKey) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST", headers, signal: controller.signal,
        body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.2 })
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`Model HTTP ${res.status}: ${raw.slice(0, 500)}`);
      const data = JSON.parse(raw);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("Empty model response.");
      return content.trim();
    } finally { clearTimeout(timer); }
  }
  if (forceCloud || mode === "cloud") {
    if (!key) throw new Error("Cloud key not configured. Set it locally in .env.");
    return withRetries("cloud model", () => call("https://openrouter.ai/api/v1", cloudModel, key));
  }
  if (mode === "local") return withRetries("local model", () => call(localUrl, localModel, ""));
  try {
    return await withRetries("local model", () => call(localUrl, localModel, ""), 1);
  } catch (e) {
    if (!key) throw new Error(`Local model unavailable (${e.message}); no cloud key configured.`);
    log("model_fallback", { message: "Local unavailable; switching to cloud." });
    return withRetries("cloud fallback", () => call("https://openrouter.ai/api/v1", cloudModel, key));
  }
}

async function gitSnapshot(repoDir, taskId) {
  await runCmd("git", ["status", "--short"], { cwd: repoDir });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const branch = `ai-workforce/${taskId}-${stamp}`;
  const current = (await runCmd("git", ["branch", "--show-current"], { cwd: repoDir })).stdout || "main";
  const status = (await runCmd("git", ["status", "--porcelain"], { cwd: repoDir })).stdout;
  if (status) throw new Error("Repository has uncommitted user changes. Commit/stash them first; refusing to mix them with AI work.");
  await runCmd("git", ["fetch", "origin"], { cwd: repoDir }).catch(e => log("fetch_warning", { message: e.message }));
  await runCmd("git", ["checkout", current], { cwd: repoDir });
  await runCmd("git", ["pull", "--ff-only"], { cwd: repoDir }).catch(e => log("pull_warning", { message: e.message }));
  await runCmd("git", ["checkout", "-b", branch], { cwd: repoDir });
  const backupRef = `refs/ai-workforce/backups/${taskId}`;
  await runCmd("git", ["update-ref", backupRef, "HEAD"], { cwd: repoDir });
  writeJsonAtomic(path.join(BACKUPS, `${taskId}.json`), { taskId, repoDir, originalBranch: current, branch, backupRef, createdAt: new Date().toISOString() });
  log("workspace_created", { taskId, branch, backupRef });
  return { branch, current, backupRef };
}

async function restoreTask(taskId) {
  const b = readJson(path.join(BACKUPS, `${taskId}.json`), null);
  if (!b) throw new Error("No backup metadata found for this task.");
  await runCmd("git", ["reset", "--hard", b.backupRef], { cwd: b.repoDir });
  await runCmd("git", ["clean", "-fd"], { cwd: b.repoDir });
  log("restored", { taskId, message: "Workspace restored to pre-task backup ref." });
}

async function createTask(taskText, worker = "developer") {
  const q = loadQueue();
  const task = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    worker, text: taskText, status: "queued", createdAt: new Date().toISOString(),
    attempts: 0, proposalFile: null, changes: [], error: null
  };
  q.push(task); saveQueue(q); log("task_queued", { taskId: task.id, worker, message: taskText.slice(0, 160) });
  return task;
}

async function planTask(task) {
  const w = workers[task.worker] || workers.developer;
  const schema = `Return ONLY valid JSON with this schema:
{"summary":"short summary","files":[{"path":"relative/path","action":"write","content":"FULL file content"}],"tests":["suggested test names"],"risks":["risk"],"notes":"brief notes"}
Rules:
- Propose only full-file writes, no shell commands, no deletions, no symlinks, no binary files.
- Maximum ${Number(process.env.MAX_FILES_PER_TASK || 12)} files. Each file content must be under ${Number(process.env.MAX_FILE_BYTES || 200000)} bytes.
- Do not edit secrets, credentials, .env files, dependencies/lockfiles, deployment config, CI workflows, or protected files.
- You may use relevant repository context supplied below; do not claim to have read files not included.
- Make minimal changes. If you cannot safely complete the task, return files: [] and explain why.`;
  const repoDir = getRepoDir();
  const context = await repoContext(repoDir, task.text);
  const answer = await requestModel(`${w.system}\n${schema}`, `Task: ${task.text}\n\nRepository context (selected text only):\n${context}`);
  const proposal = parseJsonFromModel(answer);
  if (!Array.isArray(proposal.files)) throw new Error("Proposal JSON has no files array.");
  if (proposal.files.length > Number(process.env.MAX_FILES_PER_TASK || 12)) throw new Error("Model proposal exceeds maximum files.");
  const changes = [];
  for (const f of proposal.files) {
    const rel = safeRelativePath(f.path);
    if (f.action !== "write") throw new Error(`Unsupported action for ${rel}; only write is supported.`);
    if (typeof f.content !== "string") throw new Error(`Missing content for ${rel}.`);
    if (Buffer.byteLength(f.content, "utf8") > Number(process.env.MAX_FILE_BYTES || 200000)) throw new Error(`File too large: ${rel}`);
    const ext = path.extname(rel).toLowerCase();
    if (config.allowedExtensions.length && ext && !config.allowedExtensions.includes(ext)) throw new Error(`File extension not allowlisted: ${rel}`);
    const protectedChange = needsApproval(rel, "write");
    const target = path.resolve(repoDir, rel);
    if (!target.startsWith(path.resolve(repoDir) + path.sep)) throw new Error(`Path escapes repository: ${rel}`);
    changes.push({ path: rel, content: f.content, approvalRequired: protectedChange, existed: fs.existsSync(target) });
  }
  const proposalPath = path.join(STATE, `${task.id}.proposal.json`);
  writeJsonAtomic(proposalPath, { taskId: task.id, summary: proposal.summary || "", files: changes.map(({ content, ...meta }) => ({ ...meta, content })), tests: proposal.tests || [], risks: proposal.risks || [], notes: proposal.notes || "" });
  task.proposalFile = proposalPath;
  task.changes = changes.map(({ content, ...meta }) => meta);
  task.summary = proposal.summary || "";
  task.tests = proposal.tests || [];
  task.risks = proposal.risks || [];
  task.notes = proposal.notes || "";
  task.status = changes.some(c => c.approvalRequired) ? "awaiting_approval" : "proposed";
  task.updatedAt = new Date().toISOString();
  saveTask(task);
  log("proposal_created", { taskId: task.id, files: task.changes.map(c => c.path), status: task.status });
  return task;
}
async function repoContext(repoDir, task) {
  const list = (await runCmd("git", ["ls-files"], { cwd: repoDir })).stdout.split("\n").filter(Boolean);
  const keywords = [...new Set((task.toLowerCase().match(/[a-z0-9_-]{3,}/g) || []).filter(x => !["the","and","for","with","from","into","this","that","make","please","fix"].includes(x)))];
  const candidates = list.filter(f => /\.(js|mjs|cjs|ts|tsx|jsx|json|css|html|md|txt|yml|yaml|toml|sql)$/i.test(f) && !f.startsWith("node_modules/") && !f.startsWith("dist/"));
  candidates.sort((a,b) => scorePath(b, keywords) - scorePath(a, keywords));
  let out = "";
  for (const rel of candidates.slice(0, 12)) {
    try {
      const data = fs.readFileSync(path.join(repoDir, rel), "utf8");
      if (Buffer.byteLength(data) > 18000) continue;
      out += `\n--- FILE: ${rel} ---\n${data.slice(0, 18000)}\n`;
      if (out.length > 60000) break;
    } catch {}
  }
  return out || "(No suitable tracked text files found.)";
}
function scorePath(p, words) {
  const low = p.toLowerCase();
  return words.reduce((s,w) => s + (low.includes(w) ? 4 : 0), 0) + (/\.(js|mjs|ts|tsx|jsx)$/.test(low) ? 1 : 0);
}
function saveTask(task) {
  const q = loadQueue(); const i = q.findIndex(x => x.id === task.id);
  if (i >= 0) q[i] = task; else q.push(task);
  saveQueue(q);
}
function getTask(id) { return loadQueue().find(t => t.id === id); }

async function applyProposal(task, explicitApproval = false) {
  const proposal = readJson(task.proposalFile, null);
  if (!proposal) throw new Error("Proposal file missing or unreadable.");
  const repoDir = getRepoDir();
  for (const f of proposal.files) {
    if (f.approvalRequired && !explicitApproval) throw new Error(`Approval required for ${f.path}.`);
    const rel = safeRelativePath(f.path);
    const target = path.resolve(repoDir, rel);
    if (!target.startsWith(path.resolve(repoDir) + path.sep)) throw new Error("Path escapes repository.");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Atomic replacement; never follow a pre-existing symlink.
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${rel}`);
    const tmp = `${target}.aiwf-${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, f.content, { flag: "wx" });
    fs.renameSync(tmp, target);
  }
  await runCmd("git", ["add", "--", ...proposal.files.map(f => f.path)], { cwd: repoDir });
  const diffCheck = await runCmd("git", ["diff", "--cached", "--check"], { cwd: repoDir });
  const diff = await runCmd("git", ["diff", "--cached", "--stat"], { cwd: repoDir });
  task.diffStat = diff.stdout;
  task.status = "applied_uncommitted";
  task.appliedAt = new Date().toISOString();
  saveTask(task);
  log("proposal_applied", { taskId: task.id, message: diff.stdout || "No diff summary." });
  return diffCheck;
}
async function runRepositoryTests(repoDir) {
  // Only run the repository's conventional npm test script when one is declared.
  // The script is part of the trusted repository; inspect it before using this tool on an unfamiliar repo.
  const pkgPath = path.join(repoDir, "package.json");
  if (!fs.existsSync(pkgPath)) return { ok: true, message: "No package.json; skipped automatic project tests." };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); }
  catch { return { ok: false, message: "package.json is invalid JSON; tests not run." }; }
  if (!pkg.scripts || typeof pkg.scripts.test !== "string" || !pkg.scripts.test.trim()) {
    return { ok: true, message: "No npm test script declared; skipped automatic project tests." };
  }
  try {
    const result = await withRetries("npm test", () => runCmd("npm", ["test"], { cwd: repoDir, timeout: 180000 }), 1);
    return { ok: true, message: (result.stdout + "\n" + result.stderr).trim().slice(-3000) || "npm test passed." };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function commitTask(task) {
  const repoDir = getRepoDir();
  const status = (await runCmd("git", ["status", "--porcelain"], { cwd: repoDir })).stdout;
  if (!status) { task.status = "completed"; saveTask(task); return; }
  await runCmd("git", ["commit", "-m", `AI Workforce: ${task.text.slice(0, 60).replace(/[\r\n]/g," ")}`], { cwd: repoDir });
  task.status = "completed_local_commit";
  task.completedAt = new Date().toISOString();
  saveTask(task);
  log("task_committed_locally", { taskId: task.id, message: "Local branch commit created; not pushed or deployed." });
}
async function runNext() {
  const task = loadQueue().find(t => t.status === "queued" || t.status === "retry");
  if (!task) { console.log("No queued tasks."); return; }
  task.status = "running"; task.attempts += 1; saveTask(task);
  try {
    await ensureRepo();
    const repoDir = getRepoDir();
    const snap = await gitSnapshot(repoDir, task.id);
    task.branch = snap.branch; task.backupRef = snap.backupRef; saveTask(task);
    await withRetries(`task ${task.id}`, async () => planTask(task), config.maxRetries);
    const refreshed = getTask(task.id);
    if (refreshed.status === "awaiting_approval") {
      console.log(`Task ${task.id} needs approval because it touches protected files.`);
      return;
    }
    await applyProposal(refreshed, false);
    const testResult = await runRepositoryTests(repoDir);
    if (!testResult.ok) {
      refreshed.status = "tests_failed";
      refreshed.error = testResult.message;
      saveTask(refreshed);
      log("repository_tests_failed", { taskId: refreshed.id, message: testResult.message });
      console.log(`Tests failed. Changes remain isolated on branch ${snap.branch}; they were NOT committed or pushed. Review with show ${task.id}, then fix or restore.`);
      return;
    }
    log("repository_tests_passed", { taskId: refreshed.id, message: testResult.message });
    await commitTask(refreshed);
    console.log(`Task ${task.id} finished. Changes are committed locally on branch ${snap.branch}; nothing was pushed or deployed.`);
  } catch (e) {
    task.status = task.attempts < config.maxRetries ? "retry" : "failed";
    task.error = e.message; task.updatedAt = new Date().toISOString(); saveTask(task);
    log("task_failed", { taskId: task.id, status: task.status, message: e.message });
    console.log(`Task ${task.id}: ${e.message}`);
  }
}
async function approveTask(id) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found.");
  if (!["awaiting_approval", "proposed", "applied_uncommitted"].includes(task.status)) throw new Error(`Task status is ${task.status}, not approvable.`);
  console.log(`\nTask: ${task.text}\nSummary: ${task.summary || "(none)"}`);
  const proposal = readJson(task.proposalFile, null);
  if (!proposal) throw new Error("Proposal missing.");
  console.log("Files:");
  for (const f of proposal.files) console.log(` - ${f.path}${f.approvalRequired ? " [PROTECTED]" : ""}${f.existed ? " [existing]" : " [new]"}`);
  console.log("Risks:", (task.risks || []).join("; ") || "none stated");
  console.log("Review diff before approving. No push or deploy is performed.");
  const answer = (await rl.question(`Type APPROVE ${id} to apply/commit this proposal: `)).trim();
  if (answer !== `APPROVE ${id}`) { console.log("Cancelled."); return; }
  if (task.status !== "applied_uncommitted") await applyProposal(task, true);
  await commitTask(task);
  console.log("Approved and committed locally. Review the branch before pushing.");
}
async function showTask(id) {
  const task = getTask(id);
  if (!task) throw new Error("Task not found.");
  console.log(JSON.stringify(task, null, 2));
  if (task.proposalFile && fs.existsSync(task.proposalFile)) {
    const p = readJson(task.proposalFile, {});
    console.log("\nPROPOSAL PREVIEW:");
    for (const f of p.files || []) {
      console.log(`\n--- ${f.path} ${f.approvalRequired ? "[APPROVAL REQUIRED]" : ""} ---`);
      console.log((f.content || "").split("\n").slice(0, 50).join("\n"));
      if ((f.content || "").split("\n").length > 50) console.log("... (preview truncated; full proposal is in state/)");
    }
  }
}
function showQueue() {
  const q = loadQueue();
  if (!q.length) { console.log("Queue empty."); return; }
  for (const t of q) console.log(`${t.id} | ${t.status.padEnd(20)} | ${t.worker.padEnd(10)} | ${t.text.slice(0, 100)}`);
}
function printHelp() {
  console.log(`
AI WORKFORCE v2 — Phase 1
  auth                 Check GitHub CLI auth status
  connect              Clone/fetch configured GitHub repo
  repo                 Show repository configuration/status
  task <worker> <text> Queue a task (developer, manager, tester, researcher, writer, marketer, analyst)
  run                  Run one queued task
  run-all              Process queued tasks one by one
  queue                List tasks and status
  show <task-id>       Show task and proposal preview
  approve <task-id>    Approve a protected proposal; asks for exact confirmation
  restore <task-id>    Restore current workspace to its pre-task backup ref (DESTRUCTIVE; confirms)
  mode auto|cloud|local Set AI provider mode in current process
  help                 Show commands
  exit                 Quit

Autonomy rules:
- AI output is data only. The app never executes AI-proposed shell commands.
- Each task uses a dedicated local branch and a backup Git ref.
- AI changes are only full-file writes to allowlisted text extensions.
- Secret files and paths outside the repository are blocked.
- Protected files require explicit approval.
- Nothing is pushed to GitHub or deployed automatically.
`);
}
async function main() {
  console.log("🤖 AI WORKFORCE v2 — GitHub-connected, approval-gated");
  console.log("This app will not push code or deploy. Type help.");
  let modeOverride = null;
  while (true) {
    let line;
    try { line = (await rl.question("\nCEO > ")).trim(); } catch { break; }
    if (!line) continue;
    const [cmd, ...rest] = line.split(" ");
    const arg = rest.join(" ").trim();
    try {
      if (cmd === "exit" || cmd === "quit") break;
      if (cmd === "help") printHelp();
      else if (cmd === "auth") await checkGitAuth();
      else if (cmd === "connect") {
        await ensureRepo();
        const status = await runCmd("git", ["status", "--short", "--branch"], { cwd: getRepoDir() });
        console.log(status.stdout || "Repository connected.");
      } else if (cmd === "repo") {
        console.log(`Repository: ${config.repo}\nPath: ${getRepoDir()}`);
        if (fs.existsSync(path.join(getRepoDir(), ".git"))) console.log((await runCmd("git", ["status", "--short", "--branch"], { cwd: getRepoDir() })).stdout);
        else console.log("Not cloned yet. Run connect.");
      } else if (cmd === "task") {
        const split = arg.indexOf(" ");
        if (split < 1) { console.log("Usage: task <worker> <task text>"); continue; }
        const worker = arg.slice(0, split).toLowerCase();
        if (!workers[worker]) { console.log(`Unknown worker. Options: ${Object.keys(workers).join(", ")}`); continue; }
        const t = await createTask(arg.slice(split + 1), worker);
        console.log(`Queued task: ${t.id}`);
      } else if (cmd === "run") await runNext();
      else if (cmd === "run-all") {
        while (loadQueue().some(t => t.status === "queued" || t.status === "retry")) await runNext();
      } else if (cmd === "queue") showQueue();
      else if (cmd === "show") await showTask(arg);
      else if (cmd === "approve") await approveTask(arg);
      else if (cmd === "restore") {
        const answer = (await rl.question(`This will discard uncommitted changes in the task workspace and reset to its backup. Type RESTORE ${arg}: `)).trim();
        if (answer === `RESTORE ${arg}`) await restoreTask(arg);
        else console.log("Cancelled.");
      } else if (cmd === "mode") {
        const m = arg.toLowerCase();
        if (!["auto","cloud","local"].includes(m)) console.log("Use mode auto|cloud|local");
        else { process.env.AI_MODE = m; console.log(`Mode set to ${m} for this session.`); }
      } else console.log('Unknown command. Type "help".');
    } catch (e) {
      log("command_error", { command: cmd, message: e.message });
      console.log(`Error: ${e.message}`);
    }
  }
  rl.close();
}
main();
