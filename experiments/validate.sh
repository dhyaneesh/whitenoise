#!/bin/bash
# validate.sh — Validate WhiteNoise experiment outputs
# Usage: ./validate.sh [tier]
#   ./validate.sh          # Validate all tests
#   ./validate.sh easy     # Validate only Easy tier
#   ./validate.sh medium   # Validate only Medium tier
#   ./validate.sh hard     # Validate only Hard tier
#   ./validate.sh hell     # Validate only Hell mode
#   ./validate.sh e1       # Validate single test (e1, e2, m1, h1, x1, etc.)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

# ── Helpers ─────────────────────────────────────────────────────────

pass() {
    echo -e "${GREEN}✓ PASS${NC} $1"
    ((PASS++))
}

fail() {
    echo -e "${RED}✗ FAIL${NC} $1"
    ((FAIL++))
}

warn() {
    echo -e "${YELLOW}⚠ WARN${NC} $1"
    ((WARN++))
}

check_file() {
    local file=$1
    local min_size=${2:-1}
    if [ -f "$file" ]; then
        local size
        size=$(wc -c < "$file" | tr -d ' ')
        if [ "$size" -ge "$min_size" ]; then
            pass "File exists: $file ($size bytes)"
        else
            warn "File too small: $file ($size bytes, min $min_size)"
        fi
    else
        fail "Missing file: $file"
    fi
}

check_sqlite() {
    local db=$1
    local query=$2
    local desc=$3
    if [ -f "$db" ]; then
        local result
        result=$(sqlite3 "$db" "$query" 2>/dev/null || true)
        if [ -n "$result" ]; then
            pass "$desc: $result"
        else
            fail "$desc: no data found"
        fi
    else
        fail "$desc: database missing ($db)"
    fi
}

check_postgres() {
    local query=$1
    local desc=$2
    local result
    result=$(docker exec whitenoise-postgres psql -U postgres -d whitenoise_test -tAc "$query" 2>/dev/null || true)
    if [ -n "$result" ]; then
        pass "$desc: $result"
    else
        fail "$desc: no data in Postgres"
    fi
}

check_markdown_content() {
    local file=$1
    local keywords=$2
    local desc=$3
    if [ -f "$file" ]; then
        local found=0
        for kw in $keywords; do
            if grep -qi "$kw" "$file" 2>/dev/null; then
                found=1
                break
            fi
        done
        if [ "$found" -eq 1 ]; then
            pass "$desc: content verified ($keywords)"
        else
            fail "$desc: missing expected keywords ($keywords)"
        fi
    else
        fail "$desc: file missing ($file)"
    fi
}

# ── Tier Validation Functions ──────────────────────────────────────

validate_e1() {
    echo -e "\n${BLUE}═══ E1: Web Research & Database ═══${NC}"
    check_file "/tmp/research.db"
    check_sqlite "/tmp/research.db" "SELECT COUNT(*) FROM articles" "SQLite articles count"
    check_file "/tmp/mcp-security-report.md" 50
    check_markdown_content "/tmp/mcp-security-report.md" "MCP security best practices 2024" "Report mentions 2024"
}

validate_e2() {
    echo -e "\n${BLUE}═══ E2: Project Health Check ═══${NC}"
    check_file "/tmp/whitenoise-health.md" 100
    check_markdown_content "/tmp/whitenoise-health.md" "git commit package.json TypeScript" "Report covers project analysis"
}

validate_e3() {
    echo -e "\n${BLUE}═══ E3: Web Scraping to Database ═══${NC}"
    check_file "/tmp/hn.html" 1000
    check_file "/tmp/hn.db"
    check_sqlite "/tmp/hn.db" "SELECT COUNT(*) FROM stories" "SQLite stories count"
    check_file "/tmp/hn-top10.json"
    check_markdown_content "/tmp/hn-top10.json" "title url" "JSON has expected fields"
}

validate_m1() {
    echo -e "\n${BLUE}═══ M1: Competitive Intelligence ═══${NC}"
    check_file "/tmp/competitors.db"
    check_sqlite "/tmp/competitors.db" "SELECT COUNT(*) FROM competitors" "Competitors table count"
    check_file "/tmp/competitive-analysis.md" 200
    check_markdown_content "/tmp/competitive-analysis.md" "whitenoise competitor feature" "Analysis compares whitenoise"
}

validate_m2() {
    echo -e "\n${BLUE}═══ M2: Issue Investigation ═══${NC}"
    check_file "/tmp/issue.json" 50
    check_file "/tmp/bugs.db"
    check_sqlite "/tmp/bugs.db" "SELECT COUNT(*) FROM bugs" "Bugs table count"
    check_file "/tmp/bug-report.md" 200
}

