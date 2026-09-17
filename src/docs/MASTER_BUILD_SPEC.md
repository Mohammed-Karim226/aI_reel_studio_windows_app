# AI Reel Studio — Windows Desktop Application
## Master Build Specification & Agent Execution Prompt

> **Role:** You are the lead software architect, senior desktop application engineer, video-engine engineer, AI engineer, and QA engineer responsible for building this product end-to-end.
>
> **Goal:** Build a production-quality Windows desktop application that combines a professional non-linear video editor, motion-graphics system, and AI-assisted Reel production workflow. The product is NOT a generic Premiere Pro clone. It is specialized for turning long-form videos/podcasts into high-quality short-form vertical Reels/TikToks/Shorts with strong hooks, captions, animations, effects, and social-platform optimized exports.

---

# 1. PRODUCT VISION

Build a Windows-first desktop application called **AI Reel Studio**.

Core workflow:

```text
Long Video
    ↓
Manual Cut OR AI Cut
    ↓
Reel Timeline
    ↓
Hook Designer
    ↓
Captions
    ↓
Motion Graphics
    ↓
Effects / Zooms / Transitions / SFX
    ↓
AI Edit Review
    ↓
Master Composition
    ↓
Platform-Specific Export
    ↓
Instagram / TikTok / Facebook / YouTube Shorts
```

The application should feel like a focused combination of:

- Premiere-style editing
- After Effects-style motion graphics
- CapCut-style fast social editing
- AI editing agent
- Brand/template system
- Batch Reel production system

Do NOT attempt to implement every feature of Premiere/After Effects in v1. Prioritize the workflow described in this specification.

---

# 2. PRIMARY USER WORKFLOWS

The application MUST support two primary entry points.

## Workflow A — Create a Reel from a Long Video

User imports a long-form video.

Show:

```text
How do you want to create the Reel?

[ ✂ Manual Cut ]
[ 🤖 AI Find the Best Clip ]
```

### Manual Cut

User:

1. imports video
2. previews video
3. scrubs timeline
4. marks in/out
5. cuts segments
6. rearranges segments
7. creates a vertical composition
8. designs hook
9. adds captions
10. adds animations/effects
11. previews
12. exports

### AI Cut

AI:

1. analyzes media
2. transcribes speech
3. identifies speakers
4. detects meaningful segments
5. scores candidate clips
6. suggests hooks
7. generates candidate Reel structure
8. presents candidates to the user
9. user approves/edits
10. application creates the timeline
11. user continues editing normally

AI must never lock the user into its decisions.

Every AI decision must be editable.

---

# 3. WORKFLOW B — IMPORT AN ALREADY-CUT REEL

The user can import an existing Reel.

The application should analyze:

- cuts
- scene changes
- speech
- captions
- text
- hook
- timing
- zooms
- transitions
- effects where detectable
- pacing
- speaker position

Then present:

```text
Existing Reel detected.

[Edit normally]
[Analyze with AI]
[Apply my Brand Style]
[Improve Hook]
[Improve Captions]
[Improve Pacing]
```

The AI should be able to suggest improvements without destroying the existing edit.

---

# 4. PRODUCT PRINCIPLES

## 4.1 Local-first

Large media files should remain local.

Do NOT require uploading the full source video to a remote server for normal editing.

Use local:

- media storage
- project database
- proxy generation
- timeline editing
- preview rendering
- final rendering

Cloud AI may be used when required, but AI services must be abstracted behind interfaces.

## 4.2 Non-destructive editing

Never modify the original media.

Represent edits as timeline instructions.

```text
Original Media
      ↓
Timeline / Edit Decision List
      ↓
Effects / Captions / Motion
      ↓
Final Render
```

## 4.3 Proxy workflow

For large source videos:

```text
Original 4K/High Resolution
          ↓
      Proxy Media
          ↓
      Smooth Preview
          ↓
      Final Render
          ↓
      Original Media
```

Proxies must NEVER be used for the final export unless explicitly requested by the user.

## 4.4 AI is an assistant, not the owner

The user must always be able to:

- accept
- reject
- modify
- undo
- regenerate
- manually override

AI-generated edits must be represented as normal editable timeline objects.

---

# 5. RECOMMENDED TECHNOLOGY STACK

## Desktop

- Tauri
- React
- TypeScript
- Rust for native/system functionality

If the existing repository has a strong reason to use Electron, document the reason before switching. Otherwise prefer Tauri.

## UI

- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Lucide icons
- Framer Motion where appropriate

Avoid unnecessary UI libraries.

Use strict TypeScript.

**NO `any`.**

---

# 6. VIDEO ENGINE

Use:

- FFmpeg for media inspection and final rendering/encoding
- WebCodecs where beneficial for browser-side preview/performance
- Canvas/WebGL where useful for visual composition
- Native Rust modules only where they provide meaningful performance/system benefits

Do not implement a complete video codec yourself.

---

# 7. TIMELINE ENGINE

The timeline is the heart of the application.

It must support multiple tracks:

```text
VIDEO
AUDIO
TEXT
CAPTIONS
GRAPHICS
EFFECTS
SFX
```

Example model:

```ts
type Timeline = {
  id: string;
  duration: number;
  tracks: Track[];
};

type Track = {
  id: string;
  type: TrackType;
  clips: TimelineClip[];
};

type TimelineClip = {
  id: string;
  sourceMediaId: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  timelineEnd: number;
  transform: Transform;
  effects: Effect[];
};
```

Support:

- trim
- split
- delete
- move
- duplicate
- ripple delete
- snapping
- zooming
- track visibility
- mute/solo
- undo/redo
- multi-select
- keyboard shortcuts

---

# 8. VERTICAL REEL COMPOSITION

Primary social composition:

```text
1080 × 1920
9:16
```

The canvas must support:

- video
- text
- shapes
- images
- logos
- captions
- overlays
- effects

Provide visual safe-zone overlays for major platforms.

---

# 9. HOOK SYSTEM — CRITICAL FEATURE

The Hook Designer is one of the most important parts of the product.

Do NOT treat the hook as simple text.

A hook is a mini-composition.

```text
HOOK
├── Video
├── Main Text
├── Secondary Text
├── Background
├── Shapes
├── Logo
├── SFX
├── Motion
├── Effects
└── Transition
```

The hook must have its own mini timeline.

Example:

```text
0ms
Text opacity = 0
Scale = 0.85
Y = +30

150ms
Opacity = 1
Scale = 1.05
Y = 0

280ms
Scale = 1

1000ms
Subtle movement

1500ms
Transition into main content
```

---

# 10. KEYFRAME SYSTEM

Implement a reusable keyframe animation engine.

Supported properties should include:

- x
- y
- scale
- rotation
- opacity
- blur
- brightness
- saturation
- crop
- mask parameters where supported

Supported easing:

- linear
- ease-in
- ease-out
- ease-in-out
- cubic bezier
- spring
- bounce
- elastic

Example:

```ts
type Keyframe<T> = {
  time: number;
  value: T;
  easing: Easing;
};
```

The system must be reusable for:

- text
- video
- shapes
- images
- effects
- captions

---

# 11. MOTION PRESETS

Create a reusable preset library.

Initial presets:

- Pop
- Slide Up
- Slide Down
- Slide Left
- Slide Right
- Scale In
- Scale Out
- Blur Reveal
- Typewriter
- Bounce
- Spring
- Glitch
- Impact
- Shake
- Word Highlight

Presets should create actual editable keyframes.

Do not create fake buttons that only simulate animation.

---

# 12. HOOK TEMPLATE SYSTEM

Create categories:

```text
Podcast
Healthcare
Business
Educational
Story
Controversial
Emotional
Motivational
```

Initial hook types:

- Bold Question
- Warning
- Strong Claim
- Contrarian Statement
- Story Hook
- Curiosity Gap
- Myth vs Fact
- Number/List
- Result/Outcome
- Emotional Statement

Templates must be customizable.

---

# 13. CAPTION ENGINE

Captions are a first-class system.

Pipeline:

```text
Audio
 ↓
Speech-to-text
 ↓
Word timestamps
 ↓
Caption segmentation
 ↓
Caption styling
 ↓
Animation
```

Store word-level timestamps when available.

Example:

```ts
type CaptionWord = {
  text: string;
  start: number;
  end: number;
  emphasis?: boolean;
};
```

Support styles:

- Classic
- Bold
- Karaoke
- Word Highlight
- Minimal
- Podcast
- Impact
- Dynamic
- Arabic Viral

Support:

- font
- size
- weight
- color
- outline
- shadow
- background
- position
- line spacing
- word emphasis
- animation

Arabic must be treated as a first-class language.

Handle:

- RTL
- Arabic shaping
- mixed Arabic/English
- punctuation
- numbers
- Arabic fonts

---

# 14. AI CONTENT ANALYSIS

