#!/bin/bash
# BigLinker VPS 자동 설치 스크립트
# 사용법: curl -fsSL https://your-domain/install.sh | sudo bash
# 또는:  chmod +x install.sh && sudo ./install.sh

set -e
DOMAIN=""
APP_DIR="/var/www/biglinker"
NODE_VERSION="20"

echo "═══════════════════════════════════════"
echo "  BigLinker LMS 자동 설치 스크립트"
echo "═══════════════════════════════════════"

# 도메인 입력
read -p "도메인을 입력하세요 (예: biglinker.kr): " DOMAIN
if [ -z "$DOMAIN" ]; then echo "도메인이 필요합니다"; exit 1; fi

# JWT Secret 생성
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))" 2>/dev/null || openssl rand -hex 64)

echo ""
echo "📦 시스템 패키지 설치 중..."
apt-get update -q
apt-get install -y -q curl wget git nginx certbot python3-certbot-nginx

# Node.js 설치
echo "📦 Node.js $NODE_VERSION 설치 중..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y -q nodejs

# PM2 설치
npm install -g pm2 --quiet

# 앱 디렉토리
mkdir -p $APP_DIR/public $APP_DIR/uploads $APP_DIR/logs
cd $APP_DIR

# 파일 복사 (로컬 배포 가정)
echo "📁 애플리케이션 파일 복사..."
if [ -f "./server.js" ]; then
    cp server.js $APP_DIR/server.js
    cp package.json $APP_DIR/package.json
    cp -r public $APP_DIR/
    cp ecosystem.config.js $APP_DIR/
fi

# .env 생성
cat > $APP_DIR/.env << EOF
NODE_ENV=production
PORT=3000
JWT_SECRET=$JWT_SECRET
DB_PATH=/var/www/biglinker/biglinker.db
UPLOADS_DIR=/var/www/biglinker/uploads
ALLOWED_ORIGINS=https://$DOMAIN,https://www.$DOMAIN
EOF

echo "📦 npm 패키지 설치 중..."
cd $APP_DIR && npm install --only=production --quiet

# PM2 시작
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup systemd -u $(whoami) --hp $HOME | tail -1 | bash

# Nginx 설정
echo "🌐 Nginx 설정 중..."
cp nginx.conf /etc/nginx/sites-available/biglinker 2>/dev/null || cat > /etc/nginx/sites-available/biglinker << 'NGINX'
server {
    listen 80;
    server_name PLACEHOLDER_DOMAIN www.PLACEHOLDER_DOMAIN;
    client_max_body_size 30M;
    location /api/claude/stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX

sed -i "s/PLACEHOLDER_DOMAIN/$DOMAIN/g" /etc/nginx/sites-available/biglinker
ln -sf /etc/nginx/sites-available/biglinker /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# SSL 인증서
echo "🔐 SSL 인증서 발급 중 ($DOMAIN)..."
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN || \
certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN

echo ""
echo "═══════════════════════════════════════"
echo "✅ BigLinker 설치 완료!"
echo ""
echo "   🌐 주소: https://$DOMAIN"
echo "   📁 경로: $APP_DIR"
echo ""
echo "   기본 계정:"
echo "   - 관리자:    admin / admin1234"
echo "   - 컨설턴트: cons01 / 1234"
echo "   - 학생:      kim2024 / 1234"
echo ""
echo "   ⚠️  운영 전 반드시:"
echo "   1. 관리자 로그인 > 설정 > Anthropic API 키 등록"
echo "   2. 기본 비밀번호 전원 변경"
echo "   3. 샘플 학생(kim2024) 삭제"
echo "═══════════════════════════════════════"
