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

### Vercel

1. GitHub repo를 Vercel 프로젝트로 import한다.
2. Environment Variables에 다음 값을 넣는다.

```txt
DATABASE_URL=
DATABASE_SSL=true
DATABASE_POOL_MAX=3
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_IMAGE_BUCKET=image-job-temp
SUPABASE_SIGNED_URL_EXPIRES_IN=900
SESSION_SECRET=
ADMIN_EMAILS=your-email@example.com
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
APP_ORIGIN=https://ai-refine-tool.vercel.app
LOCAL_APP_ORIGIN=http://localhost:3000
KAKAO_REST_API_KEY=
KAKAO_CLIENT_SECRET=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
MAX_UPLOAD_BYTES=12582912
NODE_ENV=production
```

3. OAuth 설정에 URL을 등록한다. Provider 콘솔의 URL은 환경 변수 origin과 1글자라도 다르면 실패한다.

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

4. 배포 후 확인한다.

```txt
GET /api/health
```

정상 응답:

```json
{"ok":true,"db":"ok"}
```

### Image storage policy

원본과 결과 이미지는 Supabase Storage private bucket에 임시 object로 저장한다. 프론트에는 signed URL만 내려준다. 사용자가 다운로드하거나 다시 선택/홈 복귀하면 cleanup API가 Storage object를 삭제하고 DB의 storage path를 비운다.

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