The AI engine should analyze long-form content.

Extract:

- transcript
- topics
- speaker turns
- sentiment/emotion where useful
- questions
- answers
- strong statements
- stories
- controversial statements
- punchlines
- useful educational sections

Candidate clip scoring:

```text
hookScore
clarityScore
emotionScore
shareabilityScore
contextCompleteness
pacingScore
```

Example:

```json
{
  "start": 132.4,
  "end": 158.7,
  "hookScore": 9.2,
  "clarityScore": 8.8,
  "emotionScore": 9.1,
  "shareabilityScore": 8.9
}
```

The exact scoring algorithm should remain configurable.

---

# 15. AI EDITOR AGENT

Build the AI system around explicit tools.

Possible tools:

```text
get_video_metadata()
transcribe_video()
search_transcript()
find_candidate_clips()
score_clip()
detect_speakers()
detect_faces()
create_clip()
create_caption()
create_hook()
apply_template()
apply_effect()
create_timeline()
analyze_reel()
render_preview()
render_final()
```

The agent should output structured edit instructions, NOT arbitrary code.

Example:

```json
{
  "format": "9:16",
  "segments": [
    {
      "start": 124.3,
      "end": 128.7,
      "role": "hook"
    },
    {
      "start": 128.7,
      "end": 154.2,
      "role": "main_content"
    }
  ],
  "hook": {
    "text": "ليه الشخص اللي بيحبك ممكن يأذيك؟",
    "template": "impact",
    "duration": 1.2
  },
  "captions": {
    "style": "bold_dynamic",
    "highlightKeywords": true
  }
}
```

Validate AI output against strict schemas before applying it.

---

# 16. AI REEL REVIEW

After the user finishes a Reel, provide:

```text
🤖 AI Edit Review
```

Analyze:

- first 1–3 seconds
- hook strength
- pacing
- dead time
- caption density
- visual variation
- long static sections
- audio issues
- text readability
- safe-zone violations
- weak transitions
- excessive effects

Example:

```text
⚠ First 2.4 seconds are slow.

Suggestion:
Start at 01:32.4 instead of 01:29.8.

⚠ Caption remains unchanged for 4.2 seconds.

Suggestion:
Add emphasis animation.

⚠ No visual change from 08.2s to 13.7s.

Suggestion:
Add subtle punch zoom.
```

Every suggestion should have:

```text
[Preview]
[Apply]
[Ignore]
```

---

# 17. AUTO REFRAME

Implement speaker/face-aware reframing.

For a 16:9 source:

```text
16:9
 ↓
Face detection
 ↓
Speaker tracking
 ↓
9:16 crop
```

The crop should smoothly follow the active speaker.

Avoid jitter.

Add smoothing/interpolation.

---

# 18. EFFECTS ENGINE

Create an extensible effects system.

Initial effects:

- Zoom
- Punch Zoom
- Blur
- Motion Blur
- Sharpen
- Brightness
- Contrast
- Saturation
- Vignette
- Glow
- Noise
- Color adjustment
- Speed adjustment

Effects must be stackable.

Example:

```text
Selected Clip

Effects
├── Punch Zoom
├── Glow
├── Sharpen
└── Color
```

Allow:

- enable/disable
- reorder
- parameters
- keyframes

---

# 19. BRAND SYSTEM

Create reusable Brand Profiles.

Example:

```text
Brand
├── Logo
├── Fonts
├── Colors
├── Caption Style
├── Hook Style
├── Animation Style
├── Outro
├── Watermark
└── Export Profiles
```

Users can select:

```text
Apply Brand:
[GrowthLab]
[Client A]
[Client B]
```

The brand profile should influence AI recommendations.

---

# 20. SOCIAL EXPORT ENGINE

Export must be professional.

Do not simply export one generic MP4.

Pipeline:

```text
Timeline
 ↓
Master Composition
 ↓
Quality Validation
 ↓
Platform Preset
 ↓
Smart Encoding
 ↓
Validation
 ↓
Final File
```

Support:

- Instagram Reels
- TikTok
- YouTube Shorts
- Facebook Reels
- Custom

Use platform-specific presets.

The architecture must allow presets to be updated without changing the rendering engine.

---

# 21. EXPORT QUALITY

The application must:

- render from original media
- never render final output from proxies by default
- preserve aspect ratio
- preserve frame rate where appropriate
- use appropriate codec/container
- support hardware encoding when available
- handle SDR/HDR intentionally
- avoid unnecessary re-encoding
- preserve audio quality
- validate output after rendering

