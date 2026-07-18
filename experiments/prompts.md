# WhiteNoise Test Prompts

**Instructions for the human:** Copy-paste each prompt into Claude Desktop. Do not help the model. Let it discover tools, read types, and compose `execute_code` on its own.

**Instructions for the model (already in system prompt):**
- Use `search_tools(query)` to discover wrappers
- Use `read_module(specifier)` to inspect types
- Use `execute_code(code)` with `mcp/...` imports to chain calls
- Intermediate results stay inside the worker

---

## Easy Tier (3 MCPs per test)

### E1: Web Research & Database

> Find the top 3 articles about MCP server security best practices from 2024, store their titles and URLs in a local database at `/tmp/research.db`, and write a summary report to `/tmp/mcp-security-report.md`.

**Expected MCPs:** `braveSearch`, `sqlite`, `filesystem`
**Validation:** `/tmp/research.db` has ≥3 rows, `/tmp/mcp-security-report.md` exists

---

### E2: Project Health Check

> Analyze the whitenoise project at `/mnt/c/Users/Dhyaneesh/whitenoise`. Look at recent git activity, count the TypeScript source files, check the dependencies in package.json, and tell me if this looks like a well-maintained project. Save your full analysis with reasoning to `/tmp/whitenoise-health.md`.

**Expected MCPs:** `git`, `filesystem`, `sequentialThinking`
**Validation:** `/tmp/whitenoise-health.md` exists with git stats, file counts, and reasoning

---

### E3: Web Scraping to Database

> Navigate to https://news.ycombinator.com, extract the top 10 story titles and their URLs, save the raw HTML to `/tmp/hn.html`, store the structured data in `/tmp/hn.db`, and export the top 10 stories as JSON to `/tmp/hn-top10.json`.

**Expected MCPs:** `puppeteer`, `filesystem`, `sqlite`
**Validation:** `/tmp/hn.html`, `/tmp/hn.db` (≥10 rows), `/tmp/hn-top10.json` all exist

---

## Medium Tier (5-6 MCPs per test)

### M1: Competitive Intelligence

> I'm considering building a competitor to whitenoise. Research what other MCP proxy or meta-tool projects exist. Search the web, scrape their landing pages for features, compare them to whitenoise by reading the local project files and git history. Store structured comparison data in `/tmp/competitors.db` (table: `competitors` with name, features, github_stars, vs_whitenoise). Use sequential thinking to analyze the gaps. Save your final recommendation to `/tmp/competitive-analysis.md`.

**Expected MCPs:** `braveSearch`, `puppeteer`, `filesystem`, `sqlite`, `sequentialThinking`, `git`
**Validation:**
- `/tmp/competitors.db` has ≥3 rows
- `/tmp/competitive-analysis.md` has reasoning + comparison table

---

### M2: Issue Investigation

> There's a critical bug pattern in MCP filesystem servers. Search GitHub for the most-discussed open issue in the `modelcontextprotocol/server-filesystem` repository. Save the issue details to `/tmp/issue.json`. Use sequential thinking to analyze the technical root cause. Look up any related documentation you can find. Create a SQLite bug tracking database at `/tmp/bugs.db` with the issue, severity, root cause, and fix recommendation. Save the full investigation to `/tmp/bug-report.md`.

**Expected MCPs:** `github`, `filesystem`, `sequentialThinking`, `sqlite`, `context7`
**Validation:**
- `/tmp/issue.json` has GitHub issue data
- `/tmp/bugs.db` has bug table with ≥1 row
- `/tmp/bug-report.md` has analysis

---

### M3: Data Migration Pipeline

> Create a SQLite database at `/tmp/sensors.db` with a table `readings` (id, timestamp, temperature, humidity). Insert 100 realistic sample sensor readings. Plan a migration strategy using sequential thinking. Migrate all data to the local Postgres database `whitenoise_test`. Verify the migration by querying Postgres and comparing row counts. Log the migration plan and results to `/tmp/migration-log.md`.

**Expected MCPs:** `sqlite`, `postgres`, `sequentialThinking`, `filesystem`, `git`
**Validation:**
- `/tmp/sensors.db` has 100 rows
- Postgres `whitenoise_test` has `readings` table with 100 rows
- `/tmp/migration-log.md` has plan + verification

---

## Hard Tier (7-9 MCPs per test)

### H1: Autonomous Research Agent

