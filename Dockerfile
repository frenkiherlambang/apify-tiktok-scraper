FROM apify/actor-node-playwright-chrome:1.0

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY INPUT_SCHEMA.json ./
COPY .dockerignore ./
