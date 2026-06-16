FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS build-runner

WORKDIR /app
COPY package*.json .
RUN npm ci
COPY src ./src
COPY tsconfig.json .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a

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
