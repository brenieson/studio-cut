const state = {
  videoPath: null,
  videoName: "",
  sourceDuration: 0,
  clips: [],            // [{ id, sourceStart, sourceEnd }]
  selectedClipId: null,
  activeClipIndex: 0,
  activeTitleIndex: -1,
  activeSubIndex: -1,
  editedTime: 0,        // Current position on the *edited* timeline (seconds)
  titles: [],           // [{ start, end, text, xPct, yPct, scale }]
  subtitles: [],        // [{ sourceStart?, sourceEnd?, start, end, text, xPct, yPct, scale }]
  undoStack: [],
  pendingDraft: null,
};

let nextClipId = 1;
let dragState = null;       // Timeline edge drag: { clipId, edge, startX, origStart, origEnd, totalEditedDur }
let titleDragState = null;  // Title move/resize: { mode: 'move' | 'resize', index, startX, startY, origXPct, origYPct, origScale }
let subDragState = null;    // Caption move/resize: { mode: 'move' | 'resize', index, startX, startY, origXPct, origYPct, origScale }
let isScrubbing = false;
let pendingVideoSeek = null;
let seekLockUntil = 0;
let rafId = null;
let autosaveTimer = null;

const player = document.getElementById("video-player");
const videoStage = document.getElementById("video-stage");
const btnOpen = document.getElementById("btn-open");
const btnDrafts = document.getElementById("btn-drafts");
const btnSaveDraft = document.getElementById("btn-save-draft");
const btnUndo = document.getElementById("btn-undo");
const btnExport = document.getElementById("btn-export");
const draftsModal = document.getElementById("drafts-modal");
const btnCloseDrafts = document.getElementById("btn-close-drafts");
const draftsList = document.getElementById("drafts-list");
const btnPlay = document.getElementById("btn-play");
const btnSplit = document.getElementById("btn-split");
const btnDeleteClip = document.getElementById("btn-delete-clip");
const btnAutoSubs = document.getElementById("btn-auto-subs");
const whisperModelSelect = document.getElementById("whisper-model");
const timeReadout = document.getElementById("time-readout");
const statusMsg = document.getElementById("status-msg");
const overlayTitle = document.getElementById("overlay-title");
const overlayTitleText = document.getElementById("overlay-title-text");
const titleResizeHandle = document.getElementById("title-resize-handle");
const overlaySub = document.getElementById("overlay-subtitle");
const overlaySubText = document.getElementById("overlay-subtitle-text");
const subResizeHandle = document.getElementById("sub-resize-handle");
const playhead = document.getElementById("playhead");
const timelineTrack = document.getElementById("timeline-track");
const timelineClips = document.getElementById("timeline-clips");

function fmtTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setStatus(msg) {
  statusMsg.textContent = msg;
}

function normalizeTitle(title) {
  return {
    ...title,
    xPct: typeof title.xPct === "number" ? title.xPct : 50,
    yPct: typeof title.yPct === "number" ? title.yPct : 12,
    scale: typeof title.scale === "number" ? title.scale : 1.0,
  };
}

function normalizeSubtitle(sub) {
  return {
    ...sub,
    xPct: typeof sub.xPct === "number" ? sub.xPct : 50,
    yPct: typeof sub.yPct === "number" ? sub.yPct : 90,
    scale: typeof sub.scale === "number" ? sub.scale : 1.0,
  };
}

function buildDraftPayload() {
  return {
    videoPath: state.videoPath,
    videoName: state.videoName,
    savedAt: new Date().toLocaleString(),
    editedTime: Number(state.editedTime.toFixed(2)),
    clips: state.clips,
    titles: state.titles,
    subtitles: state.subtitles,
  };
}

async function persistDraftNow(announce = false) {
  if (!state.videoPath || !state.clips.length || !window.pywebview?.api?.save_draft) return;
  const res = await window.pywebview.api.save_draft(buildDraftPayload());
  if (announce) {
    if (res.ok) {
      setStatus(`Draft saved (${new Date().toLocaleTimeString()}).`);
    } else {
      setStatus(`Could not save draft: ${res.error}`);
    }
  }
}

function scheduleAutosave() {
  if (!state.videoPath || !state.clips.length) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    persistDraftNow(false);
  }, 500);
}

btnSaveDraft.addEventListener("click", () => {
  persistDraftNow(true);
});

window.addEventListener("beforeunload", () => {
  if (state.videoPath && state.clips.length && window.pywebview?.api?.save_draft) {
    window.pywebview.api.save_draft(buildDraftPayload());
  }
});

