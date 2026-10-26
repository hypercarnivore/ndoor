# ndoor - ad-free, read-only Nextdoor CLI
# Run `make help` for the list of targets.

.DEFAULT_GOAL := help
SHELL := /bin/bash

# Run the CLI from source; WITH_ENV loads this repo's .env (the Jev key) first.
NDOOR    := pnpm exec tsx src/index.ts
WITH_ENV := set -a; [ -f .env ] && . ./.env; set +a;

.PHONY: help install build dev ui test test-live coverage coverage-live lint fmt binary clean harvest demo-graph screenshots \
        feed whoami check read analyze export sync report watch themes judge compare-models health query notifications search

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (pnpm)
	pnpm install

build: ## Compile the CLI to dist/ and the UI to dist/web
	pnpm run build

dev: ## Start the UI with hot reload; open the printed 127.0.0.1:5173 link
	@trap 'kill 0' EXIT INT TERM; pnpm exec tsx watch src/index.ts ui --api-only & pnpm exec vite --config web/vite.config.ts

ui: ## Serve the built UI at http://127.0.0.1:4791 and open it (builds the frontend if needed)
	@[ -f dist/web/index.html ] || pnpm run build:web
	$(NDOOR) ui --open $(ARGS)

test: ## Run the test suite
	pnpm exec vitest run

test-live: ## Run tests including live Nextdoor + Jev integration (browser session, ./.env)
	@$(WITH_ENV) NDOOR_LIVE=1 pnpm exec vitest run

coverage: ## Run offline tests with coverage report
	pnpm exec vitest run --coverage

coverage-live: ## Run all tests, including live integration, with coverage
	@$(WITH_ENV) NDOOR_LIVE=1 pnpm exec vitest run --coverage

lint: ## Lint and format-check with Biome, typecheck the frontend
	pnpm exec biome check .
	pnpm exec tsc --noEmit -p web

fmt: ## Auto-fix lint and formatting
	pnpm exec biome check --write .

binary: ## Build a standalone ./ndoor executable (requires bun)
	pnpm run binary

clean: ## Remove build artifacts
	rm -rf dist coverage ndoor demo/out

demo-graph: ## Build the invented-town graph behind the README screenshots (demo/out/graph.lbug)
	pnpm exec tsx demo/build.ts build

screenshots: ## Regenerate docs/screenshots from the demo graph (needs agent-browser)
	@command -v agent-browser >/dev/null || { echo "agent-browser is required"; exit 1; }
	@[ -f dist/web/index.html ] || pnpm run build:web
	pnpm exec tsx demo/build.ts build
	pnpm exec tsx demo/screenshots.ts

# Refresh persisted-query hashes after a Nextdoor frontend deploy. Drives a
# visible agent-browser session (log in once; the session is restored after),
# records a HAR while visiting the pages ndoor reads, then imports the hashes.
# The HAR holds session cookies in its request headers, so it is recorded
# without response bodies into a private (0700) temp dir that a trap removes on
# every exit path, including failures and Ctrl-C.
HARVEST_SESSION ?= ndoor-capture
AB := agent-browser --session $(HARVEST_SESSION) --restore --headed

