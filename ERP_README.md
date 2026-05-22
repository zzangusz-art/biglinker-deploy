# 🎯 BigLinker ERP — 사내 통합 업무 시스템

> **빅링커의 대표·관리자·직원을 위한 3계층 ERP 플랫폼**  
> 현대적 업무 관리, 재무 추적, 인사 관리, OKR 관리까지 한 곳에서

---

## 📋 주요 기능

### 👑 대표(CEO) 대시보드
- **📊 KPI 모니터링**: 월별 매출·지출·순이익, 수강생·직원 수
- **💰 재무 분석**: 매출/지출 추이 차트, 카테고리별 분류
- **👥 직원 현황**: 전체 직원 조회, 출퇴근 관리
- **📈 OKR 추적**: 분기별 목표·핵심결과 진행률
- **📋 결재 관리**: 전사 결재 요청 처리
- **📢 공지사항**: 사내 소식 발행

### 👨‍💼 관리자(Manager) 대시보드
- **📊 업무 현황**: 팀 전체 태스크 진행 상황
- **👥 팀 관리**: 직원 정보, 출퇴근, 급여 관리
- **✅ 업무 배분**: 태스크 생성 및 우선순위 설정
- **📅 일정 관리**: 회의·수업·상담 스케줄
- **📋 결재 처리**: 부하직원 결재 승인/반려
- **🎓 학생 현황**: 담당 학생 조회

### 👨‍💻 직원(Employee) 대시보드
- **🏠 내 현황**: 오늘 일정·업무·담당 학생
- **🕐 출퇴근**: 원클릭 출근/퇴근, 근무시간 자동 계산
- **✅ 업무 목록**: 배정받은 태스크, 진행상태 변경
- **📅 일정**: 개인 일정 등록 및 관리
- **📋 결재 신청**: 휴가·지출·보고 신청
- **📢 공지**: 사내 공지 열람

---

## 🏗️ 기술 스택

| 계층 | 기술 | 버전 |
|------|------|------|
| **Runtime** | Node.js | 20.x |
| **Framework** | Express.js | 4.19 |
| **Database** | SQLite | 3 |
| **Authentication** | JWT | - |
| **Security** | bcryptjs, Helmet | - |
| **API** | REST | - |
| **Deployment** | Docker, Railway | - |
| **Process Manager** | PM2 | - |

---

## 🚀 빠른 시작

### 1️⃣ 로컬 개발 (최간단)
```bash
# Mac/Linux
chmod +x deploy.sh
./deploy.sh local

# Windows
deploy.bat local
```

### 2️⃣ Docker로 실행
```bash
./deploy.sh docker    # Mac/Linux
# 또는
docker-compose up -d
```

### 3️⃣ 프로덕션 배포
```bash
./deploy.sh prod      # 자체 서버
```