// Saved Drafts Modal
btnDrafts.addEventListener("click", async () => {
  const res = await window.pywebview.api.list_drafts();
  draftsList.innerHTML = "";
  if (!res.ok || !res.drafts.length) {
    draftsList.innerHTML = `<li class="item-card"><span class="item-meta">No saved drafts yet.</span></li>`;
  } else {
    res.drafts.forEach((d, i) => {
      const li = document.createElement("li");
      li.className = "item-card";
      const missingTag = d.videoExists ? "" : `<span style="color:#f43f5e;"> (source video missing)</span>`;
      li.innerHTML = `
        <div style="flex: 1; display: flex; flex-direction: column; gap: 3px;">
          <div><strong>${escapeHtml(d.videoName)}</strong>${missingTag}</div>
          <div class="item-meta">Saved: ${escapeHtml(d.savedAt || "Unknown")} • Playhead: ${fmtTime(d.editedTime)} • ${d.clipCount} clip(s), ${d.titleCount} title(s), ${d.subtitleCount} caption(s)</div>
        </div>
        <button class="btn btn-small btn-primary" ${d.videoExists ? "" : "disabled"} onclick="openDraftByIndex(${i})">Resume</button>
      `;
      draftsList.appendChild(li);
    });
    window._listedDrafts = res.drafts;
  }
  draftsModal.classList.remove("hidden");
});

btnCloseDrafts.addEventListener("click", () => {
  draftsModal.classList.add("hidden");
});

window.openDraftByIndex = async (idx) => {
  const entry = window._listedDrafts?.[idx];
  if (!entry || !entry.videoPath) return;
  draftsModal.classList.add("hidden");
  await loadVideoWithOptionalDraft(entry.videoPath, entry.videoName);
};

async function loadVideoWithOptionalDraft(videoPath, videoName) {
  stopPlaybackLoop();
  state.videoPath = videoPath;
  state.videoName = videoName || videoPath.split(/[\\/]/).pop();
  state.clips = [];
  state.titles = [];
  state.subtitles = [];
  state.undoStack = [];
  state.editedTime = 0;
  state.activeClipIndex = 0;
  state.activeTitleIndex = -1;
  state.activeSubIndex = -1;
  state.pendingDraft = null;
  btnUndo.disabled = true;

  const draftRes = await window.pywebview.api.load_draft_for_video(videoPath);
  if (draftRes.ok && draftRes.draft) {
    state.pendingDraft = draftRes.draft;
  }

  const fileUri = "file:///" + videoPath.replaceAll("\\", "/").replace(/^\/+/, "");
  player.src = fileUri;
  btnPlay.disabled = false;
  btnSplit.disabled = false;
  btnDeleteClip.disabled = false;
  btnAutoSubs.disabled = false;
  btnSaveDraft.disabled = false;
  btnExport.disabled = false;
  setStatus(state.pendingDraft ? `Loaded ${state.videoName} — restoring saved draft...` : `Loaded ${state.videoName}`);
}

function getEditedDuration() {
  return state.clips.reduce((sum, c) => sum + Math.max(0.05, c.sourceEnd - c.sourceStart), 0);
}

function getClipStartOnEditedTimeline(index) {
  let sum = 0;
  for (let i = 0; i < index && i < state.clips.length; i++) {
    sum += Math.max(0.05, state.clips[i].sourceEnd - state.clips[i].sourceStart);
  }
  return sum;
}

function mapSourceRangeToEdited(srcStart, srcEnd) {
  let cursor = 0;
  let mappedStart = null;
  let mappedEnd = null;

  for (const clip of state.clips) {
    const dur = Math.max(0.05, clip.sourceEnd - clip.sourceStart);
    const overlapStart = Math.max(srcStart, clip.sourceStart);
    const overlapEnd = Math.min(srcEnd, clip.sourceEnd);

    if (overlapEnd > overlapStart) {
      const startInEdited = cursor + (overlapStart - clip.sourceStart);
      const endInEdited = cursor + (overlapEnd - clip.sourceStart);
      if (mappedStart === null || startInEdited < mappedStart) {
        mappedStart = startInEdited;
      }
      if (mappedEnd === null || endInEdited > mappedEnd) {
        mappedEnd = endInEdited;
      }
    }
    cursor += dur;
  }

  if (mappedStart === null || mappedEnd === null || mappedEnd <= mappedStart) {
    return null;
  }
  return { start: Number(mappedStart.toFixed(2)), end: Number(mappedEnd.toFixed(2)) };
}

function remapAutoCaptionsToEditedTimeline() {
  const updated = [];
  for (const rawSub of state.subtitles) {
    const sub = normalizeSubtitle(rawSub);
    if (typeof sub.sourceStart === "number" && typeof sub.sourceEnd === "number") {
      const mapped = mapSourceRangeToEdited(sub.sourceStart, sub.sourceEnd);
      if (mapped) {
        updated.push({ ...sub, start: mapped.start, end: mapped.end });
      }
    } else {
      updated.push(sub);
    }
  }
  state.subtitles = updated;
}

function saveUndoSnapshot() {
  state.undoStack.push(
    JSON.stringify({
      clips: state.clips,
      titles: state.titles,
      subtitles: state.subtitles,
    })
  );
  if (state.undoStack.length > 30) state.undoStack.shift();
  btnUndo.disabled = state.undoStack.length === 0;
}

btnUndo.addEventListener("click", () => {
  if (!state.undoStack.length) return;
  const snap = JSON.parse(state.undoStack.pop());
  state.clips = snap.clips;
  state.titles = (snap.titles || []).map(normalizeTitle);
  state.subtitles = (snap.subtitles || []).map(normalizeSubtitle);
  state.activeClipIndex = Math.min(state.activeClipIndex, Math.max(0, state.clips.length - 1));
  state.selectedClipId = state.clips[state.activeClipIndex]?.id ?? null;
  const total = getEditedDuration();
  state.editedTime = Math.min(state.editedTime, total);
  btnUndo.disabled = state.undoStack.length === 0;
  seekVideoToEditedTime(state.editedTime, true);
  renderAll();
  scheduleAutosave();
  setStatus("Undid last change.");
});

