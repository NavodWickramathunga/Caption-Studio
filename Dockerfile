# Caption Studio on Cloud Run.
#
# npm install rather than npm ci on purpose: package-lock.json has not
# been regenerated since Firestore was added, because nothing about this
# project is built on a laptop any more. Once a lockfile lands that
# includes Firestore, this should become `npm ci --omit=dev`, which is
# both faster and reproducible.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a change to the app does not reinstall them.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Cloud Run hands the port in; server.js already reads PORT.
ENV PORT=8080
EXPOSE 8080

# Run as the unprivileged user the image ships with.
USER node

CMD ["node", "server.js"]
