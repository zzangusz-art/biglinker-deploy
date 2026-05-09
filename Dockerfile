FROM node:20-slim

# 빌드 도구 설치 (better-sqlite3 네이티브 컴파일용)
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 설치
COPY package*.json ./
RUN npm install --only=production

# 소스 복사
COPY . .

# 데이터 폴더
RUN mkdir -p /data/uploads

ENV NODE_ENV=production \
    DB_PATH=/data/biglinker.db \
    UPLOADS_DIR=/data/uploads \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["node", "server.js"]
