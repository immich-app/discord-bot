FROM node:22.11.0-alpine@sha256:f8c7230e119ab657a4adda992f7dad2b2b068029c7710f53d930673a8eb2a1e8 AS build-runner

WORKDIR /app
COPY package*.json .
RUN npm ci
COPY src ./src
COPY tsconfig.json .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.11.0-alpine@sha256:f8c7230e119ab657a4adda992f7dad2b2b068029c7710f53d930673a8eb2a1e8

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
