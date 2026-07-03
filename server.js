import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { OAuth2Client } from "google-auth-library";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import heicConvert from "heic-convert";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query, withTransaction } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
const productionAppOrigin = process.env.APP_ORIGIN || "";
const localAppOrigin = process.env.LOCAL_APP_ORIGIN || "http://localhost:3000";
const kakaoRestApiKey = process.env.KAKAO_REST_API_KEY || "";
const kakaoClientSecret = process.env.KAKAO_CLIENT_SECRET || "";
const naverClientId = process.env.NAVER_CLIENT_ID || "";
const naverClientSecret = process.env.NAVER_CLIENT_SECRET || "";
const sessionSecret = process.env.SESSION_SECRET || "supereasy-dev-session-secret";
const adminEmails = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
const oauthClient = new OAuth2Client(googleClientId);
const PgSession = connectPgSimple(session);
const cookieMaxAge = 1000 * 60 * 60 * 24 * 14;
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 12 * 1024 * 1024);
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseImageBucket = process.env.SUPABASE_IMAGE_BUCKET || "image-job-temp";
const signedUrlExpiresIn = Number(process.env.SUPABASE_SIGNED_URL_EXPIRES_IN || 60 * 15);
const SIGNUP_FREE_CREDITS = 2;
const IMAGE_JOB_COST = 1;
const HEIC_CONVERSION_ERROR_MESSAGE =
  "HEIC 파일 변환에 실패했습니다. JPG로 변환 후 다시 업로드해주세요.";
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const IMAGE_EXTENSION_BY_MIME_TYPE = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});
const IMAGE_JOB_STATUS = Object.freeze({
  queued: "queued",
  processing: "processing",
  completed: "completed",
  failed: "failed",
});
const IMAGE_JOB_COLUMNS = `
  id,
  user_id,
  request_id,
  status,
  input_file_name,
  input_image_url,
  result_image_url,
  input_storage_path,
  result_storage_path,
  input_file_size,
  input_mime_type,
  error_message,
  created_at,
  updated_at,
  started_at,
  completed_at
`;
const OAUTH_STATE_MAX_AGE_MS = 1000 * 60 * 10;
const ALLOWED_RETURN_TO_PATHS = new Set(["/", "/pricing", "/dashboard", "/result"]);
const SOCIAL_AUTH_PROVIDERS = new Set(["kakao", "naver"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxUploadBytes,
    files: 1,
  },
});

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production.");
}

if (
  process.env.NODE_ENV === "production" &&
  (!supabaseUrl || !supabaseServiceRoleKey || !supabaseImageBucket)
) {
  throw new Error("Supabase storage environment variables are required in production.");
}

if (
  process.env.NODE_ENV === "production" &&
  (kakaoRestApiKey || naverClientId || naverClientSecret) &&
  !productionAppOrigin
) {
  throw new Error("APP_ORIGIN is required in production when social login is configured.");
}