function mapEditedTimeToSource(t) {
  if (!state.clips.length) return null;
  let cursor = 0;
  for (let i = 0; i < state.clips.length; i++) {
    const c = state.clips[i];
    const dur = Math.max(0.05, c.sourceEnd - c.sourceStart);
    if (t < cursor + dur || i === state.clips.length - 1) {
      const offset = Math.min(dur, Math.max(0, t - cursor));
      return { clip: c, clipIndex: i, sourceTime: c.sourceStart + offset };
    }
    cursor += dur;
  }
  return null;
}

function flushPendingSeek() {
  if (pendingVideoSeek === null) return;
  const target = pendingVideoSeek;
  pendingVideoSeek = null;
  seekLockUntil = performance.now() + 140;
  try {
    if (typeof player.fastSeek === "function" && isScrubbing) {
      player.fastSeek(target);
    } else {
      player.currentTime = target;
    }
  } catch (_) {
    player.currentTime = target;
  }
}

function seekVideoToEditedTime(t, immediate = false) {
  const total = getEditedDuration();
  const clamped = Math.min(Math.max(0, t), total);
  state.editedTime = clamped;
  const mapped = mapEditedTimeToSource(clamped);
  if (!mapped) return;

  state.activeClipIndex = mapped.clipIndex;
  state.selectedClipId = mapped.clip.id;
  pendingVideoSeek = mapped.sourceTime;
  if (immediate) {
    flushPendingSeek();
  }
  updateOverlaysAndPlayhead();
}

// Inline Text Editing on Section Title Overlay
overlayTitleText.addEventListener("focus", () => {
  if (!player.paused) player.pause();
  if (state.activeTitleIndex !== -1) {
    saveUndoSnapshot();
    setStatus("Editing section title directly on video...");
  }
});

overlayTitleText.addEventListener("input", () => {
  const idx = state.activeTitleIndex;
  if (idx === -1 || !state.titles[idx]) return;
  state.titles[idx].text = overlayTitleText.textContent;
  renderLists();
  scheduleAutosave();
});

overlayTitleText.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    overlayTitleText.blur();
  }
});

overlayTitleText.addEventListener("blur", () => {
  const idx = state.activeTitleIndex;
  if (idx !== -1 && state.titles[idx]) {
    state.titles[idx].text = state.titles[idx].text.trim();
  }
  renderLists();
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
  setStatus("Updated section title (saved).");
});

// Drag Section Title to Move Anywhere on Video
overlayTitle.addEventListener("mousedown", (e) => {
  if (e.target === titleResizeHandle) return;
  if (document.activeElement === overlayTitleText) return;
  const idx = state.activeTitleIndex;
  if (idx === -1 || !state.titles[idx]) return;

  if (!player.paused) player.pause();
  saveUndoSnapshot();
  const title = normalizeTitle(state.titles[idx]);
  state.titles[idx] = title;

  titleDragState = {
    mode: "move",
    index: idx,
    startX: e.clientX,
    startY: e.clientY,
    origXPct: title.xPct,
    origYPct: title.yPct,
    origScale: title.scale,
  };
  overlayTitle.classList.add("dragging");
  setStatus("Dragging section title position...");
});

// Drag Corner Handle to Enlarge / Shrink Section Title
titleResizeHandle.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  const idx = state.activeTitleIndex;
  if (idx === -1 || !state.titles[idx]) return;

  if (!player.paused) player.pause();
  saveUndoSnapshot();
  const title = normalizeTitle(state.titles[idx]);
  state.titles[idx] = title;

  titleDragState = {
    mode: "resize",
    index: idx,
    startX: e.clientX,
    startY: e.clientY,
    origXPct: title.xPct,
    origYPct: title.yPct,
    origScale: title.scale,
  };
  overlayTitle.classList.add("dragging");
  setStatus("Resizing section title...");
});

// Inline Text Editing on Caption Overlay
overlaySubText.addEventListener("focus", () => {
  if (!player.paused) player.pause();
  if (state.activeSubIndex !== -1) {
    saveUndoSnapshot();
    setStatus("Editing caption text directly on video...");
  }
});

overlaySubText.addEventListener("input", () => {
  const idx = state.activeSubIndex;
  if (idx === -1 || !state.subtitles[idx]) return;
  state.subtitles[idx].text = overlaySubText.textContent;
  renderLists();
  scheduleAutosave();
});

overlaySubText.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    overlaySubText.blur();
  }
});

overlaySubText.addEventListener("blur", () => {
  const idx = state.activeSubIndex;
  if (idx !== -1 && state.subtitles[idx]) {
    state.subtitles[idx].text = state.subtitles[idx].text.trim();
  }
  renderLists();
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
  setStatus("Updated caption (saved).");
});

