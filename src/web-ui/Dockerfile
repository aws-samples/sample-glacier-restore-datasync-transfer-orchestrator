FROM public.ecr.aws/nginx/nginx:1-alpine

# Static single-page app assets.
# NOTE: config.js is intentionally NOT copied here — it is generated at
# container startup by docker-entrypoint.sh from runtime environment variables
# (Cognito IDs, redirect URIs, etc.) and is never committed to source.
COPY index.html app.js auth.js styles.css /usr/share/nginx/html/

# nginx reverse-proxy config template — rendered by the entrypoint at startup.
# Placed outside /etc/nginx/templates/ so the base image's envsubst step does
# not strip nginx runtime variables (e.g. $uri, $http_authorization).
COPY nginx-default.conf.template /etc/nginx/nginx-default.conf.template

# Runtime config injection + nginx config rendering (runs before nginx starts)
COPY docker-entrypoint.sh /docker-entrypoint.d/40-inject-config.sh
RUN chmod +x /docker-entrypoint.d/40-inject-config.sh

# --- Run as the non-root `nginx` user (CKV_DOCKER_3) ---
# The container listens on 8080 (see nginx-default.conf.template) because an
# unprivileged user cannot bind ports below 1024. Grant the pre-existing
# `nginx` user (UID 101 in the base image) write access to the paths the
# entrypoint and nginx runtime need: rendered config, injected config.js,
# the master PID file, and the proxy temp/cache directories.
RUN touch /var/run/nginx.pid \
    && chown -R nginx:nginx /var/run/nginx.pid \
       /var/cache/nginx \
       /etc/nginx/conf.d \
       /usr/share/nginx/html

USER nginx

EXPOSE 8080

# --- Container health check (CKV_DOCKER_2) ---
# Probes the locally served app shell. Uses wget (present in the alpine base
# image). Marks the container unhealthy so the orchestrator can replace it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:8080/ || exit 1