app.set("trust proxy", 1);
app.use(express.json());
app.use(
  session({
    name: "supereasy.sid",
    store: new PgSession({
      pool,
      tableName: "session",
      createTableIfMissing: false,
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: cookieMaxAge,
    },
  }),
);

function getRequestOrigin(request) {
  return `${request.protocol}://${request.get("host")}`;
}

function normalizeOrigin(origin) {
  if (typeof origin !== "string" || !origin.trim()) return "";

  try {
    return new URL(origin.trim()).origin;
  } catch {
    return "";
  }
}

function getConfiguredAppOrigin(request) {
  const configuredOrigin =
    process.env.NODE_ENV === "production" ? productionAppOrigin : localAppOrigin;
  return normalizeOrigin(configuredOrigin) || getRequestOrigin(request);
}

function getOAuthCallbackUrl(request, provider) {
  return `${getConfiguredAppOrigin(request)}/api/auth/${provider}/callback`;
}

function normalizeReturnTo(returnTo) {
  if (typeof returnTo !== "string") return "/";

  const trimmed = returnTo.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";

  try {
    const url = new URL(trimmed, "https://supereasy.local");
    if (!ALLOWED_RETURN_TO_PATHS.has(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function getOAuthMode(mode) {
  return mode === "redirect" ? "redirect" : "popup";
}

function isValidEmail(email) {
  return typeof email === "string" && EMAIL_PATTERN.test(email.trim());
}

function requireGoogleConfig(response) {
  if (googleClientId && googleClientSecret) return true;

  response.status(500).json({
    error: "missing_google_config",
    message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required.",
  });
  return false;
}

function assertSocialAuthProviderConfig(provider) {
  if (provider === "kakao" && kakaoRestApiKey) return;
  if (provider === "naver" && naverClientId && naverClientSecret) return;

  throw createHttpError(`${provider} login is not configured.`, 500, `missing_${provider}_config`);
}

function requireSocialAuthProviderConfig(provider, response) {
  try {
    assertSocialAuthProviderConfig(provider);
    return true;
  } catch (error) {
    response.status(error.statusCode || 500).json({
      error: error.publicError || `missing_${provider}_config`,
      message: error.message,
    });
    return false;
  }
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function requireSameOriginAjax(request, response) {
  const requestedWith = request.get("X-Requested-With");
  const origin = request.get("Origin");

  if (requestedWith === "XmlHttpRequest" && (!origin || origin === getRequestOrigin(request))) {
    return true;
  }

  response.status(403).json({ error: "invalid_request_source" });
  return false;
}

function saveSession(request) {
  return new Promise((resolve, reject) => {
    request.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function regenerateSession(request) {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroySession(request) {
  return new Promise((resolve, reject) => {
    request.session.destroy((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function mapUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    name: row.display_name || row.email,
    picture: row.avatar_url || "",
    credit: Number(row.credit || 0),
  };
}

function mapImageJob(row) {
  if (!row) return null;

  return {
    id: row.id,
    requestId: row.request_id,
    status: row.status,
    inputImageUrl: row.signed_input_image_url || row.input_image_url || null,
    resultImageUrl: row.signed_result_image_url || row.result_image_url || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    errorMessage: row.error_message || null,
  };
}

async function addSignedUrlsToImageJob(row) {
  if (!row) return null;

  const [signedInputImageUrl, signedResultImageUrl] = await Promise.all([
    createSignedImageUrl(row.input_storage_path),
    createSignedImageUrl(row.result_storage_path),
  ]);

  return {
    ...row,
    signed_input_image_url: signedInputImageUrl,
    signed_result_image_url: signedResultImageUrl,
  };
}

async function mapImageJobResult(result) {
  const { job, ...rest } = result;
  return {
    ...rest,
    job: mapImageJob(await addSignedUrlsToImageJob(job)),
  };
}

async function getUserWithCredit(userId) {
  const result = await query(
    `
      SELECT
        u.id,
        u.email,
        u.email_verified,
        u.display_name,
        u.avatar_url,
        COALESCE(SUM(cl.amount), 0)::int AS credit
      FROM users u
      LEFT JOIN credit_ledger cl ON cl.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id
    `,
    [userId],
  );

  return mapUser(result.rows[0]);
}

async function getUserEmailNormalized(userId) {
  const result = await query("SELECT email_normalized FROM users WHERE id = $1", [userId]);
  return result.rows[0]?.email_normalized || "";
}

async function requireAdminUser(request, response, next) {
  try {
    const emailNormalized = await getUserEmailNormalized(request.session.userId);
    if (emailNormalized && adminEmails.has(emailNormalized)) {
      next();
      return;
    }

    response.status(403).json({ error: "forbidden" });
  } catch (error) {
    sendRouteError(response, error, "admin_check_failed");
  }
}

function requireAuthenticated(request, response, next) {
  if (!request.session.userId) {
    response.status(401).json({ error: "unauthenticated" });
    return;
  }

  next();
}

function createHttpError(message, statusCode, publicError) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicError = publicError;
  return error;
}

function isHeicMimeType(mimeType) {
  return mimeType === "image/heic" || mimeType === "image/heif";
}

function normalizeOriginalFileName(fileName) {
  if (typeof fileName !== "string" || !fileName.trim()) return null;
  return fileName.trim().slice(0, 255);
}

function normalizeRequestId(requestId) {
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw createHttpError("requestId is required.", 400, "missing_request_id");
  }

  return requestId.trim().slice(0, 200);
}

function createUploadMiddleware(request, response, next) {
  upload.single("image")(request, response, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        response.status(413).json({
          error: "image_too_large",
          message: "업로드 가능한 이미지 용량을 초과했습니다.",
        });
        return;
      }

      response.status(400).json({
        error: "invalid_image_upload",
        message: "이미지 업로드 요청이 올바르지 않습니다.",
      });
      return;
    }

    next(error);
  });
}

let supabaseClient = null;

function getSupabaseClient() {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw createHttpError("Supabase storage is not configured.", 500, "missing_supabase_config");
  }

  if (!supabaseClient) {
    supabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return supabaseClient;
}

function getImageBucket() {
  return getSupabaseClient().storage.from(supabaseImageBucket);
}

function buildStoragePath(kind, userId, extension) {
  return `${kind}/${userId}/${randomUUID()}.${extension}`;
}

async function uploadStorageObject(pathname, buffer, contentType) {
  const { error } = await getImageBucket().upload(pathname, buffer, {
    contentType,
    upsert: false,
  });

  if (error) {
    throw createHttpError(error.message, 500, "storage_upload_failed");
  }
}

async function removeStorageObjects(paths) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (!uniquePaths.length) return 0;

  const { error } = await getImageBucket().remove(uniquePaths);
  if (error) {
    throw createHttpError(error.message, 500, "storage_cleanup_failed");
  }

  return uniquePaths.length;
}

async function safeRemoveStorageObjects(paths) {
  try {
    return await removeStorageObjects(paths);
  } catch (error) {
    console.error("Unable to remove storage objects:", error);
    return 0;
  }
}

async function createSignedImageUrl(storagePath) {
  if (!storagePath) return null;

  const { data, error } = await getImageBucket().createSignedUrl(
    storagePath,
    signedUrlExpiresIn,
    {
      download: false,
    },
  );

  if (error) {
    throw createHttpError(error.message, 500, "storage_signed_url_failed");
  }

  return data.signedUrl;
}

async function convertHeicToJpeg(buffer) {
  try {
    const converted = await heicConvert({
      buffer,
      format: "JPEG",
      quality: 0.92,
    });
    return Buffer.from(converted);
  } catch (error) {
    console.error("HEIC conversion failed:", error);
    throw createHttpError(HEIC_CONVERSION_ERROR_MESSAGE, 400, "heic_conversion_failed");
  }
}

async function prepareUploadedImage(file, userId) {
  if (!file?.buffer?.length) {
    throw createHttpError("Image file is required.", 400, "missing_image_file");
  }

  const detectedType = await fileTypeFromBuffer(file.buffer);
  const detectedMimeType = detectedType?.mime;

  if (!detectedMimeType || !ALLOWED_IMAGE_MIME_TYPES.has(detectedMimeType)) {
    throw createHttpError("지원하지 않는 이미지 형식입니다.", 400, "unsupported_image_type");
  }

  let imageBuffer = file.buffer;
  let storedMimeType = detectedMimeType;

  if (isHeicMimeType(detectedMimeType)) {
    imageBuffer = await convertHeicToJpeg(file.buffer);
    storedMimeType = "image/jpeg";
  }

  const extension = IMAGE_EXTENSION_BY_MIME_TYPE[storedMimeType];
  if (!extension) {
    throw createHttpError("지원하지 않는 이미지 형식입니다.", 400, "unsupported_image_type");
  }

  const inputStoragePath = buildStoragePath("originals", userId, extension);
  await uploadStorageObject(inputStoragePath, imageBuffer, storedMimeType);

  return {
    buffer: imageBuffer,
    inputStoragePath,
    inputFileName: normalizeOriginalFileName(file.originalname),
    inputFileSize: imageBuffer.length,
    inputMimeType: storedMimeType,
    originalMimeType: detectedMimeType,
    wasConverted: isHeicMimeType(detectedMimeType),
  };
}

async function mockProcessImageJob(job, uploadedImage) {
  const extension = IMAGE_EXTENSION_BY_MIME_TYPE[uploadedImage.inputMimeType] || "jpg";
  const resultStoragePath = buildStoragePath("results", job.user_id, extension);
  await uploadStorageObject(resultStoragePath, uploadedImage.buffer, uploadedImage.inputMimeType);

  return {
    resultStoragePath,
    metadata: {
      processor: "mock-copy",
      inputStoragePath: uploadedImage.inputStoragePath,
      resultStoragePath,
      originalMimeType: uploadedImage.originalMimeType,
      storedMimeType: uploadedImage.inputMimeType,
      convertedFromHeic: uploadedImage.wasConverted,
      processedAt: new Date().toISOString(),
    },
  };
}

async function lockUserForCreditChange(client, userId) {
  const result = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
  if (result.rowCount) return result.rows[0];

  throw createHttpError("User not found.", 401, "unauthenticated");
}

async function getCreditBalance(client, userId) {
  const result = await client.query(
    "SELECT COALESCE(SUM(amount), 0)::int AS credit FROM credit_ledger WHERE user_id = $1",
    [userId],
  );
  return Number(result.rows[0].credit || 0);
}

async function insertCreditLedger(
  client,
  { userId, imageJobId = null, requestId = null, paymentId = null, amount, reason, idempotencyKey, metadata = {} },
) {
  return client.query(
    `
      INSERT INTO credit_ledger (
        user_id,
        image_job_id,
        request_id,
        payment_id,
        amount,
        reason,
        idempotency_key,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
      RETURNING id
    `,
    [
      userId,
      imageJobId,
      requestId,
      paymentId,
      amount,
      reason,
      idempotencyKey,
      JSON.stringify(metadata),
    ],
  );
}

async function grantSignupCredit(client, { userId, provider, providerAccountId }) {
  await insertCreditLedger(client, {
    userId,
    amount: SIGNUP_FREE_CREDITS,
    reason: "signup_credit",
    idempotencyKey: `signup:user:${userId}`,
    metadata: { provider, providerAccountId },
  });
}

async function grantAdminCredit({ userId, amount, requestId }) {
  const creditAmount = Number(amount);
  if (!Number.isInteger(creditAmount) || creditAmount <= 0 || creditAmount > 1000) {
    throw createHttpError("amount must be an integer between 1 and 1000.", 400, "invalid_credit_amount");
  }

  const grantRequestId =
    typeof requestId === "string" && requestId.trim() ? requestId.trim().slice(0, 200) : randomUUID();

  return withTransaction(async (client) => {
    await lockUserForCreditChange(client, userId);
    await insertCreditLedger(client, {
      userId,
      amount: creditAmount,
      reason: "admin_credit_grant",
      idempotencyKey: `admin_credit:${userId}:${grantRequestId}`,
      metadata: {
        requestId: grantRequestId,
      },
    });

    return {
      credit: await getCreditBalance(client, userId),
    };
  });
}

async function exchangeGoogleCode(code, redirectUri) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok || !tokens.id_token) {
    const message =
      tokens.error_description || tokens.error || "Unable to exchange Google auth code.";
    const error = new Error(message);
    error.statusCode = 401;
    error.publicError = "token_exchange_failed";
    throw error;
  }

  return tokens;
}

async function exchangeKakaoCode(code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: kakaoRestApiKey,
    redirect_uri: redirectUri,
    code,
  });

  if (kakaoClientSecret) {
    body.set("client_secret", kakaoClientSecret);
  }

  const tokenResponse = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });

  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.access_token) {
    const message = tokens.error_description || tokens.error || "Unable to exchange Kakao auth code.";
    throw createHttpError(message, 401, "token_exchange_failed");
  }

  return tokens;
}