> Act as a research agent. I need to understand the current landscape of AI agent orchestration frameworks (LangChain, LlamaIndex, CrewAI, AutoGen, etc.). Here's your mission:
>
> 1. Plan your research strategy with sequential thinking
> 2. Search the web for the latest developments on these frameworks
> 3. Scrape the official documentation pages for feature matrices
> 4. Check GitHub repos for each framework to get stars, activity, and open issues
> 5. Read the whitenoise codebase to understand how it handles orchestration
> 6. Store all raw findings in SQLite (`/tmp/research.db`) for quick queries
> 7. Store normalized data in Postgres (`whitenoise_test.research_archive`) for persistence
> 8. Use git to analyze which files in whitenoise handle downstream server connections
> 9. Synthesize everything into a comprehensive report at `/tmp/agent-framework-report.md` with rankings, pros/cons, and integration recommendations
>
> If any tool fails, continue with the rest and note the failure.

**Expected MCPs:** `sequentialThinking`, `braveSearch`, `puppeteer`, `github`, `filesystem`, `sqlite`, `postgres`, `git` (8 MCPs)
**Validation:**
- `/tmp/research.db` has framework data
- Postgres `research_archive` table has data
- `/tmp/agent-framework-report.md` has ≥2000 words with rankings
- Evidence of web search, GitHub queries, and local file reads

---

### H2: Debug Forensics

> Something is wrong with the whitenoise TypeScript build. I suspect a recent commit broke it. Conduct a full forensic investigation:
>
> 1. Use sequential thinking to hypothesize what could break a TypeScript MCP proxy build
> 2. Check git history for the last 10 commits and identify suspicious changes
> 3. Read tsconfig.json, package.json, and the main entry point for build config issues
> 4. Search online for similar build failures in MCP or TypeScript projects
> 5. Scrape any relevant Stack Overflow or GitHub issue pages you find
> 6. Check if upstream dependencies (like `@modelcontextprotocol/sdk`) have reported issues on GitHub
> 7. Create an incident database at `/tmp/incidents.db` with: incident_id, suspected_commit, files_changed, root_cause_hypothesis, evidence_sources, recommended_fix
> 8. Save the complete investigation with timeline to `/tmp/build-forensics.md`
>
> Even if the build isn't actually broken, document your investigation process and findings.

**Expected MCPs:** `sequentialThinking`, `git`, `filesystem`, `github`, `braveSearch`, `puppeteer`, `sqlite` (7 MCPs)
**Validation:**
- `/tmp/incidents.db` has investigation table with ≥1 row
- `/tmp/build-forensics.md` has timeline, commits, and recommendations
- Evidence of web search and GitHub issue checks

---

### H3: Multi-Source Market Analysis

> I need to choose an AI agent framework for my startup. Do a comprehensive multi-source analysis:
>
> 1. Search the web for "best AI agent frameworks 2025" and get the top 5 candidates
> 2. For each candidate, find its GitHub repo and extract: stars, last commit date, open issues count, README summary
> 3. Scrape each framework's documentation homepage for key features
> 4. Read the whitenoise project files to see if any patterns could inform our architecture choice
> 5. Check whitenoise git history to see how the project evolved (what files changed most?)
> 6. Create a SQLite comparison matrix at `/tmp/frameworks.db` with: name, language, stars, maturity_score, feature_count, docs_quality, whitenoise_compatibility
> 7. Create a Postgres table `framework_analysis` with normalized scoring
> 8. Use sequential thinking to weight factors and rank the frameworks
> 9. Generate an executive summary at `/tmp/framework-choice.md` with: top pick, runner-up, risk assessment, and integration plan
>
> This must use parallel queries where possible to speed up data collection.

**Expected MCPs:** `braveSearch`, `github`, `puppeteer`, `filesystem`, `sqlite`, `postgres`, `sequentialThinking`, `git` (8 MCPs)
**Validation:**
- `/tmp/frameworks.db` has ≥5 framework rows with scoring
- Postgres `framework_analysis` has data
- `/tmp/framework-choice.md` has executive summary with pick + rationale

---

## Hell Mode (All 10 MCPs)

### X1: The Ultimate System Audit

