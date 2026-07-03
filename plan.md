# Supereasy Implementation Plan

## 1. Server Recommendation

현재는 **Node.js + Express + PostgreSQL**을 유지하는 것이 가장 좋다.

이유:
- 이미 `server.js`, `db.js`, `express-session`, `pg`, migration 구조가 잡혀 있다.
- Google OAuth, session, credit transaction, `image_jobs`, `credit_ledger`가 이 구조로 구현되어 있다.
- 지금 단계에서 Next.js, NestJS, FastAPI 등으로 갈아타면 제품 기능보다 이관 비용이 커진다.
- 이미지 처리, 결제 confirm/webhook, AI API 호출은 Express에서도 충분히 안정적으로 구현할 수 있다.

추천 구조:

```txt
Frontend: 현재 static HTML/CSS/JS 유지
Backend: Node.js + Express
DB: PostgreSQL
Session: express-session + connect-pg-simple
Local dev file storage: /uploads
Production file storage: Cloudflare R2 또는 S3
Payment: Toss Payments sandbox 우선 검토
AI API: 결제/작업 파이프라인 안정화 후 마지막에 연결
```

나중에 프론트가 커지면 Next.js로 옮길 수 있지만, 지금은 서버 API와 DB 흐름을 완성하는 것이 우선이다.

## 2. Current State

이미 완료된 것:
- Google 로그인 기반 사용자 생성
- PostgreSQL 연결과 migration 실행 구조
- 최소 테이블: `users`, `oauth_accounts`, `image_jobs`, `credit_ledger`, `payments`
- 신규 가입 크레딧 `+2`
- 보정 요청 시 `image_jobs` 생성과 `credit_ledger -1`
- 실패 시 `credit_ledger +1` 환불
- 모든 credit 변경 transaction 처리
- `users FOR UPDATE` 기반 동시 차감 방지
- `credit_ledger` append-only trigger
- `request_id`, `image_job_id`, `idempotency_key` 기반 추적
- 프론트에서 버튼 클릭 시 크레딧 차감 후 mock 결과 화면 이동

아직 안 된 것:
- 서버로 이미지 파일 업로드
- 원본/결과 이미지 저장
- 서버 기반 mock AI 처리
- job 상태 조회 API
- 결제 sandbox 연동
- 결제 성공 시 유료 크레딧 지급
- 진짜 AI API 연동

## 3. Recommended Order

### Phase 1. Server-Based Mock Job Pipeline

목표:
사용자가 이미지를 올리고 보정 버튼을 누르면 서버가 job을 만들고, 크레딧을 차감하고, mock 결과를 저장하고, 프론트가 결과를 조회하게 만든다.

작업:
- `multer` 같은 업로드 middleware 추가
- 로컬 개발용 디렉터리 생성:
  - `uploads/originals`
  - `uploads/results`
- 정적 서빙 경로 추가:
  - `/uploads/...`
- `image_jobs` 컬럼 추가:
  - `input_image_url`
  - `result_image_url`
  - `started_at`
- `POST /api/image-jobs`를 multipart 업로드 기반으로 변경
- transaction 안에서 유지:
  - user lock
  - 잔액 확인
  - job 생성
  - debit ledger append
  - 새 잔액 반환
- mock 처리:
  - 처음에는 원본 파일을 results 폴더로 복사
  - job status를 `completed`로 변경
  - `result_image_url` 저장

주의:
- 크레딧 차감 transaction과 파일 저장은 완벽히 하나의 DB transaction으로 묶을 수 없다.
- 따라서 안전한 순서는 `파일 임시 저장 -> DB transaction -> mock 처리 -> 완료 상태 저장`이다.
- DB transaction 이후 mock 처리 실패 시 반드시 `fail` 처리와 refund를 호출한다.

### Phase 2. Job Status APIs - 현재

목표:
프론트가 job 결과를 서버 상태 기준으로 보여주게 만든다.

추가 API:

```txt
GET /api/image-jobs/:id
GET /api/image-jobs
```

`GET /api/image-jobs/:id` 응답 예시:

```json
{
  "job": {
    "id": "uuid",
    "requestId": "client-request-id",
    "status": "completed",
    "inputImageUrl": "/uploads/originals/...",
    "resultImageUrl": "/uploads/results/...",
    "createdAt": "...",
    "completedAt": "..."
  },
  "credit": 1
}
```

프론트 변경:
- 보정 버튼 클릭 후 서버 job 생성
- `processing` 화면 표시
- job 조회 또는 응답의 `resultImageUrl`로 결과 표시
- 다운로드는 서버 결과 URL 기준으로 처리

### Phase 3. Failure, Timeout, Cleanup

목표:
실패했을 때 크레딧과 파일 상태가 꼬이지 않게 만든다.

작업:
- 업로드 파일 크기 제한
- 허용 MIME type 제한: `image/jpeg`, `image/png`, `image/webp`, 필요 시 `image/heic`
- mock 처리 실패 시:
  - job `failed`
  - `credit_ledger +1`
  - refund 중복 방지
