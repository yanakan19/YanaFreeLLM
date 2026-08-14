FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first so code edits don't bust the install layer.
# npm ci installs exactly what package-lock.json pins; it needs the lockfile,
# which is committed here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# The node image ships an unprivileged `node` user — use it rather than root.
USER node

ENV PORT=4000
EXPOSE 4000

# Liveness probe: /api/live, NOT /api/health. Docker restarts an unhealthy
# container, and a restart can only fix "the process is wedged" — it cannot
# fix a down router or an empty agents.json, which is what /api/health
# reports on. Probing /api/health here would also restart-loop a container
# that is running perfectly but simply has no keys configured yet.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
