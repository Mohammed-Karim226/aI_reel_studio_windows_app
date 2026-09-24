"""Bundled local-only speech provider. JSON lines are the only stdout protocol."""
import json
import math
import os
import sys


protocol = sys.stdout


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), file=protocol, flush=True)


def main():
    global protocol
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    sys.stdout.flush()
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    # Defense in depth: neither model nor tokenizer may be downloaded by this process.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    model_path, audio_path, language, duration_text = sys.argv[1:]
    duration = float(duration_text)
    try:
        from faster_whisper import WhisperModel
    except Exception as error:
        emit({"error": "Install or repair faster-whisper in the selected Python environment, then retry: " + str(error)[:2000], "kind": "unavailable"})
        return 2
    try:
        model = WhisperModel(model_path, device="cpu", compute_type="int8", local_files_only=True)
    except Exception as error:
        emit({"error": "Cannot load the local faster-whisper model. Select a complete CTranslate2 Whisper model folder: " + str(error)[:2000], "kind": "unavailable"})
        return 2
    if language == "ar" and not model.model.is_multilingual:
        emit({"error": "The selected model supports English only. Choose a multilingual Whisper model for Arabic captions.", "kind": "unavailable"})
        return 2
    emit({"progress": 0.0})
    segments, info = model.transcribe(
        audio_path,
        language=None if language == "auto" else language,
        word_timestamps=True,
        beam_size=5,
        vad_filter=True,
    )
    words = []
    previous_start = 0.0
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            start, end = max(0.0, word.start), min(duration, word.end)
            if not text or not math.isfinite(start) or not math.isfinite(end) or end <= start:
                continue
            if start < previous_start:
                raise ValueError("The model returned unordered word timestamps.")
            words.append({"text": text, "start": start, "end": end, "emphasis": False})
            previous_start = start
            if len(words) > 100000:
                raise ValueError("Transcript exceeds 100,000 words. Transcribe a shorter clip.")
        emit({"progress": min(1.0, max(0.0, segment.end / duration))})
    emit({"language": info.language, "words": words})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        emit({"error": "Local transcription failed: " + str(error)[:2000], "kind": "failed"})
        sys.exit(1)
