# Local development helpers for place.
#
#   make build      install server deps and build the client (fast, debug)
#   make server     run the world server on PORT (default 8090)
#   make client     run the locally built client against it
#   make link       put `place-local` on your PATH
#
# Override variables on the command line, e.g. `make server PORT=9000`.

PORT     ?= 8090
PREFIX   ?= $(HOME)/.local
CARGO    ?= cargo
NODE     ?= node
NPM      ?= npm

CLIENT_DEBUG   := place/target/debug/place
CLIENT_RELEASE := place/target/release/place
PLACE_LOCAL    := $(abspath bin/place-local)

.PHONY: help all build release server client test check link unlink clean

.DEFAULT_GOAL := help

help:
	@echo "place — local development"
	@echo
	@echo "  make build      install server deps and build the client (debug)"
	@echo "  make release    build an optimized client"
	@echo "  make server     run the world server on :$(PORT)"
	@echo "  make client     run the local client against :$(PORT)"
	@echo "  make test       run the server end-to-end tests"
	@echo "  make check      server tests + client tests"
	@echo "  make link       symlink 'place-local' into $(PREFIX)/bin"
	@echo "  make unlink     remove that symlink"
	@echo "  make clean      remove build artifacts"
	@echo
	@echo "  PORT=9000 make server   # run on another port"
	@echo "  PORT=9000 make client   # ...and connect to it"

all: build

build: node_modules $(CLIENT_DEBUG)
	@echo
	@echo "built $(CLIENT_DEBUG)"
	@echo "run the client with ./bin/place-local, or 'make link' to put it on PATH"

release: node_modules
	$(CARGO) build --release --manifest-path place/Cargo.toml
	@echo "built $(CLIENT_RELEASE)"

# `npm ci` is reproducible and quick with this tiny dependency tree.
node_modules: package.json package-lock.json
	$(NPM) ci
	@touch node_modules

$(CLIENT_DEBUG): place/Cargo.toml place/Cargo.lock $(wildcard place/src/*.rs)
	$(CARGO) build --manifest-path place/Cargo.toml

server: node_modules
	PORT=$(PORT) $(NODE) world-server.js

client: $(CLIENT_DEBUG)
	PORT=$(PORT) $(PLACE_LOCAL)

test: node_modules
	$(NPM) test

check: test
	$(CARGO) test --manifest-path place/Cargo.toml

# A symlink (not a copy) so edits to bin/place-local take effect immediately.
link:
	@mkdir -p "$(PREFIX)/bin"
	@ln -sfn "$(PLACE_LOCAL)" "$(PREFIX)/bin/place-local"
	@echo "linked $(PREFIX)/bin/place-local -> $(PLACE_LOCAL)"
	@case ":$$PATH:" in \
		*":$(PREFIX)/bin:"*) ;; \
		*) echo "note: add $(PREFIX)/bin to your PATH, or run ./bin/place-local directly" ;; \
	esac

unlink:
	@rm -f "$(PREFIX)/bin/place-local"
	@echo "removed $(PREFIX)/bin/place-local"

clean:
	$(CARGO) clean --manifest-path place/Cargo.toml
	rm -rf node_modules
