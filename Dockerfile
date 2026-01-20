FROM node:24.13.0-alpine@sha256:931d7d57f8c1fd0e2179dbff7cc7da4c9dd100998bc2b32afc85142d8efbc213 AS build-runner

WORKDIR /app
COPY package*.json .
RUN npm ci
COPY src ./src
COPY tsconfig.json .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.13.0-alpine@sha256:931d7d57f8c1fd0e2179dbff7cc7da4c9dd100998bc2b32afc85142d8efbc213

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
