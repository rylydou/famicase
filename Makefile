# Deploy the famicase archive to the homelab.
#
# Layout on the server:
#   $(REMOTE_DIR)/site/              <- contents of ./archive, minus the JPEG masters
#   $(REMOTE_DIR)/Caddyfile
#
# The compose stack itself is managed by hand in Dockge; docker-compose.yml
# here is a reference copy to paste in, not something this Makefile uploads.

REMOTE      ?= root@truenas
REMOTE_DIR  ?= /mnt/ssd-z1/app/famicase
LOCAL_SITE  ?= archive
CONTAINER   ?= famicase

# The page loads AVIF and every cover image has a sibling, so the JPEG masters
# are 1.36G of bytes no browser ever asks for - 88% of the tree, to serve 210M.
# They stay local as the archival originals. DEPLOY_MASTERS=yes ships them too,
# which is what you want if the site must render on pre-16.4 Safari, since the
# <picture> fallback points at the JPEG.
DEPLOY_MASTERS ?= no

# macOS ships Apple's openrsync, which reports itself as "2.6.9 compatible"
# and rejects --info= and --human-readable. Prefer a real rsync 3 if one is
# installed (brew install rsync) and fall back to portable flags otherwise.
RSYNC       ?= $(shell command -v /opt/homebrew/bin/rsync 2>/dev/null || command -v rsync)
OPENRSYNC   := $(shell $(RSYNC) --version 2>&1 | grep -qi openrsync && echo yes)

# --delete keeps the server a mirror of ./archive; --partial so a dropped
# connection mid-upload doesn't start the whole payload over from scratch.
RSYNC_FLAGS := -rlptz --partial --delete \
               --exclude='.DS_Store' --exclude='*.part'

ifneq ($(DEPLOY_MASTERS),yes)
# --delete on its own will NOT remove a file that an --exclude covers, so
# without --delete-excluded the JPEGs from every earlier deploy would sit on the
# server forever. With it the remote stays an exact mirror of what is served,
# and the first run after this change reclaims the 1.36G.
RSYNC_FLAGS += --exclude='*.jpg' --exclude='*.jpeg' --delete-excluded
endif

ifeq ($(OPENRSYNC),yes)
RSYNC_FLAGS += --progress
else
# rsync's built-in skip-compress list predates AVIF - it covers jpg/png/webp but
# not avif - so -z would spend CPU re-deflating 149M of already-compressed
# frames for nothing. Naming a list REPLACES the built-in one rather than adding
# to it, so the suffixes worth keeping are restated here. The JSON and HTML are
# what -z is actually for, and they still get it.
RSYNC_FLAGS += --human-readable --info=progress2 \
               --skip-compress=avif/jpg/jpeg/png/webp/gz/zip/zst
endif

.DEFAULT_GOAL := help
.PHONY: help deploy dry-run rsync-info config restart logs check size

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk -F':.*?## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

deploy: ## Upload the site to the server (AVIF only; mirrors, deletes removed files)
	@test -f "$(LOCAL_SITE)/index.html" \
	  || { echo "no $(LOCAL_SITE)/index.html - run 'bun run archive' first"; exit 1; }
	ssh $(REMOTE) 'mkdir -p $(REMOTE_DIR)/site'
	$(RSYNC) $(RSYNC_FLAGS) "$(LOCAL_SITE)/" $(REMOTE):$(REMOTE_DIR)/site/

dry-run: ## Show what deploy would change, without uploading
	$(RSYNC) $(RSYNC_FLAGS) --dry-run --itemize-changes \
	  "$(LOCAL_SITE)/" $(REMOTE):$(REMOTE_DIR)/site/

rsync-info: ## Show which rsync binary and flags will be used
	@echo "binary: $(RSYNC)"
	@echo "openrsync: $(if $(OPENRSYNC),yes,no)"
	@echo "flags: $(RSYNC_FLAGS)"

config: ## Push the Caddyfile and reload the container
	ssh $(REMOTE) 'mkdir -p $(REMOTE_DIR)'
	$(RSYNC) -ptz Caddyfile $(REMOTE):$(REMOTE_DIR)/
	$(MAKE) restart

restart: ## Restart the container (picks up Caddyfile changes)
	ssh $(REMOTE) 'docker restart $(CONTAINER)'

logs: ## Tail container logs
	ssh $(REMOTE) 'docker logs -f --tail=100 $(CONTAINER)'

check: ## Verify the site responds and cache headers are set
	ssh $(REMOTE) 'docker exec $(CONTAINER) wget -qS -O /dev/null http://localhost/ 2>&1 | head -20'

size: ## Compare local, shipped and remote sizes
	@printf 'local    '; du -sh "$(LOCAL_SITE)" | cut -f1
	@printf 'shipped  '; find "$(LOCAL_SITE)" -type f \
	  ! -name '*.jpg' ! -name '*.jpeg' ! -name '.DS_Store' ! -name '*.part' \
	  -exec du -ck {} + | tail -1 | cut -f1 \
	  | awk '{printf "%.0fM\n", $$1/1024}'
	@printf 'remote   '; ssh $(REMOTE) 'du -sh $(REMOTE_DIR)/site' | cut -f1
