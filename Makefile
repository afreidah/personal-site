# -------------------------------------------------------------------------------
# Personal Site - Build and Publish
#
# Author: Alex Freidah
#
# Hugo site for alexfreidah.com: home page, resume, and posts. Built into an
# nginx image and pushed as a multi-arch manifest.
# -------------------------------------------------------------------------------

REGISTRY   ?= registry.munchbox.cc
IMAGE      := personal-site
VERSION    ?= $(shell cat .version)

FULL_TAG   := $(REGISTRY)/$(IMAGE):$(VERSION)
PLATFORMS  := linux/amd64,linux/arm64

help: ## Display available Make targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' Makefile | \
		awk 'BEGIN {FS = ":.*?## "} {printf "  %-12s %s\n", $$1, $$2}'

serve: ## Run the Hugo dev server with drafts on :1313
	hugo server --buildDrafts --disableFastRender

build: ## Render the site into public/
	hugo --minify --gc

post: ## Create a draft post: make post NAME=my-post-slug
	@test -n "$(NAME)" || { echo "usage: make post NAME=my-post-slug"; exit 1; }
	hugo new content posts/$(NAME).md

builder: ## Ensure the Buildx builder exists
	@docker buildx inspect site-builder >/dev/null 2>&1 || \
		docker buildx create --name site-builder --driver-opt network=host --use
	@docker buildx inspect --bootstrap

docker: ## Build the image for the local architecture
	docker build --pull -t $(FULL_TAG) .

run: docker ## Run the image locally on :8080
	docker run --rm -p 8080:80 $(FULL_TAG)

push: builder ## Build and push multi-arch images to the registry
	docker buildx build --pull --platform $(PLATFORMS) -t $(FULL_TAG) --output type=image,push=true .

clean: ## Remove build output
	rm -rf public resources .hugo_build.lock

.PHONY: help serve build post builder docker run push clean
.DEFAULT_GOAL := help
