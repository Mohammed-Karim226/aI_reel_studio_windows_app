use super::*;

#[test]
fn parses_word_timestamps_and_arabic_text_after_progress() {
    let transcript = parse_transcript("{\"progress\":0.5}\n{\"language\":\"ar\",\"words\":[{\"text\":\"مرحبا\",\"start\":0.1,\"end\":0.8}]}\n".as_bytes(), 1.0).unwrap();
    assert_eq!(transcript.language, "ar");
    assert_eq!(transcript.words[0].text, "مرحبا");
    assert!(!transcript.words[0].emphasis);
}

#[test]
fn empty_speech_is_a_successful_empty_transcript() {
    let transcript = parse_transcript(br#"{"language":"en","words":[]}"#, 10.0).unwrap();
    assert!(transcript.words.is_empty());
}

#[test]
fn rejects_malformed_or_out_of_range_provider_results() {
    for output in [
        r#"{"language":"en","words":[{"text":"Hi","start":-1,"end":1}]}"#,
        r#"{"language":"en","words":[{"text":"Hi","start":0,"end":11}]}"#,
        r#"{"language":"en","words":[{"text":"Hi","start":1,"end":1}]}"#,
        r#"{"language":"en","words":[{"text":"  ","start":0,"end":1}]}"#,
        r#"{"language":"en","words":[{"text":"one","start":2,"end":3},{"text":"two","start":1,"end":2}]}"#,
        "not json",
        "",
    ] {
        assert_eq!(
            parse_transcript(output.as_bytes(), 10.0)
                .unwrap_err()
                .kind(),
            "transcription_failed"
        );
    }
}

#[test]
fn missing_dependencies_are_actionable_and_distinct_from_runtime_failures() {
    let error = parse_transcript(
        br#"{"error":"Install faster-whisper","kind":"unavailable"}"#,
        1.0,
    )
    .unwrap_err();
    assert_eq!(error.kind(), "transcription_unavailable");
    assert!(!error.is_retryable());
    assert!(error.to_string().contains("Install faster-whisper"));
}

#[test]
fn validates_source_range_and_language_before_launching_tools() {
    assert!(validate_range(5.0, 10.0, 10.0, "ar").is_ok());
    for (start, end, language) in [
        (0.0, 0.0, "auto"),
        (-1.0, 2.0, "en"),
        (0.0, 11.0, "en"),
        (0.0, f64::NAN, "ar"),
        (0.0, 1.0, "invalid"),
    ] {
        assert!(validate_range(start, end, 10.0, language).is_err());
    }
    assert!(validate_range(0.0, MAX_DURATION + 1.0, MAX_DURATION + 1.0, "auto").is_err());
}

#[test]
fn model_names_cannot_trigger_downloads() {
    assert_eq!(
        FasterWhisper::new("python", "small").err().unwrap().kind(),
        "transcription_unavailable"
    );
    let dir = tempfile::tempdir().unwrap();
    assert!(FasterWhisper::new("python", dir.path().to_str().unwrap()).is_err());
}

#[test]
fn argument_boundaries_preserve_spaces_and_use_isolated_python() {
    let provider = FasterWhisper {
        python: "python".into(),
        model: r"C:\models\my local model".into(),
    };
    let input = TranscriptionInput {
        audio_path: Path::new(r"C:\project\audio range.wav"),
        language: "ar",
        duration: 2.5,
    };
    let args = provider.arguments(&input);
    assert_eq!(args[0], "-I");
    assert_eq!(args[4], provider.model.as_os_str());
    assert_eq!(args[5], input.audio_path.as_os_str());
    assert_eq!(args[6], "ar");
    let extraction = extraction_arguments(
        Path::new("input with spaces.mp4"),
        Path::new("out.wav"),
        5.0,
        2.5,
    );
    assert_eq!(extraction[7], "-i");
    assert_eq!(extraction[8], "input with spaces.mp4");
    assert_eq!(extraction[10], "2.5");
    assert!(extraction.windows(2).any(|pair| pair == ["-ar", "16000"]));
}

#[test]
fn temporary_audio_cleanup_preserves_other_requests() {
    let root = tempfile::tempdir().unwrap();
    let first = AudioFile::create(root.path()).unwrap();
    let first_path = first.0.clone();
    let second = AudioFile::create(root.path()).unwrap();
    let unrelated = second.0.parent().unwrap().join("notes.txt");
    std::fs::write(&unrelated, "keep").unwrap();
    drop(first);
    assert!(!first_path.exists());
    assert!(second.0.exists());
    assert!(unrelated.exists());
}

#[test]
fn progress_lines_handle_split_utf8_and_chunk_boundaries() {
    let mut lines = Lines::default();
    let mut captured = vec![];
    lines.push(b"{\"progress\":", &mut |line| captured.push(line.to_vec()));
    assert!(captured.is_empty());
    lines.push(b"0.5}\n{\"progress\":1}\n", &mut |line| {
        captured.push(line.to_vec())
    });
    assert_eq!(captured.len(), 2);
}
