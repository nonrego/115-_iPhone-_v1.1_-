(function () {
  "use strict";

  const APP_VERSION = "1.1.0";
  const abnormalResults = new Set(["位置不符", "標籤異常", "待報廢", "待確認"]);
  const photoRequiredResults = new Set(["位置不符", "標籤異常", "待報廢"]);
  const packageData = window.INVENTORY_PACKAGE;
  const assets = packageData.assets;
  const assetsById = new Map(assets.map((asset) => [asset.assetId, asset]));
  const assetsByBarcode = new Map(assets.map((asset) => [asset.barcode, asset]));
  const locationNames = packageData.locations.map((row) => row.location);
  const recordsById = new Map();
  const unlabeledById = new Map();

  let currentAsset = null;
  let currentScanValue = "";
  let currentPhotoFile = null;
  let previewUrl = null;
  let unlabeledPhotoFile = null;
  let unlabeledPreviewUrl = null;
  let liveScanner = null;
  let fileScanner = null;

  const el = (id) => document.getElementById(id);

  function normalize(value) {
    return String(value ?? "").trim().replace(/^\*|\*$/g, "").replace(/\s+/g, "");
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
      const random = Math.random() * 16 | 0;
      const value = char === "x" ? random : (random & 0x3 | 0x8);
      return value.toString(16);
    });
  }

  function isoNow() {
    return new Date().toISOString();
  }

  function localTime(value) {
    if (!value) return "";
    return new Date(value).toLocaleString("zh-TW", { hour12: false });
  }

  function safeFilePart(value) {
    return String(value).replace(/[^0-9A-Za-z\u4e00-\u9fff_-]+/g, "_");
  }

  function localFileStamp(value = new Date()) {
    const part = (number) => String(number).padStart(2, "0");
    return `${value.getFullYear()}${part(value.getMonth() + 1)}${part(value.getDate())}_${part(value.getHours())}${part(value.getMinutes())}${part(value.getSeconds())}`;
  }

  function showToast(message, duration = 2600) {
    const toast = el("toast");
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, duration);
  }

  function showMessage(message) {
    const target = el("scanMessage");
    target.textContent = message;
    target.hidden = false;
  }

  function hideMessage() {
    el("scanMessage").hidden = true;
  }

  function setTab(panelId) {
    document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === panelId));
    document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === panelId));
    if (panelId === "missingPanel") renderMissing();
    if (panelId === "recordsPanel") renderRecords();
    if (panelId === "unlabeledPanel") renderUnlabeled();
  }

  function populateLocationSelects() {
    const options = [`<option value="">請選擇地點</option>`]
      .concat(locationNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`))
      .join("");
    el("locationSelect").innerHTML = options;
    el("actualLocationSelect").innerHTML = options;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function loadSettings() {
    const settings = JSON.parse(localStorage.getItem("inventory-settings") || "{}");
    el("operatorInput").value = settings.operator || "";
    el("deviceInput").value = settings.device || "手機01";
    el("locationSelect").value = locationNames.includes(settings.location) ? settings.location : "";
    const lastExport = localStorage.getItem("inventory-last-export");
    el("lastExportText").textContent = lastExport ? `上次匯出：${localTime(lastExport)}` : "尚未匯出備份";
  }

  function saveSettings() {
    localStorage.setItem("inventory-settings", JSON.stringify({
      operator: el("operatorInput").value.trim(),
      device: el("deviceInput").value.trim(),
      location: el("locationSelect").value,
    }));
  }

  async function loadRecords() {
    const records = await InventoryDb.getAllRecords();
    const unlabeled = await InventoryDb.getAllUnlabeled();
    recordsById.clear();
    records.forEach((record) => recordsById.set(record.assetId, record));
    unlabeledById.clear();
    unlabeled.forEach((item) => unlabeledById.set(item.tempId, item));
    renderProgress();
    renderRecords();
    renderMissing();
    renderUnlabeled();
  }

  function renderProgress() {
    const records = [...recordsById.values()];
    const completed = records.length;
    const overallPercent = Math.round(completed / packageData.expectedTotal * 100);
    el("overallProgress").textContent = `${completed} / ${packageData.expectedTotal}`;
    el("overallPercent").textContent = `${overallPercent}%`;
    el("abnormalCount").textContent = String(records.filter((record) => abnormalResults.has(record.result)).length);
    el("unlabeledCount").textContent = String(unlabeledById.size);

    const location = el("locationSelect").value;
    const expected = location ? assets.filter((asset) => asset.expectedLocation === location) : [];
    const done = expected.filter((asset) => recordsById.has(asset.assetId)).length;
    el("locationProgress").textContent = `${done} / ${expected.length}`;
    el("locationNameSummary").textContent = location || "尚未選擇";
  }

  function selectedLocationReady() {
    if (!el("locationSelect").value) {
      showMessage("請先選擇目前盤點地點，再開始掃描或搜尋。");
      el("locationSelect").focus();
      return false;
    }
    if (!el("operatorInput").value.trim()) {
      showMessage("請先輸入盤點人姓名。");
      el("operatorInput").focus();
      return false;
    }
    saveSettings();
    return true;
  }

  function findAsset(rawValue) {
    const value = normalize(rawValue);
    if (!value) return null;
    if (assetsByBarcode.has(value)) return assetsByBarcode.get(value);
    if (assetsById.has(value)) return assetsById.get(value);
    const compact = value.replace(/-/g, "").toUpperCase();
    return assets.find((asset) => asset.assetId.replace(/-/g, "").toUpperCase() === compact) || null;
  }

  async function processScan(value) {
    hideMessage();
    if (!selectedLocationReady()) return;
    const asset = findAsset(value);
    if (!asset) {
      showMessage(`查無「${value}」。請確認條碼是否完整，或改用財產編號／名稱搜尋。`);
      if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
      return;
    }
    if (navigator.vibrate) navigator.vibrate(80);
    await openAsset(asset, normalize(value));
  }

  async function openAsset(asset, scanValue) {
    currentAsset = asset;
    currentScanValue = scanValue || asset.barcode;
    currentPhotoFile = null;
    resetPhotoPreview();
    const existing = recordsById.get(asset.assetId);
    el("assetCategory").textContent = asset.category;
    el("assetName").textContent = asset.name;
    el("assetId").textContent = asset.assetId;
    el("assetBarcode").textContent = asset.barcode;
    el("assetExpectedLocation").textContent = asset.expectedLocation;
    el("assetCustodian").textContent = `${asset.department}／${asset.custodian}`;
    el("assetSpec").textContent = asset.spec || asset.alias || "－";
    el("existingBadge").hidden = !existing;

    const currentLocation = el("locationSelect").value;
    el("actualLocationSelect").value = existing?.actualLocation || currentLocation || asset.expectedLocation;
    el("resultSelect").value = existing?.result || (currentLocation === asset.expectedLocation ? "相符" : "位置不符");
    el("noteInput").value = existing?.note || "";
    el("photoInput").value = "";

    if (existing?.photoFile) {
      const photo = await InventoryDb.getPhoto(asset.assetId);
      if (photo?.blob) setPhotoPreview(photo.blob);
    }

    el("assetForm").hidden = false;
    el("assetForm").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetPhotoPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    const preview = el("photoPreview");
    preview.src = "";
    preview.hidden = true;
  }

  function setPhotoPreview(blob) {
    resetPhotoPreview();
    previewUrl = URL.createObjectURL(blob);
    el("photoPreview").src = previewUrl;
    el("photoPreview").hidden = false;
  }

  async function compressPhoto(file) {
    const image = new Image();
    const sourceUrl = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = sourceUrl;
      });
      const maxBytes = 500 * 1024;
      const maxSide = 1400;
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
      const toBlob = (target, quality) => new Promise((resolve, reject) => target.toBlob((blob) => blob ? resolve(blob) : reject(new Error("照片壓縮失敗")), "image/jpeg", quality));
      let quality = 0.78;
      let blob = await toBlob(canvas, quality);
      while (blob.size > maxBytes && quality > 0.46) {
        quality -= 0.08;
        blob = await toBlob(canvas, quality);
      }
      if (blob.size > maxBytes) {
        const resize = Math.min(0.9, Math.sqrt(maxBytes / blob.size) * 0.94);
        const smaller = document.createElement("canvas");
        smaller.width = Math.max(480, Math.round(canvas.width * resize));
        smaller.height = Math.max(360, Math.round(canvas.height * resize));
        smaller.getContext("2d", { alpha: false }).drawImage(canvas, 0, 0, smaller.width, smaller.height);
        quality = 0.56;
        blob = await toBlob(smaller, quality);
        while (blob.size > maxBytes && quality > 0.36) {
          quality -= 0.06;
          blob = await toBlob(smaller, quality);
        }
      }
      return blob;
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  }

  async function saveRecord(event) {
    event.preventDefault();
    if (!currentAsset || !selectedLocationReady()) return;
    const operator = el("operatorInput").value.trim();
    const actualLocation = el("actualLocationSelect").value;
    const result = el("resultSelect").value;
    const note = el("noteInput").value.trim();
    const existing = recordsById.get(currentAsset.assetId);
    const existingPhoto = existing?.photoFile || "";

    if (!actualLocation) {
      showToast("請選擇實際找到地點");
      return;
    }
    if (abnormalResults.has(result) && !note) {
      showToast("異常紀錄必須填寫備註");
      el("noteInput").focus();
      return;
    }
    if (photoRequiredResults.has(result) && !currentPhotoFile && !existingPhoto) {
      showToast("此盤點結果必須拍攝現場照片");
      el("photoInput").focus();
      return;
    }

    const now = isoNow();
    let photoFile = existingPhoto;
    if (currentPhotoFile) {
      const photoBlob = await compressPhoto(currentPhotoFile);
      photoFile = `財產_${safeFilePart(currentAsset.assetId)}_${localFileStamp()}.jpg`;
      await InventoryDb.putPhoto({ assetId: currentAsset.assetId, fileName: photoFile, blob: photoBlob, updatedAt: now });
    }

    const history = Array.isArray(existing?.history) ? [...existing.history] : [];
    history.push({
      at: now,
      operator,
      action: existing ? "更正" : "新增",
      scanValue: currentScanValue,
      actualLocation,
      result,
      note,
    });

    const record = {
      recordId: existing?.recordId || uuid(),
      inventoryYear: packageData.inventoryYear,
      packageId: packageData.packageId,
      assetId: currentAsset.assetId,
      barcode: currentAsset.barcode,
      scanValue: currentScanValue,
      category: currentAsset.category,
      name: currentAsset.name,
      expectedLocation: currentAsset.expectedLocation,
      actualLocation,
      result,
      operator,
      device: el("deviceInput").value.trim() || "未命名手機",
      foundAt: existing?.foundAt || now,
      updatedAt: now,
      note,
      photoFile,
      history,
      appVersion: APP_VERSION,
    };

    await InventoryDb.putRecord(record);
    recordsById.set(record.assetId, record);
    renderProgress();
    renderRecords();
    renderMissing();
    el("assetForm").hidden = true;
    currentAsset = null;
    currentPhotoFile = null;
    resetPhotoPreview();
    showToast(existing ? "更正已保存，原歷程仍保留" : "盤點紀錄已保存");
    el("searchInput").value = "";
    el("searchInput").focus();
  }

  function searchAssets(query) {
    const q = String(query || "").trim().toLowerCase();
    const target = el("searchResults");
    target.innerHTML = "";
    if (!q) return;
    const compact = q.replace(/-/g, "");
    const matches = assets.filter((asset) => [asset.assetId, asset.barcode, asset.name, asset.alias, asset.expectedLocation, asset.custodian]
      .some((value) => String(value).toLowerCase().includes(q) || String(value).toLowerCase().replace(/-/g, "").includes(compact)))
      .slice(0, 30);
    if (!matches.length) {
      target.innerHTML = `<div class="hint">找不到符合資料。</div>`;
      return;
    }
    target.innerHTML = matches.map((asset) => `
      <button type="button" class="search-result" data-asset-id="${escapeHtml(asset.assetId)}">
        <strong>${escapeHtml(asset.name)}</strong>
        <span>${escapeHtml(asset.assetId)}｜${escapeHtml(asset.expectedLocation)}｜${escapeHtml(asset.custodian)}</span>
      </button>`).join("");
    target.querySelectorAll("[data-asset-id]").forEach((button) => button.addEventListener("click", () => {
      target.innerHTML = "";
      processScan(button.dataset.assetId);
    }));
  }

  function renderMissing() {
    const location = el("locationSelect").value;
    const list = el("missingList");
    if (!location) {
      el("missingSummary").textContent = "請先選擇盤點地點。";
      list.innerHTML = "";
      return;
    }
    const missing = assets.filter((asset) => asset.expectedLocation === location && !recordsById.has(asset.assetId));
    const expected = assets.filter((asset) => asset.expectedLocation === location).length;
    el("missingSummary").textContent = `${location}：應盤 ${expected} 筆，尚未找到 ${missing.length} 筆。`;
    list.innerHTML = missing.length ? missing.map((asset) => `
      <div class="list-item">
        <button type="button" data-missing-id="${escapeHtml(asset.assetId)}"><strong>${escapeHtml(asset.name)}</strong></button>
        <div class="mono">${escapeHtml(asset.assetId)}</div>
        <div class="meta"><span>${escapeHtml(asset.custodian)}</span><span>${escapeHtml(asset.alias)}</span></div>
      </div>`).join("") : `<div class="message">此地點已全部完成，可以匯出ZIP備份。</div>`;
    list.querySelectorAll("[data-missing-id]").forEach((button) => button.addEventListener("click", () => {
      setTab("scanPanel");
      openAsset(assetsById.get(button.dataset.missingId), assetsById.get(button.dataset.missingId).assetId);
    }));
  }

  function renderRecords() {
    const filter = String(el("recordFilter")?.value || "").trim().toLowerCase();
    const records = [...recordsById.values()]
      .filter((record) => !filter || [record.assetId, record.barcode, record.name, record.expectedLocation, record.actualLocation, record.result, record.operator]
        .some((value) => String(value).toLowerCase().includes(filter)))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const target = el("recordList");
    if (!target) return;
    target.innerHTML = records.length ? records.map((record) => `
      <div class="list-item">
        <button type="button" data-record-id="${escapeHtml(record.assetId)}"><strong>${escapeHtml(record.name)}</strong></button>
        <div class="mono">${escapeHtml(record.assetId)}</div>
        <span class="result-badge ${abnormalResults.has(record.result) ? "abnormal" : ""}">${escapeHtml(record.result)}</span>
        <div class="meta"><span>${escapeHtml(record.actualLocation)}</span><span>${escapeHtml(localTime(record.updatedAt))}</span><span>${escapeHtml(record.operator)}</span></div>
      </div>`).join("") : `<div class="hint">本機尚無盤點紀錄。</div>`;
    target.querySelectorAll("[data-record-id]").forEach((button) => button.addEventListener("click", () => {
      setTab("scanPanel");
      const asset = assetsById.get(button.dataset.recordId);
      openAsset(asset, recordsById.get(asset.assetId).scanValue);
    }));
  }

  function setUnlabeledPhotoPreview(blob) {
    if (unlabeledPreviewUrl) URL.revokeObjectURL(unlabeledPreviewUrl);
    unlabeledPreviewUrl = URL.createObjectURL(blob);
    el("unlabeledPhotoPreview").src = unlabeledPreviewUrl;
    el("unlabeledPhotoPreview").hidden = false;
  }

  function resetUnlabeledForm() {
    el("unlabeledForm").reset();
    el("unlabeledQuantity").value = "1";
    unlabeledPhotoFile = null;
    if (unlabeledPreviewUrl) URL.revokeObjectURL(unlabeledPreviewUrl);
    unlabeledPreviewUrl = null;
    el("unlabeledPhotoPreview").src = "";
    el("unlabeledPhotoPreview").hidden = true;
  }

  async function saveUnlabeled(event) {
    event.preventDefault();
    if (!selectedLocationReady()) return;
    if (!unlabeledPhotoFile) {
      showToast("待釐清物品必須拍照");
      return;
    }
    const now = isoNow();
    const device = el("deviceInput").value.trim() || "手機";
    const tempId = `UNLABELED-115-${safeFilePart(device)}-${localFileStamp()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const photoBlob = await compressPhoto(unlabeledPhotoFile);
    const photoFile = `待釐清_${safeFilePart(tempId)}_${localFileStamp()}.jpg`;
    const item = {
      tempId,
      packageId: packageData.packageId,
      inventoryYear: packageData.inventoryYear,
      category: el("unlabeledCategory").value,
      reason: el("unlabeledReason").value,
      name: el("unlabeledName").value.trim(),
      spec: el("unlabeledSpec").value.trim(),
      quantity: Number(el("unlabeledQuantity").value) || 1,
      actualLocation: el("locationSelect").value,
      custodian: el("unlabeledCustodian").value.trim(),
      note: el("unlabeledNote").value.trim(),
      status: "待釐清",
      candidateAssetId: "",
      operator: el("operatorInput").value.trim(),
      device,
      foundAt: now,
      updatedAt: now,
      photoFile,
      history: [{ at: now, operator: el("operatorInput").value.trim(), action: "現場新增", status: "待釐清" }],
      appVersion: APP_VERSION,
    };
    await InventoryDb.putPhoto({ assetId: tempId, fileName: photoFile, blob: photoBlob, updatedAt: now });
    await InventoryDb.putUnlabeled(item);
    unlabeledById.set(tempId, item);
    renderProgress();
    renderUnlabeled();
    resetUnlabeledForm();
    showToast(`已保存待釐清物品；照片${Math.round(photoBlob.size / 1024)}KB`);
  }

  function renderUnlabeled() {
    const target = el("unlabeledList");
    if (!target) return;
    const items = [...unlabeledById.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    target.innerHTML = items.length ? items.map((item) => `
      <div class="list-item">
        <strong>${escapeHtml(item.name)}</strong>
        <div class="mono">${escapeHtml(item.tempId)}</div>
        <span class="result-badge abnormal">${escapeHtml(item.reason)}／${escapeHtml(item.status || "待釐清")}</span>
        <div class="meta"><span>${escapeHtml(item.actualLocation)}</span><span>${escapeHtml(localTime(item.updatedAt))}</span><span>${escapeHtml(item.spec)}</span></div>
      </div>`).join("") : `<div class="hint">本機尚無待釐清物品。</div>`;
  }

  function csvEscape(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function recordsToCsv(records) {
    const headers = ["紀錄ID", "盤點年度", "正式財產編號", "標籤條碼", "掃描值", "財產類別", "財產名稱", "帳面地點", "實際地點", "盤點結果", "盤點人", "手機代號", "首次找到時間", "最近更新時間", "備註", "照片檔名", "更正次數"];
    const rows = records.map((record) => [record.recordId, record.inventoryYear, record.assetId, record.barcode, record.scanValue, record.category, record.name, record.expectedLocation, record.actualLocation, record.result, record.operator, record.device, record.foundAt, record.updatedAt, record.note, record.photoFile, record.history?.length || 0]);
    return "\ufeff" + [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  }

  async function exportBackup() {
    saveSettings();
    const records = [...recordsById.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
    const unlabeled = [...unlabeledById.values()].sort((a, b) => a.tempId.localeCompare(b.tempId));
    if (!records.length && !unlabeled.length) {
      showToast("目前沒有可匯出的盤點或待釐清紀錄");
      return;
    }
    const photos = await InventoryDb.getAllPhotos();
    const exportedAt = isoNow();
    const exportId = uuid();
    const operator = el("operatorInput").value.trim() || "未填盤點人";
    const device = el("deviceInput").value.trim() || "未命名手機";
    const manifest = {
      schemaVersion: "1.0.0",
      exportId,
      packageId: packageData.packageId,
      inventoryYear: packageData.inventoryYear,
      organization: packageData.organization,
      expectedTotal: packageData.expectedTotal,
      recordCount: records.length,
      unlabeledCount: unlabeled.length,
      photoCount: photos.length,
      operator,
      device,
      exportedAt,
      appVersion: APP_VERSION,
    };
    const history = records.flatMap((record) => (record.history || []).map((item, index) => ({ assetId: record.assetId, recordId: record.recordId, historyIndex: index + 1, ...item })));
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    zip.file("inventory_records.json", JSON.stringify(records, null, 2));
    zip.file("unlabeled_items.json", JSON.stringify(unlabeled, null, 2));
    zip.file("inventory_records.csv", recordsToCsv(records));
    zip.file("history.json", JSON.stringify(history, null, 2));
    const photoFolder = zip.folder("photos");
    photos.forEach((photo) => photoFolder.file(photo.fileName, photo.blob));
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const filename = `115年盤點_${safeFilePart(device)}_${exportedAt.slice(0, 10).replace(/-/g, "")}_${records.length}筆_待釐清${unlabeled.length}筆.zip`;
    const file = new File([blob], filename, { type: "application/zip" });
    let shared = false;
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "115年財產盤點資料包", text: `已盤${records.length}筆、待釐清${unlabeled.length}筆，請儲存到「檔案」或傳回電腦。` });
        shared = true;
      } catch (error) {
        if (error.name !== "AbortError") console.warn(error);
      }
    }
    if (!shared) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    localStorage.setItem("inventory-last-export", exportedAt);
    el("lastExportText").textContent = `上次匯出：${localTime(exportedAt)}（已盤${records.length}、待釐清${unlabeled.length}）`;
    showToast("ZIP資料包已產生；請確認已存入「檔案」App");
  }

  async function importBackup(file) {
    const zip = await JSZip.loadAsync(file);
    const manifestFile = zip.file("manifest.json");
    const recordsFile = zip.file("inventory_records.json");
    if (!manifestFile || !recordsFile) throw new Error("ZIP內缺少必要檔案");
    const manifest = JSON.parse(await manifestFile.async("string"));
    if (manifest.packageId !== packageData.packageId) throw new Error(`資料包不屬於本次盤點：${manifest.packageId || "未知"}`);
    const incoming = JSON.parse(await recordsFile.async("string"));
    const unlabeledFile = zip.file("unlabeled_items.json");
    const incomingUnlabeled = unlabeledFile ? JSON.parse(await unlabeledFile.async("string")) : [];
    let added = 0;
    let updated = 0;
    let ignored = 0;
    for (const record of incoming) {
      if (!assetsById.has(record.assetId)) {
        ignored += 1;
        continue;
      }
      const current = recordsById.get(record.assetId);
      if (!current || String(record.updatedAt) > String(current.updatedAt)) {
        await InventoryDb.putRecord(record);
        recordsById.set(record.assetId, record);
        if (current) updated += 1;
        else added += 1;
        if (record.photoFile) {
          const basename = record.photoFile.split(/[\\/]/).pop();
          const photoEntry = zip.file(`photos/${basename}`);
          if (photoEntry) {
            const blob = await photoEntry.async("blob");
            await InventoryDb.putPhoto({ assetId: record.assetId, fileName: basename, blob, updatedAt: record.updatedAt });
          }
        }
      } else {
        ignored += 1;
      }
    }
    let unlabeledAdded = 0;
    for (const item of incomingUnlabeled) {
      const current = unlabeledById.get(item.tempId);
      if (!current || String(item.updatedAt) > String(current.updatedAt)) {
        await InventoryDb.putUnlabeled(item);
        unlabeledById.set(item.tempId, item);
        unlabeledAdded += 1;
        if (item.photoFile) {
          const basename = item.photoFile.split(/[\\/]/).pop();
          const photoEntry = zip.file(`photos/${basename}`) || zip.file(`照片/${basename}`);
          if (photoEntry) await InventoryDb.putPhoto({ assetId: item.tempId, fileName: basename, blob: await photoEntry.async("blob"), updatedAt: item.updatedAt });
        }
      }
    }
    renderProgress();
    renderMissing();
    renderRecords();
    renderUnlabeled();
    showToast(`合併完成：盤點新增${added}、更新${updated}、待釐清${unlabeledAdded}、略過${ignored}` , 4200);
  }

  async function startCamera() {
    if (!selectedLocationReady()) return;
    if (!window.Html5Qrcode) {
      showMessage("掃碼元件未載入，請改用拍照辨識或手動輸入。");
      return;
    }
    el("readerWrap").hidden = false;
    try {
      liveScanner = new Html5Qrcode("reader", {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.EAN_13,
        ],
        verbose: false,
      });
      await liveScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 280, height: 130 }, aspectRatio: 1.5 },
        async (decodedText) => {
          await stopCamera();
          processScan(decodedText);
        },
        () => {}
      );
    } catch (error) {
      console.warn(error);
      el("readerWrap").hidden = true;
      showMessage("無法開啟連續掃描。iPhone可改按「拍下條碼辨識」，或直接輸入條碼。首次使用請允許相機權限。");
    }
  }

  async function stopCamera() {
    if (liveScanner) {
      try {
        if (liveScanner.isScanning) await liveScanner.stop();
        liveScanner.clear();
      } catch (error) {
        console.warn(error);
      }
      liveScanner = null;
    }
    el("readerWrap").hidden = true;
  }

  async function scanBarcodePhoto(file) {
    if (!selectedLocationReady()) return;
    if (!window.Html5Qrcode) throw new Error("掃碼元件未載入");
    fileScanner = fileScanner || new Html5Qrcode("fileReader", {
      formatsToSupport: [Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39, Html5QrcodeSupportedFormats.ITF, Html5QrcodeSupportedFormats.EAN_13],
      verbose: false,
    });
    const decodedText = await fileScanner.scanFile(file, true);
    await processScan(decodedText);
  }

  function updateConnection() {
    const badge = el("connectionBadge");
    badge.textContent = navigator.onLine ? "已連線" : "離線模式";
  }

  async function registerServiceWorker() {
    updateConnection();
    if (!("serviceWorker" in navigator)) {
      el("connectionBadge").textContent = "不支援離線安裝";
      return;
    }
    try {
      await navigator.serviceWorker.register("sw.js");
      await navigator.serviceWorker.ready;
      el("connectionBadge").textContent = navigator.onLine ? "離線可用" : "離線模式";
    } catch (error) {
      console.warn(error);
      el("connectionBadge").textContent = "尚未安裝離線檔";
    }
  }

  function bindEvents() {
    document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
    ["operatorInput", "deviceInput"].forEach((id) => el(id).addEventListener("change", saveSettings));
    el("locationSelect").addEventListener("change", () => {
      saveSettings();
      renderProgress();
      renderMissing();
    });
    el("searchButton").addEventListener("click", () => searchAssets(el("searchInput").value));
    el("searchInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const asset = findAsset(el("searchInput").value);
        if (asset) processScan(el("searchInput").value);
        else searchAssets(el("searchInput").value);
      }
    });
    el("startCameraButton").addEventListener("click", startCamera);
    el("stopCameraButton").addEventListener("click", stopCamera);
    el("scanPhotoButton").addEventListener("click", () => el("barcodePhotoInput").click());
    el("barcodePhotoInput").addEventListener("change", async () => {
      const file = el("barcodePhotoInput").files?.[0];
      if (!file) return;
      try {
        await scanBarcodePhoto(file);
      } catch (error) {
        console.warn(error);
        showMessage("照片中無法辨識條碼。請讓條碼置中、光線充足，或改用手動輸入。");
      } finally {
        el("barcodePhotoInput").value = "";
      }
    });
    el("photoInput").addEventListener("change", () => {
      currentPhotoFile = el("photoInput").files?.[0] || null;
      if (currentPhotoFile) setPhotoPreview(currentPhotoFile);
    });
    el("unlabeledPhotoInput").addEventListener("change", () => {
      unlabeledPhotoFile = el("unlabeledPhotoInput").files?.[0] || null;
      if (unlabeledPhotoFile) setUnlabeledPhotoPreview(unlabeledPhotoFile);
    });
    el("unlabeledForm").addEventListener("submit", saveUnlabeled);
    el("actualLocationSelect").addEventListener("change", () => {
      if (!currentAsset) return;
      const existing = recordsById.get(currentAsset.assetId);
      if (!existing) el("resultSelect").value = el("actualLocationSelect").value === currentAsset.expectedLocation ? "相符" : "位置不符";
    });
    el("assetForm").addEventListener("submit", saveRecord);
    el("cancelAssetButton").addEventListener("click", () => {
      el("assetForm").hidden = true;
      currentAsset = null;
      currentPhotoFile = null;
      resetPhotoPreview();
    });
    el("refreshMissingButton").addEventListener("click", renderMissing);
    el("recordFilter").addEventListener("input", renderRecords);
    el("exportButton").addEventListener("click", exportBackup);
    el("importInput").addEventListener("change", async () => {
      const file = el("importInput").files?.[0];
      if (!file) return;
      try {
        await importBackup(file);
      } catch (error) {
        showToast(`匯入失敗：${error.message}`, 5000);
      } finally {
        el("importInput").value = "";
      }
    });
    el("clearButton").addEventListener("click", async () => {
      const confirmation = prompt("請輸入「清除」以刪除本機全部盤點紀錄。請確認已先匯出ZIP。");
      if (confirmation !== "清除") return;
      await InventoryDb.clearAll();
      await loadRecords();
      showToast("本機盤點紀錄已清除");
    });
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
  }

  async function init() {
    if (!packageData || packageData.expectedTotal !== 1345) {
      document.body.innerHTML = "<p style='padding:2rem'>資料包載入失敗或筆數不符。</p>";
      return;
    }
    populateLocationSelects();
    loadSettings();
    bindEvents();
    await loadRecords();
    registerServiceWorker();
  }

  window.addEventListener("DOMContentLoaded", () => init().catch((error) => {
    console.error(error);
    showToast(`啟動失敗：${error.message}`, 6000);
  }));
})();