async function exchangeNaverCode({ code, state, redirectUri }) {
  const tokenResponse = await fetch("https://nid.naver.com/oauth2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: naverClientId,
      client_secret: naverClientSecret,
      redirect_uri: redirectUri,
      code,
      state,
    }),
  });

  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.access_token) {
    const message = tokens.error_description || tokens.error || "Unable to exchange Naver auth code.";
    throw createHttpError(message, 401, "token_exchange_failed");
  }

  return tokens;
}

async function fetchKakaoProfile(accessToken) {
  const profileResponse = await fetch("https://kapi.kakao.com/v2/user/me", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: new URLSearchParams({
      secure_resource: "true",
      property_keys: JSON.stringify(["kakao_account.email", "kakao_account.profile"]),
    }),
  });

  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok) {
    const message = profile.msg || profile.message || "Unable to fetch Kakao profile.";
    throw createHttpError(message, 401, "profile_fetch_failed");
  }

  const account = profile.kakao_account || {};
  const accountProfile = account.profile || {};
  if (!profile.id || !isValidEmail(account.email)) {
    throw createHttpError("Kakao email is required.", 401, "missing_provider_email");
  }

  if (account.is_email_valid !== true || account.is_email_verified !== true) {
    throw createHttpError("Kakao email is not verified.", 401, "unverified_provider_email");
  }

  return {
    provider: "kakao",
    providerAccountId: String(profile.id),
    email: account.email,
    emailVerified: true,
    displayName: account.name || accountProfile.nickname || account.email,
    avatarUrl: accountProfile.profile_image_url || accountProfile.thumbnail_image_url || null,
    rawProfile: profile,
  };
}

