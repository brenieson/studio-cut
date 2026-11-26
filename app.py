import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from faster_whisper import WhisperModel
import webview


def escape_ff_text(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
    )


class VideoEditorAPI:
    def __init__(self):
        self._window = None
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            self.bundle_dir = Path(sys._MEIPASS)
        else:
            self.bundle_dir = Path(__file__).resolve().parent

        if sys.platform == "darwin":
            writable_base = Path.home() / "Library" / "Application Support" / "StudioCut"
        elif os.name == "nt":
            local_app_data = os.environ.get("LOCALAPPDATA")
            writable_base = Path(local_app_data) / "StudioCut" if local_app_data else self.bundle_dir
        else:
            writable_base = self.bundle_dir

        self.drafts_dir = writable_base / "drafts"
        self.drafts_dir.mkdir(parents=True, exist_ok=True)
        self.ffmpeg_path = self._resolve_ffmpeg()
        self._whisper_models = {}

    def set_window(self, window):
        self._window = window

    def _resolve_ffmpeg(self) -> Path:
        exe_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        candidate = self.bundle_dir / "bin" / exe_name
        return candidate if candidate.exists() else Path(exe_name)

    def _draft_file_for_video(self, video_path_str: str) -> Path:
        resolved = str(Path(video_path_str).resolve())
        digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:16]
        return self.drafts_dir / f"draft_{digest}.json"

    def save_draft(self, draft_data: dict):
        try:
            video_path_str = draft_data.get("videoPath")
            if not video_path_str:
                return {"ok": False, "error": "No video loaded to save."}

            draft_path = self._draft_file_for_video(video_path_str)
            payload = {
                "videoPath": str(Path(video_path_str).resolve()),
                "videoName": draft_data.get("videoName") or Path(video_path_str).name,
                "savedAt": draft_data.get("savedAt", ""),
                "editedTime": float(draft_data.get("editedTime", 0.0)),
                "clips": draft_data.get("clips", []),
                "titles": draft_data.get("titles", []),
                "subtitles": draft_data.get("subtitles", []),
            }
            tmp_file = draft_path.with_suffix(".json.tmp")
            tmp_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            os.replace(tmp_file, draft_path)
            return {"ok": True, "draftPath": str(draft_path)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def load_draft_for_video(self, video_path_str: str):
        try:
            draft_path = self._draft_file_for_video(video_path_str)
            if not draft_path.exists():
                return {"ok": True, "draft": None}
            data = json.loads(draft_path.read_text(encoding="utf-8"))
            return {"ok": True, "draft": data}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def list_drafts(self):
        try:
            items = []
            for p in sorted(self.drafts_dir.glob("draft_*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    v_path = data.get("videoPath", "")
                    items.append({
                        "videoPath": v_path,
                        "videoName": data.get("videoName") or (Path(v_path).name if v_path else p.stem),
                        "savedAt": data.get("savedAt", ""),
                        "editedTime": float(data.get("editedTime", 0.0)),
                        "clipCount": len(data.get("clips", [])),
                        "titleCount": len(data.get("titles", [])),
                        "subtitleCount": len(data.get("subtitles", [])),
                        "videoExists": bool(v_path) and Path(v_path).exists(),
                    })
                except Exception:
                    continue
            return {"ok": True, "drafts": items}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _get_whisper_model(self, model_size: str = "base") -> WhisperModel:
        size = model_size if model_size in ("tiny", "base", "small", "medium") else "base"
        if size not in self._whisper_models:
            self._whisper_models[size] = WhisperModel(size, device="cpu", compute_type="int8")
        return self._whisper_models[size]

    def _extract_wav(self, video_path: Path, wav_path: Path) -> bool:
        cmd = [
            str(self.ffmpeg_path),
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(wav_path),
        ]
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return proc.returncode == 0 and wav_path.exists()

    def pick_video(self):
        result = self._window.create_file_dialog(
            webview.FileDialog.OPEN,
            file_types=("Video Files (*.mp4;*.mov;*.mkv;*.avi;*.m4v)", "All files (*.*)"),
        )
        if not result:
            return None
        video_path = Path(result[0]).resolve()
        return {
            "path": str(video_path),
            "name": video_path.name,
            "uri": video_path.as_uri(),
        }

    def pick_output_path(self, default_name="edited_video.mp4"):
        result = self._window.create_file_dialog(
            webview.FileDialog.SAVE,
            save_filename=default_name,
            file_types=("MP4 Video (*.mp4)",),
        )
        if not result:
            return None
        out = Path(result[0])
        if out.suffix.lower() != ".mp4":
            out = out.with_suffix(".mp4")
        return str(out.resolve())

    def transcribe_video(self, video_path_str: str, model_size: str = "base"):
        try:
            video_path = Path(video_path_str).resolve()
            if not video_path.exists():
                return {"ok": False, "error": "Source video file was not found."}

            with tempfile.TemporaryDirectory() as tmp_dir:
                wav_path = Path(tmp_dir) / "audio_16k.wav"
                if not self._extract_wav(video_path, wav_path):
                    return {"ok": False, "error": "FFmpeg could not extract audio from the video."}

                model = self._get_whisper_model(model_size=model_size)
                segments_iter, _ = model.transcribe(str(wav_path), vad_filter=True)

                captions = []
                for seg in segments_iter:
                    txt = (seg.text or "").strip()
                    if not txt:
                        continue
                    captions.append({
                        "sourceStart": round(float(seg.start), 2),
                        "sourceEnd": round(float(seg.end), 2),
                        "start": round(float(seg.start), 2),
                        "end": round(float(seg.end), 2),
                        "text": txt,
                        "xPct": 50.0,
                        "yPct": 90.0,
                        "scale": 1.0,
                    })

                return {"ok": True, "captions": captions}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def export_project(self, payload: dict):
        try:
            video_path = Path(payload["videoPath"]).resolve()
            output_path = Path(payload["outputPath"]).resolve()
            segments = payload.get("segments", [])
            titles = payload.get("titles", [])
            subtitles = payload.get("subtitles", [])

            if not video_path.exists():
                return {"ok": False, "error": "Source video file was not found."}
            if not segments:
                return {"ok": False, "error": "Keep at least one clip before exporting."}

            with tempfile.TemporaryDirectory():
                filter_parts = []
                concat_inputs = []
                for i, seg in enumerate(segments):
                    s = max(0.0, float(seg["start"]))
                    e = max(s + 0.05, float(seg["end"]))
                    v_label = f"v{i}"
                    a_label = f"a{i}"
                    filter_parts.append(
                        f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[{v_label}]"
                    )
                    filter_parts.append(
                        f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[{a_label}]"
                    )
                    concat_inputs.append(f"[{v_label}][{a_label}]")

                n_segs = len(segments)
                filter_parts.append(
                    f"{''.join(concat_inputs)}concat=n={n_segs}:v=1:a=1[vcut][acut]"
                )

                current_v = "vcut"
                overlay_idx = 0

                for title in titles:
                    txt = escape_ff_text((title.get("text") or "").strip())
                    t_start = max(0.0, float(title["start"]))
                    t_end = float(title["end"])
                    if not txt or t_end <= t_start:
                        continue

                    x_pct = min(92.0, max(8.0, float(title.get("xPct", 50.0))))
                    y_pct = min(94.0, max(6.0, float(title.get("yPct", 12.0))))
                    scale = min(2.5, max(0.5, float(title.get("scale", 1.0))))
                    font_size = max(18, int(round(42 * scale)))
                    box_border = max(8, int(round(14 * scale)))

                    x_expr = f"clip((w*{x_pct/100.0:.4f})-(text_w/2),16,w-text_w-16)"
                    y_expr = f"clip((h*{y_pct/100.0:.4f})-(text_h/2),16,h-text_h-16)"

                    next_v = f"vo{overlay_idx}"
                    overlay_idx += 1
                    filter_parts.append(
                        f"[{current_v}]drawtext="
                        f"text='{txt}':"
                        f"fontcolor=white:fontsize={font_size}:"
                        f"box=1:boxcolor=black@0.65:boxborderw={box_border}:"
                        f"x={x_expr}:y={y_expr}:"
                        f"enable='between(t,{t_start:.3f},{t_end:.3f})'[{next_v}]"
                    )
                    current_v = next_v

                for sub in subtitles:
                    txt = escape_ff_text((sub.get("text") or "").strip())
                    s_start = max(0.0, float(sub["start"]))
                    s_end = float(sub["end"])
                    if not txt or s_end <= s_start:
                        continue

                    x_pct = min(92.0, max(8.0, float(sub.get("xPct", 50.0))))
                    y_pct = min(94.0, max(6.0, float(sub.get("yPct", 90.0))))
                    scale = min(2.5, max(0.5, float(sub.get("scale", 1.0))))
                    font_size = max(14, int(round(30 * scale)))
                    box_border = max(6, int(round(10 * scale)))

                    x_expr = f"clip((w*{x_pct/100.0:.4f})-(text_w/2),16,w-text_w-16)"
                    y_expr = f"clip((h*{y_pct/100.0:.4f})-(text_h/2),16,h-text_h-16)"

                    next_v = f"vo{overlay_idx}"
                    overlay_idx += 1
                    filter_parts.append(
                        f"[{current_v}]drawtext="
                        f"text='{txt}':"
                        f"fontcolor=white:fontsize={font_size}:"
                        f"box=1:boxcolor=black@0.78:boxborderw={box_border}:"
                        f"x={x_expr}:y={y_expr}:"
                        f"enable='between(t,{s_start:.3f},{s_end:.3f})'[{next_v}]"
                    )
                    current_v = next_v

                filter_complex = ";".join(filter_parts)
                output_path.parent.mkdir(parents=True, exist_ok=True)

                cmd = [
                    str(self.ffmpeg_path),
                    "-y",
                    "-i",
                    str(video_path),
                    "-filter_complex",
                    filter_complex,
                    "-map",
                    f"[{current_v}]",
                    "-map",
                    "[acut]",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "20",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    str(output_path),
                ]

                proc = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )

                if proc.returncode != 0:
                    tail = "\n".join(proc.stderr.splitlines()[-12:])
                    return {"ok": False, "error": f"FFmpeg export failed:\n{tail}"}

            return {"ok": True, "outputPath": str(output_path)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


def main():
    api = VideoEditorAPI()
    html_file = api.bundle_dir / "ui" / "index.html"
    window = webview.create_window(
        title="Studio Cut — Local Video Editor",
        url=html_file.as_uri(),
        js_api=api,
        width=1280,
        height=820,
        min_size=(960, 640),
    )
    api.set_window(window)
    webview.start(debug=False)


if __name__ == "__main__":
    main()