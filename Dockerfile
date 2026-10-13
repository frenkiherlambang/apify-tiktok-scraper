# Node 24 + Playwright + Camoufox (browser pre-downloaded into ~/.cache/camoufox).
# The image preinstalls playwright, playwright-core and camoufox-js, so the
# versions in package.json must match the image tag to keep npm from swapping in
# a camoufox-js build whose constraints reject the bundled browser.
FROM apify/actor-node-playwright-camoufox:24-1.59.0-slim

COPY --chown=myuser:myuser package.json ./
RUN npm install --omit=dev

COPY --chown=myuser:myuser src ./src
COPY --chown=myuser:myuser INPUT_SCHEMA.json ./
COPY --chown=myuser:myuser .dockerignore ./