// Drag Caption to Move Anywhere on Video
overlaySub.addEventListener("mousedown", (e) => {
  if (e.target === subResizeHandle) return;
  if (document.activeElement === overlaySubText) return;
  const idx = state.activeSubIndex;
  if (idx === -1 || !state.subtitles[idx]) return;

  if (!player.paused) player.pause();
  saveUndoSnapshot();
  const sub = normalizeSubtitle(state.subtitles[idx]);
  state.subtitles[idx] = sub;

  subDragState = {
    mode: "move",
    index: idx,
    startX: e.clientX,
    startY: e.clientY,
    origXPct: sub.xPct,
    origYPct: sub.yPct,
    origScale: sub.scale,
  };
  overlaySub.classList.add("dragging");
  setStatus("Dragging caption position...");
});

// Drag Corner Handle to Enlarge / Shrink Caption
subResizeHandle.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  const idx = state.activeSubIndex;
  if (idx === -1 || !state.subtitles[idx]) return;

  if (!player.paused) player.pause();
  saveUndoSnapshot();
  const sub = normalizeSubtitle(state.subtitles[idx]);
  state.subtitles[idx] = sub;

  subDragState = {
    mode: "resize",
    index: idx,
    startX: e.clientX,
    startY: e.clientY,
    origXPct: sub.xPct,
    origYPct: sub.yPct,
    origScale: sub.scale,
  };
  overlaySub.classList.add("dragging");
  setStatus("Resizing caption...");
});

// Tabs
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

// Open Video
btnOpen.addEventListener("click", async () => {
  if (state.videoPath && state.clips.length) {
    await persistDraftNow(false);
  }
  const info = await window.pywebview.api.pick_video();
  if (!info) return;
  await loadVideoWithOptionalDraft(info.path, info.name);
});

player.addEventListener("loadedmetadata", () => {
  state.sourceDuration = player.duration || 0;

  if (state.pendingDraft) {
    const d = state.pendingDraft;
    state.pendingDraft = null;
    const restoredClips = Array.isArray(d.clips) && d.clips.length
      ? d.clips.map((c) => {
          const id = nextClipId++;
          return {
            id,
            sourceStart: Math.max(0, Number(c.sourceStart) || 0),
            sourceEnd: Math.min(state.sourceDuration || Infinity, Number(c.sourceEnd) || state.sourceDuration),
          };
        })
      : [{ id: nextClipId++, sourceStart: 0, sourceEnd: state.sourceDuration }];

    state.clips = restoredClips;
    state.selectedClipId = state.clips[0].id;
    state.activeClipIndex = 0;
    state.titles = (d.titles || []).map(normalizeTitle);
    state.subtitles = (d.subtitles || []).map(normalizeSubtitle);
    renderAll();
    seekVideoToEditedTime(Number(d.editedTime) || 0, true);
    setStatus(`Restored draft for ${state.videoName} (saved ${d.savedAt || "earlier"}).`);
    return;
  }

  if (state.clips.length === 0 && state.sourceDuration > 0) {
    const id = nextClipId++;
    state.clips = [{ id, sourceStart: 0, sourceEnd: state.sourceDuration }];
    state.selectedClipId = id;
    state.activeClipIndex = 0;
  }
  renderAll();
  seekVideoToEditedTime(0, true);
  persistDraftNow(false);
});

player.addEventListener("seeked", () => {
  updateOverlaysAndPlayhead();
});

function playbackTick() {
  if (!isScrubbing && !titleDragState && !subDragState && !player.paused && !player.ended && state.clips.length > 0) {
    flushPendingSeek();
    const now = performance.now();
    if (now >= seekLockUntil) {
      let idx = Math.min(state.activeClipIndex, state.clips.length - 1);
      let clip = state.clips[idx];
      const curSrc = player.currentTime;

      if (curSrc >= clip.sourceEnd - 0.03) {
        if (idx + 1 < state.clips.length) {
          idx += 1;
          clip = state.clips[idx];
          state.activeClipIndex = idx;
          state.selectedClipId = clip.id;
          seekLockUntil = performance.now() + 180;
          player.currentTime = clip.sourceStart;
          renderTimeline();
        } else {
          player.pause();
          state.editedTime = getEditedDuration();
          updateOverlaysAndPlayhead();
          stopPlaybackLoop();
          return;
        }
      }

      const clampedSrc = Math.min(clip.sourceEnd, Math.max(clip.sourceStart, player.currentTime));
      state.editedTime = getClipStartOnEditedTimeline(idx) + (clampedSrc - clip.sourceStart);
      updateOverlaysAndPlayhead();
    }
  }

  if (!player.paused) {
    rafId = requestAnimationFrame(playbackTick);
  }
}

function startPlaybackLoop() {
  stopPlaybackLoop();
  rafId = requestAnimationFrame(playbackTick);
}

function stopPlaybackLoop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

btnPlay.addEventListener("click", () => {
  if (!state.clips.length) return;
  if (player.paused) {
    if (state.editedTime >= getEditedDuration() - 0.05) {
      seekVideoToEditedTime(0, true);
    } else {
      seekVideoToEditedTime(state.editedTime, true);
    }
    player.play();
  } else {
    player.pause();
    persistDraftNow(false);
  }
});

player.addEventListener("play", () => {
  btnPlay.textContent = "Pause";
  startPlaybackLoop();
});