validate_m3() {
    echo -e "\n${BLUE}═══ M3: Data Migration Pipeline ═══${NC}"
    check_file "/tmp/sensors.db"
    check_sqlite "/tmp/sensors.db" "SELECT COUNT(*) FROM readings" "SQLite readings count"
    check_postgres "SELECT COUNT(*) FROM readings" "Postgres readings count"
    check_file "/tmp/migration-log.md" 100
}

validate_h1() {
    echo -e "\n${BLUE}═══ H1: Autonomous Research Agent ═══${NC}"
    check_file "/tmp/research.db"
    check_sqlite "/tmp/research.db" "SELECT COUNT(*) FROM frameworks" "Research DB frameworks"
    check_postgres "SELECT COUNT(*) FROM research_archive" "Postgres research archive"
    check_file "/tmp/agent-framework-report.md" 1500
    check_markdown_content "/tmp/agent-framework-report.md" "LangChain LlamaIndex CrewAI AutoGen ranking" "Report has framework analysis"
}

validate_h2() {
    echo -e "\n${BLUE}═══ H2: Debug Forensics ═══${NC}"
    check_file "/tmp/incidents.db"
    check_sqlite "/tmp/incidents.db" "SELECT COUNT(*) FROM incidents" "Incidents table count"
    check_file "/tmp/build-forensics.md" 500
    check_markdown_content "/tmp/build-forensics.md" "commit tsconfig build" "Report has build forensics"
}

validate_h3() {
    echo -e "\n${BLUE}═══ H3: Multi-Source Market Analysis ═══${NC}"
    check_file "/tmp/frameworks.db"
    check_sqlite "/tmp/frameworks.db" "SELECT COUNT(*) FROM frameworks" "Frameworks table count"
    check_postgres "SELECT COUNT(*) FROM framework_analysis" "Postgres framework analysis"
    check_file "/tmp/framework-choice.md" 1000
    check_markdown_content "/tmp/framework-choice.md" "recommendation integration" "Report has recommendation"
}

validate_x1() {
    echo -e "\n${BLUE}═══ X1: The Ultimate System Audit ═══${NC}"
    check_file "/tmp/audit.db"
    check_sqlite "/tmp/audit.db" "SELECT COUNT(*) FROM web_sources" "Audit web sources"
    check_sqlite "/tmp/audit.db" "SELECT COUNT(*) FROM github_repos" "Audit github repos"
    check_sqlite "/tmp/audit.db" "SELECT COUNT(*) FROM local_files" "Audit local files"
    check_postgres "SELECT COUNT(*) FROM audit_summary" "Postgres audit summary"
    check_file "/tmp/audit-technical.md" 1500
    check_file "/tmp/audit-strategic.md" 1500
    check_file "/tmp/audit-gaps.md" 1500
    check_markdown_content "/tmp/audit-gaps.md" "missing gap competitor" "Gaps report has analysis"
}

# ── Main ───────────────────────────────────────────────────────────

TIER=${1:-all}

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     WhiteNoise Experiment Validation                       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"

case "$TIER" in
    all)
        validate_e1; validate_e2; validate_e3
        validate_m1; validate_m2; validate_m3
        validate_h1; validate_h2; validate_h3
        validate_x1
        ;;
    easy)
        validate_e1; validate_e2; validate_e3
        ;;
    medium)
        validate_m1; validate_m2; validate_m3
        ;;
    hard)
        validate_h1; validate_h2; validate_h3
        ;;
    hell)
        validate_x1
        ;;
    e1) validate_e1 ;;
    e2) validate_e2 ;;
    e3) validate_e3 ;;
    m1) validate_m1 ;;
    m2) validate_m2 ;;
    m3) validate_m3 ;;
    h1) validate_h1 ;;
    h2) validate_h2 ;;
    h3) validate_h3 ;;
    x1) validate_x1 ;;
    *)
        echo "Usage: $0 [all|easy|medium|hard|hell|e1|e2|...|x1]"
        exit 1
        ;;
esac

# ── Summary ────────────────────────────────────────────────────────

echo -e "\n${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Passed:  $PASS${NC}"
echo -e "${RED}Failed:  $FAIL${NC}"
echo -e "${YELLOW}Warnings: $WARN${NC}"

TOTAL=$((PASS + FAIL))
if [ "$TOTAL" -gt 0 ]; then
    SCORE=$((PASS * 100 / TOTAL))
    echo -e "${BLUE}Score:   $SCORE%${NC}"
    if [ "$SCORE" -ge 90 ]; then
        echo -e "${GREEN}🎉 Production Ready!${NC}"
    elif [ "$SCORE" -ge 70 ]; then
        echo -e "${YELLOW}⚡ Good, minor fixes needed${NC}"
    elif [ "$SCORE" -ge 50 ]; then
        echo -e "${YELLOW}🔧 Usable but needs work${NC}"
    else
        echo -e "${RED}❌ Significant issues${NC}"
    fi
fi
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"

exit $FAIL