- 오래된 `queued`/`processing` job 정리 정책 추가
- 실패한 임시 파일 cleanup

권장 상태값:

```txt
queued
processing
completed
failed
```

`refunded`는 job status로 두지 않는 편이 좋다. 환불 여부는 `credit_ledger`의 `image_job_refund` row로 판단하는 것이 더 정확하다.

### Phase 4. Payment Sandbox

목표:
실제 결제 전에 sandbox에서 유료 크레딧 지급 흐름을 검증한다.

추천:
- 한국 결제라면 Toss Payments를 먼저 검토한다.
- 처음에는 카드 결제 sandbox만 붙인다.

필요한 개념:
- credit product:
  - 예: `credits_10`, `credits_30`
- payment order:
  - 결제 시작 전 `payments` row 생성
- payment confirm:
  - 결제 승인 확인
- payment ledger grant:
  - 성공한 결제에만 `credit_ledger +N`

추가/정리할 API:

```txt
POST /api/payments/orders
POST /api/payments/confirm
GET /api/payments/:id
```

결제 transaction:
- payment row lock
- provider 결제 승인 검증
- payment status `paid`
- `credit_ledger +N`
- 새 잔액 반환

중복 방지:
- `payments(provider, order_id)` unique
- `payments(provider, payment_key)` unique
- ledger idempotency key:
  - `payment:{paymentId}:credit`

### Phase 5. Payment UX

목표:
잔액 부족 시 자연스럽게 결제로 이어지게 만든다.

작업:
- 헤더 또는 modal에 현재 크레딧 표시 개선
- 잔액 0일 때 보정 버튼 클릭:
  - 결제 화면 또는 결제 modal로 이동
- 결제 성공 후:
  - 잔액 갱신
  - 사용자가 하던 이미지 보정 요청 재시도 가능하게 처리

처음에는 별도 페이지보다 modal 또는 단순 결제 섹션이 빠르다.

### Phase 6. Real AI API Integration

목표:
서버 mock 처리 부분만 진짜 AI 호출로 교체한다.

순서:
- mock processor 함수를 먼저 분리한다.
- 예:

```txt
processImageJob(job)
  -> mockProcessImage(job)
  -> later realAiProcessImage(job)
```

AI 연동 시 필요한 것:
- provider API key는 서버 env에만 저장
- timeout 설정
- 재시도 정책은 보수적으로 시작
- 실패 시 job `failed` + refund
- 성공 시 result file 저장 + job `completed`
- provider request/response metadata는 `image_jobs.result_metadata`에 필요한 만큼만 저장

AI API는 결제 sandbox와 서버 job 파이프라인이 안정화된 뒤 붙인다. 그래야 AI 비용, 업로드 문제, 결제 문제, 크레딧 문제를 분리해서 디버깅할 수 있다.

## 4. Suggested DB Changes

다음 migration에서 추가할 후보:

```sql
ALTER TABLE image_jobs
  ADD COLUMN input_image_url text,
  ADD COLUMN result_image_url text,
  ADD COLUMN started_at timestamptz;
```

선택 후보:

```sql
ALTER TABLE image_jobs
  ADD COLUMN input_file_size integer,
  ADD COLUMN input_mime_type text;
```

현재 `result_metadata jsonb`는 유지한다. AI provider 응답, mock 처리 정보, 결과 variant 정보 등을 넣기에 좋다.

## 5. API Shape

우선 목표 API:

```txt
POST /api/image-jobs
GET /api/image-jobs/:id
GET /api/image-jobs
POST /api/payments/orders
POST /api/payments/confirm
```

나중에 worker 구조로 바꾸면 내부 API 또는 job queue를 추가한다.

처음에는 worker 없이 Express 요청 안에서 mock 처리를 끝내도 된다. mock 처리 시간이 짧기 때문이다. 진짜 AI API를 붙일 때는 요청이 길어질 수 있으므로 background worker 또는 queue를 검토한다.

## 6. Deployment Direction

초기 로컬:

```txt
PostgreSQL local
uploads local folder
Express server
```

배포 전:

```txt
PostgreSQL managed DB
Cloudflare R2 또는 S3
HTTPS domain
SESSION_SECRET 필수
payment webhook 검증
AI API key server-side only
```

파일 저장은 배포 전에 반드시 R2/S3 같은 object storage로 옮기는 것이 좋다. 서버 로컬 디스크는 재배포, scale-out, 장애 복구에 약하다.

## 7. Immediate Next Task

바로 다음 작업은 **서버 기반 Mock Job Pipeline**이다.

구체적으로:
1. `multer` 설치
2. `uploads/originals`, `uploads/results` 준비
3. `image_jobs`에 이미지 URL 컬럼 migration 추가
4. `POST /api/image-jobs`를 이미지 업로드까지 받도록 변경
5. 서버에서 mock 결과 파일 생성
6. `GET /api/image-jobs/:id` 추가
7. 프론트 결과 표시를 blob URL이 아니라 서버 `resultImageUrl` 기준으로 변경

그다음 결제 sandbox를 붙이고, 마지막에 진짜 AI API를 붙인다.
