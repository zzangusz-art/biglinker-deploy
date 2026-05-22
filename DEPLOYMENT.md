# 🚀 BigLinker ERP 배포 가이드

## 📋 목차
1. [로컬 개발 환경](#로컬-개발-환경)
2. [Docker 배포](#docker-배포)
3. [Railway 배포 (추천)](#railway-배포-추천)
4. [자체 서버 배포](#자체-서버-배포)
5. [환경변수 설정](#환경변수-설정)
6. [트러블슈팅](#트러블슈팅)

---

## 로컬 개발 환경

### 1️⃣ 준비사항
```bash
# Node.js 20.x 설치 확인
node --version  # v20.x 이상

# npm 확인
npm --version   # v10.x 이상
```

### 2️⃣ 초기 설정
```bash
cd biglinker-deploy

# 의존성 설치
npm install

# 환경변수 복사
cp .env.example .env

# .env 파일 수정 (에디터에서)
# JWT_SECRET: 생성하려면 아래 명령 실행
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3️⃣ 개발 서버 실행
```bash
# nodemon으로 자동 재시작
npm run dev

# 또는 일반 실행
npm start
```

### 4️⃣ 접속
- **LMS**: http://localhost:3000
- **ERP**: http://localhost:3000/erp
- **Transfer LMS**: http://localhost:3000/transfer
- **API Health**: http://localhost:3000/health

---

## Docker 배포

### 1️⃣ Docker 이미지 빌드
```bash
docker build -t biglinker:latest .
```

### 2️⃣ 컨테이너 실행 (로컬)
```bash
docker run -p 3000:3000 \
  -e JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  -e NODE_ENV=production \
  -v biglinker-data:/data \
  --name biglinker \
  biglinker:latest
```

### 3️⃣ docker-compose로 실행 (권장)
```bash
# docker-compose.yml이 있으면
docker-compose up -d
```

### 4️⃣ 컨테이너 관리
```bash
# 로그 확인
docker logs biglinker

# 실시간 로그
docker logs -f biglinker

# 컨테이너 중지
docker stop biglinker

# 컨테이너 삭제
docker rm biglinker

# 볼륨 확인
docker volume ls
```

---

## Railway 배포 (추천)

### 1️⃣ Railway 계정 생성
- https://railway.app 에서 GitHub로 가입

### 2️⃣ 새 프로젝트 생성
```
Railway Dashboard → New Project → Deploy from GitHub
```

### 3️⃣ GitHub 레포 연결
- biglinker-deploy 레포 선택
- 자동 배포 활성화

### 4️⃣ 환경변수 설정
Railway Dashboard → Variables 탭에서:

```
JWT_SECRET=생성된-64자-랜덤-문자열
NODE_ENV=production
ANTHROPIC_API_KEY=sk-ant-...
ALLOWED_ORIGINS=https://your-domain.railway.app
```

**JWT_SECRET 생성:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5️⃣ 데이터베이스 설정
Railway Dashboard → New → Database → PostgreSQL (선택사항)

또는 SQLite 유지:
- Railway → Settings → Volumes → Add
- Mount Path: `/data`
- 용량: 1GB 이상

### 6️⃣ 배포 확인
```
Railway Dashboard → Deployments → 최신 배포
- Status: Success 확인
- View Logs 에서 'BigLinker 서버 시작' 메시지 확인
```

### 7️⃣ 도메인 연결
Railway Dashboard → Settings → Domain:
```
your-domain.railway.app 또는 커스텀 도메인
```

### 8️⃣ 자동 배포 설정
- GitHub 푸시 → 자동 배포 (기본 활성화)
- 빌드 로그 확인: Railway → Deployments

---

## 자체 서버 배포

### VPS/전용서버 (Ubuntu 20.04+)

#### 1️⃣ 서버 초기 설정
```bash
# 업데이트
sudo apt-get update && sudo apt-get upgrade -y

# Node.js 설치
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2 설치 (프로세스 관리)
sudo npm install -g pm2

# Nginx 설치 (프록시)
sudo apt-get install -y nginx

# SSL 인증서 (Let's Encrypt)
sudo apt-get install -y certbot python3-certbot-nginx
```

#### 2️⃣ 애플리케이션 배포
```bash
# 앱 디렉토리
mkdir -p /var/www/biglinker
cd /var/www/biglinker

# 소스 복사
git clone https://github.com/your-repo/biglinker-deploy.git .

# 의존성 설치
npm ci --only=production

# 데이터 폴더
mkdir -p /var/www/biglinker/data
chmod 755 /var/www/biglinker/data
```

#### 3️⃣ 환경변수 설정
```bash
sudo nano .env
```

```env
NODE_ENV=production
PORT=3000
JWT_SECRET=your-64-char-random-string
DB_PATH=/var/www/biglinker/data/biglinker.db
UPLOADS_DIR=/var/www/biglinker/data/uploads
ALLOWED_ORIGINS=https://yourdomain.com
ANTHROPIC_API_KEY=sk-ant-...
```

#### 4️⃣ PM2로 실행
```bash
# 시작
pm2 start ecosystem.config.js --env production

# 자동 시작 설정
pm2 startup
pm2 save

# 상태 확인
pm2 status
pm2 logs biglinker
```

#### 5️⃣ Nginx 프록시 설정
```bash
sudo nano /etc/nginx/sites-available/biglinker
```

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name yourdomain.com www.yourdomain.com;
    
    # 파일 업로드 크기 제한
    client_max_body_size 20M;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

#### 6️⃣ Nginx 활성화
```bash
sudo ln -s /etc/nginx/sites-available/biglinker \
  /etc/nginx/sites-enabled/

sudo nginx -t
sudo systemctl restart nginx
```

#### 7️⃣ SSL 인증서 설정
```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

#### 8️⃣ 자동 갱신
```bash
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
```

#### 9️⃣ 모니터링
```bash
# PM2 모니터링 대시보드
pm2 monit

# 또는 웹 대시보드
pm2 web
# http://localhost:9615 에서 확인

# 로그 확인
tail -f /var/www/biglinker/logs/out.log
tail -f /var/www/biglinker/logs/err.log
```

---

## 환경변수 설정

### 필수 변수

| 변수 | 설명 | 예시 |
|------|------|------|
| `JWT_SECRET` | JWT 토큰 서명용 비밀키 (64자 이상) | `abc123...` |
| `NODE_ENV` | 실행 환경 | `production` 또는 `development` |
| `PORT` | 서버 포트 | `3000` |

### 권장 변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `DB_PATH` | SQLite 데이터베이스 경로 | `./biglinker.db` |
| `UPLOADS_DIR` | 파일 업로드 경로 | `./uploads` |
| `ALLOWED_ORIGINS` | CORS 허용 도메인 | `*` |
| `LOG_LEVEL` | 로그 레벨 | `info` |
| `ANTHROPIC_API_KEY` | Claude API 키 (선택) | - |

---

## 트러블슈팅

### 1️⃣ "포트 이미 사용 중" 에러
```bash
# 포트 점유 프로세스 확인
lsof -i :3000

# 또는 Windows
netstat -ano | findstr :3000

# 프로세스 종료
kill -9 <PID>
```

### 2️⃣ "better-sqlite3 빌드 실패"
```bash
# 빌드 도구 설치 (Windows)
npm install --global windows-build-tools

# Linux
sudo apt-get install python3 make g++

# 재설치
npm install better-sqlite3
```

### 3️⃣ "JWT 토큰 오류"
```
원인: .env 파일의 JWT_SECRET이 변경됨
해결: 브라우저 localStorage 초기화
     → DevTools → Application → LocalStorage → 비우기
```

### 4️⃣ "데이터베이스 잠금 오류"
```bash
# SQLite 파일 권한 확인
ls -l biglinker.db

# 권한 수정
chmod 666 biglinker.db
```

### 5️⃣ "파일 업로드 실패"
```bash
# uploads 폴더 생성 및 권한
mkdir -p uploads
chmod 755 uploads
```

### 6️⃣ "CORS 오류"
```env
# .env에서 ALLOWED_ORIGINS 확인
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

### 7️⃣ "메모리 부족"
```bash
# PM2 설정 (ecosystem.config.js)
max_memory_restart: '256M'  # 256MB로 자동 재시작

# 또는
node --max-old-space-size=512 server.js
```

### 8️⃣ "502 Bad Gateway (Nginx)"
```bash
# Nginx 로그 확인
sudo tail -f /var/log/nginx/error.log

# Node.js 애플리케이션 실행 확인
pm2 status

# 포트 바인딩 확인
netstat -tlnp | grep 3000
```

---

## 📊 배포 체크리스트

### 배포 전
- [ ] JWT_SECRET 생성 및 설정
- [ ] ALLOWED_ORIGINS 설정
- [ ] ANTHROPIC_API_KEY 설정 (선택)
- [ ] 데이터베이스 백업
- [ ] 로컬에서 테스트 완료

### Railway 배포
- [ ] GitHub 레포 연결
- [ ] 환경변수 설정
- [ ] 자동 배포 확인
- [ ] 헬스체크 통과 확인
- [ ] 도메인 설정

### 자체 서버 배포
- [ ] Node.js 20.x 설치
- [ ] PM2 설치 및 설정
- [ ] Nginx 설정
- [ ] SSL 인증서 설정
- [ ] 파이어월 포트 개방 (80, 443)
- [ ] 자동 백업 설정

### 배포 후
- [ ] 홈페이지 접속 확인
- [ ] ERP 로그인 확인
- [ ] API 엔드포인트 테스트
- [ ] 파일 업로드 테스트
- [ ] 출퇴근 기능 테스트
- [ ] 모니터링 대시보드 설정

---

## 🔒 보안 체크리스트

- [ ] JWT_SECRET이 강력한 난수인지 확인
- [ ] ALLOWED_ORIGINS가 정확하게 설정되었는지 확인
- [ ] HTTP에서 HTTPS로 자동 리다이렉트 설정
- [ ] 데이터베이스 파일 권한 확인 (chmod 660)
- [ ] 업로드 폴더 권한 확인 (chmod 755)
- [ ] 환경변수 파일을 git에 커밋하지 않았는지 확인
- [ ] 정기 백업 설정
- [ ] 로그 모니터링 설정

---

## 📞 지원

문제 발생 시:
1. 로그 확인: `pm2 logs biglinker`
2. 헬스체크: `curl http://localhost:3000/health`
3. 에러 메시지 캡처 후 이슈 제출

---

**Happy Deployment! 🎉**
