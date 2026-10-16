const UPLOAD_STORAGE = "decupa.uploads.v1";

function savedUploads(storage) {
  try {
    const value = JSON.parse(storage.getItem(UPLOAD_STORAGE) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function saveUploads(storage, value) {
  try { storage.setItem(UPLOAD_STORAGE, JSON.stringify(value)); } catch { /* armazenamento indisponível */ }
}

export function uploadFingerprint(file) {
  return [file.name, file.size, file.lastModified || 0].join("\u0000");
}

/** Erro de HTTP com o status preservado: quem mostra a mensagem escolhe o texto pelo código. */
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export class UploadPausedError extends Error {
  constructor() {
    super("envio pausado");
    this.name = "UploadPausedError";
  }
}

/** Upload sequencial: uma parte em voo, estado persistido e retomável. */
export class ResumableMediaUpload {
  // O `fetch` do navegador não pode ser guardado e chamado como método de outro
  // objeto (`this.fetchImpl(...)`): no Chrome isso lança "Illegal invocation".
  constructor({ fetchImpl = (url, init) => fetch(url, init), storage = globalThis.localStorage, onProgress = () => {} } = {}) {
    this.fetchImpl = fetchImpl;
    this.storage = storage;
    this.onProgress = onProgress;
    this.paused = false;
    this.state = "parado";
    this.controller = null;
    this.uploadId = null;
    this.offset = 0;
    this.total = 0;
    this.partSize = 20 * 1024 * 1024;
  }

  readSaved(file) {
    return savedUploads(this.storage)[uploadFingerprint(file)] || null;
  }

  writeSaved(file, state) {
    const all = savedUploads(this.storage);
    all[uploadFingerprint(file)] = { ...state, nome: file.name, tamanho: file.size, ultimaModificacao: file.lastModified || 0 };
    saveUploads(this.storage, all);
  }

  forget(file) {
    const all = savedUploads(this.storage);
    delete all[uploadFingerprint(file)];
    saveUploads(this.storage, all);
  }

  pause() {
    this.paused = true;
    if (this.state !== "concluido") this.state = "pausado";
    this.controller?.abort();
  }

  async cancel(file) {
    this.pause();
    if (this.uploadId) await this.fetchImpl(`/api/uploads/${encodeURIComponent(this.uploadId)}`, { method: "DELETE" }).catch(() => {});
    this.forget(file);
    this.uploadId = null;
    this.state = "parado";
  }

  async start(file) {
    this.paused = false;
    this.state = "enviando";
    this.total = file.size;
    let saved = this.readSaved(file);
    let result;
    let transportState;
    try {
      if (saved?.id) {
        const stateResponse = await this.fetchImpl(`/api/uploads/${encodeURIComponent(saved.id)}`);
        if (stateResponse.ok) {
          const state = await stateResponse.json();
          transportState = state;
          if (state.mediaId) {
            this.state = "concluido";
            this.onProgress({ bytes: file.size, total: file.size, percent: 100, state: state.deduplicado ? "deduped" : "ready" });
            this.forget(file);
            return state;
          }
          this.uploadId = saved.id;
          this.offset = Math.min(Number(state.offset) || 0, file.size);
          this.partSize = Math.max(1, Number(state.tamanhoParte) || Number(saved.tamanhoParte) || this.partSize);
          this.writeSaved(file, { ...saved, id: this.uploadId, offset: this.offset, tamanhoParte: this.partSize });
        } else if (stateResponse.status === 404 || stateResponse.status === 410) {
          saved = null;
        } else {
          const body = await stateResponse.json().catch(() => ({}));
          throw httpError(stateResponse.status, body.error || `erro ${stateResponse.status}`);
        }
      }
      if (!saved) {
        const created = await this.fetchImpl("/api/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nome: file.name, tamanho: file.size }),
        });
        result = await created.json().catch(() => ({}));
        transportState = result;
        if (!created.ok) throw httpError(created.status, result.error || `erro ${created.status}`);
        if (result.mediaId) {
          this.onProgress({ bytes: file.size, total: file.size, percent: 100, state: result.deduplicado ? "deduped" : "ready" });
          this.state = "concluido";
          this.forget(file);
          return result;
        }
        this.uploadId = result.id;
        this.offset = Number(result.offset) || 0;
        this.partSize = Math.max(1, Number(result.tamanhoParte) || this.partSize);
        this.writeSaved(file, { id: this.uploadId, offset: this.offset, tamanhoParte: this.partSize });
      }
    } catch (error) {
      if (this.paused || error?.name === "AbortError") {
        this.state = "pausado";
        throw new UploadPausedError();
      }
      this.state = "parado";
      throw error;
    }

    if (transportState?.transporte === "r2") {
      try { return await this.startR2(file, transportState); }
      catch (error) {
        if (this.paused || error?.name === "AbortError") { this.state = "pausado"; throw new UploadPausedError(); }
        this.state = "parado";
        throw error;
      } finally { this.controller = null; }
    }

    const partSize = Math.max(1, Number(result?.tamanhoParte) || this.partSize);
    this.onProgress({ bytes: this.offset, total: file.size, percent: file.size ? this.offset / file.size * 100 : 100, state: "uploading" });
    while (this.offset < file.size) {
      if (this.paused) throw new UploadPausedError();
      const start = this.offset;
      const end = Math.min(file.size, start + partSize) - 1;
      this.controller = new AbortController();
      try {
        const response = await this.fetchImpl(`/api/uploads/${encodeURIComponent(this.uploadId)}`, {
          method: "PATCH",
          headers: { "Content-Range": `bytes ${start}-${end}/${file.size}` },
          body: file.slice(start, end + 1),
          signal: this.controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (response.status === 409) {
          this.offset = Number(body.offset) || 0;
          this.writeSaved(file, { id: this.uploadId, offset: this.offset, tamanhoParte: this.partSize });
          continue;
        }
        if (!response.ok) throw httpError(response.status, body.error || `erro ${response.status}`);
        this.offset = end + 1;
        this.writeSaved(file, { id: this.uploadId, offset: this.offset, tamanhoParte: this.partSize });
        this.onProgress({ bytes: this.offset, total: file.size, percent: file.size ? this.offset / file.size * 100 : 100, state: this.offset === file.size ? "verifying" : "uploading" });
        if (body.mediaId) {
          this.forget(file);
          this.state = "concluido";
          this.onProgress({ bytes: file.size, total: file.size, percent: 100, state: body.deduplicado ? "deduped" : "ready" });
          return body;
        }
      } catch (error) {
        if (this.paused || error?.name === "AbortError") {
          this.state = "pausado";
          throw new UploadPausedError();
        }
        this.state = "parado";
        this.writeSaved(file, { id: this.uploadId, offset: this.offset, tamanhoParte: this.partSize });
        throw error;
      } finally {
        this.controller = null;
      }
    }
    this.state = "parado";
    throw new Error("o servidor encerrou o envio sem mediaId");
  }

  async startR2(file, initial) {
    if (this.paused) throw new UploadPausedError();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const endpoint = `/api/uploads/${encodeURIComponent(this.uploadId)}`;
    const request = async (path, init = {}) => {
      const response = await this.fetchImpl(path, { ...init, signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw httpError(response.status, body.error || `erro ${response.status}`);
      return body;
    };
    let result = initial;
    if (initial.estado !== "importing") {
      // Uma importação que falhou já tem o objeto completo no R2. O retry
      // repete só a importação, sem mandar novamente o arquivo do usuário.
      if (initial.estado !== "failed") {
        while (this.offset < file.size) {
          const end = Math.min(file.size, this.offset + this.partSize);
          const signed = await request(`${endpoint}/parts`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ numero: Math.floor(this.offset / this.partSize) + 1 }),
          });
          if (signed.mediaId || signed.estado === "importing") { result = signed; break; }
          const response = await this.fetchImpl(signed.url, {
            method: "PUT", body: file.slice(this.offset, end), signal,
            credentials: "omit", referrerPolicy: "no-referrer",
            headers: { "content-type": "application/octet-stream" },
          });
          if (!response.ok) throw httpError(response.status, `falha ao enviar parte ao R2 (${response.status})`);
          this.offset = end;
          this.writeSaved(file, { id: this.uploadId, offset: this.offset, tamanhoParte: this.partSize });
          this.onProgress({ bytes: this.offset, total: file.size, percent: this.offset / file.size * 100, state: "uploading" });
        }
      }
      if (!result.mediaId && result.estado !== "importing") result = await request(`${endpoint}/complete`, { method: "POST" });
    }
    this.onProgress({ bytes: file.size, total: file.size, percent: 100, state: "importing" });
    while (!result.mediaId) {
      if (signal.aborted) throw new UploadPausedError();
      result = await request(endpoint);
      if (result.estado === "failed") throw httpError(result.status || 502, result.error || "a importação do R2 falhou");
      if (!result.mediaId) await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new UploadPausedError()); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    this.state = "concluido";
    this.forget(file);
    this.onProgress({ bytes: file.size, total: file.size, percent: 100, state: result.deduplicado ? "deduped" : "ready" });
    return result;
  }
}