player.addEventListener("pause", () => {
  btnPlay.textContent = "Play";
  flushPendingSeek();
  stopPlaybackLoop();
});

// Split clip at playhead
btnSplit.addEventListener("click", () => {
  const mapped = mapEditedTimeToSource(state.editedTime);
  if (!mapped) return;
  const { clip, clipIndex, sourceTime } = mapped;
  const minPiece = 0.25;
  if (sourceTime - clip.sourceStart < minPiece || clip.sourceEnd - sourceTime < minPiece) {
    setStatus("Move the playhead further from the clip edge to split.");
    return;
  }

  saveUndoSnapshot();
  const rightId = nextClipId++;
  const leftClip = { ...clip, sourceEnd: sourceTime };
  const rightClip = { id: rightId, sourceStart: sourceTime, sourceEnd: clip.sourceEnd };

  state.clips.splice(clipIndex, 1, leftClip, rightClip);
  state.selectedClipId = rightId;
  state.activeClipIndex = clipIndex + 1;
  remapAutoCaptionsToEditedTimeline();
  renderAll();
  persistDraftNow(false);
  setStatus(`Split clip at ${fmtTime(state.editedTime)} (saved).`);
});

// Delete selected clip
btnDeleteClip.addEventListener("click", () => {
  if (!state.selectedClipId) return;
  if (state.clips.length <= 1) {
    setStatus("Cannot delete the last remaining clip.");
    return;
  }
  saveUndoSnapshot();
  const idx = state.clips.findIndex((c) => c.id === state.selectedClipId);
  if (idx === -1) return;
  state.clips.splice(idx, 1);
  const nextIdx = Math.min(idx, state.clips.length - 1);
  state.activeClipIndex = nextIdx;
  state.selectedClipId = state.clips[nextIdx].id;
  remapAutoCaptionsToEditedTimeline();
  const total = getEditedDuration();
  seekVideoToEditedTime(Math.min(state.editedTime, total), true);
  renderAll();
  persistDraftNow(false);
  setStatus("Removed selected clip (saved).");
});

// Add Section Title at Playhead
document.getElementById("btn-add-title").addEventListener("click", () => {
  const text = document.getElementById("title-text").value.trim();
  const dur = Math.max(0.5, parseFloat(document.getElementById("title-dur").value) || 4);
  if (!text) return;
  saveUndoSnapshot();
  state.titles.push({
    start: Number(state.editedTime.toFixed(2)),
    end: Number((state.editedTime + dur).toFixed(2)),
    text,
    xPct: 50,
    yPct: 12,
    scale: 1.0,
  });
  document.getElementById("title-text").value = "";
  renderLists();
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
  setStatus("Added section title on video (saved).");
});

// Add Subtitle at Playhead
document.getElementById("btn-add-sub").addEventListener("click", () => {
  const text = document.getElementById("sub-text").value.trim();
  const dur = Math.max(0.5, parseFloat(document.getElementById("sub-dur").value) || 3);
  if (!text) return;
  saveUndoSnapshot();
  state.subtitles.push({
    start: Number(state.editedTime.toFixed(2)),
    end: Number((state.editedTime + dur).toFixed(2)),
    text,
    xPct: 50,
    yPct: 90,
    scale: 1.0,
  });
  document.getElementById("sub-text").value = "";
  renderLists();
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
  setStatus("Added caption on video (saved).");
});

// Auto-generate speech-to-text captions
btnAutoSubs.addEventListener("click", async () => {
  if (!state.videoPath) return;
  saveUndoSnapshot();
  btnAutoSubs.disabled = true;
  const modelSize = whisperModelSelect.value;
  setStatus(`Transcribing audio (${modelSize})... this may take a few minutes on long videos.`);

  const res = await window.pywebview.api.transcribe_video(state.videoPath, modelSize);
  btnAutoSubs.disabled = false;

  if (!res.ok) {
    setStatus(`Transcription error: ${res.error}`);
    return;
  }

  state.subtitles = (res.captions || []).map(normalizeSubtitle);
  remapAutoCaptionsToEditedTimeline();
  renderLists();
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
  setStatus(`Generated ${state.subtitles.length} captions (saved).`);
});

