"""One offline JSON readiness result; library/native stdout is routed to stderr."""
import json
import os
import sys


def main():
    # Keep our protocol handle separate before any dependency can write to stdout.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    sys.stdout.flush()
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    result = {
        "pythonVersion": ".".join(str(part) for part in sys.version_info[:3]),
        "providerVersion": None,
        "modelReady": False,
        "multilingual": None,
        "issues": [],
    }
    try:
        if sys.version_info < (3, 9):
            result["issues"].append("Choose Python 3.9 or newer for faster-whisper.")
        else:
            check_provider(result, sys.argv[1])
    except Exception as error:
        result["issues"].append("The local setup check failed: " + str(error)[:2000])
    protocol.write(json.dumps(result, ensure_ascii=False) + "\n")
    protocol.close()


def check_provider(result, model_path):
    try:
        from importlib.metadata import version
        import ctranslate2
        from faster_whisper import WhisperModel

        result["providerVersion"] = version("faster-whisper")
        # Access both versions so broken native installations also fail the probe.
        if not ctranslate2.__version__:
            raise ImportError("CTranslate2 version is missing")
    except Exception as error:
        result["issues"].append(
            "Install or repair faster-whisper and CTranslate2 in the selected Python environment: "
            + str(error)[:2000]
        )
        return
    if not model_path:
        return  # The Rust caller supplies the actionable missing-folder issue.
    try:
        model = WhisperModel(model_path, device="cpu", compute_type="int8", local_files_only=True)
        multilingual = model.model.is_multilingual
        if not isinstance(multilingual, bool):
            raise ValueError("The model did not report whether it supports multiple languages")
        result["modelReady"] = True
        result["multilingual"] = multilingual
    except Exception as error:
        result["issues"].append(
            "Cannot load the local model. Choose a complete CTranslate2 Whisper model folder: "
            + str(error)[:2000]
        )


if __name__ == "__main__":
    main()
