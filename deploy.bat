@echo off
REM ═══════════════════════════════════════════════════════
REM BigLinker ERP 배포 스크립트 (Windows)
REM 사용: deploy.bat [local|docker|prod]
REM ═══════════════════════════════════════════════════════

setlocal enabledelayedexpansion

set COMMAND=%1
if "%COMMAND%"=="" set COMMAND=help

echo.
echo ═══════════════════════════════════════════════════════
echo   BigLinker ERP 배포 스크립트
echo ═══════════════════════════════════════════════════════
echo.

if "%COMMAND%"=="local" goto DEPLOY_LOCAL
if "%COMMAND%"=="docker" goto DEPLOY_DOCKER
if "%COMMAND%"=="prod" goto DEPLOY_PROD
if "%COMMAND%"=="help" goto SHOW_HELP
if "%COMMAND%"=="--help" goto SHOW_HELP
if "%COMMAND%"=="-h" goto SHOW_HELP

echo 알 수 없는 명령어: %COMMAND%
echo.
goto SHOW_HELP

REM ─────────────────────────────────────────────────────
REM 로컬 개발 환경
REM ─────────────────────────────────────────────────────
:DEPLOY_LOCAL
echo 로컬 개발 환경 설정
echo.

REM Node.js 확인
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Node.js가 설치되지 않았습니다.
    echo https://nodejs.org에서 v20.x 이상을 설치하세요
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo Node.js: %NODE_VERSION%
echo.

REM .env 파일 생성
if not exist .env (
    echo .env 파일이 없습니다. 생성 중...
    copy .env.example .env >nul
    echo .env 파일 생성 완료
    echo.
    echo 다음 항목을 .env에서 확인하세요:
    echo  - ALLOWED_ORIGINS (도메인)
    echo  - ANTHROPIC_API_KEY (선택사항)
    echo.
) else (
    echo .env 파일 이미 존재
    echo.
)

REM 의존성 설치
echo 의존성 설치 중...
call npm install

echo.
echo 준비 완료!
echo.
echo 다음 명령으로 시작하세요:
echo   npm run dev    # 자동 재시작
echo   npm start      # 일반 실행
echo.
echo 접속 주소:
echo   LMS: http://localhost:3000
echo   ERP: http://localhost:3000/erp
echo.
goto END

REM ─────────────────────────────────────────────────────
REM Docker 배포
REM ─────────────────────────────────────────────────────
:DEPLOY_DOCKER
echo Docker 배포
echo.

REM Docker 확인
where docker >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Docker가 설치되지 않았습니다.
    echo https://www.docker.com에서 설치하세요
    exit /b 1
)
for /f "tokens=*" %%i in ('docker --version') do echo %%i
echo.

REM .env 파일 생성
if not exist .env (
    echo .env 파일이 없습니다. 생성 중...
    copy .env.example .env >nul
    echo .env 파일 생성 완료
    echo.
)

REM Docker 이미지 빌드
echo Docker 이미지 빌드 중...
docker build -t biglinker:latest .

echo.
echo 컨테이너 시작 중...
docker-compose up -d

echo.
echo Docker 배포 완료!
echo.
echo 유용한 명령어:
echo   docker-compose logs -f       (실시간 로그)
echo   docker-compose stop          (중지)
echo   docker-compose restart       (재시작)
echo   docker-compose down          (중지 및 삭제)
echo.
echo 접속 주소:
echo   LMS: http://localhost:3000
echo   ERP: http://localhost:3000/erp
echo.
goto END

REM ─────────────────────────────────────────────────────
REM 프로덕션 배포
REM ─────────────────────────────────────────────────────
:DEPLOY_PROD
echo 프로덕션 배포
echo.

REM Node.js 확인
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Node.js가 설치되지 않았습니다.
    echo https://nodejs.org에서 v20.x 이상을 설치하세요
    exit /b 1
)

REM .env 파일 생성
if not exist .env (
    echo .env 파일이 없습니다. 생성 중...
    copy .env.example .env >nul
    echo .env 파일 생성 완료
    echo.
)

REM 의존성 설치
echo 의존성 설치 중...
call npm ci --only=production

echo.
echo Windows에서는 PM2 대신 다음 방법을 권장합니다:
echo.
echo 방법 1: Node.js 직접 실행 (커맨드 창 유지)
echo   node server.js
echo.
echo 방법 2: forever 설치 및 사용
echo   npm install -g forever
echo   forever start server.js
echo.
echo 방법 3: NSSM (Windows Service Manager)으로 서비스 등록
echo   https://nssm.cc 에서 nssm.exe 다운로드
echo   nssm install biglinker "node server.js"
echo   net start biglinker
echo.
echo 접속 주소:
echo   LMS: http://localhost:3000
echo   ERP: http://localhost:3000/erp
echo.
goto END

REM ─────────────────────────────────────────────────────
REM 도움말
REM ─────────────────────────────────────────────────────
:SHOW_HELP
echo 사용법:
echo   deploy.bat [명령어]
echo.
echo 명령어:
echo   local       로컬 개발 환경 설정
echo   docker      Docker Compose로 배포
echo   prod        프로덕션 배포 (서버 전용)
echo   help        이 도움말 표시
echo.
echo 예시:
echo   deploy.bat local       ^(로컬 개발 시작^)
echo   deploy.bat docker      ^(Docker로 실행^)
echo   deploy.bat prod        ^(프로덕션 배포^)
echo.

:END
echo.
endlocal