function renderLists() {
  const tList = document.getElementById("titles-list");
  tList.innerHTML = "";
  state.titles.forEach((rawTitle, i) => {
    const t = normalizeTitle(rawTitle);
    state.titles[i] = t;
    const li = document.createElement("li");
    li.className = "item-card";
    li.innerHTML = `
      <div style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
        <div class="item-meta" style="cursor: pointer;" onclick="jumpToTitle(${i})">${fmtTime(t.start)} – ${fmtTime(t.end)} (click to jump)</div>
        <input type="text" value="${escapeHtml(t.text)}" onchange="updateTitleText(${i}, this.value)" />
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 11px; color: #9ca3af;">
          <label>Start (s): <input type="number" step="0.1" min="0" value="${t.start}" onchange="updateTitleTiming(${i}, 'start', this.value)" /></label>
          <label>End (s): <input type="number" step="0.1" min="0" value="${t.end}" onchange="updateTitleTiming(${i}, 'end', this.value)" /></label>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; font-size: 11px; color: #cbd5e1;">
          <span style="white-space: nowrap;">Size (${t.scale.toFixed(1)}x):</span>
          <input type="range" min="0.5" max="2.5" step="0.1" value="${t.scale}" oninput="updateTitleScale(${i}, this.value)" />
          <button class="btn btn-secondary" style="padding: 3px 7px; font-size: 11px;" onclick="resetTitlePlacement(${i})">Reset</button>
        </div>
      </div>
      <button class="btn btn-danger" onclick="deleteTitle(${i})">Delete</button>
    `;
    tList.appendChild(li);
  });

  const sList = document.getElementById("subs-list");
  sList.innerHTML = "";
  state.subtitles.forEach((rawSub, i) => {
    const s = normalizeSubtitle(rawSub);
    state.subtitles[i] = s;
    const li = document.createElement("li");
    li.className = "item-card";
    li.innerHTML = `
      <div style="flex: 1; display: flex; flex-direction: column; gap: 6px;">
        <div class="item-meta" style="cursor: pointer;" onclick="jumpToSubtitle(${i})">${fmtTime(s.start)} – ${fmtTime(s.end)} (click to jump)</div>
        <input type="text" value="${escapeHtml(s.text)}" onchange="updateSubText(${i}, this.value)" />
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 11px; color: #9ca3af;">
          <label>Start (s): <input type="number" step="0.1" min="0" value="${s.start}" onchange="updateSubTiming(${i}, 'start', this.value)" /></label>
          <label>End (s): <input type="number" step="0.1" min="0" value="${s.end}" onchange="updateSubTiming(${i}, 'end', this.value)" /></label>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; font-size: 11px; color: #cbd5e1;">
          <span style="white-space: nowrap;">Size (${s.scale.toFixed(1)}x):</span>
          <input type="range" min="0.5" max="2.5" step="0.1" value="${s.scale}" oninput="updateSubScale(${i}, this.value)" />
          <button class="btn btn-secondary" style="padding: 3px 7px; font-size: 11px;" onclick="resetSubPlacement(${i})">Reset</button>
        </div>
      </div>
      <button class="btn btn-danger" onclick="deleteSub(${i})">Delete</button>
    `;
    sList.appendChild(li);
  });
}

window.deleteTitle = (i) => {
  saveUndoSnapshot();
  state.titles.splice(i, 1);
  renderLists();
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
};

window.updateTitleText = (i, newText) => {
  if (!state.titles[i]) return;
  saveUndoSnapshot();
  state.titles[i].text = newText;
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
};

window.updateTitleTiming = (i, field, val) => {
  const item = state.titles[i];
  if (!item) return;
  const num = Math.max(0, parseFloat(val) || 0);
  saveUndoSnapshot();
  item[field] = Number(num.toFixed(2));
  if (item.end <= item.start) {
    item.end = Number((item.start + 0.5).toFixed(2));
  }
  renderLists();
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
};

window.updateTitleScale = (i, val) => {
  const item = state.titles[i];
  if (!item) return;
  const nextScale = Math.min(2.5, Math.max(0.5, parseFloat(val) || 1.0));
  item.scale = Number(nextScale.toFixed(2));
  updateOverlaysAndPlayhead();
  renderLists();
  scheduleAutosave();
};

window.resetTitlePlacement = (i) => {
  const item = state.titles[i];
  if (!item) return;
  saveUndoSnapshot();
  item.xPct = 50;
  item.yPct = 12;
  item.scale = 1.0;
  updateOverlaysAndPlayhead();
  renderLists();
  persistDraftNow(false);
  setStatus("Reset section title position and size (saved).");
};

window.jumpToTitle = (i) => {
  const item = state.titles[i];
  if (!item) return;
  seekVideoToEditedTime(item.start + 0.05, true);
};

window.deleteSub = (i) => {
  saveUndoSnapshot();
  state.subtitles.splice(i, 1);
  renderLists();
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
};

window.updateSubText = (i, newText) => {
  if (!state.subtitles[i]) return;
  saveUndoSnapshot();
  state.subtitles[i].text = newText;
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
};

window.updateSubTiming = (i, field, val) => {
  const item = state.subtitles[i];
  if (!item) return;
  const num = Math.max(0, parseFloat(val) || 0);
  saveUndoSnapshot();
  delete item.sourceStart;
  delete item.sourceEnd;
  item[field] = Number(num.toFixed(2));
  if (item.end <= item.start) {
    item.end = Number((item.start + 0.5).toFixed(2));
  }
  renderLists();
  updateOverlaysAndPlayhead();
  persistDraftNow(false);
};

window.updateSubScale = (i, val) => {
  const item = state.subtitles[i];
  if (!item) return;
  const nextScale = Math.min(2.5, Math.max(0.5, parseFloat(val) || 1.0));
  item.scale = Number(nextScale.toFixed(2));
  updateOverlaysAndPlayhead();
  renderLists();
  scheduleAutosave();
};

window.resetSubPlacement = (i) => {
  const item = state.subtitles[i];
  if (!item) return;
  saveUndoSnapshot();
  item.xPct = 50;
  item.yPct = 90;
  item.scale = 1.0;
  updateOverlaysAndPlayhead();
  renderLists();
  persistDraftNow(false);
  setStatus("Reset caption position and size (saved).");
};

