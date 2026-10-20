# AI Workforce v2 — Phase 1

A Termux-friendly Node.js agent runner for an authorized GitHub repository. It includes a persistent task queue, seven worker roles, local-first/cloud-fallback model routing, bounded retries, JSONL logs, isolated Git branches, backup refs, file path restrictions, protected-file approval gates, and local-only commits.

## Important boundaries

- The app can clone/fetch a repository using GitHub CLI authentication.
- It reads a limited selection of tracked text files to give the model context.
- The model proposes complete text-file replacements in JSON. The app validates paths and file types before applying.
- It does not execute commands supplied by the model.
- It does not push to GitHub or deploy.
- Changes to protected files (package/dependency manifests, deployment config, CI workflows, secrets-related paths) require explicit `approve <task-id>`.
- Deletion proposals are not supported in Phase 1.
- Existing uncommitted changes block task execution so they are not mixed with AI changes.
- Use this only with a repository you own or are authorized to change. AI can still produce faulty code; review diffs and run project-specific tests before pushing.

## 1. Install on Android Termux

Install current Termux from its official distribution source. In Termux:

```sh
pkg update
pkg install nodejs-lts git gh
termux-setup-storage
mkdir -p ~/ai-workforce-v2
```

Download `ai-workforce-v2.zip` to Android Downloads, then:

```sh
cp ~/storage/downloads/ai-workforce-v2.zip ~/
cd ~
unzip -o ai-workforce-v2.zip -d ~/ai-workforce-v2
cd ~/ai-workforce-v2
cp .env.example .env
nano .env
```

Set `GITHUB_REPO=RKG-CODES/worler` if that is the repository you want. Configure `OPENROUTER_API_KEY` locally only if using cloud mode. Never paste the key into chat or commit `.env`.

Authenticate GitHub without putting a token in the clone URL:

```sh
gh auth login
gh auth status
```

Follow the prompts. Choose GitHub.com and HTTPS; browser/device authentication is preferable where offered. Only grant permissions needed for the repository. For Phase 1 the app clones/fetches and makes local commits; it does not push.

## 2. Start the app

```sh
cd ~/ai-workforce-v2
node app.mjs
```

Then use:

```text
auth
connect
repo
task developer Fix a clear bug in the login page and add an appropriate test if the repository already has a test pattern
queue
run
```

If the task touches a protected file, it will pause and ask for approval. Use `show <task-id>` to inspect the proposed content, then `approve <task-id>` to explicitly approve. Safe changes are applied to a dedicated local branch and committed locally. No push/deploy occurs.

Useful commands:

```text
task manager Plan a safe improvement to WORLER
task tester Review the login flow for edge cases
run-all
queue
show <task-id>
restore <task-id>
mode cloud
mode local
mode auto
```

`restore <task-id>` is destructive to uncommitted changes in the configured workspace; it requires typing an exact confirmation. Do not use it if you have made manual edits you need to keep.

## 3. Cloud AI

OpenRouter: https://openrouter.ai/
Pricing/model list: https://openrouter.ai/pricing and https://openrouter.ai/models?max_price=0

Create an API key on the provider site, then place it only in your local `.env`:
`OPENROUTER_API_KEY=...`
Default model router is `openrouter/free`. Free-model availability and rate limits can change. This system uses one model request for each planning/proposal attempt, and retries may consume more requests.

## 4. Optional local AI

Run a local OpenAI-compatible server at `http://127.0.0.1:8080/v1`; for example, `llama.cpp` can provide `llama-server` with a compatible GGUF model. Install and configure it separately according to official documentation:
https://github.com/ggml-org/llama.cpp/blob/master/docs/android.md

Then set `AI_MODE=local` or use the in-app `mode local`. `auto` tries local first and cloud second. A local model on Android can be slow and requires enough RAM/storage. Never expose the local server publicly.

## 5. What Phase 1 does not automate yet

No GitHub pushes, merges, production deployments, social-media publishing, arbitrary shell commands, deletion, or 24/7 daemon are enabled. Those should be added later as separate integrations with scoped credentials, explicit policies, and auditable approvals. The current queue runs when you enter `run` or `run-all`; background scheduling is a later phase.

## Logs and data

- `state/queue.json`: persistent task queue
- `state/*.proposal.json`: proposed file contents
- `backups/*.json`: task backup metadata
- `logs/workforce.jsonl`: append-only activity log
- `workspaces/worler`: cloned repository

Back up the `state`, `logs`, and `backups` folders if you need an audit trail. Do not share them publicly if they contain private project content.
