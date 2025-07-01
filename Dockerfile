FROM node:22.17.0-alpine@sha256:5340cbfc2df14331ab021555fdd9f83f072ce811488e705b0e736b11adeec4bb AS build-runner

WORKDIR /app
COPY package*.json .
RUN npm ci
COPY src ./src
COPY tsconfig.json .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.17.0-alpine@sha256:5340cbfc2df14331ab021555fdd9f83f072ce811488e705b0e736b11adeec4bb

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
