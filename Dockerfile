FROM node:20-slim

# ── 빌드 도구 설치 (better-sqlite3 네이티브 컴파일 필수) ──────────────
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── 의존성 설치 (소스 복사 전 캐시 최적화) ────────────────────────────
COPY package.json package-lock.json* ./

# pdf-parse postinstall 스크립트가 Docker 환경에서 실패하는 문제 방지
# --ignore-scripts 후 better-sqlite3 rebuild만 명시적으로 실행
RUN npm ci --only=production --ignore-scripts \
    && npm rebuild better-sqlite3 \
    && npm rebuild bcryptjs

# ── 소스 복사 ─────────────────────────────────────────────────────────
COPY . .

# ── 런타임 데이터 폴더 ────────────────────────────────────────────────
RUN mkdir -p /data/uploads

# ── 환경변수 기본값 ───────────────────────────────────────────────────
ENV NODE_ENV=production \
    DB_PATH=/data/biglinker.db \
    UPLOADS_DIR=/data/uploads \
    PORT=3000

EXPOSE 3000

# ── 헬스체크 ─────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["node", "server.js"]
