# 🚀 빅링커 ERP — 5분 내 배포 가이드

## ⚡ 가장 간단한 방법: Railway (추천)

### 1단계: GitHub에 푸시
```bash
git add .
git commit -m "Add BigLinker ERP system"
git push origin main
```

### 2단계: Railway 연결
1. https://railway.app 접속 (GitHub로 가입)
2. "New Project" → "Deploy from GitHub"
3. biglinker-deploy 레포 선택
4. "Add Variables" 탭에서 환경변수 설정:
   ```
   JWT_SECRET=<생성된 64자 난수>
   NODE_ENV=production
   ANTHROPIC_API_KEY=<필수 아님>
   ALLOWED_ORIGINS=https://프로젝트명.up.railway.app
   ```
5. Deploy 버튼 클릭

**완료!** 자동으로 배포됨. URL: `https://프로젝트명.up.railway.app/erp`

---

## 💻 로컬에서 테스트 (3단계)

### Mac/Linux
```bash
chmod +x deploy.sh
./deploy.sh local
npm run dev
```

### Windows
```bash
deploy.bat local
npm run dev
```

**접속**: http://localhost:3000/erp

**테스트 계정:**
- 대표: `ceo` / `ceo1234`
- 관리자: `admin` / `admin1234`
- 직원: `cons01` / `1234`

---

## 🐳 Docker로 빠르게 실행

```bash
./deploy.sh docker
# 또는
docker-compose up -d
```

**접속**: http://localhost:3000/erp

---

## 🖥️ 자체 서버 배포 (Ubuntu/Debian)

```bash
./deploy.sh prod
```

준비사항: Node.js 20.x, PM2

---

## 📊 배포 후 확인사항

```bash
# 헬스체크
curl https://프로젝트명.up.railway.app/health

# 로그 확인 (Railway)
# Dashboard → Deployments → View Logs

# 로그 확인 (Local)
docker-compose logs -f
# 또는
npm run dev
```

---

## 🔑 환경변수 생성

```bash
# JWT_SECRET 생성 (필수)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 출력 예:
# a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

---

## 📚 자세한 가이드

| 내용 | 파일 |
|------|------|
| 전체 배포 가이드 | [DEPLOYMENT.md](./DEPLOYMENT.md) |
| ERP 기능 설명 | [ERP_README.md](./ERP_README.md) |
| API 문서 | API 엔드포인트 섹션 참고 |

---

## ⚠️ 흔한 문제 해결

### 포트 이미 사용 중
```bash
lsof -i :3000           # 프로세스 확인
kill -9 <PID>           # 종료
```

### JWT 오류
```
→ 브라우저 DevTools → Application → LocalStorage 비우기
```

### Docker 빌드 실패
```bash
docker system prune -a  # 캐시 초기화
docker-compose build --no-cache
```

---

## 🎯 배포 후 추천 설정

1. **도메인 연결** (Railway)
   - Settings → Domain → 커스텀 도메인 추가

2. **자동 백업** (Local)
   ```bash
   # 매일 자동 백업
   crontab -e
   # 0 2 * * * cp /path/to/biglinker.db /path/to/backup/biglinker_$(date +%Y%m%d).db
   ```

3. **모니터링** (Local PM2)
   ```bash
   pm2 monit        # 실시간 모니터링
   pm2 logs         # 로그 확인
   ```

4. **SSL 인증서** (자체 서버)
   ```bash
   sudo certbot --nginx -d yourdomain.com
   ```

---

## 📞 도움말

- **로컬 문제**: `npm run dev` 실행 후 로그 확인
- **배포 문제**: Railway Dashboard → Deployments → View Logs
- **API 문제**: `/health` 엔드포인트 확인
- **데이터 문제**: SQLite 파일 권한 확인

---

## ✅ 배포 체크리스트

```
로컬 테스트
☐ npm install 완료
☐ npm run dev로 실행 확인
☐ http://localhost:3000/erp 접속 확인
☐ 테스트 계정으로 로그인 확인

Railway 배포
☐ GitHub 푸시 완료
☐ Railway 프로젝트 생성
☐ 환경변수 설정
☐ 자동 배포 확인
☐ 헬스체크 통과

Docker 배포
☐ docker-compose.yml 확인
☐ docker-compose up -d 실행
☐ docker logs -f 확인
☐ http://localhost:3000/erp 접속 확인

프로덕션 (자체 서버)
☐ Node.js 20.x 설치
☐ PM2 설치
☐ Nginx 설정
☐ SSL 인증서 설정
☐ 자동 시작 설정
☐ 모니터링 활성화
```

---

<div align="center">

**이제 시작할 준비가 되셨나요?** 

[🚀 지금 배포하기](#-가장-간단한-방법-railway-추천)

</div>