async function fetchNaverProfile(accessToken) {
  const profileResponse = await fetch("https://openapi.naver.com/v1/nid/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok || profile.resultcode !== "00") {
    const message = profile.message || "Unable to fetch Naver profile.";
    throw createHttpError(message, 401, "profile_fetch_failed");
  }

  const naverProfile = profile.response || {};
  if (!naverProfile.id || !isValidEmail(naverProfile.email)) {
    throw createHttpError("Naver email is required.", 401, "missing_provider_email");
  }

  return {
    provider: "naver",
    providerAccountId: String(naverProfile.id),
    email: naverProfile.email,
    emailVerified: true,
    displayName: naverProfile.name || naverProfile.nickname || naverProfile.email,
    avatarUrl: naverProfile.profile_image || null,
    rawProfile: profile,
  };
}

function mapGoogleOAuthProfile(payload) {
  if (!payload?.sub || !isValidEmail(payload.email)) {
    throw createHttpError("Invalid Google profile.", 401, "invalid_google_profile");
  }

  return {
    provider: "google",
    providerAccountId: String(payload.sub),
    email: payload.email,
    emailVerified: Boolean(payload.email_verified),
    displayName: payload.name || payload.email,
    avatarUrl: payload.picture || null,
    rawProfile: payload,
  };
}

async function updateUserProfileForOAuth(client, user, profile, emailNormalized) {
  const emailMatchesUser = user.email_normalized === emailNormalized;
  const updateResult = await client.query(
    emailMatchesUser
      ? `
          UPDATE users
          SET
            email = $2,
            email_verified = $3,
            display_name = COALESCE($4, display_name),
            avatar_url = COALESCE($5, avatar_url),
            updated_at = now()
          WHERE id = $1
          RETURNING id, email, email_verified, display_name, avatar_url, email_normalized
        `
      : `
          UPDATE users
          SET
            display_name = COALESCE($4, display_name),
            avatar_url = COALESCE($5, avatar_url),
            updated_at = now()
          WHERE id = $1
          RETURNING id, email, email_verified, display_name, avatar_url, email_normalized
        `,
    [
      user.id,
      profile.email,
      Boolean(profile.emailVerified),
      profile.displayName || profile.email,
      profile.avatarUrl || null,
    ],
  );

  return updateResult.rows[0];
}

async function assertNoProviderAccountConflict(client, { userId, provider, providerAccountId }) {
  const conflictResult = await client.query(
    `
      SELECT id
      FROM oauth_accounts
      WHERE user_id = $1
        AND provider = $2
        AND provider_account_id <> $3
      LIMIT 1
    `,
    [userId, provider, providerAccountId],
  );

  if (conflictResult.rowCount) {
    throw createHttpError("Provider account is already linked.", 409, "provider_account_conflict");
  }
}

async function insertOAuthAccount(client, { userId, profile }) {
  const insertResult = await client.query(
    `
      INSERT INTO oauth_accounts (
        user_id,
        provider,
        provider_account_id,
        email,
        raw_profile
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (provider, provider_account_id) DO NOTHING
      RETURNING id
    `,
    [
      userId,
      profile.provider,
      profile.providerAccountId,
      profile.email,
      JSON.stringify(profile.rawProfile || {}),
    ],
  );

  if (!insertResult.rowCount) {
    throw createHttpError("OAuth account is already linked.", 409, "oauth_account_conflict");
  }
}

async function upsertOAuthUser(profile) {
  if (
    !profile?.provider ||
    !profile.providerAccountId ||
    !isValidEmail(profile.email) ||
    typeof profile.emailVerified !== "boolean"
  ) {
    throw createHttpError("Invalid OAuth profile.", 401, "invalid_oauth_profile");
  }

  const emailNormalized = normalizeEmail(profile.email);

  return withTransaction(async (client) => {
    const existingAccountResult = await client.query(
      `
        SELECT
          u.id,
          u.email,
          u.email_verified,
          u.display_name,
          u.avatar_url,
          u.email_normalized
        FROM oauth_accounts oa
        JOIN users u ON u.id = oa.user_id
        WHERE oa.provider = $1
          AND oa.provider_account_id = $2
        FOR UPDATE OF oa, u
      `,
      [profile.provider, profile.providerAccountId],
    );

    if (existingAccountResult.rowCount) {
      const existingUser = existingAccountResult.rows[0];
      const user = await updateUserProfileForOAuth(client, existingUser, profile, emailNormalized);

      await client.query(
        `
          UPDATE oauth_accounts
          SET
            email = $3,
            raw_profile = $4,
            updated_at = now()
          WHERE provider = $1
            AND provider_account_id = $2
        `,
        [
          profile.provider,
          profile.providerAccountId,
          profile.email,
          JSON.stringify(profile.rawProfile || {}),
        ],
      );

      return user;
    }

    let userResult = await client.query(
      `
        SELECT id, email, email_verified, display_name, avatar_url, email_normalized
        FROM users
        WHERE email_normalized = $1
        FOR UPDATE
      `,
      [emailNormalized],
    );

    let user = userResult.rows[0];
    let wasCreated = false;

    if (!user) {
      userResult = await client.query(
        `
          INSERT INTO users (email, email_normalized, email_verified, display_name, avatar_url)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (email_normalized) DO NOTHING
          RETURNING id, email, email_verified, display_name, avatar_url, email_normalized
        `,
        [
          profile.email,
          emailNormalized,
          Boolean(profile.emailVerified),
          profile.displayName || profile.email,
          profile.avatarUrl || null,
        ],
      );

      if (userResult.rowCount) {
        user = userResult.rows[0];
        wasCreated = true;
      } else {
        const concurrentUserResult = await client.query(
          `
            SELECT id, email, email_verified, display_name, avatar_url, email_normalized
            FROM users
            WHERE email_normalized = $1
            FOR UPDATE
          `,
          [emailNormalized],
        );
        user = concurrentUserResult.rows[0];
      }
    }

    if (!user) {
      throw createHttpError("User could not be created.", 500, "user_upsert_failed");
    }

    if (!wasCreated) {
      if (!profile.emailVerified) {
        throw createHttpError("Verified email is required to link accounts.", 401, "unverified_provider_email");
      }

      await assertNoProviderAccountConflict(client, {
        userId: user.id,
        provider: profile.provider,
        providerAccountId: profile.providerAccountId,
      });

      user = await updateUserProfileForOAuth(client, user, profile, emailNormalized);
      console.info(`linked ${profile.provider} account to existing user by verified email`);
    }

    await insertOAuthAccount(client, { userId: user.id, profile });

    if (wasCreated) {
      await grantSignupCredit(client, {
        userId: user.id,
        provider: profile.provider,
        providerAccountId: profile.providerAccountId,
      });
    }

    return user;
  });
}

