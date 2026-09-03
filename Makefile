.PHONY: test test-eth test-web fmt fmt-check lint abi abi-check pins pins-check

ABI_DIR := web/public/abi
ABI_OUT := $(abspath $(ABI_DIR))

test: abi-check pins-check test-eth test-web test-indexer

test-eth:
	$(MAKE) -C eth test

test-indexer:
	cd indexer && bun test src

test-web:
	bun run --cwd web check

fmt:
	$(MAKE) -C eth fmt

fmt-check:
	$(MAKE) -C eth fmt-check

lint:
	bun run --cwd web typecheck

abi:
	cd eth && forge inspect --offline Conet abi --json > $(ABI_OUT)/Conet.json
	cd eth && forge inspect --offline ConetFactory abi --json > $(ABI_OUT)/ConetFactory.json

abi-check:
	@tmp=$$(mktemp -d) && $(MAKE) --no-print-directory abi ABI_DIR=$$tmp >/dev/null && \
	for name in Conet ConetFactory; do \
		diff -u $(ABI_DIR)/$$name.json $$tmp/$$name.json || \
			{ echo "$(ABI_DIR)/$$name.json does not match the compiled contract: run make abi"; exit 1; }; \
	done

pins:
	cd eth && forge script --offline script/Pins.s.sol:Pins | sed -n '/== Return ==/,$$p'

pins-check:
	bun scripts/check-pins.ts