> Execute a comprehensive audit of the AI tooling ecosystem as it relates to Model Context Protocol. This is your ultimate test:
>
> 1. Plan a multi-phase audit strategy using sequential thinking (minimum 5 reasoning steps)
> 2. Search the web for the latest MCP developments, new servers, and community trends
> 3. Scrape the official MCP documentation site for the server list and capabilities
> 4. Search GitHub for trending MCP server implementations created in 2024-2025
> 5. For the top 3 repos you find, extract: stars, forks, description, primary language
> 6. Read ALL local project files in `/mnt/c/Users/Dhyaneesh/whitenoise` (source, tests, configs)
> 7. Analyze whitenoise git history: most active contributors, commit frequency, largest changes
> 8. Look up any framework documentation via context7 that could help evaluate MCP patterns
> 9. If Chrome is available with remote debugging, analyze any web-based MCP dashboard or docs page
> 10. Store all structured findings in SQLite (`/tmp/audit.db`) with tables: `web_sources`, `github_repos`, `local_files`, `git_stats`, `framework_insights`
> 11. Store a normalized summary in Postgres (`whitenoise_test.audit_summary`)
> 12. Generate three outputs:
>     - `/tmp/audit-technical.md` — deep technical analysis
>     - `/tmp/audit-strategic.md` — business/strategic recommendations
>     - `/tmp/audit-gaps.md` — what whitenoise is missing vs competitors
>
> **Fault tolerance requirement:** If any MCP fails (e.g., context7 needs credentials, Chrome not running), catch the error, log it, and continue with the remaining 9 MCPs. The final report must note which tools were unavailable and how the audit adapted.

**Expected MCPs:** ALL 10 (`sequentialThinking`, `braveSearch`, `puppeteer`, `github`, `filesystem`, `sqlite`, `postgres`, `git`, `context7`, `chromeDevtools`)
**Validation:**
- `/tmp/audit.db` has ≥5 tables with data
- Postgres `audit_summary` has data
- All 3 markdown reports exist and are ≥1500 words each
- Reports mention which MCPs failed and how the audit adapted
- Evidence of web search, GitHub queries, local file reads, git analysis

---

## Prompt Design Philosophy

These prompts are intentionally **open-ended and vague** about which tools to use. The model must:

1. **Recognize the task requires multiple capabilities** (search, scrape, read, write, analyze, store)
2. **Search for relevant wrappers** using semantic queries like "web search", "database query", "git log"
3. **Read module signatures** to understand argument shapes
4. **Write TypeScript** that imports from `mcp/servers/...` and chains async calls
5. **Handle data flow** — output of one tool becomes input to another
6. **Fail gracefully** — try/catch around optional tools, continue with core mission

The harder tiers add:
- **Planning:** Must use `sequentialThinking` before executing
- **Persistence:** Must store data in both SQLite (lightweight) and Postgres (production)
- **Parallelism:** Should use `Promise.all` for independent queries
- **Cross-referencing:** Must compare web data, GitHub data, and local project data
- **Synthesis:** Must produce insights, not just raw data dumps

---

## Validation Mapping

| Test | Expected Files/DBs | Minimum Row Count | Key Evidence |
|------|-------------------|-------------------|--------------|
| E1 | `/tmp/research.db`, `/tmp/mcp-security-report.md` | 3 rows | URLs from 2024 |
| E2 | `/tmp/whitenoise-health.md` | N/A | Git stats, file count, reasoning |
| E3 | `/tmp/hn.html`, `/tmp/hn.db`, `/tmp/hn-top10.json` | 10 rows | HN titles |
| M1 | `/tmp/competitors.db`, `/tmp/competitive-analysis.md` | 3 rows | Feature comparison |
| M2 | `/tmp/issue.json`, `/tmp/bugs.db`, `/tmp/bug-report.md` | 1 row | GitHub issue data |
| M3 | `/tmp/sensors.db`, `/tmp/migration-log.md` | 100 rows | Postgres verification |
| H1 | `/tmp/research.db`, Postgres `research_archive`, `/tmp/agent-framework-report.md` | 5 rows | Framework rankings |
| H2 | `/tmp/incidents.db`, `/tmp/build-forensics.md` | 1 row | Commit analysis |
| H3 | `/tmp/frameworks.db`, Postgres `framework_analysis`, `/tmp/framework-choice.md` | 5 rows | Scoring matrix |
| X1 | `/tmp/audit.db`, Postgres `audit_summary`, 3 `.md` reports | 10+ rows total | Multi-source evidence |

Run `./validate.sh` after all tests to verify outputs.
