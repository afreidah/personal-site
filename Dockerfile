# -------------------------------------------------------------------------------
# Personal Site - Static Site Container
#
# Project: alexfreidah.com / Author: Alex Freidah
#
# Multi-architecture build using Hugo. The static output is platform-agnostic,
# so Hugo runs natively on the build host architecture and only the nginx
# runtime stage is built per platform.
# -------------------------------------------------------------------------------

# --- Build stage (pinned by digest for reproducible builds) ---
FROM --platform=$BUILDPLATFORM hugomods/hugo@sha256:367ea85950c9f3e12746fbf049f29ea00758c86791072dfdc9772748ff9306bc AS build

WORKDIR /src
COPY . .

# --- Clean destination so nothing stale from a local public/ ships ---
RUN hugo --minify --gc --cleanDestinationDir

# --- Runtime stage (multi-arch) ---
FROM nginx:alpine

RUN apk upgrade --no-cache

COPY --from=build /src/public /usr/share/nginx/html

# --- Cache headers and compression ---
COPY nginx-cache.conf /etc/nginx/conf.d/nginx-cache.conf

# --- Replaces the stock default server so the redirect and 404 settings apply ---
COPY nginx-site.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
