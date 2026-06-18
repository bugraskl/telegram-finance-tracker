FROM node:20-alpine

WORKDIR /app

# Bagimliliklar (sadece production)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Uygulama
COPY server.js ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080

# Saglik kontrolu
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
