use super::*;

fn sample(kind: EffectType) -> Effect {
    Effect {
        id: "effect-1".into(),
        kind,
        enabled: true,
        params: kind
            .parameters()
            .iter()
            .map(|(name, min, max)| ((*name).into(), (min + max) / 2.0))
            .collect(),
        animations: vec![],
    }
}

fn animated() -> Effect {
    Effect {
        animations: vec![EffectAnimation {
            property: "scale".into(),
            keyframes: vec![
                EffectKeyframe {
                    time: 0.0,
                    value: 1.0,
                    easing: "linear".into(),
                },
                EffectKeyframe {
                    time: 3600.0,
                    value: 4.0,
                    easing: "ease-in-out".into(),
                },
            ],
        }],
        ..sample(EffectType::PunchZoom)
    }
}

const KINDS: [EffectType; 7] = [
    EffectType::Zoom,
    EffectType::PunchZoom,
    EffectType::Blur,
    EffectType::Color,
    EffectType::Glow,
    EffectType::Sharpen,
    EffectType::Vignette,
];

#[test]
fn every_effect_round_trips_with_its_camel_case_contract() {
    for (kind, name) in KINDS.into_iter().zip([
        "zoom",
        "punchZoom",
        "blur",
        "color",
        "glow",
        "sharpen",
        "vignette",
    ]) {
        let effect = sample(kind);
        validate(std::slice::from_ref(&effect)).unwrap();
        let json = serde_json::to_value(&effect).unwrap();
        assert_eq!(json["type"], name);
        assert!(json.get("kind").is_none());
        assert_eq!(serde_json::from_value::<Effect>(json).unwrap(), effect);
    }
}

#[test]
fn parameters_and_keyframe_values_use_exact_finite_bounds_for_every_type() {
    for kind in KINDS {
        for &(name, min, max) in kind.parameters() {
            for value in [min, max] {
                let mut effect = sample(kind);
                effect.params.insert(name.into(), value);
                effect.animations.push(EffectAnimation {
                    property: name.into(),
                    keyframes: vec![EffectKeyframe {
                        time: 0.0,
                        value,
                        easing: "linear".into(),
                    }],
                });
                validate(&[effect]).unwrap();
            }
            for value in [
                min - 0.001,
                max + 0.001,
                f64::NAN,
                f64::INFINITY,
                f64::NEG_INFINITY,
            ] {
                let mut effect = sample(kind);
                effect.params.insert(name.into(), value);
                assert!(validate(&[effect]).is_err(), "{kind:?}.{name} = {value}");
                let mut effect = sample(kind);
                effect.animations.push(EffectAnimation {
                    property: name.into(),
                    keyframes: vec![EffectKeyframe {
                        time: 0.0,
                        value,
                        easing: "linear".into(),
                    }],
                });
                assert!(
                    validate(&[effect]).is_err(),
                    "animated {kind:?}.{name} = {value}"
                );
            }
        }
    }
}

#[test]
fn parameters_cannot_be_missing_extra_or_unknown_with_the_same_count() {
    let mut effect = sample(EffectType::Zoom);
    effect.params.remove("scale");
    assert!(validate(std::slice::from_ref(&effect)).is_err());
    effect.params.insert("other".into(), 1.0);
    assert!(validate(std::slice::from_ref(&effect)).is_err());
    effect.params.insert("scale".into(), 1.0);
    assert!(validate(&[effect]).is_err());
}

