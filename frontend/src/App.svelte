<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "./lib/Icon.svelte";

  type User = { id: string; name: string; email: string; role?: "ADMIN" | "USER" };
  type FolderPermission = "VIEW" | "EDIT";
  type Folder = {
    id: string;
    name: string;
    parentId: string | null;
    isPublic?: boolean;
    publicToken?: string | null;
    publicPermission?: FolderPermission;
    createdAt: string;
    updatedAt: string;
  };
  type FileItem = {
    id: string;
    name: string;
    size: number;
    mimeType?: string | null;
    folderId: string | null;
    isPublic?: boolean;
    publicToken?: string | null;
    publicUrl?: string | null;
    downloadUrl?: string | null;
    createdAt: string;
    updatedAt: string;
  };
  type Crumb = { id: string | null; name: string };
  type FileWithRelativePath = File & { webkitRelativePath?: string };
  type DriveRow =
    | { kind: "folder"; id: string; name: string; modifiedAt: string; sizeLabel: "-"; folder: Folder }
    | { kind: "file"; id: string; name: string; modifiedAt: string; sizeLabel: string; file: FileItem };
  type MenuState = { open: boolean; x: number; y: number; target: DriveRow | null };
  type PublicFolderContentResponse = {
    share: {
      token: string;
      permission: FolderPermission;
      rootFolderId: string;
      currentFolderId: string;
    };
    folders: Folder[];
    files: FileItem[];
  };
  type StorageSummary = {
    totalBytes: number;
    totalGb: number;
    fileCount: number;
  };
  type UploadStatus = "uploading" | "done" | "error";
  type UploadTask = {
    id: string;
    name: string;
    totalBytes: number;
    loadedBytes: number;
    status: UploadStatus;
    errorMessage?: string;
    batchId?: string;
  };
  type UploadBatch = {
    id: string;
    label: string;
    totalFiles: number;
    totalBytes: number;
    loadedBytes: number;
    completedFiles: number;
    failedFiles: number;
    status: UploadStatus;
  };

  const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

  let loadingSession = true;
  let loadingDrive = false;
  let publicMode = false;
  let publicShareToken: string | null = null;
  let publicSharePermission: FolderPermission = "VIEW";
  let publicRootFolderId: string | null = null;
  let authMode: "login" | "register" = "login";
  let user: User | null = null;
  let email = "";
  let password = "";
  let name = "";
  let searchQuery = "";
  let errorMessage = "";
  let successMessage = "";
  let folders: Folder[] = [];
  let files: FileItem[] = [];
  let storageSummary: StorageSummary | null = null;
  let uploadTasks: UploadTask[] = [];
  let uploadBatches: UploadBatch[] = [];
  let breadcrumbs: Crumb[] = [{ id: null, name: "My Drive" }];
  let currentFolderId: string | null = null;
  let clipboardAction: "cut" | "copy" | null = null;
  let clipboardFile: FileItem | null = null;
  let selectedRow: DriveRow | null = null;
  let selectedIds = new Set<string>();
  let lastClickedIndex = -1;
  let menu: MenuState = { open: false, x: 0, y: 0, target: null };
  let uploadFileInput: HTMLInputElement | null = null;
  let uploadFolderInput: HTMLInputElement | null = null;

  // Profile modal
  let showProfile = false;
  let profileName = "";
  let profileOldPassword = "";
  let profileNewPassword = "";
  let profileConfirmPassword = "";
  let profileSaving = false;
  let profileError = "";
  let profileSuccess = "";

  // Auto-dismiss timers per batch
  const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

  $: folderMenuTarget = menu.target && menu.target.kind === "folder" ? menu.target.folder : null;
  $: fileMenuTarget = menu.target && menu.target.kind === "file" ? menu.target.file : null;
  $: canEditCurrentView = !publicMode || publicSharePermission === "EDIT";
  $: visibleUploadTasks = uploadTasks.slice(-8).reverse();
  $: latestUploadBatch = uploadBatches.length ? uploadBatches[uploadBatches.length - 1] : null;
  $: isAtRoot = currentFolderId === null;
  $: selectedCount = selectedIds.size;

  $: driveRows = [...folders.map(folderToRow), ...files.map(fileToRow)].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  $: filteredRows = driveRows.filter((row) =>
    row.name.toLowerCase().includes(searchQuery.toLowerCase().trim())
  );

  function folderToRow(folder: Folder): DriveRow {
    return { kind: "folder", id: folder.id, name: folder.name, modifiedAt: folder.updatedAt || folder.createdAt, sizeLabel: "-", folder };
  }
  function fileToRow(file: FileItem): DriveRow {
    return { kind: "file", id: file.id, name: file.name, modifiedAt: file.updatedAt || file.createdAt, sizeLabel: formatSize(file.size), file };
  }

  function setError(message: string) { errorMessage = message; successMessage = ""; }
  function setSuccess(message: string) { successMessage = message; errorMessage = ""; }
  function resetMessages() { errorMessage = ""; successMessage = ""; }

  function buildFolderShareLink(token: string): string {
    return `${window.location.origin}?share=${encodeURIComponent(token)}`;
  }

  function directoryPicker(node: HTMLInputElement) {
    node.setAttribute("webkitdirectory", "");
    node.setAttribute("directory", "");
  }

  function makeId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // ── Multi-select helpers ──────────────────────────────────────────────────
  function rowId(row: DriveRow): string {
    return `${row.kind}:${row.id}`;
  }

  function isRowSelected(row: DriveRow): boolean {
    return selectedIds.has(rowId(row));
  }

  function clearSelection() {
    selectedIds = new Set();
    selectedRow = null;
    lastClickedIndex = -1;
  }

  function selectAll() {
    selectedIds = new Set(filteredRows.map(rowId));
  }

  function handleRowClick(event: MouseEvent, row: DriveRow, index: number) {
    if (event.ctrlKey || event.metaKey) {
      const id = rowId(row);
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      selectedIds = next;
      lastClickedIndex = index;
      selectedRow = row;
    } else if (event.shiftKey && lastClickedIndex >= 0) {
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      selectedIds = new Set(filteredRows.slice(start, end + 1).map(rowId));
    } else {
      selectedIds = new Set([rowId(row)]);
      lastClickedIndex = index;
      selectedRow = row;
    }
  }

  function toggleCheckbox(row: DriveRow, index: number) {
    const id = rowId(row);
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
    lastClickedIndex = index;
  }

  async function deleteSelected() {
    if (selectedCount === 0) return;
    const count = selectedCount;
    if (!confirm(`Hapus ${count} item yang dipilih?`)) return;
    const toDelete = filteredRows.filter((row) => selectedIds.has(rowId(row)));
    clearSelection();
    try {
      for (const row of toDelete) {
        if (row.kind === "folder") {
          const ep = publicMode && publicShareToken
            ? `/api/public/folders/${publicShareToken}/folders/${row.id}`
            : `/api/folders/${row.id}`;
          await request(ep, { method: "DELETE" });
        } else {
          const ep = publicMode && publicShareToken
            ? `/api/public/folders/${publicShareToken}/files/${row.id}`
            : `/api/files/${row.id}`;
          await request(ep, { method: "DELETE" });
        }
      }
      await refreshDrive();
      setSuccess(`${count} item berhasil dihapus.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Gagal menghapus item");
      await refreshDrive();
    }
  }

  // ── Profile modal ─────────────────────────────────────────────────────────
  function openProfile() {
    profileName = user?.name ?? "";
    profileOldPassword = "";
    profileNewPassword = "";
    profileConfirmPassword = "";
    profileError = "";
    profileSuccess = "";
    showProfile = true;
  }

  function closeProfile() {
    showProfile = false;
  }

  async function handleProfileNameUpdate(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = profileName.trim();
    if (!trimmed || trimmed === user?.name) return;
    profileSaving = true;
    profileError = "";
    profileSuccess = "";
    try {
      const response = await request<{ user: User }>("/api/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed })
      });
      if (user) user = { ...user, name: response.user.name };
      profileName = response.user.name;
      profileSuccess = "Nama berhasil diperbarui.";
    } catch (error) {
      profileError = error instanceof Error ? error.message : "Gagal memperbarui nama";
    } finally {
      profileSaving = false;
    }
  }

  async function handlePasswordChange(event: SubmitEvent) {
    event.preventDefault();
    if (profileNewPassword !== profileConfirmPassword) {
      profileError = "Password baru tidak cocok.";
      return;
    }
    if (profileNewPassword.length < 6) {
      profileError = "Password baru minimal 6 karakter.";
      return;
    }
    profileSaving = true;
    profileError = "";
    profileSuccess = "";
    try {
      await request("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ oldPassword: profileOldPassword, newPassword: profileNewPassword })
      });
      profileOldPassword = "";
      profileNewPassword = "";
      profileConfirmPassword = "";
      profileSuccess = "Password berhasil diubah.";
    } catch (error) {
      profileError = error instanceof Error ? error.message : "Gagal mengubah password";
    } finally {
      profileSaving = false;
    }
  }

  // ── Upload batch helpers ──────────────────────────────────────────────────
  function createUploadBatch(label: string, totalFiles: number, totalBytes: number): string {
    const id = makeId();
    uploadBatches = [...uploadBatches, { id, label, totalFiles, totalBytes, loadedBytes: 0, completedFiles: 0, failedFiles: 0, status: "uploading" }];
    return id;
  }

  function addUploadTask(taskName: string, totalBytes: number, batchId?: string): string {
    const id = makeId();
    uploadTasks = [...uploadTasks, { id, name: taskName, totalBytes, loadedBytes: 0, status: "uploading", batchId }];
    if (batchId) syncUploadBatch(batchId);
    return id;
  }

  function getUploadTask(taskId: string): UploadTask | undefined {
    return uploadTasks.find((t) => t.id === taskId);
  }

  function syncUploadBatch(batchId: string) {
    const batchTasks = uploadTasks.filter((t) => t.batchId === batchId);
    if (!batchTasks.length) return;

    const loadedBytes = batchTasks.reduce((total, task) => {
      if (task.status === "done") return total + task.totalBytes;
      return total + Math.min(task.loadedBytes, task.totalBytes || task.loadedBytes);
    }, 0);
    const completedFiles = batchTasks.filter((t) => t.status === "done").length;
    const failedFiles = batchTasks.filter((t) => t.status === "error").length;
    const totalFiles = batchTasks.length;
    const status: UploadStatus =
      completedFiles + failedFiles === totalFiles
        ? failedFiles > 0 ? "error" : "done"
        : "uploading";

    const prevStatus = uploadBatches.find((b) => b.id === batchId)?.status;

    uploadBatches = uploadBatches.map((batch) =>
      batch.id === batchId
        ? { ...batch, loadedBytes, completedFiles, failedFiles, totalFiles, status }
        : batch
    );

    // Auto-dismiss on first transition to done/error
    if (prevStatus === "uploading" && (status === "done" || status === "error") && !autoDismissTimers.has(batchId)) {
      const delay = status === "error" ? 5000 : 2500;
      const timer = setTimeout(() => {
        uploadTasks = uploadTasks.filter((t) => t.batchId !== batchId);
        uploadBatches = uploadBatches.filter((b) => b.id !== batchId);
        autoDismissTimers.delete(batchId);
      }, delay);
      autoDismissTimers.set(batchId, timer);
    }
  }

  function updateUploadTaskProgress(taskId: string, loadedBytes: number, totalBytes?: number) {
    let bId: string | undefined;
    uploadTasks = uploadTasks.map((task) => {
      if (task.id !== taskId) return task;
      bId = task.batchId;
      const fallbackTotal = totalBytes && totalBytes > 0 ? totalBytes : task.totalBytes;
      const nextTotal = fallbackTotal > 0 ? fallbackTotal : task.totalBytes;
      const nextLoaded = Math.max(0, Math.min(loadedBytes, nextTotal || loadedBytes));
      return { ...task, totalBytes: nextTotal, loadedBytes: nextLoaded };
    });
    if (bId) syncUploadBatch(bId);
  }

  function setUploadTaskDone(taskId: string) {
    let bId: string | undefined;
    uploadTasks = uploadTasks.map((task) => {
      if (task.id !== taskId) return task;
      bId = task.batchId;
      return { ...task, status: "done", loadedBytes: task.totalBytes };
    });
    if (bId) syncUploadBatch(bId);
  }

  function setUploadTaskError(taskId: string, message: string) {
    let bId: string | undefined;
    uploadTasks = uploadTasks.map((task) => {
      if (task.id !== taskId) return task;
      bId = task.batchId;
      return { ...task, status: "error", errorMessage: message };
    });
    if (bId) syncUploadBatch(bId);
  }

  function clearFinishedUploads() {
    const doneBatchIds = new Set(uploadBatches.filter((b) => b.status !== "uploading").map((b) => b.id));
    for (const bId of doneBatchIds) {
      const timer = autoDismissTimers.get(bId);
      if (timer) { clearTimeout(timer); autoDismissTimers.delete(bId); }
    }
    uploadTasks = uploadTasks.filter((t) => t.status === "uploading");
    uploadBatches = uploadBatches.filter((b) => b.status === "uploading");
  }

  function percent(loaded: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
  }
  function batchPercent(batch: UploadBatch): number {
    if (batch.totalBytes > 0) return percent(batch.loadedBytes, batch.totalBytes);
    if (batch.totalFiles <= 0) return 0;
    return percent(batch.completedFiles + batch.failedFiles, batch.totalFiles);
  }
  function uploadStatusLabel(status: UploadStatus): string {
    if (status === "done") return "Selesai";
    if (status === "error") return "Gagal";
    return "Uploading";
  }

  async function runWithConcurrency<T>(items: T[], maxConcurrent: number, worker: (item: T) => Promise<void>) {
    if (items.length === 0) return;
    const queue = [...items];
    const runnerCount = Math.min(maxConcurrent, queue.length);
    await Promise.all(
      Array.from({ length: runnerCount }, async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (!item) return;
          await worker(item);
        }
      })
    );
  }

  function closeMenu() {
    menu = { ...menu, open: false, target: null };
  }

  function openMenu(event: MouseEvent, row: DriveRow | null) {
    event.preventDefault();
    if (row) {
      selectedRow = row;
      if (!selectedIds.has(rowId(row))) {
        selectedIds = new Set([rowId(row)]);
      }
    }
    const maxX = Math.max(8, window.innerWidth - 250);
    const maxY = Math.max(8, window.innerHeight - 360);
    menu = {
      open: true,
      x: Math.max(8, Math.min(event.clientX, maxX)),
      y: Math.max(8, Math.min(event.clientY, maxY)),
      target: row
    };
  }

  function openBackgroundMenu(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("tr[data-row='1']")) return;
    openMenu(event, null);
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers ?? {});
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(payload?.message ?? `Request failed (${response.status})`);
    return payload as T;
  }

  async function uploadRequestWithProgress<T>(
    path: string,
    formData: FormData,
    onProgress?: (loadedBytes: number, totalBytes: number) => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}${path}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (event) => {
        if (!onProgress) return;
        onProgress(event.loaded, event.lengthComputable ? event.total : 0);
      };
      xhr.onerror = () => reject(new Error("Network error saat upload"));
      xhr.onabort = () => reject(new Error("Upload dibatalkan"));
      xhr.onload = () => {
        let payload: unknown = null;
        if (xhr.responseText) {
          try { payload = JSON.parse(xhr.responseText); } catch { payload = null; }
        }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(payload as T); return; }
        const message =
          typeof payload === "object" && payload !== null && "message" in payload &&
          typeof (payload as { message?: unknown }).message === "string"
            ? (payload as { message: string }).message
            : `Request failed (${xhr.status})`;
        reject(new Error(message));
      };
      xhr.send(formData);
    });
  }

  async function loadSession() {
    try {
      const response = await request<{ user: User }>("/api/auth/me");
      user = response.user;
      await refreshDrive();
    } catch {
      user = null;
    } finally {
      loadingSession = false;
    }
  }

  async function handleAuthSubmit(event: SubmitEvent) {
    event.preventDefault();
    resetMessages();
    try {
      const response =
        authMode === "register"
          ? await request<{ user: User }>("/api/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) })
          : await request<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      user = response.user;
      email = ""; password = ""; name = "";
      breadcrumbs = [{ id: null, name: "My Drive" }];
      currentFolderId = null;
      await refreshDrive();
      setSuccess("Berhasil masuk.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Authentication failed");
    }
  }

  async function logout() {
    await request("/api/auth/logout", { method: "POST" });
    user = null;
    folders = []; files = []; storageSummary = null;
    breadcrumbs = [{ id: null, name: "My Drive" }];
    currentFolderId = null;
    clipboardAction = null; clipboardFile = null;
    selectedRow = null; selectedIds = new Set();
    showProfile = false;
  }

  async function refreshDrive() {
    loadingDrive = true;
    resetMessages();
    try {
      if (publicMode && publicShareToken) {
        const query = currentFolderId ? `?folderId=${encodeURIComponent(currentFolderId)}` : "";
        const response = await request<PublicFolderContentResponse>(
          `/api/public/folders/${publicShareToken}/content${query}`
        );
        publicSharePermission = response.share.permission;
        publicRootFolderId = response.share.rootFolderId;
        currentFolderId = response.share.currentFolderId;
        folders = response.folders;
        files = response.files.map((file) => ({ ...file, isPublic: false, publicUrl: null }));
        storageSummary = null;
        return;
      }
      if (!user) return;
      const parentQuery = currentFolderId ? `?parentId=${encodeURIComponent(currentFolderId)}` : "?parentId=";
      const fileQuery = currentFolderId ? `?folderId=${encodeURIComponent(currentFolderId)}` : "?folderId=";
      const summaryPromise = request<StorageSummary>("/api/files/storage/summary").catch(() => null);
      const [folderResponse, fileResponse] = await Promise.all([
        request<{ folders: Folder[] }>(`/api/folders${parentQuery}`),
        request<{ files: FileItem[] }>(`/api/files${fileQuery}`)
      ]);
      const summaryResponse = await summaryPromise;
      folders = folderResponse.folders;
      files = fileResponse.files;
      storageSummary = summaryResponse;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Gagal load data drive");
    } finally {
      loadingDrive = false;
    }
  }

  async function createFolder(nameValue: string) {
    if (!canEditCurrentView) { setError("Folder ini read-only."); return; }
    const nameClean = nameValue.trim();
    if (!nameClean) return;
    if (publicMode && publicShareToken) {
      await request(`/api/public/folders/${publicShareToken}/folders`, {
        method: "POST", body: JSON.stringify({ name: nameClean, parentId: currentFolderId })
      });
    } else {
      await request("/api/folders", { method: "POST", body: JSON.stringify({ name: nameClean, parentId: currentFolderId }) });
    }
    await refreshDrive();
    setSuccess(`Folder "${nameClean}" berhasil dibuat.`);
  }

  async function createFile(nameValue: string) {
    if (!canEditCurrentView) { setError("Folder ini read-only."); return; }
    const nameClean = nameValue.trim() || "Untitled.txt";
    if (publicMode && publicShareToken) {
      await request(`/api/public/folders/${publicShareToken}/files/create`, {
        method: "POST", body: JSON.stringify({ name: nameClean, folderId: currentFolderId })
      });
    } else {
      await request("/api/files/create", { method: "POST", body: JSON.stringify({ name: nameClean, folderId: currentFolderId }) });
    }
    await refreshDrive();
    setSuccess(`File "${nameClean}" berhasil dibuat.`);
  }

  async function promptCreateFile() {
    const value = window.prompt("Nama file", "Untitled.txt");
    if (value === null) return;
    await createFile(value);
  }
  async function promptCreateFolder() {
    const value = window.prompt("Nama folder", "Folder baru");
    if (value === null) return;
    await createFolder(value);
  }

  async function uploadSingleFile(
    file: File,
    folderId: string | null,
    fileName?: string,
    onProgress?: (loadedBytes: number, totalBytes: number) => void
  ) {
    const formData = new FormData();
    // folderId must be appended BEFORE file so the server reads it during streaming
    if (folderId) formData.append("folderId", folderId);
    formData.append("file", file, fileName ?? file.name);

    const endpoint = publicMode && publicShareToken
      ? `/api/public/folders/${publicShareToken}/files/upload`
      : "/api/files/upload";

    await uploadRequestWithProgress(endpoint, formData, (loaded, total) => {
      onProgress?.(loaded, total > 0 ? total : file.size);
    });
  }

  // Multi-file upload handler (also handles single file)
  async function handleUpload(event: Event) {
    if (!canEditCurrentView) { setError("Folder ini read-only."); return; }
    const input = event.currentTarget as HTMLInputElement;
    const pickedFiles = Array.from(input.files ?? []);
    if (!pickedFiles.length) return;

    const totalBytes = pickedFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    const batchLabel = pickedFiles.length === 1
      ? `Upload "${pickedFiles[0].name}"`
      : `Upload ${pickedFiles.length} file`;
    const batchId = createUploadBatch(batchLabel, pickedFiles.length, totalBytes);

    type TaskItem = { file: File; taskId: string };
    const taskItems: TaskItem[] = pickedFiles.map((file) => ({
      file,
      taskId: addUploadTask(file.name, file.size || 0, batchId)
    }));

    try {
      await runWithConcurrency(taskItems, 3, async (task) => {
        try {
          await uploadSingleFile(task.file, currentFolderId, undefined, (loaded, total) =>
            updateUploadTaskProgress(task.taskId, loaded, total)
          );
          setUploadTaskDone(task.taskId);
        } catch (error) {
          setUploadTaskError(task.taskId, error instanceof Error ? error.message : "Upload gagal");
        }
      });

      await refreshDrive();
      const failedCount = taskItems.filter((t) => getUploadTask(t.taskId)?.status === "error").length;
      if (failedCount > 0) {
        setError(`${failedCount} dari ${pickedFiles.length} file gagal diupload.`);
      } else {
        setSuccess(pickedFiles.length === 1
          ? `File "${pickedFiles[0].name}" berhasil diupload.`
          : `${pickedFiles.length} file berhasil diupload.`
        );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Upload gagal");
    } finally {
      input.value = "";
    }
  }

  async function ensureFolderPath(segments: string[], cache: Map<string, string | null>): Promise<string | null> {
    if (!canEditCurrentView) throw new Error("Folder ini read-only.");
    let parentId = currentFolderId;
    let pathKey = "";
    for (const segmentRaw of segments) {
      const segment = segmentRaw.trim();
      if (!segment) continue;
      pathKey = pathKey ? `${pathKey}/${segment}` : segment;
      if (cache.has(pathKey)) {
        parentId = cache.get(pathKey) ?? null;
        continue;
      }
      const endpoint = publicMode && publicShareToken
        ? `/api/public/folders/${publicShareToken}/folders`
        : "/api/folders";
      const created = await request<{ folder: Folder }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ name: segment, parentId })
      });
      parentId = created.folder.id;
      cache.set(pathKey, parentId);
    }
    return parentId;
  }

  async function handleUploadFolder(event: Event) {
    if (!canEditCurrentView) { setError("Folder ini read-only."); return; }
    const input = event.currentTarget as HTMLInputElement;
    const picked = Array.from(input.files ?? []) as FileWithRelativePath[];
    if (!picked.length) return;

    try {
      const cache = new Map<string, string | null>();
      cache.set("", currentFolderId);
      const batchId = createUploadBatch(
        `Upload folder (${picked.length} file)`,
        picked.length,
        picked.reduce((sum, f) => sum + (f.size || 0), 0)
      );

      type FolderTaskItem = { file: FileWithRelativePath; folderId: string | null; fileName: string; taskId: string };
      const taskItems: FolderTaskItem[] = [];

      for (const file of picked) {
        const rel = file.webkitRelativePath || file.name;
        const parts = rel.split("/").filter(Boolean);
        const fileName = parts.pop() || file.name;
        const folderId = await ensureFolderPath(parts, cache);
        const taskId = addUploadTask(fileName, file.size || 0, batchId);
        taskItems.push({ file, folderId, fileName, taskId });
      }

      await runWithConcurrency(taskItems, 3, async (task) => {
        try {
          await uploadSingleFile(task.file, task.folderId, task.fileName, (loaded, total) =>
            updateUploadTaskProgress(task.taskId, loaded, total)
          );
          setUploadTaskDone(task.taskId);
        } catch (error) {
          setUploadTaskError(task.taskId, error instanceof Error ? error.message : "Upload file gagal");
        }
      });

      await refreshDrive();
      const failedCount = taskItems.filter((t) => getUploadTask(t.taskId)?.status === "error").length;
      if (failedCount > 0) {
        setError(`Upload folder selesai dengan ${failedCount} file gagal dari ${picked.length}.`);
      } else {
        setSuccess(`Upload folder selesai (${picked.length} file).`);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Upload folder gagal");
    } finally {
      input.value = "";
    }
  }

  function openFolder(folder: Folder) {
    breadcrumbs = [...breadcrumbs, { id: folder.id, name: folder.name }];
    currentFolderId = folder.id;
    selectedRow = null;
    selectedIds = new Set();
    void refreshDrive();
  }

  function goToBreadcrumb(index: number) {
    breadcrumbs = breadcrumbs.slice(0, index + 1);
    currentFolderId = breadcrumbs[breadcrumbs.length - 1]?.id ?? null;
    selectedRow = null;
    selectedIds = new Set();
    void refreshDrive();
  }

  function copyToClipboard(file: FileItem) { clipboardAction = "copy"; clipboardFile = file; setSuccess(`"${file.name}" siap di-copy.`); }
  function cutToClipboard(file: FileItem) { clipboardAction = "cut"; clipboardFile = file; setSuccess(`"${file.name}" siap dipindah.`); }

  async function pasteClipboard() {
    if (!clipboardAction || !clipboardFile) return;
    if (clipboardAction === "copy") {
      await request(`/api/files/${clipboardFile.id}/copy`, { method: "POST", body: JSON.stringify({ targetFolderId: currentFolderId }) });
      setSuccess(`"${clipboardFile.name}" berhasil dicopy.`);
    } else {
      await request(`/api/files/${clipboardFile.id}/move`, { method: "PATCH", body: JSON.stringify({ targetFolderId: currentFolderId }) });
      clipboardAction = null; clipboardFile = null;
      setSuccess("File berhasil dipindah.");
    }
    await refreshDrive();
  }

  async function renameFile(file: FileItem) {
    if (!canEditCurrentView) { setError("Folder ini read-only."); return; }
    const nextName = window.prompt("Rename file", file.name)?.trim();
    if (!nextName || nextName === file.name) return;
    const ep = publicMode && publicShareToken
      ? `/api/public/folders/${publicShareToken}/files/${file.id}/rename`
      : `/api/files/${file.id}/rename`;
    await request(ep, { method: "PATCH", body: JSON.stringify({ name: nextName }) });
    await refreshDrive();
  }

  async function renameFolder(folder: Folder) {
    if (!canEditCurrentView) { setError("Folder ini read-only."); return; }
    const nextName = window.prompt("Rename folder", folder.name)?.trim();
    if (!nextName || nextName === folder.name) return;
    const ep = publicMode && publicShareToken
      ? `/api/public/folders/${publicShareToken}/folders/${folder.id}/rename`
      : `/api/folders/${folder.id}/rename`;
    await request(ep, { method: "PATCH", body: JSON.stringify({ name: nextName }) });
    await refreshDrive();
  }

  async function removeFile(file: FileItem) {
    if (!canEditCurrentView) { setError("Folder ini read-only."); return; }
    if (!confirm(`Hapus file "${file.name}"?`)) return;
    const ep = publicMode && publicShareToken
      ? `/api/public/folders/${publicShareToken}/files/${file.id}`
      : `/api/files/${file.id}`;
    await request(ep, { method: "DELETE" });
    await refreshDrive();
  }

  async function removeFolder(folder: Folder) {
    if (!canEditCurrentView) { setError("Folder ini read-only."); return; }
    if (!confirm(`Hapus folder "${folder.name}" dan isinya?`)) return;
    const ep = publicMode && publicShareToken
      ? `/api/public/folders/${publicShareToken}/folders/${folder.id}`
      : `/api/folders/${folder.id}`;
    await request(ep, { method: "DELETE" });
    await refreshDrive();
  }

  async function togglePublic(file: FileItem) {
    await request(`/api/files/${file.id}/share/public`, { method: "POST", body: JSON.stringify({ enabled: !file.isPublic }) });
    await refreshDrive();
  }
  async function copyPublicLink(file: FileItem) {
    if (!file.publicUrl) return;
    await navigator.clipboard.writeText(file.publicUrl);
  }
  async function openFile(file: FileItem) {
    if (publicMode && publicShareToken) {
      const url = file.downloadUrl ?? `${API_BASE}/api/public/folders/${publicShareToken}/files/${file.id}/download`;
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    if (file.isPublic && file.publicUrl) {
      window.open(file.publicUrl, "_blank", "noopener,noreferrer");
      return;
    }
    const response = await request<{ url: string }>(`/api/files/${file.id}/download-url`);
    window.open(response.url, "_blank", "noopener,noreferrer");
  }

  async function updateFolderPublicShare(folder: Folder, enabled: boolean, permission?: FolderPermission) {
    const response = await request<{ folder: Folder }>(`/api/folders/${folder.id}/share/public`, {
      method: "POST",
      body: JSON.stringify({ enabled, permission })
    });
    await refreshDrive();
    if (enabled && response.folder.publicToken) {
      const link = buildFolderShareLink(response.folder.publicToken);
      await navigator.clipboard.writeText(link);
      setSuccess("Link folder public berhasil disalin.");
    } else {
      setSuccess(`Share folder "${folder.name}" diperbarui.`);
    }
  }

  async function copyFolderPublicLink(folder: Folder) {
    if (!folder.publicToken) return;
    await navigator.clipboard.writeText(buildFolderShareLink(folder.publicToken));
    setSuccess("Link folder public berhasil disalin.");
  }

  async function runMenuAction(action: () => Promise<void> | void) {
    closeMenu();
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : "Aksi gagal dijalankan"); }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  function formatDate(value: string): string {
    return new Date(value).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function initials(value: string): string {
    return value.split(" ").filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase() ?? "").join("");
  }

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const shareToken = params.get("share") ?? params.get("folderShare");
    if (shareToken) {
      publicMode = true;
      publicShareToken = shareToken;
      breadcrumbs = [{ id: null, name: "Shared Folder" }];
      currentFolderId = null;
      loadingSession = false;
      void refreshDrive();
    } else {
      void loadSession();
    }
    const clickListener = () => closeMenu();
    const keyListener = (event: KeyboardEvent) => {
      if (event.key === "Escape") { closeMenu(); if (showProfile) closeProfile(); }
    };
    window.addEventListener("click", clickListener);
    window.addEventListener("keydown", keyListener);
    return () => {
      window.removeEventListener("click", clickListener);
      window.removeEventListener("keydown", keyListener);
    };
  });
</script>

{#if loadingSession}
  <div class="grid min-h-screen place-items-center bg-[#f8fafd] text-[#5f6368]">
    <p class="text-sm">Memuat ProtekDrive...</p>
  </div>
{:else if !user && !publicMode}
  <div class="min-h-screen bg-[#f8fafd] px-4 py-10 text-[#202124]">
    <div class="mx-auto max-w-4xl rounded-[28px] border border-[#dadce0] bg-white p-6 md:flex md:gap-10 md:p-10">
      <div class="md:w-1/2">
        <h1 class="flex items-center gap-2 text-[34px]">
          <span class="text-[#1a73e8]"><Icon name="brand" size={28} /></span>
          ProtekDrive
        </h1>
        <p class="mt-2 text-sm text-[#5f6368]">Cloud file manager bergaya Google Drive.</p>
      </div>
      <div class="mt-8 md:mt-0 md:w-1/2">
        <div class="mb-4 inline-flex rounded-full border border-[#dadce0] p-1 text-sm">
          <button class={`rounded-full px-4 py-1.5 ${authMode === "login" ? "bg-[#e8f0fe] text-[#1967d2]" : "text-[#5f6368]"}`} on:click={() => (authMode = "login")}>Login</button>
          <button class={`rounded-full px-4 py-1.5 ${authMode === "register" ? "bg-[#e8f0fe] text-[#1967d2]" : "text-[#5f6368]"}`} on:click={() => (authMode = "register")}>Register</button>
        </div>
        <form class="space-y-3" on:submit={handleAuthSubmit}>
          {#if authMode === "register"}
            <input class="h-12 w-full rounded-lg border border-[#dadce0] px-3 text-sm" type="text" placeholder="Nama lengkap" bind:value={name} required />
          {/if}
          <input class="h-12 w-full rounded-lg border border-[#dadce0] px-3 text-sm" type="email" placeholder="Email" bind:value={email} required />
          <input class="h-12 w-full rounded-lg border border-[#dadce0] px-3 text-sm" type="password" placeholder="Password" bind:value={password} minlength="6" required />
          <div class="text-right">
            <button class="rounded-full bg-[#1a73e8] px-6 py-2 text-sm text-white" type="submit">{authMode === "register" ? "Buat akun" : "Masuk"}</button>
          </div>
        </form>
        {#if errorMessage}<p class="mt-3 rounded-lg bg-[#fce8e6] px-3 py-2 text-sm text-[#b3261e]">{errorMessage}</p>{/if}
      </div>
    </div>
  </div>
{:else}
  <!-- Hidden file inputs: multiple for multi-file, folder picker -->
  <input bind:this={uploadFileInput} class="hidden" type="file" multiple on:change={handleUpload} />
  <input bind:this={uploadFolderInput} class="hidden" type="file" multiple use:directoryPicker on:change={handleUploadFolder} />

  <div class="h-screen overflow-hidden bg-[#f8fafd] text-[#202124]">
    <!-- Header -->
    <header class="flex h-16 items-center gap-3 border-b border-[#e8eaed] px-4">
      <h1 class="flex items-center gap-2 text-[22px] text-[#5f6368]">
        <span class="text-[#1a73e8]"><Icon name="brand" size={18} /></span>
        ProtekDrive
      </h1>
      <div class="ml-2 hidden h-10 w-full max-w-2xl items-center rounded-full bg-[#e9eef6] px-4 text-sm md:flex">
        <span class="text-[#5f6368]"><Icon name="search" size={15} /></span>
        <input class="ml-2 w-full bg-transparent text-sm outline-none" placeholder="Search in ProtekDrive" bind:value={searchQuery} />
      </div>
      <div class="ml-auto flex items-center gap-2">
        {#if publicMode}
          <div class="rounded-full border border-[#dadce0] px-3 py-1.5 text-xs text-[#5f6368]">
            Public {publicSharePermission === "EDIT" ? "(Can edit)" : "(Read-only)"}
          </div>
        {:else}
          <button
            class="grid h-9 w-9 place-items-center rounded-full bg-[#1a73e8] text-xs font-semibold text-white hover:opacity-90 transition-opacity cursor-pointer"
            title="Profil saya"
            on:click|stopPropagation={openProfile}
          >
            {initials(user?.name ?? "U")}
          </button>
        {/if}
      </div>
    </header>

    <div class="flex h-[calc(100vh-64px)]">
      <!-- Sidebar -->
      <aside class="hidden w-62.5 border-r border-[#e8eaed] px-3 py-4 md:block">
        <button class="mb-2 flex w-full items-center gap-2 rounded-full border border-[#dadce0] px-4 py-2 text-left text-sm disabled:cursor-not-allowed disabled:text-[#9aa0a6]" disabled={!canEditCurrentView} on:click={promptCreateFile}>
          <Icon name="file" size={14} /> Create file
        </button>
        <button class="mb-2 flex w-full items-center gap-2 rounded-full border border-[#dadce0] px-4 py-2 text-left text-sm disabled:cursor-not-allowed disabled:text-[#9aa0a6]" disabled={!canEditCurrentView} on:click={promptCreateFolder}>
          <Icon name="folder" size={14} /> Create folder
        </button>
        <button class="mb-2 flex w-full items-center gap-2 rounded-full border border-[#dadce0] px-4 py-2 text-left text-sm disabled:cursor-not-allowed disabled:text-[#9aa0a6]" disabled={!canEditCurrentView} on:click={() => uploadFileInput?.click()}>
          <Icon name="upload" size={14} /> Upload file
        </button>
        <button class="mb-2 flex w-full items-center gap-2 rounded-full border border-[#dadce0] px-4 py-2 text-left text-sm disabled:cursor-not-allowed disabled:text-[#9aa0a6]" disabled={!canEditCurrentView} on:click={() => uploadFolderInput?.click()}>
          <Icon name="uploadFolder" size={14} /> Upload folder
        </button>
        <button class="mb-2 flex w-full items-center gap-2 rounded-full border border-[#dadce0] px-4 py-2 text-left text-sm disabled:cursor-not-allowed disabled:text-[#9aa0a6]" disabled={!clipboardFile || !canEditCurrentView} on:click={pasteClipboard}>
          <Icon name="paste" size={14} /> Paste {clipboardAction ? `(${clipboardAction})` : ""}
        </button>
        <button class="flex w-full items-center gap-2 rounded-full border border-[#dadce0] px-4 py-2 text-left text-sm" on:click={refreshDrive}>
          <Icon name="refresh" size={14} /> Refresh
        </button>
        {#if !publicMode}
          <div class="mt-4 rounded-xl border border-[#e8eaed] bg-[#f8fafd] px-3 py-2 text-xs text-[#5f6368]">
            <p class="font-medium text-[#3c4043]">Total Storage</p>
            <p>{storageSummary ? `${storageSummary.totalGb.toFixed(3)} GB` : "-"}</p>
            <p>Total file: {storageSummary?.fileCount ?? 0}</p>
          </div>
        {/if}
        {#if publicMode}
          <p class="mt-3 px-1 text-xs text-[#5f6368]">
            Link public: {publicSharePermission === "EDIT" ? "boleh edit" : "read-only"}
          </p>
        {/if}
      </aside>

      <!-- Main content -->
      <main class="flex-1 overflow-hidden p-4">
        <section class="flex h-full flex-col overflow-hidden rounded-3xl border border-[#e8eaed] bg-white">
          <!-- Breadcrumbs -->
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[#e8eaed] px-4 py-3 text-sm">
            <div>
              {#each breadcrumbs as crumb, index}
                <button class={`mr-2 rounded-full px-3 py-1 ${index === breadcrumbs.length - 1 ? "bg-[#e8f0fe] text-[#1967d2]" : "hover:bg-[#f1f3f4]"}`} on:click={() => goToBreadcrumb(index)}>{crumb.name}</button>
              {/each}
            </div>
            {#if !publicMode}
              <p class="text-xs text-[#5f6368]">
                Storage: {storageSummary ? `${storageSummary.totalGb.toFixed(3)} GB` : "-"}
              </p>
            {/if}
          </div>

          <!-- Messages -->
          {#if errorMessage}<p class="mx-4 mt-3 rounded-lg bg-[#fce8e6] px-3 py-2 text-sm text-[#b3261e]">{errorMessage}</p>{/if}
          {#if successMessage}<p class="mx-4 mt-3 rounded-lg bg-[#e6f4ea] px-3 py-2 text-sm text-[#137333]">{successMessage}</p>{/if}

          <!-- Upload progress panel (auto-dismisses after completion) -->
          {#if uploadTasks.length > 0}
            <div class="mx-4 mt-3 rounded-xl border border-[#d2e3fc] bg-[#f6f9fe] p-3">
              <div class="flex items-center justify-between gap-2">
                <p class="text-sm font-medium text-[#174ea6]">Upload Progress</p>
                <button class="rounded-full border border-[#dadce0] px-3 py-1 text-xs text-[#5f6368] hover:bg-white" on:click={clearFinishedUploads}>
                  Clear finished
                </button>
              </div>
              {#if latestUploadBatch}
                <div class="mt-2 rounded-lg border border-[#e8eaed] bg-white px-2 py-2">
                  <div class="flex items-center justify-between text-xs text-[#5f6368]">
                    <p class="font-medium text-[#3c4043]">{latestUploadBatch.label}</p>
                    <p>
                      {latestUploadBatch.completedFiles}/{latestUploadBatch.totalFiles} selesai
                      {#if latestUploadBatch.failedFiles > 0}, {latestUploadBatch.failedFiles} gagal{/if}
                    </p>
                  </div>
                  <div class="mt-2 h-1.5 rounded-full bg-[#e8eaed]">
                    <div
                      class={`h-1.5 rounded-full transition-all ${latestUploadBatch.status === "error" ? "bg-[#ea4335]" : "bg-[#1a73e8]"}`}
                      style={`width:${batchPercent(latestUploadBatch)}%`}
                    ></div>
                  </div>
                </div>
              {/if}
              <div class="mt-2 space-y-2">
                {#each visibleUploadTasks as task}
                  <div class="rounded-lg border border-[#e8eaed] bg-white px-2 py-2">
                    <div class="flex items-center justify-between gap-2 text-xs">
                      <p class="truncate text-[#3c4043]" title={task.name}>{task.name}</p>
                      <p class={task.status === "error" ? "text-[#b3261e]" : "text-[#5f6368]"}>
                        {uploadStatusLabel(task.status)}
                        {#if task.status === "uploading"}{` ${percent(task.loadedBytes, task.totalBytes)}%`}{/if}
                      </p>
                    </div>
                    <div class="mt-1 h-1.5 rounded-full bg-[#e8eaed]">
                      <div
                        class={`h-1.5 rounded-full transition-all ${task.status === "error" ? "bg-[#ea4335]" : "bg-[#1a73e8]"}`}
                        style={`width:${task.status === "done" ? 100 : percent(task.loadedBytes, task.totalBytes)}%`}
                      ></div>
                    </div>
                    {#if task.status === "error" && task.errorMessage}
                      <p class="mt-1 text-[11px] text-[#b3261e]" title={task.errorMessage}>{task.errorMessage}</p>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Bulk action bar (shown when 2+ items selected) -->
          {#if selectedCount > 1}
            <div class="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-[#d2e3fc] bg-[#e8f0fe] px-4 py-2">
              <span class="text-sm font-medium text-[#1967d2]">{selectedCount} item dipilih</span>
              {#if canEditCurrentView}
                <button
                  class="rounded-full bg-[#ea4335] px-3 py-1 text-xs font-medium text-white hover:bg-[#c62828] transition-colors"
                  on:click={deleteSelected}
                >
                  Hapus ({selectedCount})
                </button>
              {/if}
              <button
                class="ml-auto rounded-full border border-[#dadce0] bg-white px-3 py-1 text-xs text-[#5f6368] hover:bg-[#f1f3f4] transition-colors"
                on:click={clearSelection}
              >
                Batal pilih
              </button>
            </div>
          {/if}

          <!-- File table -->
          <div class="mt-2 flex-1 overflow-auto pb-14 md:pb-0" role="presentation" on:contextmenu={openBackgroundMenu}>
            <table class="w-full min-w-215 text-sm">
              <thead class="sticky top-0 bg-white text-left text-xs uppercase text-[#5f6368]">
                <tr>
                  <th class="border-b border-[#e8eaed] px-3 py-3 w-10">
                    <input
                      type="checkbox"
                      class="cursor-pointer accent-[#1a73e8]"
                      checked={filteredRows.length > 0 && selectedCount === filteredRows.length}
                      on:click={() => selectedCount === filteredRows.length ? clearSelection() : selectAll()}
                    />
                  </th>
                  <th class="border-b border-[#e8eaed] px-4 py-3">Name</th>
                  <th class="border-b border-[#e8eaed] px-4 py-3">Owner</th>
                  <th class="border-b border-[#e8eaed] px-4 py-3">Last modified</th>
                  <th class="border-b border-[#e8eaed] px-4 py-3">File size</th>
                </tr>
              </thead>
              <tbody>
                {#if loadingDrive}
                  <tr><td class="px-4 py-6 text-[#5f6368]" colspan="5">Memuat data...</td></tr>
                {:else if filteredRows.length === 0}
                  <tr><td class="px-4 py-6 text-[#5f6368]" colspan="5">Tidak ada data.</td></tr>
                {:else}
                  {#each filteredRows as row, index}
                    <tr
                      data-row="1"
                      class={`cursor-default border-b border-[#f1f3f4] hover:bg-[#f8f9fa] ${isRowSelected(row) ? "bg-[#e8f0fe] hover:bg-[#dce8fd]" : ""}`}
                      on:click={(e) => handleRowClick(e, row, index)}
                      on:dblclick={() => (row.kind === "folder" ? openFolder(row.folder) : openFile(row.file))}
                      on:contextmenu={(event) => openMenu(event, row)}
                    >
                      <td class="px-3 py-3">
                        <input
                          type="checkbox"
                          class="cursor-pointer accent-[#1a73e8]"
                          checked={isRowSelected(row)}
                          on:click|stopPropagation={() => toggleCheckbox(row, index)}
                        />
                      </td>
                      <td class="px-4 py-3">
                        <div class="flex items-center gap-2">
                          <span class={row.kind === "folder" ? "text-[#f9ab00]" : "text-[#5f6368]"}>
                            <Icon name={row.kind === "folder" ? "folder" : "file"} size={14} />
                          </span>
                          <span>{row.name}</span>
                          {#if row.kind === "folder" && row.folder.isPublic}
                            <span class="rounded-full bg-[#e6f4ea] px-1.5 py-0.5 text-[10px] text-[#137333]">shared</span>
                          {/if}
                          {#if row.kind === "file" && row.file.isPublic}
                            <span class="rounded-full bg-[#e6f4ea] px-1.5 py-0.5 text-[10px] text-[#137333]">public</span>
                          {/if}
                        </div>
                      </td>
                      <td class="px-4 py-3 text-[#5f6368]">{publicMode ? "Public" : (user?.name ?? "-")}</td>
                      <td class="px-4 py-3 text-[#5f6368]">{formatDate(row.modifiedAt)}</td>
                      <td class="px-4 py-3 text-[#5f6368]">{row.sizeLabel}</td>
                    </tr>
                  {/each}
                {/if}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  </div>

  <!-- Mobile bottom navigation -->
  <nav class="fixed bottom-0 left-0 right-0 z-40 border-t border-[#e8eaed] bg-white md:hidden">
    <div class="flex items-stretch">
      <button
        class="flex flex-1 flex-col items-center gap-0.5 px-2 py-3 transition-colors {isAtRoot ? 'text-[#1a73e8]' : 'text-[#5f6368]'}"
        on:click={() => goToBreadcrumb(0)}
      >
        <Icon name="home" size={22} />
        <span class="text-[10px] font-medium">Home</span>
      </button>
      <button
        class="flex flex-1 flex-col items-center gap-0.5 px-2 py-3 text-[#5f6368] transition-colors disabled:text-[#bdc1c6]"
        disabled={!canEditCurrentView}
        on:click={promptCreateFolder}
      >
        <Icon name="plus" size={22} />
        <span class="text-[10px] font-medium">Buat Folder</span>
      </button>
      <button
        class="flex flex-1 flex-col items-center gap-0.5 px-2 py-3 text-[#5f6368] transition-colors disabled:text-[#bdc1c6]"
        disabled={!canEditCurrentView}
        on:click={() => uploadFileInput?.click()}
      >
        <Icon name="upload" size={22} />
        <span class="text-[10px] font-medium">Upload</span>
      </button>
      <button
        class="flex flex-1 flex-col items-center gap-0.5 px-2 py-3 text-[#5f6368] transition-colors disabled:text-[#bdc1c6]"
        disabled={!canEditCurrentView}
        on:click={() => uploadFolderInput?.click()}
      >
        <Icon name="uploadFolder" size={22} />
        <span class="text-[10px] font-medium">Folder</span>
      </button>
      {#if !publicMode}
        <button
          class="flex flex-1 flex-col items-center gap-0.5 px-2 py-3 text-[#5f6368] transition-colors"
          on:click={openProfile}
        >
          <div class="h-6 w-6 rounded-full bg-[#1a73e8] flex items-center justify-center text-[10px] font-semibold text-white">
            {initials(user?.name ?? "U")}
          </div>
          <span class="text-[10px] font-medium">Profil</span>
        </button>
      {/if}
    </div>
  </nav>

  <!-- Context menu -->
  {#if menu.open}
    <div
      class="fixed inset-0 z-50"
      role="button"
      tabindex="0"
      on:click={closeMenu}
      on:keydown={(event) => event.key === "Escape" && closeMenu()}
    >
      <div
        class="absolute w-56 rounded-xl border border-[#dadce0] bg-white py-1 shadow-[0_8px_24px_rgba(0,0,0,0.16)]"
        style={`left:${menu.x}px;top:${menu.y}px;`}
        role="menu"
        tabindex="-1"
        on:contextmenu|preventDefault
      >
        {#if menu.target === null}
          {#if canEditCurrentView}
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(promptCreateFile)}>
              <Icon name="file" size={14} /> Create file
            </button>
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(promptCreateFolder)}>
              <Icon name="folder" size={14} /> Create folder
            </button>
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => uploadFileInput?.click())}>
              <Icon name="upload" size={14} /> Upload file
            </button>
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => uploadFolderInput?.click())}>
              <Icon name="uploadFolder" size={14} /> Upload folder
            </button>
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4] disabled:text-[#9aa0a6]" disabled={!clipboardFile} on:click={() => runMenuAction(pasteClipboard)}>
              <Icon name="paste" size={14} /> Paste {clipboardAction ? `(${clipboardAction})` : ""}
            </button>
            <div class="my-1 border-t border-[#e8eaed]"></div>
          {/if}
          <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(refreshDrive)}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        {:else if folderMenuTarget}
          <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => openFolder(folderMenuTarget))}>
            <Icon name="open" size={14} /> Open
          </button>
          {#if !publicMode}
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => renameFolder(folderMenuTarget))}>
              <Icon name="rename" size={14} /> Rename
            </button>
            {#if folderMenuTarget.isPublic}
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => updateFolderPublicShare(folderMenuTarget, true, "VIEW"))}>
                <Icon name="share" size={14} /> Permission: VIEW
              </button>
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => updateFolderPublicShare(folderMenuTarget, true, "EDIT"))}>
                <Icon name="share" size={14} /> Permission: EDIT
              </button>
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => copyFolderPublicLink(folderMenuTarget))}>
                <Icon name="link" size={14} /> Copy folder link
              </button>
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => updateFolderPublicShare(folderMenuTarget, false))}>
                <Icon name="share" size={14} /> Unshare public
              </button>
            {:else}
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => updateFolderPublicShare(folderMenuTarget, true, "VIEW"))}>
                <Icon name="share" size={14} /> Share public (VIEW)
              </button>
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => updateFolderPublicShare(folderMenuTarget, true, "EDIT"))}>
                <Icon name="share" size={14} /> Share public (EDIT)
              </button>
            {/if}
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#b3261e] hover:bg-[#fce8e6]" on:click={() => runMenuAction(() => removeFolder(folderMenuTarget))}>
              <Icon name="delete" size={14} /> Delete
            </button>
          {:else if canEditCurrentView}
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => runMenuAction(() => renameFolder(folderMenuTarget))}>
              <Icon name="rename" size={14} /> Rename
            </button>
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#b3261e] hover:bg-[#fce8e6]" on:click={() => runMenuAction(() => removeFolder(folderMenuTarget))}>
              <Icon name="delete" size={14} /> Delete
            </button>
          {/if}
        {:else}
          <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => fileMenuTarget && runMenuAction(() => openFile(fileMenuTarget))}>
            <Icon name="open" size={14} /> Open
          </button>
          {#if publicMode}
            {#if canEditCurrentView}
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => fileMenuTarget && runMenuAction(() => renameFile(fileMenuTarget))}>
                <Icon name="rename" size={14} /> Rename
              </button>
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#b3261e] hover:bg-[#fce8e6]" on:click={() => fileMenuTarget && runMenuAction(() => removeFile(fileMenuTarget))}>
                <Icon name="delete" size={14} /> Delete
              </button>
            {/if}
          {:else}
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => fileMenuTarget && runMenuAction(() => renameFile(fileMenuTarget))}>
              <Icon name="rename" size={14} /> Rename
            </button>
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => fileMenuTarget && runMenuAction(() => copyToClipboard(fileMenuTarget))}>
              <Icon name="copy" size={14} /> Copy
            </button>
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => fileMenuTarget && runMenuAction(() => cutToClipboard(fileMenuTarget))}>
              <Icon name="cut" size={14} /> Cut
            </button>
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => fileMenuTarget && runMenuAction(() => togglePublic(fileMenuTarget))}>
              <Icon name="share" size={14} /> {fileMenuTarget?.isPublic ? "Unshare public" : "Share public"}
            </button>
            {#if fileMenuTarget?.isPublic && fileMenuTarget?.publicUrl}
              <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[#f1f3f4]" on:click={() => fileMenuTarget && runMenuAction(() => copyPublicLink(fileMenuTarget))}>
                <Icon name="link" size={14} /> Copy public link
              </button>
            {/if}
            <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#b3261e] hover:bg-[#fce8e6]" on:click={() => fileMenuTarget && runMenuAction(() => removeFile(fileMenuTarget))}>
              <Icon name="delete" size={14} /> Delete
            </button>
          {/if}
        {/if}
      </div>
    </div>
  {/if}

  <!-- Profile Modal -->
  {#if showProfile}
    <div
      class="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      on:click|self={closeProfile}
    >
      <div class="w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-hidden">
        <!-- Modal header -->
        <div class="flex items-center justify-between border-b border-[#e8eaed] px-6 py-4">
          <h2 class="text-base font-semibold text-[#202124]">Profil Saya</h2>
          <button class="rounded-full p-1 text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124] transition-colors" on:click={closeProfile}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="max-h-[80vh] overflow-y-auto px-6 py-5 space-y-5">
          <!-- Avatar & info -->
          <div class="flex items-center gap-4">
            <div class="h-14 w-14 shrink-0 rounded-full bg-[#1a73e8] flex items-center justify-center text-xl font-semibold text-white select-none">
              {initials(user?.name ?? "U")}
            </div>
            <div class="min-w-0">
              <p class="font-medium text-[#202124] truncate">{user?.name}</p>
              <p class="text-sm text-[#5f6368] truncate">{user?.email}</p>
              <span class="inline-block mt-0.5 rounded-full bg-[#e8f0fe] px-2 py-0.5 text-[11px] text-[#1967d2] capitalize">{user?.role?.toLowerCase() ?? "user"}</span>
            </div>
          </div>

          <!-- Storage usage -->
          {#if storageSummary && !publicMode}
            <div class="rounded-xl border border-[#e8eaed] bg-[#f8fafd] px-4 py-3">
              <p class="text-xs font-semibold text-[#3c4043] mb-2">Penggunaan Storage</p>
              <div class="flex items-end justify-between">
                <div>
                  <p class="text-lg font-semibold text-[#202124]">{storageSummary.totalGb.toFixed(3)} GB</p>
                  <p class="text-xs text-[#5f6368]">{storageSummary.fileCount} file tersimpan</p>
                </div>
                <p class="text-xs text-[#9aa0a6]">{formatSize(storageSummary.totalBytes)}</p>
              </div>
            </div>
          {/if}

          <!-- Feedback messages -->
          {#if profileError}<p class="rounded-lg bg-[#fce8e6] px-3 py-2 text-sm text-[#b3261e]">{profileError}</p>{/if}
          {#if profileSuccess}<p class="rounded-lg bg-[#e6f4ea] px-3 py-2 text-sm text-[#137333]">{profileSuccess}</p>{/if}

          <!-- Update name -->
          <form on:submit={handleProfileNameUpdate}>
            <p class="text-xs font-semibold text-[#5f6368] mb-1.5 uppercase tracking-wide">Username</p>
            <div class="flex gap-2">
              <input
                class="flex-1 h-10 rounded-lg border border-[#dadce0] px-3 text-sm focus:border-[#1a73e8] focus:outline-none"
                type="text"
                placeholder="Nama lengkap"
                bind:value={profileName}
                minlength="2"
                required
              />
              <button
                class="rounded-lg bg-[#1a73e8] px-4 py-2 text-sm font-medium text-white hover:bg-[#1557b0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                type="submit"
                disabled={profileSaving || !profileName.trim() || profileName.trim() === user?.name}
              >
                Simpan
              </button>
            </div>
          </form>

          <!-- Change password -->
          <form on:submit={handlePasswordChange}>
            <p class="text-xs font-semibold text-[#5f6368] mb-1.5 uppercase tracking-wide">Ganti Password</p>
            <div class="space-y-2">
              <input
                class="h-10 w-full rounded-lg border border-[#dadce0] px-3 text-sm focus:border-[#1a73e8] focus:outline-none"
                type="password"
                placeholder="Password lama"
                bind:value={profileOldPassword}
                required
              />
              <input
                class="h-10 w-full rounded-lg border border-[#dadce0] px-3 text-sm focus:border-[#1a73e8] focus:outline-none"
                type="password"
                placeholder="Password baru (min. 6 karakter)"
                bind:value={profileNewPassword}
                minlength="6"
                required
              />
              <input
                class="h-10 w-full rounded-lg border border-[#dadce0] px-3 text-sm focus:border-[#1a73e8] focus:outline-none"
                type="password"
                placeholder="Konfirmasi password baru"
                bind:value={profileConfirmPassword}
                minlength="6"
                required
              />
              <button
                class="w-full rounded-lg bg-[#1a73e8] py-2.5 text-sm font-medium text-white hover:bg-[#1557b0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                type="submit"
                disabled={profileSaving}
              >
                Ganti Password
              </button>
            </div>
          </form>

          <!-- Logout -->
          <div class="border-t border-[#e8eaed] pt-4">
            <button
              class="w-full flex items-center justify-center gap-2 rounded-lg border border-[#ea4335] py-2.5 text-sm font-medium text-[#ea4335] hover:bg-[#fce8e6] transition-colors"
              on:click={() => { closeProfile(); logout(); }}
            >
              <Icon name="logout" size={15} /> Keluar dari akun
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
{/if}
