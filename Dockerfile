# gsession — one image: Node.js API + admin panel + real Chrome for headed,
# watchable Google sign-ins inside a container.
#
# Headed Chrome needs a display; the container has none, so the entrypoint
# starts Xvfb (a virtual display) and Chrome runs "headed" against it. The
# admin panel's live view (CDP screencast) is how you watch and finish sign-ins
# remotely — exactly like on a desktop, minus a physical monitor.
FROM node:20-bookworm

# Xvfb = virtual display for headed Chrome; fonts + ca-certificates are needed
# by Chrome. Chromium's remaining OS dependencies are installed by
# `playwright install --with-deps` below.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        ca-certificates \
        fonts-liberation \
        fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# npm dependencies first, so this layer is cached independently of app code
COPY package.json package-lock.json ./
RUN npm ci

# Playwright's bundled Chromium + all of its OS dependencies (fallback browser —
# lib/browser.js prefers real Chrome and falls back to this)
RUN npx playwright install --with-deps chromium

# Real Chrome: Google's sign-in trusts it far more than bundled Chromium
RUN apt-get update && apt-get install -y --no-install-recommends gnupg wget \
    && install -d -m 0755 /etc/apt/keyrings \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# app code
COPY . .

# GSESSION_CONTAINER=1 tells lib/browser.js to add --no-sandbox /
# --disable-dev-shm-usage (required inside containers) and to route browser
# traffic through the HTTP(S)_PROXY egress proxy when one is set.
# Secrets (GSESSION_MASTER_KEY, ADMIN_TOKEN) are injected at RUNTIME via
# environment — never baked into the image.
ENV GSESSION_CONTAINER=1 \
    PORT=3002 \
    HOST=0.0.0.0

EXPOSE 3002

RUN chmod +x /app/docker-entrypoint.sh
ENTRYPOINT ["/app/docker-entrypoint.sh"]