async function createAppSession(request, userId) {
  await regenerateSession(request);
  request.session.userId = userId;
  await saveSession(request);
  return getUserWithCredit(userId);
}

async function createOAuthState(request, { provider, returnTo, mode }) {
  const state = randomUUID();
  request.session.oauthState = {
    state,
    provider,
    returnTo: normalizeReturnTo(returnTo),
    mode: getOAuthMode(mode),
    createdAt: Date.now(),
  };
  await saveSession(request);
  return request.session.oauthState;
}

async function consumeOAuthState(request, { provider, state }) {
  const oauthState = request.session.oauthState;

  if (!oauthState || typeof state !== "string" || !state) {
    throw createHttpError("OAuth state is missing.", 401, "invalid_oauth_state");
  }

  if (oauthState.state !== state || oauthState.provider !== provider) {
    throw createHttpError("OAuth state does not match.", 401, "invalid_oauth_state");
  }

  if (!oauthState.createdAt || Date.now() - Number(oauthState.createdAt) > OAUTH_STATE_MAX_AGE_MS) {
    throw createHttpError("OAuth state has expired.", 401, "expired_oauth_state");
  }

  const consumedState = {
    returnTo: normalizeReturnTo(oauthState.returnTo),
    mode: getOAuthMode(oauthState.mode),
  };
  delete request.session.oauthState;
  await saveSession(request);
  return consumedState;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function sendOAuthCallbackHtml(
  request,
  response,
  { provider, authenticated, user = null, error = null, message = "", returnTo = "/", mode = "popup" },
) {
  const payload = {
    type: "supereasy:oauth-complete",
    provider,
    authenticated,
    user,
    error,
  };
  const targetOrigin = getConfiguredAppOrigin(request);
  const fallbackReturnTo = normalizeReturnTo(returnTo);
  const title = authenticated ? "로그인이 완료되었습니다." : "로그인에 실패했습니다.";
  const bodyMessage = authenticated
    ? "로그인이 완료되었습니다. 이 창을 닫아주세요."
    : message || "로그인에 실패했습니다. 다시 시도해주세요.";

  response.type("html").send(`<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color: #1c1c1c;
        background: #ffffff;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        display: grid;
        min-height: 100vh;
        margin: 0;
        place-items: center;
      }

      main {
        width: min(100% - 48px, 420px);
        text-align: center;
      }

      h1 {
        margin: 0 0 10px;
        font-size: 22px;
        line-height: 1.35;
      }

      p {
        margin: 0;
        color: rgba(28, 28, 28, 0.62);
        font-size: 15px;
        line-height: 1.6;
      }

      a {
        display: inline-flex;
        min-height: 40px;
        margin-top: 20px;
        align-items: center;
        justify-content: center;
        padding: 0 16px;
        border-radius: 9999px;
        background: #ed008c;
        color: #ffffff;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(bodyMessage)}</p>
      <a href="${escapeHtml(fallbackReturnTo)}">돌아가기</a>
    </main>
    <script>
      (() => {
        const payload = ${safeJson(payload)};
        const targetOrigin = ${safeJson(targetOrigin)};
        const returnTo = ${safeJson(fallbackReturnTo)};
        const mode = ${safeJson(getOAuthMode(mode))};

        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, targetOrigin);
          window.close();
          return;
        }

        if (mode === "redirect" && payload.authenticated) {
          window.location.replace(returnTo);
        }
      })();
    </script>
  </body>
</html>`);
}

function normalizeErrorMessage(message) {
  if (typeof message !== "string" || !message.trim()) return "Image generation failed.";
  return message.trim().slice(0, 1000);
}

async function lockImageJobForUser(client, userId, imageJobId) {
  const result = await client.query(
    `
      SELECT ${IMAGE_JOB_COLUMNS}
      FROM image_jobs
      WHERE id = $1 AND user_id = $2
      FOR UPDATE
    `,
    [imageJobId, userId],
  );

  if (result.rowCount) return result.rows[0];

  throw createHttpError("Image job not found.", 404, "image_job_not_found");
}

async function createImageJobWithDebit({
  userId,
  requestId,
  inputFileName,
  inputStoragePath,
  inputFileSize,
  inputMimeType,
}) {
  const normalizedRequestId = normalizeRequestId(requestId);

  return withTransaction(async (client) => {
    await lockUserForCreditChange(client, userId);

    const debitKey = `image_job:${normalizedRequestId}:debit`;
    const existingJob = await client.query(
      `
        SELECT ${IMAGE_JOB_COLUMNS}
        FROM image_jobs
        WHERE user_id = $1 AND request_id = $2
        FOR UPDATE
      `,
      [userId, normalizedRequestId],
    );

    if (existingJob.rowCount) {
      const existingDebit = await client.query(
        `
          SELECT id
          FROM credit_ledger
          WHERE user_id = $1
            AND image_job_id = $2
            AND request_id = $3
            AND reason = 'image_job_debit'
            AND idempotency_key = $4
        `,
        [userId, existingJob.rows[0].id, normalizedRequestId, debitKey],
      );

      if (!existingDebit.rowCount) {
        throw createHttpError(
          "Existing image job is missing its debit ledger entry.",
          409,
          "image_job_debit_missing",
        );
      }

      const balance = await getCreditBalance(client, userId);
      return {
        job: existingJob.rows[0],
        credit: balance,
        idempotent: true,
      };
    }

    const balance = await getCreditBalance(client, userId);
    if (balance < IMAGE_JOB_COST) {
      throw createHttpError("Insufficient credits.", 402, "insufficient_credits");
    }

    const jobResult = await client.query(
      `
        INSERT INTO image_jobs (
          user_id,
          request_id,
          status,
          input_file_name,
          input_storage_path,
          input_file_size,
          input_mime_type
        )
        VALUES ($1, $2, 'queued', $3, $4, $5, $6)
        RETURNING ${IMAGE_JOB_COLUMNS}
      `,
      [
        userId,
        normalizedRequestId,
        inputFileName || null,
        inputStoragePath || null,
        inputFileSize || null,
        inputMimeType || null,
      ],
    );
    const job = jobResult.rows[0];

    const debitResult = await insertCreditLedger(client, {
      userId,
      imageJobId: job.id,
      requestId: normalizedRequestId,
      amount: -IMAGE_JOB_COST,
      reason: "image_job_debit",
      idempotencyKey: debitKey,
      metadata: {
        requestId: normalizedRequestId,
        cost: IMAGE_JOB_COST,
        inputStoragePath,
        inputMimeType,
      },
    });

    if (!debitResult.rowCount) {
      throw createHttpError("Image job debit already exists.", 409, "image_job_debit_exists");
    }

    return {
      job,
      credit: await getCreditBalance(client, userId),
      idempotent: false,
    };
  });
}

async function completeImageJob({ userId, imageJobId, resultStoragePath, resultMetadata = {} }) {
  if (!imageJobId || typeof imageJobId !== "string") {
    throw createHttpError("imageJobId is required.", 400, "missing_image_job_id");
  }

  return withTransaction(async (client) => {
    await lockUserForCreditChange(client, userId);
    const job = await lockImageJobForUser(client, userId, imageJobId);

    if (job.status === IMAGE_JOB_STATUS.completed) {
      return {
        job,
        credit: await getCreditBalance(client, userId),
        idempotent: true,
      };
    }

    if (job.status === IMAGE_JOB_STATUS.failed) {
      throw createHttpError(
        "Failed image jobs cannot be completed.",
        409,
        "image_job_already_failed",
      );
    }

    if (!resultStoragePath || typeof resultStoragePath !== "string") {
      throw createHttpError("resultStoragePath is required.", 400, "missing_result_storage_path");
    }

    const updatedJob = await client.query(
      `
        UPDATE image_jobs
        SET
          status = 'completed',
          result_image_url = NULL,
          result_storage_path = $3,
          result_metadata = result_metadata || $4::jsonb,
          error_message = NULL,
          started_at = COALESCE(started_at, now()),
          updated_at = now(),
          completed_at = COALESCE(completed_at, now())
        WHERE id = $1 AND user_id = $2
        RETURNING ${IMAGE_JOB_COLUMNS}
      `,
      [imageJobId, userId, resultStoragePath, JSON.stringify(resultMetadata)],
    );

    return {
      job: updatedJob.rows[0],
      credit: await getCreditBalance(client, userId),
      idempotent: false,
    };
  });
}

async function failImageJobWithRefund({ userId, imageJobId, errorMessage }) {
  if (!imageJobId || typeof imageJobId !== "string") {
    throw createHttpError("imageJobId is required.", 400, "missing_image_job_id");
  }

  return withTransaction(async (client) => {
    await lockUserForCreditChange(client, userId);
    const job = await lockImageJobForUser(client, userId, imageJobId);

    if (job.status === IMAGE_JOB_STATUS.completed) {
      throw createHttpError(
        "Completed image jobs cannot be failed or refunded.",
        409,
        "image_job_already_completed",
      );
    }

    let currentJob = job;
    if (job.status !== IMAGE_JOB_STATUS.failed) {
      const failedJob = await client.query(
        `
          UPDATE image_jobs
          SET
            status = 'failed',
            error_message = $3,
            started_at = COALESCE(started_at, now()),
            updated_at = now(),
            completed_at = COALESCE(completed_at, now())
          WHERE id = $1 AND user_id = $2
          RETURNING ${IMAGE_JOB_COLUMNS}
        `,
        [imageJobId, userId, normalizeErrorMessage(errorMessage)],
      );
      currentJob = failedJob.rows[0];
    }

    const debitResult = await client.query(
      `
        SELECT id
        FROM credit_ledger
        WHERE user_id = $1
          AND image_job_id = $2
          AND request_id = $3
          AND reason = 'image_job_debit'
        LIMIT 1
      `,
      [userId, currentJob.id, currentJob.request_id],
    );

    const refundResult = await client.query(
      `
        SELECT id
        FROM credit_ledger
        WHERE user_id = $1
          AND image_job_id = $2
          AND request_id = $3
          AND reason = 'image_job_refund'
        LIMIT 1
      `,
      [userId, currentJob.id, currentJob.request_id],
    );

    let refunded = false;
    if (debitResult.rowCount && !refundResult.rowCount) {
      const ledgerResult = await insertCreditLedger(client, {
        userId,
        imageJobId: currentJob.id,
        requestId: currentJob.request_id,
        amount: IMAGE_JOB_COST,
        reason: "image_job_refund",
        idempotencyKey: `image_job:${currentJob.id}:refund`,
        metadata: {
          requestId: currentJob.request_id,
          amount: IMAGE_JOB_COST,
          debitLedgerId: debitResult.rows[0].id,
        },
      });
      refunded = Boolean(ledgerResult.rowCount);
    }

    return {
      job: currentJob,
      credit: await getCreditBalance(client, userId),
      refunded,
      idempotent: job.status === IMAGE_JOB_STATUS.failed,
    };
  });
}

async function getImageJobForUser(userId, imageJobId) {
  if (!imageJobId || typeof imageJobId !== "string") {
    throw createHttpError("imageJobId is required.", 400, "missing_image_job_id");
  }

  const [jobResult, user] = await Promise.all([
    query(
      `
        SELECT ${IMAGE_JOB_COLUMNS}
        FROM image_jobs
        WHERE id = $1 AND user_id = $2
      `,
      [imageJobId, userId],
    ),
    getUserWithCredit(userId),
  ]);

  if (!jobResult.rowCount) {
    throw createHttpError("Image job not found.", 404, "image_job_not_found");
  }

  return {
    job: jobResult.rows[0],
    credit: user?.credit || 0,
  };
}

async function cleanupImageJobFiles({ userId, imageJobId }) {
  if (!imageJobId || typeof imageJobId !== "string") {
    throw createHttpError("imageJobId is required.", 400, "missing_image_job_id");
  }

  const result = await query(
    `
      SELECT id, input_storage_path, result_storage_path
      FROM image_jobs
      WHERE id = $1 AND user_id = $2
    `,
    [imageJobId, userId],
  );

  if (!result.rowCount) {
    throw createHttpError("Image job not found.", 404, "image_job_not_found");
  }

  const job = result.rows[0];
  const storagePaths = [job.input_storage_path, job.result_storage_path].filter(Boolean);
  const deletedFiles = await removeStorageObjects(storagePaths);

  await query(
    `
      UPDATE image_jobs
      SET
        input_image_url = NULL,
        result_image_url = NULL,
        input_storage_path = NULL,
        result_storage_path = NULL,
        updated_at = now(),
        result_metadata = result_metadata || $3::jsonb
      WHERE id = $1 AND user_id = $2
    `,
    [
      imageJobId,
      userId,
      JSON.stringify({
        filesCleanedUpAt: new Date().toISOString(),
        cleanupReason: "mvp_ephemeral_storage",
      }),
    ],
  );

  return {
    ok: true,
    deletedFiles,
  };
}

function sendRouteError(response, error, fallbackError) {
  console.error(error);
  const databaseErrorCodes = new Set([
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "28P01",
    "3D000",
  ]);
  let publicError = error.publicError || fallbackError;
  if (databaseErrorCodes.has(error.code)) {
    publicError = "database_connection_failed";
  } else if (error.code === "42P01") {
    publicError = "database_schema_missing";
  }

  response.status(error.statusCode || 500).json({
    error: publicError,
    message: error.message,
  });
}

function getSingleQueryValue(value) {
  return typeof value === "string" ? value : "";
}

function buildKakaoAuthorizationUrl(request, oauthState) {
  const authorizationUrl = new URL("https://kauth.kakao.com/oauth/authorize");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", kakaoRestApiKey);
  authorizationUrl.searchParams.set("redirect_uri", getOAuthCallbackUrl(request, "kakao"));
  authorizationUrl.searchParams.set("state", oauthState.state);
  return authorizationUrl.toString();
}

function buildNaverAuthorizationUrl(request, oauthState) {
  const authorizationUrl = new URL("https://nid.naver.com/oauth2.0/authorize");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", naverClientId);
  authorizationUrl.searchParams.set("redirect_uri", getOAuthCallbackUrl(request, "naver"));
  authorizationUrl.searchParams.set("state", oauthState.state);
  return authorizationUrl.toString();
}

function buildAuthorizationUrl(request, provider, oauthState) {
  if (provider === "kakao") return buildKakaoAuthorizationUrl(request, oauthState);
  if (provider === "naver") return buildNaverAuthorizationUrl(request, oauthState);
  throw createHttpError("Unsupported OAuth provider.", 404, "unsupported_oauth_provider");
}

async function startSocialOAuth(request, response, provider) {
  if (!SOCIAL_AUTH_PROVIDERS.has(provider)) {
    response.status(404).json({ error: "unsupported_oauth_provider" });
    return;
  }

  if (!requireSocialAuthProviderConfig(provider, response)) return;

  try {
    const oauthState = await createOAuthState(request, {
      provider,
      returnTo: getSingleQueryValue(request.query.returnTo),
      mode: getSingleQueryValue(request.query.mode),
    });
    response.redirect(buildAuthorizationUrl(request, provider, oauthState));
  } catch (error) {
    sendRouteError(response, error, `${provider}_auth_start_failed`);
  }
}

async function completeSocialOAuth(request, response, provider) {
  let consumedState = { returnTo: "/", mode: "popup" };

  try {
    assertSocialAuthProviderConfig(provider);

    const state = getSingleQueryValue(request.query.state);
    const code = getSingleQueryValue(request.query.code);
    const providerError = getSingleQueryValue(request.query.error);
    const providerErrorDescription = getSingleQueryValue(request.query.error_description);
    consumedState = await consumeOAuthState(request, { provider, state });

    if (providerError) {
      throw createHttpError(providerErrorDescription || providerError, 401, "oauth_provider_error");
    }

    if (!code) {
      throw createHttpError("OAuth code is missing.", 400, "missing_code");
    }

    const redirectUri = getOAuthCallbackUrl(request, provider);
    const profile =
      provider === "kakao"
        ? await fetchKakaoProfile((await exchangeKakaoCode(code, redirectUri)).access_token)
        : await fetchNaverProfile(
            (await exchangeNaverCode({ code, state, redirectUri })).access_token,
          );
    const userRecord = await upsertOAuthUser(profile);
    const user = await createAppSession(request, userRecord.id);

    sendOAuthCallbackHtml(request, response, {
      provider,
      authenticated: true,
      user,
      returnTo: consumedState.returnTo,
      mode: consumedState.mode,
    });
  } catch (error) {
    console.error(`${provider} auth failed:`, error);
    sendOAuthCallbackHtml(request, response, {
      provider,
      authenticated: false,
      error: error.publicError || `${provider}_auth_failed`,
      message: error.message,
      returnTo: consumedState.returnTo,
      mode: consumedState.mode,
    });
  }
}

app.get("/api/health", async (_request, response) => {
  try {
    const result = await query(`
      SELECT
        to_regclass('public.users') IS NOT NULL AS users,
        to_regclass('public.oauth_accounts') IS NOT NULL AS oauth_accounts,
        to_regclass('public.credit_ledger') IS NOT NULL AS credit_ledger,
        to_regclass('public.session') IS NOT NULL AS session,
        to_regclass('public.image_jobs') IS NOT NULL AS image_jobs
    `);
    const tables = result.rows[0];
    const missingTables = Object.entries(tables)
      .filter(([, exists]) => !exists)
      .map(([table]) => table);

    response.status(missingTables.length ? 503 : 200).json({
      ok: missingTables.length === 0,
      db: missingTables.length ? "schema_missing" : "ok",
      missingTables,
    });
  } catch (error) {
    console.error("Health check failed:", error);
    response.status(503).json({ ok: false, db: "error", error: error.code || "db_error" });
  }
});

app.get("/api/config", (_request, response) => {
  response.json({
    googleClientId,
    authProviders: {
      google: Boolean(googleClientId && googleClientSecret),
      kakao: Boolean(kakaoRestApiKey),
      naver: Boolean(naverClientId && naverClientSecret),
    },
  });
});

app.get("/api/me", async (request, response) => {
  if (!request.session.userId) {
    response.json({ authenticated: false, user: null });
    return;
  }

  try {
    const user = await getUserWithCredit(request.session.userId);
    if (!user) {
      await destroySession(request);
      response.clearCookie("supereasy.sid");
      response.json({ authenticated: false, user: null });
      return;
    }

    response.json({ authenticated: true, user });
  } catch (error) {
    sendRouteError(response, error, "me_failed");
  }
});

app.post("/api/auth/google", async (request, response) => {
  if (!requireGoogleConfig(response) || !requireSameOriginAjax(request, response)) return;

  const { code } = request.body || {};
  if (!code || typeof code !== "string") {
    response.status(400).json({ error: "missing_code" });
    return;
  }

  try {
    const tokens = await exchangeGoogleCode(code, getRequestOrigin(request));
    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: googleClientId,
    });
    const userRecord = await upsertOAuthUser(mapGoogleOAuthProfile(ticket.getPayload()));
    const user = await createAppSession(request, userRecord.id);
    response.json({ authenticated: true, user });
  } catch (error) {
    sendRouteError(response, error, "google_auth_failed");
  }
});

