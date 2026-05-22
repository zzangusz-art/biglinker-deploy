#!/bin/bash

# ═══════════════════════════════════════════════════════
# BigLinker ERP 배포 스크립트
# 사용: ./deploy.sh [로컬|도커|프로덕션]
# ═══════════════════════════════════════════════════════

set -e

# 색상
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  BigLinker ERP 배포 스크립트${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

# ─────────────────────────────────────────────────────
# 함수 정의
# ─────────────────────────────────────────────────────

generate_jwt_secret() {
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
}

check_node() {
    if ! command -v node &> /dev/null; then
        echo -e "${RED}❌ Node.js가 설치되지 않았습니다${NC}"
        echo "   https://nodejs.org 에서 v20.x 이상을 설치하세요"
        exit 1
    fi
    echo -e "${GREEN}✓ Node.js: $(node --version)${NC}"
}

check_docker() {
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}❌ Docker가 설치되지 않았습니다${NC}"
        echo "   https://www.docker.com 에서 설치하세요"
        exit 1
    fi
    echo -e "${GREEN}✓ Docker: $(docker --version)${NC}"
}

setup_env() {
    if [ ! -f .env ]; then
        echo -e "${YELLOW}⚠️  .env 파일이 없습니다. 생성 중...${NC}"
        cp .env.example .env

        # JWT_SECRET 자동 생성
        JWT_SECRET=$(generate_jwt_secret)
        sed -i "s/your-super-secret-key-change-this-to-random-32-chars-minimum/$JWT_SECRET/" .env

        echo -e "${GREEN}✓ .env 파일 생성 완료${NC}"
        echo -e "${YELLOW}⚠️  다음 항목을 .env에서 확인하세요:${NC}"
        echo "   - ALLOWED_ORIGINS (도메인)"
        echo "   - ANTHROPIC_API_KEY (선택사항)"
    else
        echo -e "${GREEN}✓ .env 파일 이미 존재${NC}"
    fi
}

deploy_local() {
    echo -e "${BLUE}📦 로컬 개발 환경 설정${NC}"

    check_node
    setup_env

    echo -e "${YELLOW}📥 의존성 설치 중...${NC}"
    npm install

    echo -e "${GREEN}✓ 준비 완료!${NC}"
    echo -e "${BLUE}다음 명령으로 시작하세요:${NC}"
    echo "   npm run dev    # 자동 재시작"
    echo "   npm start      # 일반 실행"
    echo ""
    echo -e "${YELLOW}접속 주소:${NC}"
    echo "   LMS: http://localhost:3000"
    echo "   ERP: http://localhost:3000/erp"
}

deploy_docker() {
    echo -e "${BLUE}🐳 Docker 배포${NC}"

    check_docker
    setup_env

    echo -e "${YELLOW}🔨 Docker 이미지 빌드 중...${NC}"
    docker build -t biglinker:latest .

    echo -e "${YELLOW}🚀 컨테이너 시작 중...${NC}"
    docker-compose up -d

    echo -e "${GREEN}✓ Docker 배포 완료!${NC}"
    echo ""
    echo -e "${YELLOW}유용한 명령어:${NC}"
    echo "   docker-compose logs -f          # 실시간 로그"
    echo "   docker-compose stop             # 중지"
    echo "   docker-compose restart          # 재시작"
    echo "   docker-compose down             # 중지 및 삭제"
    echo ""
    echo -e "${YELLOW}접속 주소:${NC}"
    echo "   LMS: http://localhost:3000"
    echo "   ERP: http://localhost:3000/erp"
}

deploy_production() {
    echo -e "${BLUE}🚀 프로덕션 배포 (자체 서버)${NC}"

    check_node
    setup_env

    # PM2 확인
    if ! command -v pm2 &> /dev/null; then
        echo -e "${YELLOW}⚠️  PM2가 설치되지 않았습니다. 설치 중...${NC}"
        npm install -g pm2
    fi

    echo -e "${YELLOW}📥 의존성 설치 중...${NC}"
    npm ci --only=production

    echo -e "${YELLOW}🚀 PM2로 시작 중...${NC}"
    pm2 start ecosystem.config.js --env production

    echo -e "${YELLOW}💾 PM2 자동 시작 설정 중...${NC}"
    pm2 startup
    pm2 save

    echo -e "${GREEN}✓ 프로덕션 배포 완료!${NC}"
    echo ""
    echo -e "${YELLOW}모니터링:${NC}"
    echo "   pm2 status              # 프로세스 상태"
    echo "   pm2 logs biglinker      # 로그"
    echo "   pm2 monit               # 실시간 모니터링"
    echo "   pm2 web                 # 웹 대시보드 (http://localhost:9615)"
    echo ""
    echo -e "${YELLOW}관리 명령어:${NC}"
    echo "   pm2 restart biglinker   # 재시작"
    echo "   pm2 stop biglinker      # 중지"
    echo "   pm2 delete biglinker    # 삭제"
}

show_help() {
    echo -e "${BLUE}사용법:${NC}"
    echo "   ./deploy.sh [명령어]"
    echo ""
    echo -e "${BLUE}명령어:${NC}"
    echo "   local          로컬 개발 환경 설정"
    echo "   docker         Docker Compose로 배포"
    echo "   prod           프로덕션 배포 (PM2 필수)"
    echo "   help           이 도움말 표시"
    echo ""
    echo -e "${BLUE}예시:${NC}"
    echo "   ./deploy.sh local       # 로컬 개발 시작"
    echo "   ./deploy.sh docker      # Docker로 실행"
    echo "   ./deploy.sh prod        # 프로덕션 배포"
}

# ─────────────────────────────────────────────────────
# 메인 로직
# ─────────────────────────────────────────────────────

COMMAND=${1:-help}

case $COMMAND in
    local)
        deploy_local
        ;;
    docker)
        deploy_docker
        ;;
    prod|production)
        deploy_production
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        echo -e "${RED}❌ 알 수 없는 명령어: $COMMAND${NC}"
        echo ""
        show_help
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}완료! 🎉${NC}"
