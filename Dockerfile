FROM node:22.19.0-alpine@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9 AS build-runner

WORKDIR /app
COPY package*.json .
RUN npm ci
COPY src ./src
COPY tsconfig.json .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.19.0-alpine@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9

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
