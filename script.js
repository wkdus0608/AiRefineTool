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
const resetButton = document.querySelector("#resetButton");
const resultResetButton = document.querySelector("#resultResetButton");
const downloadLink = document.querySelector("#downloadLink");

const appData = {
  imageId: "",
  originalImageUrl: "",
  originalFileName: "supereasy-result",
  pendingFile: null,
  resultUrls: [],
};

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

function revokeStoredUrls() {
  if (appData.originalImageUrl) {
    URL.revokeObjectURL(appData.originalImageUrl);
  }

  appData.resultUrls.forEach((url) => URL.revokeObjectURL(url));
  appData.resultUrls = [];
}

function resetExperience() {
  revokeStoredUrls();
  appData.imageId = "";
  appData.originalImageUrl = "";
  appData.originalFileName = "supereasy-result";
  appData.pendingFile = null;
  fileInput.value = "";
  previewImage.removeAttribute("src");
  selectedFileName.textContent = "선택된 사진";
  versionOneImage.removeAttribute("src");
  versionTwoImage.removeAttribute("src");
  downloadLink.removeAttribute("href");
  setAppState("landing");
}

function getBaseName(fileName) {
  return fileName.replace(/\.[^.]+$/, "") || "supereasy-result";
}

function readImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function createCanvasFromImage(image) {
  const canvas = document.createElement("canvas");
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  return canvas;
}

function addSoftOverlay(context, canvas, color, mode = "soft-light") {
  context.globalCompositeOperation = mode;
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "source-over";
}

function canvasToBlobUrl(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(URL.createObjectURL(blob)), "image/png", 0.96);
  });
}

async function createResultVersion(image, variant) {
  const canvas = createCanvasFromImage(image);
  const context = canvas.getContext("2d");

  if (variant === 1) {
    context.filter = "brightness(1.035) contrast(1.03) saturate(1.035)";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    addSoftOverlay(context, canvas, "rgba(237, 0, 140, 0.035)");
  } else {
    context.filter = "brightness(1.02) contrast(1.055) saturate(0.985)";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    addSoftOverlay(context, canvas, "rgba(255, 255, 255, 0.08)", "screen");
  }

  return canvasToBlobUrl(canvas);
}

function selectImage(file) {
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

async function processSelectedImage() {
  if (!appData.originalImageUrl) return;

  setAppState("processing");
  await new Promise((resolve) => window.setTimeout(resolve, 520));

  const image = await readImage(appData.originalImageUrl);
  const resultOneUrl = await createResultVersion(image, 1);
  const resultTwoUrl = await createResultVersion(image, 2);
  appData.resultUrls = [resultOneUrl, resultTwoUrl];

  versionOneImage.src = resultOneUrl;
  versionTwoImage.src = resultTwoUrl;
  downloadLink.href = resultOneUrl;
  downloadLink.download = `${appData.originalFileName}-version-1.png`;
  setAppState("results");
}

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    fileInput.value = "";
    return;
  }

  selectImage(file);
}

enhanceButton.addEventListener("click", () => {
  processSelectedImage();
});

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

setAppState("landing");
