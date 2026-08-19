#!/bin/sh
set -e

# ─── Render the nginx reverse-proxy config from API_URL ─────────────────────
# API_URL looks like: https://abc123.execute-api.us-west-2.amazonaws.com/prod
# Extract the host (for proxy_pass) and the stage (for the URI rewrite).
no_scheme="${API_URL#https://}"
no_scheme="${no_scheme#http://}"
API_HOST="${no_scheme%%/*}"

# Everything after the first "/" is the path; the first path segment is the stage.
API_PATH="${no_scheme#*/}"
if [ "$API_PATH" = "$no_scheme" ]; then
  # No path component present in API_URL — no stage.
  API_STAGE=""
else
  API_STAGE="${API_PATH%%/*}"
fi

sed -e "s|__API_HOST__|${API_HOST}|g" \
    -e "s|__API_STAGE__|${API_STAGE}|g" \
    /etc/nginx/nginx-default.conf.template > /etc/nginx/conf.d/default.conf

# ─── Inject runtime front-end configuration ─────────────────────────────────
# The browser calls the ALB at the same origin via "/api", which nginx proxies
# to the Private API Gateway (see the reverse proxy above). This avoids the
# browser having to reach the private execute-api endpoint directly.
cat > /usr/share/nginx/html/config.js << EOF
window.__CONFIG__ = {
  "apiUrl": "/api",
  "cognito": {
    "userPoolId": "${COGNITO_USER_POOL_ID}",
    "clientId": "${COGNITO_CLIENT_ID}",
    "domain": "${COGNITO_DOMAIN}",
    "redirectUri": "${REDIRECT_URI}",
    "logoutUri": "${LOGOUT_URI}"
  }
};
EOF