window.jumpToSubtitle = (i) => {
  const sub = state.subtitles[i];
  if (!sub) return;
  seekVideoToEditedTime(sub.start + 0.05, true);
};

// Render timeline clips with independent left/right trim handles
function renderTimeline() {
  timelineClips.innerHTML = "";
  const totalDur = getEditedDuration();
  if (!totalDur) return;

  let cursor = 0;
  state.clips.forEach((clip, idx) => {
    const dur = Math.max(0.05, clip.sourceEnd - clip.sourceStart);
    const leftPct = (cursor / totalDur) * 100;
    const widthPct = (dur / totalDur) * 100;

    const block = document.createElement("div");
    block.className = `clip-block ${clip.id === state.selectedClipId ? "selected" : ""}`;
    block.style.left = `${leftPct}%`;
    block.style.width = `${widthPct}%`;

    const leftHandle = document.createElement("div");
    leftHandle.className = "trim-handle left";
    leftHandle.title = "Drag to extend into earlier video or trim start";

    const rightHandle = document.createElement("div");
    rightHandle.className = "trim-handle right";
    rightHandle.title = "Drag to extend into later video or trim end";

    const label = document.createElement("span");
    label.className = "clip-label";
    label.textContent = `Clip ${idx + 1} (${fmtTime(clip.sourceStart)}–${fmtTime(clip.sourceEnd)})`;

    block.addEventListener("mousedown", (e) => {
      if (e.target === leftHandle || e.target === rightHandle) return;
      state.selectedClipId = clip.id;
      state.activeClipIndex = idx;
      renderTimeline();
    });

    leftHandle.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      saveUndoSnapshot();
      state.selectedClipId = clip.id;
      state.activeClipIndex = idx;
      dragState = {
        clipId: clip.id,
        edge: "left",
        startX: e.clientX,
        origStart: clip.sourceStart,
        origEnd: clip.sourceEnd,
        totalEditedDur: totalDur,
      };
      leftHandle.classList.add("active");
    });

    rightHandle.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      saveUndoSnapshot();
      state.selectedClipId = clip.id;
      state.activeClipIndex = idx;
      dragState = {
        clipId: clip.id,
        edge: "right",
        startX: e.clientX,
        origStart: clip.sourceStart,
        origEnd: clip.sourceEnd,
        totalEditedDur: totalDur,
      };
      rightHandle.classList.add("active");
    });

    block.appendChild(leftHandle);
    block.appendChild(label);
    block.appendChild(rightHandle);
    timelineClips.appendChild(block);

    cursor += dur;
  });
}

window.addEventListener("mousemove", (e) => {
  if (titleDragState) {
    const title = state.titles[titleDragState.index];
    if (!title) return;
    const stageRect = videoStage.getBoundingClientRect();

    if (titleDragState.mode === "move") {
      const dxPct = ((e.clientX - titleDragState.startX) / Math.max(1, stageRect.width)) * 100;
      const dyPct = ((e.clientY - titleDragState.startY) / Math.max(1, stageRect.height)) * 100;
      title.xPct = Number(Math.min(92, Math.max(8, titleDragState.origXPct + dxPct)).toFixed(1));
      title.yPct = Number(Math.min(94, Math.max(6, titleDragState.origYPct + dyPct)).toFixed(1));
      updateOverlaysAndPlayhead();
      scheduleAutosave();
    } else if (titleDragState.mode === "resize") {
      const deltaPx = (e.clientX - titleDragState.startX) + (e.clientY - titleDragState.startY);
      const nextScale = Math.min(2.5, Math.max(0.5, titleDragState.origScale + deltaPx / 120));
      title.scale = Number(nextScale.toFixed(2));
      updateOverlaysAndPlayhead();
      renderLists();
      scheduleAutosave();
    }
    return;
  }

  if (subDragState) {
    const sub = state.subtitles[subDragState.index];
    if (!sub) return;
    const stageRect = videoStage.getBoundingClientRect();

    if (subDragState.mode === "move") {
      const dxPct = ((e.clientX - subDragState.startX) / Math.max(1, stageRect.width)) * 100;
      const dyPct = ((e.clientY - subDragState.startY) / Math.max(1, stageRect.height)) * 100;
      sub.xPct = Number(Math.min(92, Math.max(8, subDragState.origXPct + dxPct)).toFixed(1));
      sub.yPct = Number(Math.min(94, Math.max(6, subDragState.origYPct + dyPct)).toFixed(1));
      updateOverlaysAndPlayhead();
      scheduleAutosave();
    } else if (subDragState.mode === "resize") {
      const deltaPx = (e.clientX - subDragState.startX) + (e.clientY - subDragState.startY);
      const nextScale = Math.min(2.5, Math.max(0.5, subDragState.origScale + deltaPx / 120));
      sub.scale = Number(nextScale.toFixed(2));
      updateOverlaysAndPlayhead();
      renderLists();
      scheduleAutosave();
    }
    return;
  }

  if (dragState) {
    const trackRect = timelineTrack.getBoundingClientRect();
    const deltaPx = e.clientX - dragState.startX;
    const deltaSec = (deltaPx / Math.max(1, trackRect.width)) * dragState.totalEditedDur;

    const clip = state.clips.find((c) => c.id === dragState.clipId);
    if (!clip) return;
    const minClipLen = 0.25;

    if (dragState.edge === "left") {
      clip.sourceStart = Math.min(
        clip.sourceEnd - minClipLen,
        Math.max(0, dragState.origStart + deltaSec)
      );
    } else {
      clip.sourceEnd = Math.max(
        clip.sourceStart + minClipLen,
        Math.min(state.sourceDuration, dragState.origEnd + deltaSec)
      );
    }

    remapAutoCaptionsToEditedTimeline();
    renderTimeline();
    renderLists();
    updateOverlaysAndPlayhead();
    scheduleAutosave();
    return;
  }

  if (isScrubbing) {
    scrubToClientX(e.clientX, false);
  }
});