app.get("/api/auth/kakao/start", (request, response) => {
  startSocialOAuth(request, response, "kakao");
});

app.get("/api/auth/kakao/callback", (request, response) => {
  completeSocialOAuth(request, response, "kakao");
});

app.get("/api/auth/naver/start", (request, response) => {
  startSocialOAuth(request, response, "naver");
});

app.get("/api/auth/naver/callback", (request, response) => {
  completeSocialOAuth(request, response, "naver");
});

app.post("/api/logout", async (request, response) => {
  try {
    await destroySession(request);
    response.clearCookie("supereasy.sid");
    response.json({ ok: true });
  } catch (error) {
    sendRouteError(response, error, "logout_failed");
  }
});

app.post(
  "/api/admin/credits/grant",
  requireAuthenticated,
  requireAdminUser,
  async (request, response) => {
    try {
      const result = await grantAdminCredit({
        userId: request.session.userId,
        amount: request.body?.amount,
        requestId: request.body?.requestId,
      });

      response.json(result);
    } catch (error) {
      sendRouteError(response, error, "admin_credit_grant_failed");
    }
  },
);

app.post(
  "/api/image-jobs",
  requireAuthenticated,
  createUploadMiddleware,
  async (request, response) => {
    let uploadedImage = null;
    let resultStoragePath = null;

    try {
      uploadedImage = await prepareUploadedImage(request.file, request.session.userId);
      const debitResult = await createImageJobWithDebit({
        userId: request.session.userId,
        requestId: request.body?.requestId,
        inputFileName: uploadedImage.inputFileName,
        inputStoragePath: uploadedImage.inputStoragePath,
        inputFileSize: uploadedImage.inputFileSize,
        inputMimeType: uploadedImage.inputMimeType,
      });

      if (debitResult.idempotent) {
        await safeRemoveStorageObjects([uploadedImage.inputStoragePath]);
        response.status(200).json(await mapImageJobResult(debitResult));
        return;
      }

      try {
        const mockResult = await mockProcessImageJob(debitResult.job, uploadedImage);
        resultStoragePath = mockResult.resultStoragePath;

        const completeResult = await completeImageJob({
          userId: request.session.userId,
          imageJobId: debitResult.job.id,
          resultStoragePath: mockResult.resultStoragePath,
          resultMetadata: mockResult.metadata,
        });

        response.status(201).json(await mapImageJobResult(completeResult));
      } catch (processingError) {
        console.error(processingError);
        await safeRemoveStorageObjects([resultStoragePath]);

        const failResult = await failImageJobWithRefund({
          userId: request.session.userId,
          imageJobId: debitResult.job.id,
          errorMessage: processingError.message,
        });

        response.status(500).json({
          error: "image_job_processing_failed",
          message: "Image generation failed.",
          ...(await mapImageJobResult(failResult)),
        });
      }
    } catch (error) {
      await safeRemoveStorageObjects([uploadedImage?.inputStoragePath]);
      sendRouteError(response, error, "image_job_failed");
    }
  },
);

app.get("/api/image-jobs/:id", requireAuthenticated, async (request, response) => {
  try {
    const result = await getImageJobForUser(request.session.userId, request.params.id);
    response.json(await mapImageJobResult(result));
  } catch (error) {
    sendRouteError(response, error, "image_job_get_failed");
  }
});

app.delete("/api/image-jobs/:id/files", requireAuthenticated, async (request, response) => {
  try {
    const result = await cleanupImageJobFiles({
      userId: request.session.userId,
      imageJobId: request.params.id,
    });

    response.json(result);
  } catch (error) {
    sendRouteError(response, error, "image_job_cleanup_failed");
  }
});

app.use((error, _request, response, _next) => {
  sendRouteError(response, error, "server_error");
});

app.use(express.static(__dirname));

async function startServer() {
  return app.listen(port, () => {
    console.log(`Supereasy server listening on http://localhost:${port}`);
  });
}

if (process.env.VERCEL !== "1") {
  startServer().catch((error) => {
    console.error("Unable to start Supereasy server:", error);
    process.exit(1);
  });
}

export { app, startServer };
export default app;
