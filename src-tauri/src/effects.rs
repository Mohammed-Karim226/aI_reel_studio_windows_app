//! Ordered, non-destructive visual effects stored with each video clip.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{error::AppResult, timeline::invalid};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectType {
    Zoom,
    PunchZoom,
    Blur,
    Color,
    Glow,
    Sharpen,
    Vignette,
}

impl EffectType {
    fn parameters(self) -> &'static [(&'static str, f64, f64)] {
        match self {
            Self::Zoom | Self::PunchZoom => &[
                ("scale", 1.0, 4.0),
                ("centerX", 0.0, 100.0),
                ("centerY", 0.0, 100.0),
            ],
            Self::Blur => &[("radius", 0.0, 40.0)],
            Self::Color => &[
                ("brightness", 0.0, 2.0),
                ("contrast", 0.0, 2.0),
                ("saturation", 0.0, 2.0),
                ("temperature", -1.0, 1.0),
                ("tint", -1.0, 1.0),
            ],
            Self::Glow => &[("radius", 0.0, 40.0), ("intensity", 0.0, 2.0)],
            Self::Sharpen => &[("amount", 0.0, 2.0)],
            Self::Vignette => &[
                ("amount", 0.0, 1.0),
                ("radius", 0.1, 1.0),
                ("softness", 0.01, 1.0),
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectKeyframe {
    /// Source-media seconds, so moving, trimming and splitting keep the same curve.
    pub time: f64,
    pub value: f64,
    pub easing: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectAnimation {
    pub property: String,
    pub keyframes: Vec<EffectKeyframe>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Effect {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: EffectType,
    pub enabled: bool,
    pub params: BTreeMap<String, f64>,
    pub animations: Vec<EffectAnimation>,
}

/// IDs are local to a clip: a duplicate or split may retain its original effect IDs.
pub fn validate(effects: &[Effect]) -> AppResult<()> {
    if effects.len() > 16 {
        return Err(invalid("a clip can have at most 16 effects"));
    }
    let mut ids = HashSet::new();
    for effect in effects {
        if effect.id.is_empty() || effect.id.len() > 128 || !ids.insert(&effect.id) {
            return Err(invalid("invalid or duplicate clip effect ID"));
        }
        let parameters = effect.kind.parameters();
        if effect.params.len() != parameters.len()
            || parameters.iter().any(|(name, min, max)| {
                effect
                    .params
                    .get(*name)
                    .is_none_or(|value| !value.is_finite() || value < min || value > max)
            })
        {
            return Err(invalid("invalid or unknown clip effect parameter"));
        }
        if effect.animations.len() > parameters.len() {
            return Err(invalid("too many clip effect animations"));
        }
        let mut properties = HashSet::new();
        for animation in &effect.animations {
            let Some((_, min, max)) = parameters
                .iter()
                .find(|(name, _, _)| *name == animation.property)
            else {
                return Err(invalid("unknown clip effect animation property"));
            };
            if !properties.insert(&animation.property)
                || animation.keyframes.is_empty()
                || animation.keyframes.len() > 100
            {
                return Err(invalid("invalid or duplicate clip effect animation"));
            }
            let mut previous = -1.0;
            for keyframe in &animation.keyframes {
                if !keyframe.time.is_finite()
                    || keyframe.time < 0.0
                    || keyframe.time <= previous
                    || !keyframe.value.is_finite()
                    || keyframe.value < *min
                    || keyframe.value > *max
                    || !["linear", "ease-in", "ease-out", "ease-in-out"]
                        .contains(&keyframe.easing.as_str())
                {
                    return Err(invalid("invalid clip effect keyframe"));
                }
                previous = keyframe.time;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
