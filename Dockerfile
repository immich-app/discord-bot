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

## production runner
FROM node:lts-alpine as prod-runner

ARG COMMIT

# Set work directory
WORKDIR /app

# Copy package.json from build-runner
COPY --from=build-runner /app/build /app/build
COPY package*.json .

# Install dependencies
RUN npm install --omit=dev

# Move build files
COPY --from=build-runner /tmp/app/build /app/build

ENV COMMIT_SHA=${COMMIT}

# Start bot
CMD [ "npm", "run", "start" ]