Provide:

```text
Fast
Social Optimized
Maximum Quality
```

Export modes.

---

# 22. SAFE ZONES

Provide platform-aware overlays.

User can preview:

```text
Instagram Safe Zone
TikTok Safe Zone
YouTube Shorts Safe Zone
Facebook Safe Zone
```

Warn if:

- hook is too close to UI area
- captions are likely to be covered
- important visual content is outside the safe region

---

# 23. BATCH EXPORT

Support:

```text
20 Reels
×
4 Platforms
=
80 Exports
```

Use a render queue.

UI:

```text
RENDER QUEUE

#01 ███████████ 100% ✓
#02 ███████████ 100% ✓
#03 ███████░░░░ 65%
#04 Waiting
#05 Waiting
```

Rendering should run in background when possible.

---

# 24. MASTER + PLATFORM EXPORT

Never create platform exports from another platform export.

Correct:

```text
Master Timeline
 ├── Instagram Export
 ├── TikTok Export
 ├── Facebook Export
 └── YouTube Shorts Export
```

All exports must originate from the same master timeline.

---

# 25. PROJECT STRUCTURE

Conceptually:

```text
Project/
├── project.json
├── media/
├── proxies/
├── thumbnails/
├── captions/
├── assets/
├── templates/
├── brands/
├── previews/
└── renders/
```

The project must be portable and recoverable.

---

# 26. DATABASE

Use SQLite locally.

Entities should include at minimum:

```text
Project
MediaAsset
Timeline
Track
TimelineClip
Caption
CaptionWord
TextElement
Animation
Keyframe
Effect
HookTemplate
BrandProfile
ExportPreset
RenderJob
AIAnalysis
AISuggestion
```

Use migrations.

Never store massive video binary data directly inside SQLite.

Store references/paths and metadata.

---

# 27. UI / UX

The UI should look like a modern professional creative application.

Layout:

```text
┌─────────────────────────────────────────────────────────────┐
│ Top Bar: Project | Undo | Redo | Preview | Export           │
├──────────────┬──────────────────────────────┬───────────────┤
│              │                              │               │
│ AI / Assets  │         VIDEO CANVAS         │ Inspector     │
│              │                              │               │
│ Media        │                              │ Transform     │
│ AI Clips     │                              │ Text          │
│ Templates    │                              │ Animation     │
│ Captions     │                              │ Effects        │
│ Brands       │                              │ Audio         │
│              │                              │               │
├──────────────┴──────────────────────────────┴───────────────┤
│                     TIMELINE                                │
│                                                             │
│ VIDEO      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━              │
│ CAPTIONS   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━              │
│ TEXT       ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━              │
│ EFFECTS    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━              │
│ AUDIO      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━              │
└─────────────────────────────────────────────────────────────┘
```

Use keyboard shortcuts heavily.

Prioritize fast editing.

---

# 28. PERFORMANCE REQUIREMENTS

The application should remain responsive while:

- importing large videos
- generating proxies
- analyzing media
- generating thumbnails
- scrubbing
- editing captions
- rendering previews
- rendering final exports

Never block the UI thread with heavy processing.

Use workers/background processes/jobs.

---

# 29. ERROR HANDLING

Never silently fail.

Every long-running task must have:

- progress
- cancellation
- retry
- error message
- logs

Examples:

```text
Proxy generation failed
[Retry]

AI transcription failed
[Retry]

Render failed
[Retry] [View Logs]
```

---

# 30. OBSERVABILITY / DEBUGGING

Create structured local logs.

Useful categories:

```text
MEDIA
TIMELINE
AI
RENDER
EXPORT
DATABASE
SYSTEM
```

Provide a developer diagnostics panel.

---

# 31. SECURITY

Never hardcode API keys.

Use secure environment/configuration mechanisms.

AI provider configuration must be abstracted.

Example:

```text
AI Provider
├── Provider A
├── Provider B
└── Local Model
```

The application should not assume one AI vendor.

---

# 32. AI PROVIDER ABSTRACTION

Create interfaces such as:

```ts
interface TranscriptionProvider {
  transcribe(input: TranscriptionInput): Promise<Transcript>;
}

interface LLMProvider {
  generateEditPlan(input: EditPlanInput): Promise<EditPlan>;
}

interface VisionProvider {
  analyzeFrames(input: VisionInput): Promise<VisionAnalysis>;
}
```