window.addEventListener("mouseup", () => {
  if (titleDragState) {
    titleDragState = null;
    overlayTitle.classList.remove("dragging");
    renderLists();
    persistDraftNow(false);
    setStatus("Updated section title position/size (saved).");
  }

  if (subDragState) {
    subDragState = null;
    overlaySub.classList.remove("dragging");
    renderLists();
    persistDraftNow(false);
    setStatus("Updated caption position/size (saved).");
  }

  if (dragState) {
    dragState = null;
    document.querySelectorAll(".trim-handle.active").forEach((h) => h.classList.remove("active"));
    const total = getEditedDuration();
    seekVideoToEditedTime(Math.min(state.editedTime, total), true);
    renderTimeline();
    persistDraftNow(false);
  }

  if (isScrubbing) {
    isScrubbing = false;
    timelineTrack.classList.remove("scrubbing");
    flushPendingSeek();
    scheduleAutosave();
  }
});

function scrubToClientX(clientX, immediateSeek) {
  const totalDur = getEditedDuration();
  if (!totalDur) return;
  const rect = timelineTrack.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  seekVideoToEditedTime(ratio * totalDur, immediateSeek);
}

timelineTrack.addEventListener("mousedown", (e) => {
  if (dragState) return;
  if (!getEditedDuration()) return;
  isScrubbing = true;
  timelineTrack.classList.add("scrubbing");
  scrubToClientX(e.clientX, true);
});

function updateOverlaysAndPlayhead() {
  const totalDur = getEditedDuration();
  timeReadout.textContent = `${fmtTime(state.editedTime)} / ${fmtTime(totalDur)}`;
  if (totalDur > 0) {
    playhead.style.left = `${Math.min(100, Math.max(0, (state.editedTime / totalDur) * 100))}%`;
  }

  const titleIdx = state.titles.findIndex(
    (t) => state.editedTime >= t.start && state.editedTime <= t.end
  );
  state.activeTitleIndex = titleIdx;
  if (titleIdx !== -1 && state.titles[titleIdx].text) {
    const title = normalizeTitle(state.titles[titleIdx]);
    state.titles[titleIdx] = title;
    if (document.activeElement !== overlayTitleText) {
      overlayTitleText.textContent = title.text;
    }
    overlayTitle.style.left = `${title.xPct}%`;
    overlayTitle.style.top = `${title.yPct}%`;
    overlayTitle.style.fontSize = `${Math.round(24 * title.scale)}px`;
    overlayTitle.classList.remove("hidden");
  } else if (document.activeElement !== overlayTitleText) {
    overlayTitle.classList.add("hidden");
  }

  const subIdx = state.subtitles.findIndex(
    (s) => state.editedTime >= s.start && state.editedTime <= s.end
  );
  state.activeSubIndex = subIdx;
  if (subIdx !== -1 && state.subtitles[subIdx].text) {
    const sub = normalizeSubtitle(state.subtitles[subIdx]);
    state.subtitles[subIdx] = sub;
    if (document.activeElement !== overlaySubText) {
      overlaySubText.textContent = sub.text;
    }
    overlaySub.style.left = `${sub.xPct}%`;
    overlaySub.style.top = `${sub.yPct}%`;
    overlaySub.style.fontSize = `${Math.round(17 * sub.scale)}px`;
    overlaySub.classList.remove("hidden");
  } else if (document.activeElement !== overlaySubText) {
    overlaySub.classList.add("hidden");
  }
}

function renderAll() {
  renderTimeline();
  renderLists();
}

// Export via Python FFmpeg backend
btnExport.addEventListener("click", async () => {
  if (!state.videoPath || !state.clips.length) return;
  await persistDraftNow(false);
  const outputPath = await window.pywebview.api.pick_output_path("edited_video.mp4");
  if (!outputPath) return;

  btnExport.disabled = true;
  setStatus("Exporting edited video...");

  const segments = state.clips.map((c) => ({ start: c.sourceStart, end: c.sourceEnd }));
  const res = await window.pywebview.api.export_project({
    videoPath: state.videoPath,
    outputPath,
    segments,
    titles: state.titles,
    subtitles: state.subtitles,
  });

  btnExport.disabled = false;
  if (res.ok) {
    setStatus(`Saved to ${res.outputPath}`);
  } else {
    setStatus(`Export error: ${res.error}`);
  }
});