FROM public.ecr.aws/nginx/nginx:1-alpine

# Static single-page app assets
COPY index.html app.js auth.js config.js styles.css /usr/share/nginx/html/

# nginx reverse-proxy config template — rendered by the entrypoint at startup.
# Placed outside /etc/nginx/templates/ so the base image's envsubst step does
# not strip nginx runtime variables (e.g. $uri, $http_authorization).
COPY nginx-default.conf.template /etc/nginx/nginx-default.conf.template

# Runtime config injection + nginx config rendering (runs before nginx starts)
COPY docker-entrypoint.sh /docker-entrypoint.d/40-inject-config.sh
RUN chmod +x /docker-entrypoint.d/40-inject-config.sh

EXPOSE 80
