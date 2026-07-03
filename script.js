const appShell = document.querySelector("#appShell");
const workspaceCard = document.querySelector("#workspaceCard");
const startView = document.querySelector("#startView");
const processingView = document.querySelector("#processingView");
const resultsView = document.querySelector("#resultsView");
const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const previewImage = document.querySelector("#previewImage");
const selectedFile = document.querySelector("#selectedFile");
const selectedFileName = document.querySelector("#selectedFileName");
const selectionActions = document.querySelector("#selectionActions");
const enhanceButton = document.querySelector("#enhanceButton");
const versionOneImage = document.querySelector("#versionOneImage");
const versionTwoImage = document.querySelector("#versionTwoImage");
const resultImages = [versionOneImage, versionTwoImage];
const originalToggleButtons = document.querySelectorAll(".original-toggle");
const imageDownloadButtons = document.querySelectorAll(".image-download-button");
const resetButton = document.querySelector("#resetButton");
const resultResetButton = document.querySelector("#resultResetButton");
const downloadLink = document.querySelector("#downloadLink");
const authControls = document.querySelector("#authControls");
const authLoginShell = document.querySelector("#authLoginShell");
const loginButton = document.querySelector("#loginButton");
const logoutButton = document.querySelector("#logoutButton");
const authUser = document.querySelector("#authUser");
const authAvatar = document.querySelector("#authAvatar");
const authName = document.querySelector("#authName");
const authCredit = document.querySelector("#authCredit");
const authProviderMenu = document.querySelector("#authProviderMenu");
const authProviderButtons = document.querySelectorAll("[data-auth-provider]");

const appData = {
  imageId: "",
  imageJobId: "",
  originalImageUrl: "",
  originalFileName: "supereasy-result",
  pendingFile: null,
  resultUrls: [],
  isProcessing: false,
};

const authData = {
  googleClientId: "",
  authProviders: {
    google: false,
    kakao: false,
    naver: false,
  },
  codeClient: null,
  user: null,
  pendingLogin: null,
};
const AUTH_PROVIDER_LABELS = Object.freeze({
  google: "Google",
  kakao: "Kakao",
  naver: "Naver",
});
const IMAGE_JOB_COST = 1;

function setLoginBusy(isBusy) {
  loginButton.disabled = isBusy;
  loginButton.textContent = isBusy ? "로그인 중" : "로그인";
  authProviderButtons.forEach((button) => {
    const provider = button.dataset.authProvider;
    button.disabled = isBusy || !authData.authProviders[provider];
  });
}

function setEnhanceBusy(isBusy) {
  enhanceButton.disabled = isBusy;
  enhanceButton.textContent = isBusy ? "처리 중" : "보정하기";
}

function hasEnabledAuthProvider() {
  return Object.values(authData.authProviders).some(Boolean);
}

function closeAuthProviderMenu() {
  authProviderMenu.hidden = true;
  loginButton.setAttribute("aria-expanded", "false");
}

function openAuthProviderMenu() {
  if (authData.user) return;

  authProviderMenu.hidden = false;
  loginButton.setAttribute("aria-expanded", "true");
}

function toggleAuthProviderMenu() {
  if (authProviderMenu.hidden) {
    openAuthProviderMenu();
    return;
  }

  closeAuthProviderMenu();
}

function updateUserCredit(credit) {
  if (!authData.user) return;

  authData.user.credit = Number(credit || 0);
  authCredit.textContent = `크레딧 ${authData.user.credit}`;
}

function renderAuthState() {
  const isLoggedIn = Boolean(authData.user);

  authControls.dataset.authState = isLoggedIn ? "authenticated" : "guest";
  authLoginShell.hidden = isLoggedIn;
  authUser.hidden = !isLoggedIn;

  if (!isLoggedIn) {
    authAvatar.hidden = true;
    authAvatar.removeAttribute("src");
    authName.textContent = "";
    authCredit.textContent = "";
    setLoginBusy(false);
    return;
  }

  closeAuthProviderMenu();
  authAvatar.src = authData.user.picture || "";
  authAvatar.hidden = !authData.user.picture;
  authName.textContent = authData.user.name || authData.user.email || "사용자";
  updateUserCredit(authData.user.credit);
}

