# asmltr-insights dashboard — multi-stage: build the Vite SPA, serve via nginx.
# nginx also reverse-proxies /api + /socket.io to the host collector (127.0.0.1:3017
# reached as host.docker.internal) and /manager to the connector manager
# (127.0.0.1:3024), injecting the read + manager service bearers so the tokens
# never reach the browser. Authelia 2FA is enforced at the Traefik edge.
# Set ASMLTR_INSIGHTS_TOKEN and ASMLTR_MANAGER_TOKEN at container start.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:alpine
# The official entrypoint envsubsts only real env vars (e.g. ${ASMLTR_INSIGHTS_TOKEN}),
# leaving nginx runtime vars like $http_upgrade untouched.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
