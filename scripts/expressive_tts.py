"""
Marigold's expressive voice (started by the engine, reachable only from this Mac).

  Chatterbox Turbo (open weights, MIT) on Apple's MLX: a natural voice that can laugh, chuckle, sigh and gasp.
  POST /speak {"text": "..."}   -> audio/wav (24 kHz)       GET /health -> {"ready": bool}
Text may contain [laugh] [chuckle] [sigh] [gasp] [cough] [groan] [sniff] [shush] [clear throat]; anything else in
brackets is dropped. Every request needs the engine's token.
Usage: expressive_tts.py --port N --token T
"""
import argparse, io, json, os, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("TQDM_DISABLE", "1")
ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--token", required=True)
ap.add_argument("--repo", default="mlx-community/chatterbox-turbo-fp16")
args = ap.parse_args()

import numpy as np
import soundfile as sf

TAGS = {"laugh", "chuckle", "sigh", "gasp", "cough", "groan", "sniff", "shush", "clear throat"}
ALIAS = {"laughs": "laugh", "laughing": "laugh", "chuckles": "chuckle", "sighs": "sigh", "gasps": "gasp", "coughs": "cough", "sniffs": "sniff", "giggle": "chuckle", "giggles": "chuckle", "haha": "laugh"}

_model = None
_ready = False
_lock = threading.Lock()


def _tag(word: str):
    t = word.strip().lower()
    t = ALIAS.get(t, t)
    return t if t in TAGS else None


def clean(text: str) -> str:
    text = re.sub(r"\[([^\]]{1,20})\]", lambda m: f"[{_tag(m.group(1))}]" if _tag(m.group(1)) else "", text)
    text = re.sub(r"\(([a-zA-Z ]{3,14})\)", lambda m: f"[{_tag(m.group(1))}]" if _tag(m.group(1)) else m.group(0), text)
    return re.sub(r"\s+", " ", text).strip()


def load():
    global _model, _ready
    from mlx_audio.tts.utils import load_model
    _model = load_model(args.repo)
    list(_model.generate(text="Hi."))  # warm up (the first call compiles)
    _ready = True


def speak(text: str) -> bytes:
    with _lock:
        out = []
        sr = 24000
        for r in _model.generate(text=text):
            out.append(np.array(r.audio).reshape(-1))
            sr = getattr(r, "sample_rate", None) or sr
        audio = np.concatenate(out) if out else np.zeros(2400, dtype="float32")
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
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
        if self._auth():
            self._send(200, {"ready": _ready}) if self.path == "/health" else self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth():
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        if self.path != "/speak":
            return self._send(404, {"error": "not found"})
        if not _ready:
            return self._send(503, {"error": "loading"})
        try:
            text = clean(str(json.loads(body or b"{}").get("text", ""))[:600])
            if not text:
                return self._send(400, {"error": "text required"})
            self._send(200, speak(text), "audio/wav")
        except Exception as e:
            self._send(500, {"error": str(e)[:200]})


threading.Thread(target=load, daemon=True).start()
ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()
