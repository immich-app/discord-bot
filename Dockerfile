FROM node:lts-alpine@sha256:eb8101caae9ac02229bd64c024919fe3d4504ff7f329da79ca60a04db08cef52 AS build-runner

WORKDIR /app
COPY package*.json .
RUN npm ci
COPY src ./src
COPY tsconfig.json .
RUN npm run build
RUN npm prune --omit=dev

FROM node:lts-alpine@sha256:eb8101caae9ac02229bd64c024919fe3d4504ff7f329da79ca60a04db08cef52

RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build-runner /app/node_modules /app/node_modules
COPY --from=build-runner /app/dist /app/dist
COPY package*.json .
ARG COMMIT
ENV COMMIT_SHA=${COMMIT}
USER node
ENTRYPOINT ["/sbin/tini", "--", "/bin/sh"]
CMD ["-c", "node dist/main.js"]
