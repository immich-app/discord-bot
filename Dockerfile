FROM node:22.12.0-alpine@sha256:4a5468a23354839a70381edc2d44edd79d9de678914b86ecf176ead1f1169c22 AS build-runner

WORKDIR /app
COPY package*.json .
RUN npm ci
COPY src ./src
COPY tsconfig.json .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.12.0-alpine@sha256:4a5468a23354839a70381edc2d44edd79d9de678914b86ecf176ead1f1169c22

RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build-runner /app/node_modules /app/node_modules
COPY --from=build-runner /app/dist /app/dist
COPY package*.json .
ARG COMMIT
ENV COMMIT_SHA=${COMMIT}
USER node
ENTRYPOINT ["/sbin/tini", "--", "/bin/sh"]
CMD ["-c", "node --experimental-require-module dist/main.js "]