harvest: ## Re-capture GraphQL hashes from nextdoor.com via agent-browser
	@command -v agent-browser >/dev/null || { echo "agent-browser is required"; exit 1; }
	@set -eu; umask 077; \
	dir=$$(mktemp -d "$${TMPDIR:-/tmp}/ndoor-harvest.XXXXXX"); \
	trap 'rm -rf "$$dir"; $(AB) close >/dev/null 2>&1 || true' EXIT INT TERM; \
	har="$$dir/capture.har"; \
	$(AB) open https://nextdoor.com/news_feed/ >/dev/null; \
	read -p "Log in if needed, then press Enter once the feed shows... " _; \
	$(AB) network har start --content none >/dev/null; \
	$(AB) open https://nextdoor.com/news_feed/ >/dev/null; $(AB) wait 4000 >/dev/null; \
	feed_posts=$$($(AB) eval "[...new Set([...document.querySelectorAll('a[href*=\"/p/\"]')].map(a => a.getAttribute('href').split('?')[0]))].slice(0, 3).join(' ')" | tr -d '"'); \
	busy_posts=$$($(NDOOR) query "MATCH (p:Post) WHERE p.removedAt IS NULL AND p.url IS NOT NULL WITH p ORDER BY p.createdAt DESC LIMIT 200 RETURN p.url AS url ORDER BY p.commentCount DESC LIMIT 3" 2>/dev/null | grep -o '/p/[A-Za-z0-9_-]*' || true); \
	for post in $$feed_posts $$busy_posts; do \
	  $(AB) open "https://nextdoor.com$$post?view=detail" >/dev/null && $(AB) wait 4000 >/dev/null; \
	  clicked=$$($(AB) eval "(() => { const b = [...document.querySelectorAll('button,a,[role=button]')].find(e => /^(see|view|show|load).*more (repl|comment)/i.test(e.innerText.trim())); if (b) { b.click(); return 'yes'; } return 'no'; })()" | tr -d '"'); \
	  if [ "$$clicked" = yes ]; then $(AB) wait 3000 >/dev/null; break; fi; \
	done; \
	$(AB) open "https://nextdoor.com/search/posts/?query=recommend" >/dev/null; $(AB) wait 4000 >/dev/null; \
	$(AB) open https://nextdoor.com/notifications/ >/dev/null; $(AB) wait 4000 >/dev/null; \
	$(AB) open https://nextdoor.com/news_feed/ >/dev/null; $(AB) wait 4000 >/dev/null; \
	for kind in profile neighborhood agency-detail page; do \
	  link=$$($(AB) eval "[...document.querySelectorAll('a[href^=\"/$$kind/\"]')].map(a => a.getAttribute('href').split('?')[0])[0] || ''" | tr -d '"'); \
	  if [ -n "$$link" ]; then $(AB) open "https://nextdoor.com$$link" >/dev/null && $(AB) wait 4000 >/dev/null; $(AB) back >/dev/null; $(AB) wait 3000 >/dev/null; fi; \
	done; \
	me=$$($(NDOOR) whoami --json 2>/dev/null | grep -o 'secureUser_[A-Za-z0-9_-]*' | head -1 | sed 's/^secureUser_//' || true); \
	if [ -n "$$me" ]; then \
	  $(AB) open "https://nextdoor.com/profile/$$me/" >/dev/null && $(AB) wait 4000 >/dev/null; \
	  $(AB) eval "(() => { const t = [...document.querySelectorAll('[role=tab],button,a')].find(e => e.innerText.trim() === 'Activity'); if (t) t.click(); })()" >/dev/null; $(AB) wait 3000 >/dev/null; \
	  for tab in Reactions Comments; do \
	    $(AB) eval "(() => { const t = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').trim() === '$$tab'); if (t) t.click(); })()" >/dev/null; $(AB) wait 3500 >/dev/null; \
	  done; \
	fi; \
	agency_post=$$($(NDOOR) query "MATCH (u:User)-[:SPEAKS_FOR]->(:Agency), (u)-[:POSTED]->(p:Post) WHERE p.removedAt IS NULL AND p.url IS NOT NULL RETURN p.url AS url ORDER BY p.createdAt DESC LIMIT 1" 2>/dev/null | grep -o '/p/[A-Za-z0-9_-]*' | head -1 || true); \
	if [ -n "$$agency_post" ]; then \
	  $(AB) open "https://nextdoor.com$$agency_post?view=detail" >/dev/null && $(AB) wait 4000 >/dev/null; \
	  agency=$$($(AB) eval "[...document.querySelectorAll('a[href*=\"/agency-detail/\"]')].map(a => a.getAttribute('href').split('?')[0])[0] || ''" | tr -d '"'); \
	  if [ -n "$$agency" ]; then $(AB) open "https://nextdoor.com$$agency" >/dev/null && $(AB) wait 4000 >/dev/null; fi; \
	fi; \
	$(AB) open https://nextdoor.com/groups/ >/dev/null; $(AB) wait 4000 >/dev/null; \
	group=$$($(AB) eval "[...document.querySelectorAll('a[href*=\"/g/\"]')].map(a => a.getAttribute('href').split('?')[0])[0] || ''" | tr -d '"'); \
	if [ -n "$$group" ]; then $(AB) open "https://nextdoor.com$$group" >/dev/null && $(AB) wait 4000 >/dev/null; fi; \
	$(AB) open https://nextdoor.com/local_news/ >/dev/null; $(AB) wait 4000 >/dev/null; \
	$(AB) network har stop "$$har" >/dev/null; \
	$(NDOOR) ops harvest "$$har"

# --- Wrappers around the CLI (pass ARGS="..."; see README for each command) ---

feed: ## Show your ad-free news feed
	$(NDOOR) feed $(ARGS)

whoami: ## Show the logged-in Nextdoor account
	$(NDOOR) whoami $(ARGS)

check: ## Show which credential source ndoor will use
	$(NDOOR) check $(ARGS)

read: ## Read a post with all comments (ARGS="<post-url>")
	$(NDOOR) read $(ARGS)

notifications: ## Show your notification center
	$(NDOOR) notifications $(ARGS)

search: ## Search posts (ARGS="<query>")
	$(NDOOR) search $(ARGS)

export: ## Export everything you have written (posts + comments with context)
	$(NDOOR) export $(ARGS)

sync: ## Harvest the community graph (ARGS="--preset deep --analyze"); Jev key from .env
	@$(WITH_ENV) $(NDOOR) sync $(ARGS)

judge: ## Run pending Jev judgments on the cached graph, no Nextdoor requests
	@$(WITH_ENV) $(NDOOR) judge $(ARGS)

analyze: ## Jev analysis of the feed, or a thread (ARGS="<post-url>")
	@$(WITH_ENV) $(NDOOR) analyze $(ARGS)

themes: ## Discover community themes from the cached graph (ARGS="discover" | "list" | "assign")
	@$(WITH_ENV) $(NDOOR) themes $(ARGS)

compare-models: ## Compare decision models on recent cached posts (ARGS="--candidate microsoft/microsoft-decision-1 --fresh")
	@$(WITH_ENV) $(NDOOR) compare-models $(ARGS)

report: ## Graph report (ARGS="influencers --since 90d"; no ARGS lists reports)
	$(NDOOR) report $(ARGS)

health: ## Community health score 1-10 with its signals (ARGS="--since 90d")
	$(NDOOR) health $(ARGS)

watch: ## Watches and alerts (ARGS="init" | "list" | "check --notify")
	$(NDOOR) watch $(ARGS)

query: ## Read-only Cypher against the graph (ARGS="'MATCH (u:User) RETURN count(u)'")
	$(NDOOR) query $(ARGS)