자세한 배포 가이드: [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## 📊 데이터베이스 구조

```
┌─────────────────────────────────────────────┐
│            BigLinker ERP DB                 │
├─────────────────────────────────────────────┤
│ erp_employees     → 직원 정보               │
│ erp_attendance    → 출퇴근 기록             │
│ erp_tasks         → 업무 태스크             │
│ erp_schedules     → 일정                    │
│ erp_notices       → 공지사항                │
│ erp_approvals     → 결재                    │
│ erp_revenue       → 매출 (수강료·컨설팅비) │
│ erp_expenses      → 지출 (임대료·공과금)   │
│ erp_okrs          → OKR (목표 관리)        │
│ erp_payroll       → 급여 (월별)            │
└─────────────────────────────────────────────┘
```

---

## 🔐 테스트 계정

```
👑 대표    : ceo / ceo1234
👨‍💼 관리자  : admin / admin1234
👨‍💻 직원    : cons01 / 1234
```

**접속**: http://localhost:3000/erp

---

## 📡 API 엔드포인트

### 인증
```
POST /api/auth/login              로그인
GET  /api/erp/me                  현재 사용자 정보
```

### 대시보드
```
GET  /api/erp/dashboard           역할별 대시보드 데이터
```

### 직원 관리
```
GET  /api/erp/employees           직원 목록
PUT  /api/erp/employees/:id       직원 정보 수정
```

### 출퇴근
```
GET  /api/erp/attendance          출퇴근 기록
POST /api/erp/attendance/checkin  출근
POST /api/erp/attendance/checkout 퇴근
```

### 업무
```
GET    /api/erp/tasks             태스크 목록
POST   /api/erp/tasks             태스크 생성
PUT    /api/erp/tasks/:id         태스크 수정
DELETE /api/erp/tasks/:id         태스크 삭제
```

### 일정
```
GET    /api/erp/schedules         일정 목록
POST   /api/erp/schedules         일정 생성
PUT    /api/erp/schedules/:id     일정 수정
DELETE /api/erp/schedules/:id     일정 삭제
```

### 결재
```
GET  /api/erp/approvals                결재 목록
POST /api/erp/approvals                결재 신청
PUT  /api/erp/approvals/:id/process    결재 처리
```

### 공지사항
```
GET    /api/erp/notices           공지 목록
POST   /api/erp/notices           공지 작성
PUT    /api/erp/notices/:id       공지 수정
DELETE /api/erp/notices/:id       공지 삭제
```

### 재무 (CEO 전용)
```
GET  /api/erp/finance/summary     재무 요약
GET  /api/erp/revenue             매출 목록
POST /api/erp/revenue             매출 등록
GET  /api/erp/expenses            지출 목록
POST /api/erp/expenses            지출 등록
```

### OKR (CEO/Manager)
```
GET    /api/erp/okrs              OKR 목록
POST   /api/erp/okrs              OKR 생성
PUT    /api/erp/okrs/:id          OKR 수정
DELETE /api/erp/okrs/:id          OKR 삭제
```

### 급여 (CEO)
```
GET  /api/erp/payroll             급여 목록
POST /api/erp/payroll             급여 생성
```

---

## 🎨 현대적 업무 시스템 특징

### 1️⃣ OKR 목표 관리
- 분기별 핵심 목표 설정 및 진행률 추적
- 대표 → 팀 → 개인 목표 연계
- 투명한 성과 관리

### 2️⃣ 데이터 기반 의사결정
- 실시간 재무 대시보드 (매출/지출/순이익)
- 월별 추이 시각화
- 카테고리별 지출 분석

### 3️⃣ 효율적 자원 배분
- 업무 우선순위 관리 (긴급/높음/보통/낮음)
- 담당자별 업무 부하 분산
- 기한 기반 추적

### 4️⃣ 투명한 결재 시스템
- 휴가·지출·보고 결재 원스톱
- 자동 결재자 라우팅
- 결재 이력 관리

### 5️⃣ 직원 참여 문화
- 출퇴근 자동 관리 (위변조 방지)
- 개인 공정한 평가
- 목표 달성도 투명 공개

### 6️⃣ 통합 커뮤니케이션
- 사내 공지사항 일괄 발송
- 중요 공지 고정 기능
- 조회수 추적

---

## 🛠️ 개발 가이드

### 로컬 환경 설정
```bash
# 1. 저장소 클론
git clone <repo-url>
cd biglinker-deploy

# 2. 의존성 설치
npm install

# 3. 환경변수 설정
cp .env.example .env
# JWT_SECRET 생성:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. 개발 서버 실행
npm run dev
```

### 새 API 추가
```javascript
// server.js에 추가
app.get('/api/erp/custom', erpAuth, (req, res) => {
  // 비즈니스 로직
  res.json({ success: true });
});
```

### ERP 페이지 추가
```javascript
// erp.html의 navigate() 함수에 추가
else if (page === 'custom') renderCustom(content);

// 렌더링 함수 추가
async function renderCustom(parent) {
  const data = await api('GET', '/api/erp/custom');
  // UI 생성
}
```

---

## 📈 모니터링 및 운영

### 헬스체크
```bash
curl http://localhost:3000/health
```

### 로그 확인
```bash
# Docker
docker-compose logs -f

# PM2
pm2 logs biglinker

# 직접 실행
tail -f logs/out.log
```

### 성능 모니터링
```bash
# PM2 모니터링
pm2 monit

# 또는 웹 대시보드
pm2 web
# http://localhost:9615
```

### 데이터베이스 백업
```bash
# SQLite 백업
cp biglinker.db biglinker.db.backup

# 또는 자동 백업 스크립트 설정
```

---

## 🔒 보안 체크리스트

- [ ] JWT_SECRET이 강력한 난수 (최소 32자)
- [ ] ALLOWED_ORIGINS가 정확하게 설정됨
- [ ] HTTP → HTTPS 자동 리다이렉트
- [ ] 데이터베이스 파일 권한 (chmod 660)
- [ ] 업로드 폴더 권한 (chmod 755)
- [ ] .env 파일을 git에서 제외
- [ ] 정기 백업 설정
- [ ] 로그 모니터링 활성화

---

## 📞 문제 해결

### "포트 이미 사용 중" 오류
```bash
# 포트 점유 프로세스 확인
lsof -i :3000

# 프로세스 종료
kill -9 <PID>
```

### "JWT 토큰 오류"
```
해결: 브라우저 localStorage 비우기
DevTools → Application → LocalStorage → 비우기
```

### "데이터베이스 잠금" 오류
```bash
chmod 666 biglinker.db
```

자세한 트러블슈팅: [DEPLOYMENT.md](./DEPLOYMENT.md#트러블슈팅)

---

## 📦 배포 옵션

| 플랫폼 | 방법 | 난이도 | 비용 |
|--------|------|--------|------|
| **로컬** | npm start | ⭐ | 무료 |
| **Docker** | docker-compose | ⭐⭐ | 무료 |
| **Railway** | GitHub 연동 | ⭐⭐ | 기본 무료 |
| **Vercel** | Node.js 함수 | ⭐⭐⭐ | 기본 무료 |
| **AWS** | EC2/RDS | ⭐⭐⭐⭐ | 유료 |
| **자체 서버** | PM2 + Nginx | ⭐⭐⭐⭐ | 유료 |

**추천**: Railway (가장 간단, 자동 배포)

---

## 🎯 로드맵

### Phase 1 (완료 ✓)
- [x] 3계층 대시보드
- [x] 직원 관리
- [x] 출퇴근 시스템
- [x] 업무 관리
- [x] 일정 관리
- [x] 결재 시스템
- [x] 공지사항

### Phase 2 (진행 중)
- [ ] 모달 폼 완성 (CRUD)
- [ ] 고급 차트 (매출/지출)
- [ ] 알림·푸시 시스템
- [ ] 모바일 최적화
- [ ] 다중 언어 지원

### Phase 3 (계획 중)
- [ ] 보고서 기능
- [ ] 고급 분석
- [ ] 연동 기능 (급여 시스템)
- [ ] API 문서 자동화

---

## 📄 라이선스

MIT License - 자유롭게 사용 가능

---

## 🤝 기여하기

버그 리포트 및 기능 제안은 GitHub Issues로 부탁드립니다.

---

## 📞 지원

- **이메일**: support@gobiglinker.com
- **문제**: GitHub Issues
- **피드백**: Discussions

---

**Happy Business Management! 🚀**

---

<div align="center">

**빅링커 ERP로 더 스마트한 비즈니스를 만들어보세요!**

[📖 전체 배포 가이드](./DEPLOYMENT.md) | [🐳 Docker 실행](./docker-compose.yml) | [📊 API 문서](./API.md)

</div>
