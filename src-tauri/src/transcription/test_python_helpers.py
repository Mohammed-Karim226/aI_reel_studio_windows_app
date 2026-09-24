"""Offline protocol checks with tiny fake providers; no installed model is needed.

Run: python -I src-tauri/src/transcription/test_python_helpers.py
"""
import json
import pathlib
import subprocess
import sys
import textwrap
import unittest


ROOT = pathlib.Path(__file__).resolve().parent
FAKE_PROVIDER = """
import importlib.metadata
import os
import sys
import types

provider = types.ModuleType('faster_whisper')
backend = types.ModuleType('ctranslate2')
backend.__version__ = '4.6.0'
sys.modules['ctranslate2'] = backend
sys.modules['faster_whisper'] = provider
importlib.metadata.version = lambda name: '1.2.0'

class WhisperModel:
    def __init__(self, path, **options):
        assert path == 'C:/local model'
        assert options == {'device': 'cpu', 'compute_type': 'int8', 'local_files_only': True}
        assert os.environ['HF_HUB_OFFLINE'] == '1'
        assert os.environ['TRANSFORMERS_OFFLINE'] == '1'
        assert os.environ['HF_HUB_DISABLE_TELEMETRY'] == '1'
        print('library noise', flush=True)
        os.write(1, b'native library noise\\n')
        self.model = types.SimpleNamespace(is_multilingual=True)

    def transcribe(self, path, **options):
        assert path == 'C:/audio.wav'
        assert options['word_timestamps'] is True
        assert options['vad_filter'] is True
        word = types.SimpleNamespace(word=' Hello ', start=0.1, end=0.6)
        segment = types.SimpleNamespace(words=[word], end=0.6)
        return iter([segment]), types.SimpleNamespace(language='en')

provider.WhisperModel = WhisperModel
"""


def run_helper(name, fixture=FAKE_PROVIDER, arguments=None):
    source = (ROOT / name).read_text(encoding="utf-8")
    driver = textwrap.dedent(fixture) + "\nexec(" + repr(source) + ")\n"
    result = subprocess.run(
        [sys.executable, "-I", "-u", "-c", driver, *(arguments or ["C:/local model"])],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=10,
    )
    return result, [json.loads(line) for line in result.stdout.splitlines()]


class SetupProbeTests(unittest.TestCase):
    def test_complete_multilingual_model_and_noisy_imports_stay_offline(self):
        result, records = run_helper("setup_probe.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["providerVersion"], "1.2.0")
        self.assertTrue(records[0]["modelReady"])
        self.assertTrue(records[0]["multilingual"])
        self.assertEqual(records[0]["issues"], [])
        self.assertIn("library noise", result.stderr)
        self.assertIn("native library noise", result.stderr)

    def test_english_only_model_is_reported(self):
        fixture = FAKE_PROVIDER.replace("is_multilingual=True", "is_multilingual=False")
        result, records = run_helper("setup_probe.py", fixture)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(records[0]["modelReady"])
        self.assertFalse(records[0]["multilingual"])

    def test_missing_native_dependency_is_actionable(self):
        fixture = """
        import builtins
        original_import = builtins.__import__
        def failing_import(name, *args, **kwargs):
            if name == 'ctranslate2':
                raise ImportError('test native dependency is unavailable')
            return original_import(name, *args, **kwargs)
        builtins.__import__ = failing_import
        """
        result, records = run_helper("setup_probe.py", fixture)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(records[0]["modelReady"])
        self.assertIsNone(records[0]["providerVersion"])
        self.assertIn("Install or repair", records[0]["issues"][0])

    def test_incompatible_python_is_reported_before_importing_provider(self):
        result, records = run_helper("setup_probe.py", "import sys\nsys.version_info = (3, 8, 0)")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(records[0]["pythonVersion"], "3.8.0")
        self.assertIsNone(records[0]["providerVersion"])
        self.assertIn("Python 3.9", records[0]["issues"][0])

    def test_corrupt_local_model_is_reported_without_download(self):
        fixture = FAKE_PROVIDER.replace("self.model = types.SimpleNamespace(is_multilingual=True)", "raise ValueError('model weights are corrupt')")
        result, records = run_helper("setup_probe.py", fixture)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(records[0]["modelReady"])
        self.assertIsNone(records[0]["multilingual"])
        self.assertEqual(records[0]["providerVersion"], "1.2.0")
        self.assertIn("Cannot load the local model", records[0]["issues"][0])

    def test_incomplete_draft_checks_provider_without_loading_model(self):
        fixture = FAKE_PROVIDER.replace("assert path == 'C:/local model'", "raise AssertionError('a draft must not load a model')")
        result, records = run_helper("setup_probe.py", fixture, [""])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(records[0]["providerVersion"], "1.2.0")
        self.assertFalse(records[0]["modelReady"])
        self.assertEqual(records[0]["issues"], [])


class TranscriptionHelperTests(unittest.TestCase):
    def test_words_and_progress_are_valid_json_despite_native_stdout(self):
        result, records = run_helper(
            "faster_whisper.py", arguments=["C:/local model", "C:/audio.wav", "en", "1.0"]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(records[-1], {
            "language": "en",
            "words": [{"text": "Hello", "start": 0.1, "end": 0.6, "emphasis": False}],
        })
        self.assertEqual(records[0], {"progress": 0.0})
        self.assertIn("native library noise", result.stderr)

    def test_arabic_requires_multilingual_model_before_transcribing(self):
        fixture = FAKE_PROVIDER.replace("is_multilingual=True", "is_multilingual=False")
        result, records = run_helper(
            "faster_whisper.py", fixture, ["C:/local model", "C:/audio.wav", "ar", "1.0"]
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["kind"], "unavailable")
        self.assertIn("English only", records[0]["error"])


if __name__ == "__main__":
    unittest.main()