#[test]
fn stack_ids_and_count_are_bounded_and_disabled_effects_are_validated() {
    validate(&[]).unwrap();
    let mut effects: Vec<_> = (0..16)
        .map(|index| Effect {
            id: format!("effect-{index}"),
            ..sample(EffectType::Blur)
        })
        .collect();
    validate(&effects).unwrap();
    effects.push(Effect {
        id: "seventeenth".into(),
        ..sample(EffectType::Blur)
    });
    assert!(validate(&effects).is_err());
    let effect = sample(EffectType::Blur);
    assert!(validate(&[effect.clone(), effect]).is_err());
    for id in [String::new(), "x".repeat(129)] {
        assert!(validate(&[Effect {
            id,
            ..sample(EffectType::Blur)
        }])
        .is_err());
    }
    validate(&[Effect {
        id: "x".repeat(128),
        ..sample(EffectType::Blur)
    }])
    .unwrap();
    let mut effect = sample(EffectType::Blur);
    effect.enabled = false;
    effect.params.insert("radius".into(), f64::NAN);
    assert!(validate(&[effect]).is_err());
}

#[test]
fn animation_properties_are_known_unique_and_bounded() {
    let mut effect = animated();
    effect.animations[0].property = "opacity".into();
    assert!(validate(&[effect]).is_err());
    let mut effect = animated();
    effect.animations.push(effect.animations[0].clone());
    assert!(validate(&[effect]).is_err());
    let mut effect = sample(EffectType::Blur);
    effect.animations = animated().animations.repeat(2);
    assert!(validate(&[effect]).is_err());
    let mut effect = animated();
    effect.animations[0].keyframes.clear();
    assert!(validate(&[effect]).is_err());
    let mut effect = animated();
    effect.animations[0].keyframes = (0..100)
        .map(|index| EffectKeyframe {
            time: f64::from(index),
            value: 1.0,
            easing: "linear".into(),
        })
        .collect();
    validate(std::slice::from_ref(&effect)).unwrap();
    effect.animations[0].keyframes.push(EffectKeyframe {
        time: 100.0,
        value: 1.0,
        easing: "linear".into(),
    });
    assert!(validate(&[effect]).is_err());
}

#[test]
fn source_keyframes_are_strictly_increasing_finite_and_nonnegative() {
    validate(&[animated()]).unwrap();
    for time in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut effect = animated();
        effect.animations[0].keyframes[0].time = time;
        assert!(validate(&[effect]).is_err());
    }
    for time in [0.0, -0.001] {
        let mut effect = animated();
        effect.animations[0].keyframes[1].time = time;
        assert!(validate(&[effect]).is_err());
    }
    let mut effect = animated();
    effect.animations[0].keyframes.reverse();
    assert!(validate(&[effect]).is_err());
}

#[test]
fn only_supported_easings_are_accepted() {
    for easing in ["linear", "ease-in", "ease-out", "ease-in-out"] {
        let mut effect = animated();
        effect.animations[0].keyframes[0].easing = easing.into();
        validate(&[effect]).unwrap();
    }
    for easing in ["", "ease", "cubic-bezier(0,0,1,1)"] {
        let mut effect = animated();
        effect.animations[0].keyframes[0].easing = easing.into();
        assert!(validate(&[effect]).is_err());
    }
}

#[test]
fn unknown_fields_and_types_are_rejected_at_every_struct_level() {
    let json = serde_json::to_value(animated()).unwrap();
    let mut invalid = json.clone();
    invalid["unexpected"] = true.into();
    assert!(serde_json::from_value::<Effect>(invalid).is_err());
    let mut invalid = json.clone();
    invalid["animations"][0]["unexpected"] = true.into();
    assert!(serde_json::from_value::<Effect>(invalid).is_err());
    let mut invalid = json.clone();
    invalid["animations"][0]["keyframes"][0]["unexpected"] = true.into();
    assert!(serde_json::from_value::<Effect>(invalid).is_err());
    let mut invalid = json.clone();
    invalid["type"] = "unknown".into();
    assert!(serde_json::from_value::<Effect>(invalid).is_err());
    let mut invalid = json.clone();
    invalid["params"]["scale"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<Effect>(invalid).is_err());
    for field in ["id", "type", "enabled", "params", "animations"] {
        let mut invalid = json.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Effect>(invalid).is_err());
    }
}
