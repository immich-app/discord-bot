## build runner
FROM node:lts-alpine as build-runner

# Set temp directory
WORKDIR /app

# Move package.json
COPY package*.json .

# Install dependencies
RUN npm ci

# Move source files
COPY src ./src
COPY tsconfig.json .

# Build project
RUN npm run build
RUN npm prune --omit=dev

## production runner
FROM node:lts-alpine as prod-runner

ARG COMMIT

# Set work directory
WORKDIR /app

COPY --from=build-runner /app/node_modules /app/node_modules
COPY --from=build-runner /app/build /app/build
COPY package*.json .

ENV COMMIT_SHA=${COMMIT}

# Start bot
CMD [ "npm", "run", "start" ]
