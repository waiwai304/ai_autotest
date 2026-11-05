FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json playwright.config.ts ./
COPY config ./config
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts

RUN chmod +x /app/scripts/run-tests.sh \
    && mkdir -p /app/output/html-report \
                  /app/output/test-results \
                  /app/output/junit \
                  /app/output/json

ENV CI=true
ENV HEADLESS=true

CMD ["npm", "run", "test:all"]
