FROM apify/actor-node-playwright-chrome:latest

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY INPUT_SCHEMA.json ./
COPY .dockerignore ./
