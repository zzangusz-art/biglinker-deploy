# BigLinker 편입 LMS — 배포 가이드

## 🚀 빠른 시작

### 1. 로컬 실행
```bash
npm install
cp .env.example .env   # .env 파일 생성 후 값 입력
node server.js
```
브라우저에서 `http://localhost:3000/transfer` 접속

---

## 🌐 GitHub → Railway 배포 (권장)

### 1단계: GitHub 리포지토리 설정
```bash
git add .
git commit -m "feat: 편입 LMS 추가"
git push origin main
```

### 2단계: Railway 프로젝트 생성
1. [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. 리포지토리 선택

### 3단계: 환경변수 설정 (Railway Dashboard → Variables)
| 변수명 | 값 |
|--------|-----|
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` 결과 |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DB_PATH` | `/data/biglinker.db` |
| `ALLOWED_ORIGINS` | `*` (또는 실제 도메인) |

### 4단계: Volume 마운트 (데이터 영구 저장)
Railway Dashboard → Add Volume → Mount Path: `/data`

### 5단계: GitHub Actions 자동 배포
`.github/workflows/deploy.yml` 이미 설정됨
- `RAILWAY_TOKEN`: Railway Dashboard → Account Settings → Tokens
- GitHub Repository → Settings → Secrets → `RAILWAY_TOKEN` 추가

---

## 🌐 Render 배포

`render.yaml` 이미 설정됨
1. [render.com](https://render.com) → New Web Service → Connect Repository
2. Build Command: `npm install`
3. Start Command: `node server.js`
4. 환경변수 설정 (위 표 참고)

---

## 🔑 기본 계정

| 역할 | 아이디 | 비밀번호 |
|------|--------|---------|
| 관리자 | `transfer_admin` | `admin1234` |
| 강사1 | `instructor01` | `1234` |
| 강사2 | `instructor02` | `1234` |
| 학생 (A반) | `s_choi`, `s_park` | `1234` |
| 학생 (B반) | `s_kim`, `s_lee` | `1234` |
| 학생 (C반) | `s_jung`, `s_han` | `1234` |

---

## 📁 주요 URL

| URL | 설명 |
|-----|------|
| `/` | 기존 대입 LMS (컨설턴트 시스템) |
| `/transfer` | **편입 LMS** (관리자·강사·학생) |
| `/health` | 서버 상태 확인 |

---

## 🏗 편입 LMS 기능 구조

### 관리자
- 대시보드: 학생/반/테스트 통계
- 학생 관리: A/B/C반 배정, 강사 연결
- 강사 관리: 계정 생성/삭제
- 스케줄 관리: 일별 라이브 Zoom 링크 등록
- 레벨테스트 결과: 신규 학생 배정 현황
- 전체 분석: 학생별 성적 조회

### 강사
- 대시보드: 오늘 수업 현황
- **녹화본 등록**: 수업 후 Zoom 녹화 링크 교시별 등록
- 스케줄 관리: 라이브 강의 Zoom 링크 등록
- 내 학생: 담당 학생 성적/강약점 분석
- 문제 관리: 테스트 문제 추가/삭제

### 학생
- 홈: 오늘 수업·복습·테스트 현황
- **오전 수업**: 1~3교시 라이브 Zoom 입장
- **오후 복습**: 녹화본 시청 + 자습 메모장
- **레벨테스트**: 40문제 → A/B/C반 자동 배정
- **테스트 센터**: 단어·어휘·문법·독해·논리·학교별 무제한
- **내 성적**: 섹션별 강약점·추천 학습법

### 반 배정 기준
| 반 | 목표 대학 | 정답률 |
|----|-----------|--------|
| A반 | 서울대·연세대·고려대 | 80% 이상 |
| B반 | 서울권 상위 대학 | 60~79% |
| C반 | 일반 대학 | 60% 미만 |
