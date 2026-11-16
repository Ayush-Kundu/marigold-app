"""
Marigold's local voice helper (started by the engine, never reachable from outside this Mac).

  STT  Whisper (small.en) via faster-whisper      POST /stt   (WAV bytes)        -> {"text": "..."}
  TTS  Kokoro-82M (open weights) via kokoro-onnx  POST /tts   {"text","voice"}   -> audio/wav
       GET /health -> {"stt": bool, "tts": bool}

Both models load on first use and then stay in memory. Every request needs the engine's token.
Usage: voice_server.py --port N --token T --models DIR
"""
import argparse, io, json, sys, threading, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--token", required=True)
ap.add_argument("--models", required=True)
ap.add_argument("--whisper", default="small.en")
args = ap.parse_args()

import numpy as np
import soundfile as sf

_lock = threading.Lock()
_stt = None
_tts = None


def stt_model():
    global _stt
    if _stt is None:
        from faster_whisper import WhisperModel
        _stt = WhisperModel(args.whisper, device="cpu", compute_type="int8", download_root=f"{args.models}/whisper")
    return _stt


def tts_model():
    global _tts
    if _tts is None:
        from kokoro_onnx import Kokoro
        _tts = Kokoro(f"{args.models}/kokoro.onnx", f"{args.models}/voices.bin")
    return _tts


def to_mono16k(data: bytes):
    audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:  # plain linear resample is plenty for speech
        n = int(len(audio) * 16000 / sr)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype("float32")
    return audio


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        if self.headers.get("x-marigold-voice") != args.token:
            self._send(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        if not self._auth():
            return
        if self.path == "/health":
            self._send(200, {"stt": _stt is not None, "tts": _tts is not None})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth():
            return
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n)
        try:
            if self.path == "/stt":
                audio = to_mono16k(body)
                if len(audio) < 1600:  # < 0.1 s
                    return self._send(200, {"text": ""})
                with _lock:
                    segs, _ = stt_model().transcribe(audio, language="en", beam_size=3, vad_filter=True, condition_on_previous_text=False)
                    seglist = [{"start": round(float(s.start), 2), "end": round(float(s.end), 2), "text": s.text.strip()} for s in segs]
                    text = " ".join(x["text"] for x in seglist).strip()
                self._send(200, {"text": text, "segments": seglist})
            elif self.path == "/tts":
                j = json.loads(body or b"{}")
                text = str(j.get("text", "")).strip()[:1500]
                if not text:
                    return self._send(400, {"error": "no text"})
                with _lock:
                    samples, sr = tts_model().create(text, voice=str(j.get("voice") or "af_heart"), speed=float(j.get("speed") or 1.0), lang="en-us")
                buf = io.BytesIO()
                sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
                self._send(200, buf.getvalue(), "audio/wav")
            else:
                self._send(404, {"error": "not found"})
        except Exception as e:  # keep serving
            traceback.print_exc(file=sys.stderr)
            self._send(500, {"error": str(e)[:300]})


ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()