This allows provider changes without rewriting the application.

---

# 33. TESTING

Use:

- unit tests
- integration tests
- timeline engine tests
- rendering tests
- AI schema validation tests
- export preset tests

Critical tests:

1. split clip
2. trim clip
3. undo/redo
4. keyframe interpolation
5. caption timing
6. RTL Arabic captions
7. timeline serialization
8. project reopening
9. render queue
10. platform export
11. failed render recovery
12. AI edit-plan validation

---

# 34. WINDOWS REQUIREMENTS

Target Windows 10/11 64-bit.

The final product should provide:

- installer
- desktop shortcut option
- clean uninstall
- project file association if useful
- automatic crash-safe recovery
- configurable media cache directory

---

# 35. RECOVERY / AUTOSAVE

Implement:

- autosave
- project snapshots
- crash recovery
- unsaved-change detection

If the application crashes:

```text
Previous session recovered.

[Restore]
[Discard]
```

---

# 36. DO NOT BUILD THESE IN V1

Do NOT waste time implementing:

- full 3D compositor
- advanced color grading suite
- complete After Effects clone
- plugin marketplace
- collaborative cloud editing
- professional DAW
- advanced masking/tracking suite
- every possible video codec

Build the Reel production workflow first.

---

# 37. DEVELOPMENT STRATEGY

Build in vertical slices.

Do NOT create 100 empty components first.

Recommended sequence:

## Phase 0 — Architecture

Create:

- repository structure
- TypeScript types
- Rust/Tauri shell
- React UI shell
- SQLite layer
- media abstraction
- AI provider interfaces
- rendering abstraction

Then verify the app launches.

## Phase 1 — Media Foundation

Implement:

- project creation
- import video
- media metadata
- thumbnail generation
- waveform
- proxy generation
- video preview

Acceptance:

> User can create a project, import a large video, preview it smoothly, and reopen the project.

## Phase 2 — Timeline

Implement:

- tracks
- clips
- split
- trim
- move
- delete
- snapping
- undo/redo
- serialization

Acceptance:

> User can manually create a Reel timeline.

## Phase 3 — Vertical Composition

Implement:

- 9:16 canvas
- transform
- crop
- positioning
- safe zones
- preview

Acceptance:

> User can convert a long-form video segment into a proper vertical composition.

## Phase 4 — Hook Designer

Implement:

- hook composition
- text layers
- shapes
- background
- keyframes
- easing
- animation presets
- hook templates
- hook timeline

Acceptance:

> User can create a professional animated Hook without writing code.

## Phase 5 — Captions

Implement:

- transcription provider
- word timestamps
- caption segmentation
- Arabic RTL
- caption styles
- word highlighting
- caption animation

Acceptance:

> User can generate and customize high-quality Arabic/English captions.

## Phase 6 — Effects

Implement:

- zoom
- punch zoom
- blur
- color
- glow
- sharpen
- vignette
- effect stack
- effect keyframes

## Phase 7 — AI Cut

Implement:

```text
Long Video
 ↓
Transcript
 ↓
Candidate Clips
 ↓
Scoring
 ↓
User selects
 ↓
Timeline created
```

Do not automatically overwrite the user's timeline.

## Phase 8 — AI Edit Assistant

Implement:

- hook suggestions
- pacing analysis
- caption recommendations
- dynamic zoom suggestions
- weak-section detection
- safe-zone analysis

## Phase 9 — Export Engine

Implement:

- master render
- platform presets
- hardware encoding
- quality checks
- export queue
- batch rendering
- final file validation

## Phase 10 — Brand System

Implement:

- brand profiles
- templates
- reusable caption styles
- reusable hook styles
- export profiles

## Phase 11 — Polish

Implement:

- keyboard shortcuts
- autosave
- crash recovery
- logs
- installer
- performance optimization
- onboarding
- empty states
- error states

---

# 38. DEFINITION OF DONE

The MVP is NOT complete until a real user can do this:

```text
1. Launch Windows application
2. Create project
3. Import a long podcast/video
4. Choose Manual Cut OR AI Cut
5. Create a Reel
6. Convert to 9:16
7. Design a strong Hook
8. Animate the Hook
9. Generate Arabic captions
10. Style captions
11. Add zoom/effects
12. Preview final Reel
13. Run AI Edit Review
14. Apply useful suggestions
15. Export for Instagram/TikTok/YouTube
16. Export from original media
17. Reopen project later
18. Continue editing
```

---

