슬로건 : **자연스러운 얼굴 보정을 빠르게**

너무 복잡한 보정 앱. 1초만에 끝내세요

철학 : 복잡한 보정 없애기

> 복잡한 뷰티 앱을 쓰기 싫은 사람이, 업로드 한 번으로 ‘남이 봐도 자연스러운’ 얼굴 보정을 끝내게 한다.
> 

> 기능이 적어서 좋은 보정 서비스
> 

> 
> 
> 
> 메이투처럼 많은 기능을 만들지 말고, 페이스튠처럼 수동 편집을 요구하지 말고, 스노우/B612처럼 카메라 슈퍼앱이 되지 말 것.
> 
> 오직 “업로드하면 자연스럽게 예뻐지는 얼굴 보정 버튼” 하나로 시작할 것.
> 
- "결과가 사람 같냐, AI 같냐."
- 복잡함을 덜어냄
- 생각할 필요 없게

MVP : 업로드 → 버튼 → 보정된 결과

## MVP 배포: Vercel + Supabase

무료 MVP 배포는 Vercel Hobby와 Supabase Free 조합을 기준으로 한다.

### Supabase

1. Supabase 프로젝트를 만든다.
2. SQL editor 또는 로컬 환경에서 migration을 적용한다.

```bash
npm run migrate
```

3. Storage에서 private bucket을 만든다.

```txt
image-job-temp
```

4. Database connection string은 Supavisor pooler URL을 사용한다.

### Cloud Run API

Express API는 Cloud Run 컨테이너로 배포한다. Cloud Run 파일시스템은 임시 공간으로만 보고, 원본/결과 이미지는 반드시 Supabase Storage 같은 외부 object storage에 저장한다.

```bash
docker build -t supereasy-api .
docker run --env-file .env -e PORT=8080 -e SERVE_STATIC=false -p 8080:8080 supereasy-api
```

Cloud Run production env 예시:

```txt
NODE_ENV=production
PORT=8080
SERVE_STATIC=false
APP_ORIGIN=https://your-project.vercel.app
LOCAL_APP_ORIGIN=http://localhost:3000
DATABASE_URL=
DATABASE_SSL=true
DATABASE_POOL_MAX=3
STORAGE_PROVIDER=supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_IMAGE_BUCKET=image-job-temp
SUPABASE_SIGNED_URL_EXPIRES_IN=900
SESSION_SECRET=
ADMIN_EMAILS=your-email@example.com
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
KAKAO_REST_API_KEY=
KAKAO_CLIENT_SECRET=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
MAX_UPLOAD_BYTES=12582912
AI_PROVIDER=mock
AI_REQUEST_TIMEOUT_MS=120000
AI_PROMPT_A=
AI_PROMPT_B=
MAI_ENDPOINT=
MAI_API_KEY=
MAI_DEPLOYMENT_NAME=
```

실제 MAI 테스트 때만 다음 값을 채운다.

```txt
AI_PROVIDER=mai
MAI_ENDPOINT=https://<resource-name>.services.ai.azure.com
MAI_API_KEY=
MAI_DEPLOYMENT_NAME=
AI_PROMPT_A=
AI_PROMPT_B=
```

### Vercel Frontend

1. GitHub repo를 Vercel 프로젝트로 import한다.
2. `vercel.json`의 `https://supereasy-api-CHANGE-ME.a.run.app`를 실제 Cloud Run URL로 교체한다.
3. Vercel은 정적 프론트만 서빙하고 `/api/*` 요청은 Cloud Run으로 rewrite한다.

4. OAuth 설정에 URL을 등록한다. Provider 콘솔의 URL은 `APP_ORIGIN`과 1글자라도 다르면 실패한다.

```txt
Google Authorized JavaScript origins:
https://your-project.vercel.app

Google Authorized redirect URIs:
https://your-project.vercel.app

Kakao Redirect URI:
https://your-project.vercel.app/api/auth/kakao/callback

Naver Callback URL:
https://your-project.vercel.app/api/auth/naver/callback
```

로컬 테스트용 callback URL은 다음 값을 등록한다.

```txt
Kakao Redirect URI:
http://localhost:3000/api/auth/kakao/callback

Naver Callback URL:
http://localhost:3000/api/auth/naver/callback
```

5. 배포 후 확인한다.

```txt
GET /api/health
```

정상 응답:

```json
{"ok":true,"db":"ok"}
```

### Image storage policy

원본과 결과 이미지는 Supabase Storage private bucket에 임시 object로 저장한다. Cloud Run 로컬 디스크에는 저장하지 않는다. 프론트에는 signed URL만 내려준다. 사용자가 다운로드하거나 다시 선택/홈 복귀하면 cleanup API가 Storage object를 삭제하고 DB의 storage path를 비운다.

### Admin credit grant

테스트용 어드민 계정은 Vercel env에 등록한다.

```txt
ADMIN_EMAILS=your-email@example.com
```

로그인한 어드민은 브라우저 콘솔에서 자기 계정에 크레딧을 수동 지급할 수 있다.

```js
await fetch("/api/admin/credits/grant", {
  method: "POST",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ amount: 20, requestId: crypto.randomUUID() }),
}).then((response) => response.json());
```

지급 내역은 `credit_ledger`에 `admin_credit_grant` reason으로 남는다.