async function requestJson(url, options = {}) {
  const { headers = {}, ...requestOptions } = options;
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    ...requestOptions,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || "Request failed");
    error.status = response.status;
    error.code = data.error || "request_failed";
    error.data = data;
    throw error;
  }

  return data;
}

async function requestForm(url, formData, options = {}) {
  const { headers = {}, ...requestOptions } = options;
  const response = await fetch(url, {
    credentials: "same-origin",
    headers,
    body: formData,
    ...requestOptions,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || "Request failed");
    error.status = response.status;
    error.code = data.error || "request_failed";
    error.data = data;
    throw error;
  }

  return data;
}

function waitForGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let checks = 0;
    const timer = window.setInterval(() => {
      checks += 1;

      if (window.google?.accounts?.oauth2) {
        window.clearInterval(timer);
        resolve();
        return;
      }

      if (checks > 80) {
        window.clearInterval(timer);
        reject(new Error("Google Identity Services를 불러오지 못했습니다."));
      }
    }, 100);
  });
}

function createCodeClient() {
  if (!authData.googleClientId || authData.codeClient) return;

  authData.codeClient = window.google.accounts.oauth2.initCodeClient({
    client_id: authData.googleClientId,
    scope: "openid email profile",
    ux_mode: "popup",
    redirect_uri: window.location.origin,
    callback: handleGoogleCodeResponse,
    error_callback: () => {
      finishPendingLogin(false);
    },
  });
}

function finishPendingLogin(success) {
  const pendingLogin = authData.pendingLogin;
  authData.pendingLogin = null;
  if (pendingLogin?.popupMonitor) {
    window.clearInterval(pendingLogin.popupMonitor);
  }
  setLoginBusy(false);
  pendingLogin?.resolve(success);
}

async function handleGoogleCodeResponse(response) {
  if (response.error || !response.code) {
    finishPendingLogin(false);
    return;
  }

  try {
    const data = await requestJson("/api/auth/google", {
      method: "POST",
      headers: {
        "X-Requested-With": "XmlHttpRequest",
      },
      body: JSON.stringify({ code: response.code }),
    });

    authData.user = data.user;
    renderAuthState();
    finishPendingLogin(true);
  } catch (error) {
    console.error(error);
    const detail = error.code ? ` (${error.code})` : "";
    alert(`로그인에 실패했습니다${detail}. 잠시 후 다시 시도해주세요.`);
    finishPendingLogin(false);
  }
}

function getLoginReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}` || "/";
}

function shouldUseRedirectLogin() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function buildSocialLoginUrl(provider, mode) {
  const url = new URL(`/api/auth/${provider}/start`, window.location.origin);
  url.searchParams.set("returnTo", getLoginReturnTo());
  url.searchParams.set("mode", mode);
  return url.toString();
}

async function beginGoogleLogin() {
  if (authData.user) return true;

  if (!authData.authProviders.google || !authData.googleClientId) {
    alert("Google 로그인 설정이 필요합니다. 서버의 .env 값을 확인해주세요.");
    return false;
  }

  try {
    if (!authData.codeClient) {
      await waitForGoogleIdentity();
      createCodeClient();
    }
  } catch (error) {
    console.error(error);
    alert("Google Identity Services를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
    return false;
  }

  if (authData.pendingLogin) return authData.pendingLogin.promise;

  const promise = new Promise((resolve) => {
    authData.pendingLogin = { resolve };
  });

  closeAuthProviderMenu();
  setLoginBusy(true);
  try {
    authData.codeClient.requestCode();
  } catch (error) {
    console.error(error);
    finishPendingLogin(false);
  }

  return promise;
}

function beginSocialLogin(provider) {
  if (authData.user) return true;

  const providerLabel = AUTH_PROVIDER_LABELS[provider] || "소셜";
  if (!authData.authProviders[provider]) {
    alert(`${providerLabel} 로그인 설정이 필요합니다. 서버의 .env 값을 확인해주세요.`);
    return false;
  }

  if (authData.pendingLogin) return authData.pendingLogin.promise;

  closeAuthProviderMenu();

  if (shouldUseRedirectLogin()) {
    window.location.href = buildSocialLoginUrl(provider, "redirect");
    return false;
  }

  const promise = new Promise((resolve) => {
    authData.pendingLogin = { resolve };
  });
  setLoginBusy(true);

  const popup = window.open(
    buildSocialLoginUrl(provider, "popup"),
    "supereasy-oauth",
    "width=480,height=720",
  );

  if (!popup) {
    finishPendingLogin(false);
    window.location.href = buildSocialLoginUrl(provider, "redirect");
    return false;
  }

  if (authData.pendingLogin) {
    authData.pendingLogin.popup = popup;
    authData.pendingLogin.popupMonitor = window.setInterval(() => {
      if (popup.closed) {
        finishPendingLogin(false);
      }
    }, 500);
  }
  popup.focus?.();

  return promise;
}

function beginProviderLogin(provider) {
  if (provider === "google") return beginGoogleLogin();
  if (provider === "kakao" || provider === "naver") return beginSocialLogin(provider);
  return false;
}

function handleOAuthMessage(event) {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "supereasy:oauth-complete") return;

  if (event.data.authenticated && event.data.user) {
    authData.user = event.data.user;
    renderAuthState();
    finishPendingLogin(true);
    return;
  }

  const detail = event.data?.error ? ` (${event.data.error})` : "";
  alert(`로그인에 실패했습니다${detail}. 잠시 후 다시 시도해주세요.`);
  finishPendingLogin(false);
}

async function initAuth() {
  try {
    const [config, me] = await Promise.all([
      requestJson("/api/config"),
      requestJson("/api/me"),
    ]);

    authData.googleClientId = config.googleClientId || "";
    authData.authProviders = {
      google: Boolean(config.authProviders?.google && config.googleClientId),
      kakao: Boolean(config.authProviders?.kakao),
      naver: Boolean(config.authProviders?.naver),
    };
    authData.user = me.user;
    renderAuthState();

    if (authData.authProviders.google) {
      await waitForGoogleIdentity();
      createCodeClient();
    }
  } catch (error) {
    console.error(error);
    authControls.dataset.authState = "guest";
    setLoginBusy(false);
  }
}

async function ensureAuthenticated() {
  if (authData.user) return true;

  if (!hasEnabledAuthProvider()) {
    alert("로그인 설정이 필요합니다. 서버의 .env 값을 확인해주세요.");
    return false;
  }

  openAuthProviderMenu();
  loginButton.focus();
  return false;
}

async function logout() {
  try {
    await requestJson("/api/logout", { method: "POST" });
  } catch (error) {
    console.error(error);
  }

  authData.user = null;
  renderAuthState();
}

function setAppState(state) {
  appShell.dataset.appState = state;
  workspaceCard.dataset.state = state;

  startView.hidden = state !== "landing" && state !== "selected";
  processingView.hidden = state !== "processing";
  resultsView.hidden = state !== "results";
  previewImage.hidden = state !== "selected";
  selectedFile.hidden = state !== "selected";
  selectionActions.hidden = state !== "selected";
}

function isBlobUrl(url) {
  return typeof url === "string" && url.startsWith("blob:");
}

function revokeBlobUrl(url) {
  if (isBlobUrl(url)) {
    URL.revokeObjectURL(url);
  }
}

function revokeStoredUrls() {
  revokeBlobUrl(appData.originalImageUrl);
  appData.resultUrls.forEach((url) => revokeBlobUrl(url));
  appData.resultUrls = [];
}

async function cleanupCurrentImageJobFiles() {
  const imageJobId = appData.imageJobId;
  if (!imageJobId) return false;

  appData.imageJobId = "";

  try {
    await requestJson(`/api/image-jobs/${imageJobId}/files`, { method: "DELETE" });
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

async function resetExperience() {
  await cleanupCurrentImageJobFiles();
  revokeStoredUrls();
  appData.imageId = "";
  appData.imageJobId = "";
  appData.originalImageUrl = "";
  appData.originalFileName = "supereasy-result";
  appData.pendingFile = null;
  appData.isProcessing = false;
  fileInput.value = "";
  previewImage.removeAttribute("src");
  selectedFileName.textContent = "선택된 사진";
  versionOneImage.removeAttribute("src");
  versionTwoImage.removeAttribute("src");
  setEnhanceBusy(false);
  setAppState("landing");
}

function getBaseName(fileName) {
  return fileName.replace(/\.[^.]+$/, "") || "supereasy-result";
}

async function selectImage(file) {
  await cleanupCurrentImageJobFiles();
  revokeStoredUrls();

  appData.imageId = window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `image-${Date.now()}`;
  appData.originalFileName = getBaseName(file.name);
  appData.originalImageUrl = URL.createObjectURL(file);
  appData.pendingFile = file;
  fileInput.value = "";
  previewImage.src = appData.originalImageUrl;
  selectedFileName.textContent = file.name;
  setAppState("selected");
}

function setOriginalPreview(button, isPressed) {
  const index = Number(button.dataset.resultIndex);
  const targetImage = resultImages[index];
  const resultUrl = appData.resultUrls[index];

  if (!targetImage || !appData.originalImageUrl || !resultUrl) return;

  button.classList.toggle("is-pressed", isPressed);
  targetImage.src = isPressed ? appData.originalImageUrl : resultUrl;
}

function triggerDownload(url, fileName) {
  if (!url) return;

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}

async function downloadUrl(url, fileName) {
  if (!url) return;

  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error("Download failed.");
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  triggerDownload(objectUrl, fileName);

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

async function downloadResult(index) {
  const url = appData.resultUrls[index];
  const versionNumber = index + 1;
  try {
    await downloadUrl(
      url,
      `${appData.originalFileName}-version-${versionNumber}${getUrlExtension(url)}`,
    );
    await cleanupCurrentImageJobFiles();
  } catch (error) {
    console.error(error);
    alert("다운로드에 실패했습니다. 잠시 후 다시 시도해주세요.");
  }
}

async function downloadAllResults() {
  try {
    const uniqueUrls = [...new Set(appData.resultUrls.filter(Boolean))];
    await Promise.all(
      uniqueUrls.map((url, index) =>
        downloadUrl(
          url,
          uniqueUrls.length === 1
            ? `${appData.originalFileName}${getUrlExtension(url)}`
            : `${appData.originalFileName}-version-${index + 1}${getUrlExtension(url)}`,
        ),
      ),
    );
    await cleanupCurrentImageJobFiles();
  } catch (error) {
    console.error(error);
    alert("다운로드에 실패했습니다. 잠시 후 다시 시도해주세요.");
  }
}

function createRequestId() {
  return window.crypto?.randomUUID ? window.crypto.randomUUID() : `image-job-${Date.now()}`;
}

async function createImageJobForSelectedFile() {
  const formData = new FormData();
  formData.append("requestId", createRequestId());
  formData.append("image", appData.pendingFile);

  return requestForm("/api/image-jobs", formData, {
    method: "POST",
  });
}

function handleImageJobCreateError(error) {
  if (error.status === 402 || error.code === "insufficient_credits") {
    alert("남은 크레딧이 없습니다.");
    return;
  }

  if (error.code === "heic_conversion_failed") {
    alert(error.message);
    return;
  }

  if (error.code === "unsupported_image_type") {
    alert("JPG, PNG, WebP, HEIC 파일만 업로드할 수 있습니다.");
    return;
  }

  if (error.code === "image_too_large") {
    alert(error.message || "업로드 가능한 이미지 용량을 초과했습니다.");
    return;
  }

  if (error.code === "image_job_processing_failed") {
    alert("결과물을 만들지 못했습니다. 차감된 크레딧은 복구되었습니다.");
    return;
  }

  alert("보정 요청을 시작하지 못했습니다. 잠시 후 다시 시도해주세요.");
}

function getUrlExtension(url) {
  try {
    const { pathname } = new URL(url, window.location.href);
    const match = pathname.match(/\.[a-z0-9]+$/i);
    return match ? match[0] : ".jpg";
  } catch (_error) {
    return ".jpg";
  }
}

function renderServerJobResult(job) {
  if (!job?.resultImageUrl) {
    throw new Error("Server response did not include resultImageUrl.");
  }

  const previousOriginalUrl = appData.originalImageUrl;
  appData.imageJobId = job.id || "";
  appData.originalImageUrl = job.inputImageUrl || appData.originalImageUrl;
  appData.resultUrls = [job.resultImageUrl, job.resultImageUrl];

  previewImage.src = appData.originalImageUrl;
  versionOneImage.src = job.resultImageUrl;
  versionTwoImage.src = job.resultImageUrl;
  revokeBlobUrl(previousOriginalUrl);
  setAppState("results");
}

async function handleEnhanceRequest() {
  if (appData.isProcessing || !appData.originalImageUrl || !appData.pendingFile) return;

  const isAuthenticated = await ensureAuthenticated();
  if (!isAuthenticated) return;

  if (Number(authData.user?.credit || 0) < IMAGE_JOB_COST) {
    alert("남은 크레딧이 없습니다.");
    return;
  }

  appData.isProcessing = true;
  setEnhanceBusy(true);
  setAppState("processing");

  try {
    const result = await createImageJobForSelectedFile();
    updateUserCredit(result.credit);
    renderServerJobResult(result.job);
  } catch (error) {
    console.error(error);
    if (error.data && "credit" in error.data) {
      updateUserCredit(error.data.credit);
    }
    setAppState("selected");
    handleImageJobCreateError(error);
  } finally {
    appData.isProcessing = false;
    setEnhanceBusy(false);
  }
}

async function handleFile(file) {
  const hasImageMimeType = file?.type?.startsWith("image/");
  const hasSupportedImageExtension = /\.(jpe?g|png|webp|heic|heif)$/i.test(file?.name || "");

  if (!file || (!hasImageMimeType && !hasSupportedImageExtension)) {
    fileInput.value = "";
    return;
  }

  await selectImage(file);
}

enhanceButton.addEventListener("click", handleEnhanceRequest);

fileInput.addEventListener("change", (event) => {
  handleFile(event.target.files[0]);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  handleFile(event.dataTransfer.files[0]);
});

resetButton.addEventListener("click", resetExperience);
resultResetButton.addEventListener("click", resetExperience);
downloadLink.addEventListener("click", downloadAllResults);
loginButton.addEventListener("click", () => {
  if (hasEnabledAuthProvider()) {
    toggleAuthProviderMenu();
    return;
  }

  alert("로그인 설정이 필요합니다. 서버의 .env 값을 확인해주세요.");
});
logoutButton.addEventListener("click", logout);
window.addEventListener("message", handleOAuthMessage);

authProviderButtons.forEach((button) => {
  button.addEventListener("click", () => {
    beginProviderLogin(button.dataset.authProvider);
  });
});

document.addEventListener("click", (event) => {
  if (authLoginShell.hidden || authLoginShell.contains(event.target)) return;
  closeAuthProviderMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAuthProviderMenu();
  }
});

imageDownloadButtons.forEach((button) => {
  button.addEventListener("click", () => {
    downloadResult(Number(button.dataset.resultIndex));
  });
});

originalToggleButtons.forEach((button) => {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    setOriginalPreview(button, true);
  });

  button.addEventListener("pointerup", (event) => {
    button.releasePointerCapture?.(event.pointerId);
    setOriginalPreview(button, false);
  });

  button.addEventListener("pointercancel", () => {
    setOriginalPreview(button, false);
  });

  button.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    setOriginalPreview(button, true);
  });

  button.addEventListener("keyup", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    setOriginalPreview(button, false);
  });

  button.addEventListener("blur", () => {
    setOriginalPreview(button, false);
  });
});

setAppState("landing");
initAuth();