# 39. CODE QUALITY RULES

Mandatory:

- strict TypeScript
- no `any`
- no duplicated business logic
- no giant components
- no giant files
- clear domain boundaries
- reusable services
- typed API contracts
- schema validation
- error handling
- tests for core logic
- meaningful naming
- comments only where they explain WHY

Prefer feature-based architecture over a huge generic `components/` folder.

---

# 40. RECOMMENDED DOMAIN STRUCTURE

Use a structure similar to:

```text
src/
├── app/
├── features/
│   ├── projects/
│   ├── media/
│   ├── timeline/
│   ├── canvas/
│   ├── captions/
│   ├── hooks/
│   ├── animations/
│   ├── effects/
│   ├── ai/
│   ├── brands/
│   └── export/
├── domain/
│   ├── timeline/
│   ├── media/
│   ├── animation/
│   ├── captions/
│   ├── effects/
│   └── export/
├── infrastructure/
│   ├── ffmpeg/
│   ├── sqlite/
│   ├── filesystem/
│   └── ai/
└── shared/
```

Adapt this to the actual framework if needed.

---

# 41. IMPORTANT AGENT BEHAVIOR

You are not allowed to simply produce a plan and stop.

You must implement the application.

Before coding:

1. inspect the repository
2. understand existing architecture
3. identify reusable code
4. document assumptions
5. create an implementation roadmap

Then immediately begin implementation.

After every major phase:

1. run tests
2. run type checks
3. run lint
4. build the application
5. fix errors
6. verify the feature manually where possible

Do not leave fake implementations such as:

```ts
// TODO: implement later
```

for core functionality.

If a complex feature cannot be fully implemented immediately, implement the smallest real version that works end-to-end and document the limitation.

---

# 42. NEVER FAKE CORE FUNCTIONALITY

Do not create:

- fake rendering progress
- fake AI results
- fake timeline behavior
- fake export buttons
- fake captions
- fake animations

A button should either work or clearly be marked as unavailable.

---

# 43. AI EDIT PLAN CONTRACT

All AI-generated edits must conform to typed schemas.

Example:

```ts
type EditPlan = {
  version: number;
  format: {
    width: number;
    height: number;
    fps: number;
  };
  segments: EditSegment[];
  hook?: HookPlan;
  captions?: CaptionPlan;
  effects?: EffectPlan[];
};
```

Validate using a schema library such as Zod.

Reject malformed AI output.

---

# 44. PERFORMANCE TARGETS

Aim for:

- instant UI interactions
- smooth timeline scrolling
- responsive scrubbing with proxies
- asynchronous thumbnail generation
- asynchronous waveform generation
- background AI processing
- background rendering
- GPU acceleration when available
- no blocking of React UI by FFmpeg

Do not optimize blindly.

Measure bottlenecks.

---

# 45. FINAL PRODUCT PHILOSOPHY

The application should feel like:

> "I give it a long video. It helps me find the gold, turn it into a Reel, make the first seconds visually powerful, add professional captions and motion graphics, and export it perfectly for every platform."

The user should NOT feel like they are operating a complicated professional editing suite unless they choose advanced controls.

Default experience:

```text
Fast
Visual
AI-assisted
Editable
Professional
Social-first
```

Advanced users can open deeper controls.

---

# 46. FIRST TASK FOR THE AGENT

Start by inspecting the current repository.

Then produce a concise report:

```text
1. Existing stack
2. Existing files
3. Existing architecture
4. What can be reused
5. Missing foundations
6. Risks
7. Recommended implementation order
```

Then immediately begin Phase 0 and Phase 1.

Do not wait for additional confirmation unless a destructive change or genuinely ambiguous architectural decision requires it.

---

# 47. SUCCESS CRITERIA

The final application should become a real Windows desktop Reel-production tool capable of:

```text
LONG VIDEO
     ↓
AI OR MANUAL CUT
     ↓
REEL
     ↓
PROFESSIONAL HOOK
     ↓
SMOOTH MOTION
     ↓
CAPTIONS
     ↓
EFFECTS
     ↓
AI QUALITY REVIEW
     ↓
SOCIAL OPTIMIZED EXPORT
```

The architecture must remain extensible enough to later support:

- more AI models
- more platforms
- more motion templates
- more effects
- more codecs
- local AI
- cloud AI
- B-roll generation/suggestions
- automatic Reel batches
- advanced tracking
- richer motion graphics

Build the foundation correctly so these features can be added without rewriting the entire application.
