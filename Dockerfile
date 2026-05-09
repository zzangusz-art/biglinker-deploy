FROM node:20-alpine

# 필수 빌드 도구 (better-sqlite3 컴파일용)
RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app

# 의존성 설치 (캐시 최적화)
COPY package*.json ./
RUN npm ci --only=production

# 소스 복사
COPY . .

# 폴더 생성
RUN mkdir -p /data/uploads && chmod 755 /data

# 비루트 사용자
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app /data
USER appuser

EXPOSE 3000

ENV NODE_ENV=production \
    DB_PATH=/data/biglinker.db \
    UPLOADS_DIR=/data/uploads \
    PORT=3000

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
